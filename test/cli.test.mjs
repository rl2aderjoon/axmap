/**
 * CLI 종료 코드.
 *
 * 🔴 순수 로직 테스트로는 **못 잡는 층**이 있다. `applyRelease` 는 예전에도
 *    `hadNothing` 을 정직하게 냈다. 그것을 받아 **0 을 반환하던 것**이 사고였다.
 *    판정은 맞는데 바깥에 전하는 신호가 틀린 경우다.
 *
 *    실제로 물렸다 — `AXMAP_AGENT=X` 로 claim 한 뒤 그 변수가 없는 셸에서
 *    release 를 불렀고, 이름이 `git config` 로 떨어져 아무것도 반납되지 않은
 *    채 종료 코드 0 이 나왔다. 반납했다고 믿었지만 락은 30분 더 남아 있었다.
 *
 * 그래서 여기서는 진짜 저장소를 만들고 진짜 프로세스를 돌린다.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bin', 'axmap.mjs')

let repo = null

/** 이 저장소 안에서 axMap 을 돌린다. `agent` 가 null 이면 환경변수를 **뺀다.** */
function bm(args, agent) {
  const env = { ...process.env }
  delete env.AXMAP_AGENT
  if (agent) env.AXMAP_AGENT = agent
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo, env, encoding: 'utf8', windowsHide: true,
  })
}

const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true })

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-cli-'))
  git('init', '-q')
  // 이름을 고정한다. 폴백 경로가 이 이름을 집는지 확인해야 하기 때문이다.
  git('config', 'user.name', 'fallback-name')
  git('config', 'user.email', 'x@example.com')
  git('config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  const r = bm(['init'], 'setup')
  assert.equal(r.status, 0, `init 실패: ${r.stderr || r.stdout}`)
})

after(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ }
})

describe('release 종료 코드', () => {
  it('잡은 사람이 반납하면 0', () => {
    assert.equal(bm(['claim', 'a.txt', '--task', 'T1', '--intent', '테스트'], 'alice').status, 0)
    const r = bm(['release'], 'alice')
    assert.equal(r.status, 0, r.stderr)
  })

  it('🔴 다른 이름으로 반납하면 5 — 조용히 성공하지 않는다', () => {
    assert.equal(bm(['claim', 'a.txt', '--task', 'T2', '--intent', '테스트'], 'alice').status, 0)
    const r = bm(['release'], 'bob')
    assert.equal(r.status, 5, `종료 코드가 ${r.status} 다. 0 이면 예전 사고가 돌아온 것이다`)
    // 락이 남아 있어야 한다 — 남의 이름으로 부른 것이 남의 락을 풀면 더 나쁘다
    assert.match(bm(['status'], 'bob').stdout, /alice/)
  })

  it('이름이 어디서 왔는지 말한다 — 원인이 거의 항상 그것이다', () => {
    const r = bm(['release'], null)   // 환경변수 없음 → git config 로 폴백
    assert.equal(r.status, 5)
    assert.match(r.stderr, /fallback-name/, '떨어진 이름을 안 알려준다')
    assert.match(r.stderr, /git config/, '어디서 왔는지 안 알려준다')
  })

  it('장부에 남의 것이 있으면 그것을 보여준다', () => {
    const r = bm(['release'], 'bob')
    assert.match(r.stderr, /alice \[T2\]/, '누가 잡고 있는지 안 보여주면 고칠 수가 없다')
    assert.equal(bm(['release'], 'alice').status, 0)
  })

  it('아무도 아무것도 안 잡았을 때도 5 — 반납할 것이 없는 것은 같다', () => {
    // 두 번 반납하면 두 번째는 실패다. 그것이 진실이다.
    const r = bm(['release'], 'alice')
    assert.equal(r.status, 5)
  })
})

/**
 * 🔴 원자성 — 관문 1 이 CAS 인 이상 전제 조건이다.
 *
 * claim 레코드를 그냥 writeFileSync 로 쓰면, 다른 에이전트의 `git add -A` 가
 * **반쯤 쓰인 파일**을 스테이징할 수 있다. readClaims 는 파싱 실패를 건너뛰지 않고
 * 전체를 중단하므로(fail-closed), 그 순간 팀 전원의 장부가 함께 멈춘다.
 * 창은 좁지만 터지면 범위가 전부다.
 *
 * 그래서 임시 파일에 다 쓴 뒤 rename 하고, 임시 이름은 장부가 무시한다.
 * 아래 세 개는 그 설계가 실제로 서 있는지를 고정한다.
 */
describe('장부 쓰기의 원자성', () => {
  const ledger = () => path.join(repo, '.axmap', 'ledger')
  const lgit = (...a) =>
    spawnSync('git', a, { cwd: ledger(), encoding: 'utf8', windowsHide: true })

  it('임시 파일은 장부에 스테이징되지 않는다', () => {
    fs.writeFileSync(path.join(repo, 'atom1.txt'), 'x\n')
    assert.equal(bm(['claim', 'atom1.txt', '--task', 'AT1', '--intent', '원자성'], 'atom1').status, 0)
    const tmp = path.join(ledger(), 'claims', 'atom1.json.tmp-99999')
    fs.writeFileSync(tmp, '{"agent":"atom')
    try {
      // -n 은 무엇을 넣을지만 말하고 인덱스를 건드리지 않는다.
      // 같은 파일의 다른 테스트가 무작위 순서로 끼어들어도 안전하다.
      const out = lgit('add', '-A', '-n').stdout ?? ''
      assert.ok(!out.includes('tmp-99999'), `임시 파일이 장부에 실린다:\n${out}`)
    } finally {
      fs.rmSync(tmp, { force: true })
      bm(['release'], 'atom1')
    }
  })

  it('깨진 임시 파일이 있어도 판정은 멈추지 않는다', () => {
    const tmp = path.join(ledger(), 'claims', 'garbage.json.tmp-99998')
    fs.writeFileSync(tmp, '{ 이건 JSON 이 아니다')
    try {
      // `.json` 으로 끝나지 않으므로 readClaims 가 아예 보지 않는다.
      // 이것이 "못 막을 때는 실패의 크기라도 낮춘다" 의 실물이다.
      assert.equal(bm(['status'], 'atom2').status, 0)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('claim 이 끝나면 임시 파일이 남지 않는다', () => {
    fs.writeFileSync(path.join(repo, 'atom3.txt'), 'x\n')
    assert.equal(bm(['claim', 'atom3.txt', '--task', 'AT3', '--intent', '원자성'], 'atom3').status, 0)
    try {
      const left = fs
        .readdirSync(path.join(ledger(), 'claims'))
        .filter((f) => f.includes('.tmp-'))
      assert.deepEqual(left, [], `임시 파일이 남았다: ${left.join(', ')}`)
    } finally {
      bm(['release'], 'atom3')
    }
  })
})

// ---------------------------------------------------------------------------

describe('딸린 프로그램을 이름으로 부른다 — 경로가 박혀 있으면 사본을 못 지운다', () => {
  /**
   * 같은 것을 **이름으로** 부른 것과 **경로로** 부른 것이 같아야 한다.
   *
   * 🔴 여기서 갈리면 제일 나쁜 방식으로 갈린다. CI 는 종료 코드만 보므로,
   *    이름으로 부른 쪽이 0 을 내면 **막아야 할 MR 이 조용히 초록**이 된다.
   *    이 파일 맨 위의 사고와 같은 종류다 — 판정은 맞는데 바깥에 전하는 신호가 틀린 것.
   */
  const both = (name, rel, args) => ({
    byName: spawnSync(process.execPath, [CLI, name, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true }),
    byPath: spawnSync(process.execPath, [path.join(ROOT, ...rel.split('/')), ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true }),
  })

  it('🔴 거부(2)가 그대로 전해진다', () => {
    const { byName, byPath } = both('mr-target', 'tools/mr-target.mjs',
      ['--source', 'feat/S15P21E201-144-login', '--target', 'main'])
    assert.equal(byPath.status, 2, '기준이 되는 경로 호출부터 2 가 아니다')
    assert.equal(byName.status, 2, `이름으로 부르니 ${byName.status} 가 나왔다 — CI 가 틀리게 초록이 된다`)
  })

  it('통과(0)도 그대로 전해진다', () => {
    const { byName, byPath } = both('mr-target', 'tools/mr-target.mjs',
      ['--source', 'feat/S15P21E201-144-login', '--target', 'back/dev'])
    assert.equal(byPath.status, 0)
    assert.equal(byName.status, 0)
  })

  it('🔴 판정 불가(1)도 그대로 전해진다 — 재료가 없으면 멈춰야 한다', () => {
    const { byName, byPath } = both('gate', 'governance/gate.mjs', [])
    assert.equal(byPath.status, 1)
    assert.equal(byName.status, 1)
  })

  it('인자는 손대지 않고 그대로 간다 — 명령 이름과 같은 값도 살아남는다', () => {
    // 예전 방식(이름과 같은 인자를 전부 지우기)이었다면 `--source` 의 값이 사라진다.
    const { byName, byPath } = both('mr-target', 'tools/mr-target.mjs',
      ['--source', 'mr-target', '--target', 'back/dev'])
    assert.equal(byName.status, byPath.status)
    assert.equal(byName.stdout + byName.stderr, byPath.stdout + byPath.stderr)
  })

  it('도움말에 새 이름들이 적혀 있다 — 적히지 않은 손잡이는 없는 것과 같다', () => {
    const r = spawnSync(process.execPath, [CLI], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
    for (const name of ['gate', 'vote', 'bus', 'mr-target', 'version', 'promote', 'mcp']) {
      // 정규식을 안 쓴다 — 이름에 `-` 가 들어 있고, 이스케이프가 하나 어긋나면
      // 테스트가 조용히 아무것도 검사하지 않게 된다.
      assert.ok(r.stdout.includes(`axmap ${name} `), `${name} 이 도움말에 없다`)
    }
  })
})

describe('audit --code 와 한글 경로', () => {
  /**
   * 🔴 순수 로직 테스트로는 **절대 못 잡는다.** `enforcementViolations` 는 이미
   *    파싱된 경로 배열을 받으므로 늘 통과한다. 틀리는 것은 그 배열을 만드는
   *    층이다 - git 은 기본으로 ASCII 밖 글자를 역슬래시 + 8진수 세 자리로 감싸
   *    내보내고, 그러면 장부에 적힌 경로와 절대 같아지지 않는다.
   *
   *    어긋나는 방향은 fail-open 이 아니라 **잡았는데 안 잡았다고 하는 쪽**이다.
   *    팀 CI 의 claims 잡이 한글 파일이 든 push 마다 빨개졌고, 잡 안에서
   *    `git config core.quotepath false` 로 우회하고 있었다 (실측 2026-09-01).
   *    우회는 그 잡에만 걸리므로 부르는 자리에 못을 박고, 여기서 지킨다.
   */
  it('claim 한 한글 경로를 고친 커밋은 위반이 아니다', () => {
    const rel = 'docs/한글-경로.md'
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), '내용 한 줄')

    assert.equal(
      bm(['claim', rel, '--task', 'T-hangul', '--intent', '한글 경로'], 'hangul-agent').status,
      0,
    )

    const base = git('rev-parse', 'HEAD').stdout.trim()
    git('add', rel)

    // 🔴 커밋 시각을 못 박는다. git 의 %ct 는 **초 단위로 내림**이라, 방금 한
    //    claim(밀리초까지 적힌다)이 커밋보다 뒤에 있는 것으로 보이고 "아무도
    //    안 잡았다" 가 나온다. 이 테스트가 보려는 것은 시계가 아니라 경로 글자다.
    const later = new Date(Date.now() + 5000).toISOString()
    spawnSync('git', ['commit', '-q', '-m', '한글 파일을 더한다'], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_AUTHOR_DATE: later, GIT_COMMITTER_DATE: later },
    })
    const head = git('rev-parse', 'HEAD').stdout.trim()

    const r = bm(['audit', '--code', base + '..' + head], 'hangul-agent')
    assert.equal(
      r.status, 0,
      `잡아둔 한글 경로가 위반으로 잡혔다 (core.quotepath): ${r.stdout}${r.stderr}`,
    )

    bm(['release'], 'hangul-agent')
  })
})

describe('🔴 커밋 훅은 저장소 안 사본(ci/axmap)으로 되돌아가지 않는다 (D31)', () => {
  /**
   * 예전 훅은 박아둔 경로가 사라지면 `<루트>/ci/axmap/bin/axmap.mjs` 를 대신 불렀다.
   * 그 사본은 만든 날의 규칙에 멈춰 있어서 **옛 규칙으로 판정**했다 (GIT-AS-DB 사고 3).
   * 사본을 걷어낸 지금, 사본이 남아 있는 저장소에서 진짜 도구를 못 찾으면
   * 조용히 통과시키지 않고 멈춰서 `hook install` 을 안내해야 한다.
   */
  let dir = null
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', windowsHide: true })
  const hookFile = () => path.join(dir, '.git', 'hooks', 'pre-commit')
  /** 박아둔 경로를 없는 곳으로 바꾼다 — 폴더를 옮긴 뒤의 훅과 같은 상태다. */
  const breakPin = () => {
    const text = fs.readFileSync(hookFile(), 'utf8').replace(/^AX=".*"$/m, 'AX="/axmap-여기-없다/bin/axmap.mjs"')
    fs.writeFileSync(hookFile(), text)
  }

  /**
   * 훅을 git 이 부르게 한다. 훅은 git 이 자기 sh 로 돌리므로, 셸을 따로 찾지 않고
   * 실제 커밋 경로를 그대로 탄다 (Windows 의 PATH 에는 sh 가 없을 수 있다).
   */
  const commit = () => run('git', ['commit', '-q', '--allow-empty', '-m', 'hook'])

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-hook-'))
    run('git', ['init', '-q'])
    run('git', ['config', 'user.name', 'hook-test'])
    run('git', ['config', 'user.email', 'hook@example.com'])
    run('git', ['config', 'commit.gpgsign', 'false'])
    const r = spawnSync(process.execPath, [CLI, 'hook', 'install'], { cwd: dir, encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, `hook install 실패: ${r.stderr || r.stdout}`)
  })

  after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ }
  })

  it('새 훅에는 사본으로 되돌아가는 목록이 없다', () => {
    const text = fs.readFileSync(hookFile(), 'utf8')
    assert.doesNotMatch(text, /for p in "\$ROOT\/ci\/axmap/, '훅이 아직 사본으로 되돌아간다')
    assert.match(text, /verify/)
  })

  it('🔴 도구를 못 찾았는데 사본이 남아 있으면 막는다(1) — 옛 규칙에 판정을 맡기지 않는다', () => {
    breakPin()
    fs.mkdirSync(path.join(dir, 'ci', 'axmap', 'bin'), { recursive: true })
    // 이 사본이 불리면 0 으로 끝난다. 막혔다면 훅이 사본을 부르지 않은 것이다.
    fs.writeFileSync(path.join(dir, 'ci', 'axmap', 'bin', 'axmap.mjs'), 'process.exit(0)\n')
    try {
      const r = commit()
      assert.equal(r.status, 1, `사본이 있는데 통과했다: ${r.stdout}${r.stderr}`)
      assert.match(r.stderr, /더 이상 쓰지 않습니다/)
      assert.match(r.stderr, /hook install/)
    } finally {
      fs.rmSync(path.join(dir, 'ci'), { recursive: true, force: true })
    }
  })

  it('사본도 도구도 없으면 경고만 하고 통과한다(0) — 설치 문제로 모든 커밋을 막지 않는다', () => {
    breakPin()
    const r = commit()
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /검사 도구를 찾지 못했습니다/)
  })

  it('🔴 doctor 는 사본으로 되돌아가는 옛 훅을 고쳐야 할 것으로 말한다', () => {
    const old = '#!/bin/sh\nAX="/axmap-여기-없다/bin/axmap.mjs"\nif [ ! -f "$AX" ]; then\n' +
      '  ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || ROOT=""\n' +
      '  for p in "$ROOT/ci/axmap/bin/axmap.mjs" "$ROOT/axmap/bin/axmap.mjs" "$ROOT/bin/axmap.mjs"; do\n' +
      '    if [ -f "$p" ]; then AX="$p"; break; fi\n  done\nfi\nexec node "$AX" verify\n'
    fs.writeFileSync(hookFile(), old)
    const r = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: dir, encoding: 'utf8', windowsHide: true })
    const hook = JSON.parse(r.stdout).checks.find((c) => c.what === '커밋 훅')
    assert.equal(hook?.status, 'no', `옛 훅을 정상으로 봤다: ${JSON.stringify(hook)}`)
    assert.match(hook.detail, /hook install/)
  })

  it('🔴 doctor 는 사본을 직접 박은 옛 훅도 고쳐야 할 것으로 말한다', () => {
    fs.mkdirSync(path.join(dir, 'ci', 'axmap', 'bin'), { recursive: true })
    const pinned = path.join(dir, 'ci', 'axmap', 'bin', 'axmap.mjs').replace(/\\/g, '/')
    fs.writeFileSync(pinned, 'process.exit(0)\n')
    try {
      fs.writeFileSync(hookFile(), `#!/bin/sh\nAX="${pinned}"\nexec node "$AX" verify\n`)
      const r = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: dir, encoding: 'utf8', windowsHide: true })
      const hook = JSON.parse(r.stdout).checks.find((c) => c.what === '커밋 훅')
      assert.equal(hook?.status, 'no', `사본을 부르는 훅을 정상으로 봤다: ${JSON.stringify(hook)}`)
    } finally {
      fs.rmSync(path.join(dir, 'ci'), { recursive: true, force: true })
    }
  })
})
