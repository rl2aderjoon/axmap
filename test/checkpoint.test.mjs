/**
 * 감사 체크포인트 — **빨라진 대신 보장이 헐거워지지 않았는가.**
 *
 * 🔴 성능 변경에서 진짜 위험은 느린 것이 아니라 **조용히 통과하는 것**이다.
 *    "이미 본 구간은 다시 안 본다" 는 재생 구간을 줄이는 장치이므로, 잘못 만들면
 *    거부해야 할 것이 검사 밖으로 빠져나간다. 그래서 여기서 재는 것은 속도가
 *    아니라 **여전히 잡는가** 다.
 *
 * 두 갈래로 나눈다.
 *   - 순수 로직: 어디서부터 재생할지 고르는 계산 (git 없이)
 *   - 진짜 저장소: 일부러 만든 위반을 실제 명령이 잡는가
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { planAudit, pickCheckpoint } from '../src/invariants.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bin', 'axmap.mjs')

const T0 = Date.parse('2026-09-01T00:00:00.000Z')
const HOUR = 3600_000
const MIN = 60_000
const at = (i) => T0 + i * HOUR

const cp = (ledger, i) => ({ ledger, time: at(i), at: new Date(at(i)).toISOString() })
const code = (sha, i, offset = MIN) => ({ sha, subject: sha, time: at(i) + offset, files: [] })

// ---------------------------------------------------------------------------
// 순수 로직 — 어디서부터 재생할 것인가
// ---------------------------------------------------------------------------

describe('재생 시작점 고르기', () => {
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)
  const C = 'c'.repeat(40)

  it('체크포인트가 하나도 없으면 장부 뿌리부터 본다 - 예전 그대로', () => {
    const p = planAudit({ checkpoints: [], codeCommits: [code('x', 5)] })
    assert.equal(p.from, null)
    assert.equal(p.judged.length, 1)
    assert.equal(p.amnestied.length, 0)
  })

  it('🔴 시작점은 "가장 최근" 이 아니라 "가장 오래된 코드 커밋보다 앞선" 것이다', () => {
    // 이것이 이 설계의 전부다. 최근 것부터 재생하면 9일 전 커밋은 대조할 장부
    // 스냅샷이 없어서 **조용히 통과**한다 - 락에서 최악인 fail-open 이다.
    const checkpoints = [cp(A, 0), cp(B, 3), cp(C, 9)]
    const p = planAudit({ checkpoints, codeCommits: [code('old', 4), code('new', 10)] })
    assert.equal(p.from.ledger, B, '가장 오래된 코드 커밋(4시)보다 앞선 마지막 체크포인트는 3시다')
    assert.equal(p.judged.length, 2)
  })

  it('코드 커밋이 전부 최근이면 최근 체크포인트에서 시작한다 - 그래서 빠르다', () => {
    const checkpoints = [cp(A, 0), cp(B, 3), cp(C, 9)]
    const p = planAudit({ checkpoints, codeCommits: [code('new', 10)] })
    assert.equal(p.from.ledger, C)
  })

  it('첫 체크포인트보다 앞선 코드 커밋은 면제되고 **목록에 남는다**', () => {
    // 조용히 빼면 "위반 0" 이 "검사했고 깨끗함" 으로 읽힌다.
    const checkpoints = [cp(B, 5)]
    const p = planAudit({ checkpoints, codeCommits: [code('ancient', 1), code('now', 6)] })
    assert.equal(p.amnestied.length, 1)
    assert.equal(p.amnestied[0].sha, 'ancient')
    assert.equal(p.judged.length, 1)
    assert.equal(p.from.ledger, B)
  })

  it('코드 대조를 안 하면 마지막 체크포인트부터 본다 (I1 만 본다)', () => {
    const checkpoints = [cp(A, 0), cp(C, 9)]
    const p = planAudit({ checkpoints, codeCommits: null })
    assert.equal(p.from.ledger, C)
    assert.equal(p.judged, null)
  })

  it('pickCheckpoint 는 그 시점에 이미 있던 것 중 가장 늦은 것을 준다', () => {
    const checkpoints = [cp(A, 0), cp(B, 3), cp(C, 9)]
    assert.equal(pickCheckpoint(checkpoints, at(5)).ledger, B)
    assert.equal(pickCheckpoint(checkpoints, at(0)).ledger, A)
    assert.equal(pickCheckpoint(checkpoints, at(0) - 1), null)
  })
})

// ---------------------------------------------------------------------------
// 진짜 저장소 — 일부러 만든 위반을 실제로 잡는가
// ---------------------------------------------------------------------------

const repos = []

function bm(repo, args, agent = 'auditor') {
  const env = { ...process.env }
  delete env.AXMAP_AGENT
  if (agent) env.AXMAP_AGENT = agent
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo, env, encoding: 'utf8', windowsHide: true,
  })
}

const g = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true })

function mkrepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-cp-'))
  repos.push(repo)
  g(repo, 'init', '-q')
  g(repo, 'config', 'user.name', 'bench')
  g(repo, 'config', 'user.email', 'bench@example.com')
  g(repo, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n')
  g(repo, 'add', '-A')
  g(repo, 'commit', '-q', '--no-verify', '-m', 'first')
  const r = bm(repo, ['init'], 'setup')
  assert.equal(r.status, 0, `init 실패: ${r.stdout}${r.stderr}`)
  // init 이 .gitignore 에 .axmap/ 을 더한다. 그것을 커밋해 두지 않으면 뒤의
  // 첫 코드 커밋에 딸려 들어가 "아무도 안 잡은 파일" 이 하나 더 생긴다.
  g(repo, 'add', '-A')
  g(repo, 'commit', '-q', '--no-verify', '-m', 'axmap init')
  return repo
}

/**
 * 장부 스냅샷 하나를 **그 시점의 전부**로 덮어쓴다.
 *
 * `axmap claim` 을 쓰지 않는 이유: claim 은 커밋 시각에 벽시계를 쓰므로 과거를
 * 만들 수 없다. 여기서 시험하는 것은 claim 이 아니라 **감사가 장부를 어떻게
 * 읽는가** 이고, 감사는 git 트리를 읽으므로 트리를 직접 만드는 것이 맞다.
 *
 * @param claims  { 이름: [경로...] }
 */
function ledgerCommit(repo, claims, atMs, subject = 'claim') {
  const dir = path.join(repo, '.axmap', 'ledger', 'claims')
  fs.mkdirSync(dir, { recursive: true })
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) fs.rmSync(path.join(dir, f), { force: true })
  }
  for (const [agent, paths] of Object.entries(claims)) {
    fs.writeFileSync(
      path.join(dir, `${agent}.json`),
      JSON.stringify({ agent, paths, since: new Date(atMs).toISOString(), ttlMs: 30 * MIN }, null, 2) + '\n',
    )
  }
  const ledger = path.join(repo, '.axmap', 'ledger')
  const iso = new Date(atMs).toISOString()
  g(ledger, 'add', '-A')
  const r = spawnSync('git', ['commit', '-q', '--no-verify', '-m', subject], {
    cwd: ledger, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  })
  assert.equal(r.status, 0, `장부 커밋 실패: ${r.stdout}${r.stderr}`)
  return g(ledger, 'rev-parse', 'HEAD').stdout.trim()
}

function codeCommit(repo, rel, atMs, subject) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), `// ${subject}\n`)
  const iso = new Date(atMs).toISOString()
  g(repo, 'add', '-A')
  spawnSync('git', ['commit', '-q', '--no-verify', '-m', subject], {
    cwd: repo, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  })
  return g(repo, 'rev-parse', 'HEAD').stdout.trim()
}

const checkpointsOf = (repo) => {
  const r = g(repo, 'show', 'axmap/checkpoints:checkpoints.json')
  return r.status === 0 ? JSON.parse(r.stdout).checkpoints : []
}

after(() => {
  for (const r of repos) {
    try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ }
  }
})

describe('양성 대조 - 체크포인트가 있어도 위반을 잡는가', () => {
  it('🔴 체크포인트 **뒤에** 생긴 겹침을 잡는다', () => {
    const repo = mkrepo()
    for (let i = 0; i < 4; i++) ledgerCommit(repo, { alice: [`src/a${i}.mjs`] }, at(i))

    const made = bm(repo, ['audit', '--checkpoint'])
    assert.equal(made.status, 0, `깨끗한 장부인데 감사가 실패했다: ${made.stdout}${made.stderr}`)
    assert.equal(checkpointsOf(repo).length, 1, '체크포인트가 안 남았다')

    // 체크포인트 뒤에서 둘이 같은 파일을 잡는다
    ledgerCommit(repo, { alice: ['src/same.mjs'], bob: ['src/same.mjs'] }, at(5), '겹침')

    const r = bm(repo, ['audit'])
    assert.equal(r.status, 4, `겹침을 못 잡았다: ${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /I1/)
    assert.match(r.stdout, /src\/same\.mjs/)
  })

  it('🔴 겹침이 있는 장부에는 체크포인트를 **남기지 않는다**', () => {
    // 남기면 그 위반이 영원히 검사 밖으로 나간다. 체크포인트의 뜻이
    // "여기까지 봤고 깨끗했다" 이므로 깨끗하지 않으면 적을 것이 없다.
    const repo = mkrepo()
    ledgerCommit(repo, { alice: ['src/a.mjs'] }, at(0))
    assert.equal(bm(repo, ['audit', '--checkpoint']).status, 0)
    assert.equal(checkpointsOf(repo).length, 1)

    ledgerCommit(repo, { alice: ['src/x.mjs'], bob: ['src/x.mjs'] }, at(1), '겹침')
    const r = bm(repo, ['audit', '--checkpoint'])
    assert.equal(r.status, 4, `겹친 장부에 체크포인트를 남기려 했는데 통과했다: ${r.stdout}`)
    assert.equal(checkpointsOf(repo).length, 1, '위반이 있는데 체크포인트가 늘었다')
  })

  it('🔴 체크포인트가 그 뒤에 여럿 있어도 **오래된 코드 커밋**의 I5 위반을 잡는다', () => {
    /**
     * 이것이 "가장 최근 체크포인트부터 재생" 이 만드는 구멍이다. 승격 MR 은
     * 며칠치 커밋을 한 번에 나르는데, 최근 체크포인트부터 보면 그 오래된 커밋은
     * 대조할 장부 스냅샷이 없어서 조용히 통과한다.
     */
    const repo = mkrepo()
    const base = g(repo, 'rev-parse', 'HEAD').stdout.trim()
    const shas = []
    for (let i = 0; i < 10; i++) shas.push(ledgerCommit(repo, { alice: [`src/a${i}.mjs`] }, at(i)))

    // 3시·6시·9시에 체크포인트를 남긴다 (장부를 그때로 되감았다가 되돌린다 —
    // 실제로는 시간이 지나면서 하나씩 쌓이지만, 시험에서는 되감아 만든다)
    const ledger = path.join(repo, '.axmap', 'ledger')
    for (const i of [3, 6, 9]) {
      g(ledger, 'reset', '--hard', '--quiet', shas[i])
      assert.equal(bm(repo, ['audit', '--checkpoint']).status, 0)
    }
    assert.equal(checkpointsOf(repo).length, 3)

    // 4시에 아무도 안 잡은 파일을 고쳤다 (I5 위반) + 9시에 정상 커밋 하나
    codeCommit(repo, 'src/never-claimed.mjs', at(4) + MIN, '아무도 안 잡은 파일')
    codeCommit(repo, 'src/a9.mjs', at(9) + MIN, '잡아둔 파일')
    const head = g(repo, 'rev-parse', 'HEAD').stdout.trim()

    const r = bm(repo, ['audit', '--code', `${base}..${head}`, '--json'])
    assert.equal(r.status, 4, `오래된 커밋의 I5 위반을 놓쳤다: ${r.stdout}${r.stderr}`)
    const report = JSON.parse(r.stdout)
    assert.equal(report.violations.length, 1)
    assert.equal(report.violations[0].invariant, 'I5')
    assert.match(report.violations[0].message, /never-claimed/)
    // 🔴 시작점이 "가장 오래된 코드 커밋(4시)보다 앞선" 3시 체크포인트여야 한다
    assert.equal(report.replay.from, shas[3], '가장 최근 체크포인트에서 시작하면 위 위반을 놓친다')
    assert.equal(report.amnesty.length, 0)
  })

  it('첫 체크포인트보다 앞선 코드 커밋은 면제하되 **몇 건인지 찍는다**', () => {
    const repo = mkrepo()
    const base = g(repo, 'rev-parse', 'HEAD').stdout.trim()
    const shas = []
    for (let i = 0; i < 6; i++) shas.push(ledgerCommit(repo, { alice: [`src/a${i}.mjs`] }, at(i)))
    assert.equal(bm(repo, ['audit', '--checkpoint']).status, 0)

    // 장부는 있지만 첫 체크포인트(5시)보다 앞선 시각의 커밋
    codeCommit(repo, 'src/never-claimed.mjs', at(1) + MIN, '옛 커밋')
    const head = g(repo, 'rev-parse', 'HEAD').stdout.trim()

    const r = bm(repo, ['audit', '--code', `${base}..${head}`])
    assert.equal(r.status, 0, `면제 대상인데 실패로 냈다: ${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /면제 1개/)
    assert.match(r.stdout, /옛 커밋/, '무엇을 면제했는지 안 찍으면 조용히 넘긴 것과 같다')
  })
})

describe('판정 불가 - 못 본 것을 통과로 내지 않는다', () => {
  it('🔴 장부 이력이 다시 쓰이면 0 이 아닌 종료 코드로 멈춘다', () => {
    const repo = mkrepo()
    for (let i = 0; i < 3; i++) ledgerCommit(repo, { alice: [`src/a${i}.mjs`] }, at(i))
    assert.equal(bm(repo, ['audit', '--checkpoint']).status, 0)

    // 체크포인트가 가리키던 이력을 통째로 갈아엎는다
    const ledger = path.join(repo, '.axmap', 'ledger')
    const root = g(ledger, 'rev-list', '--max-parents=0', 'HEAD').stdout.trim()
    g(ledger, 'reset', '--hard', '--quiet', root)
    ledgerCommit(repo, { carol: ['src/z.mjs'] }, at(9), '다른 이력')

    const r = bm(repo, ['audit'])
    assert.notEqual(r.status, 0, `이어 붙일 수 없는 상태인데 통과했다: ${r.stdout}`)
    assert.match(r.stderr, /판정 불가/)
  })

  it('🔴 체크포인트 파일이 깨져 있으면 멈춘다 - 빈 목록으로 넘기지 않는다', () => {
    const repo = mkrepo()
    ledgerCommit(repo, { alice: ['src/a.mjs'] }, at(0))
    assert.equal(bm(repo, ['audit', '--checkpoint']).status, 0)

    // checkpoints.json 을 망가뜨린 커밋을 브랜치 끝에 올린다
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repo, input: '{ 망가진', encoding: 'utf8', windowsHide: true,
    }).stdout.trim()
    const tree = spawnSync('git', ['mktree'], {
      cwd: repo, input: `100644 blob ${blob}\tcheckpoints.json\n`, encoding: 'utf8', windowsHide: true,
    }).stdout.trim()
    const parent = g(repo, 'rev-parse', 'axmap/checkpoints').stdout.trim()
    const commit = g(repo, 'commit-tree', tree, '-p', parent, '-m', 'broken').stdout.trim()
    g(repo, 'branch', '-f', 'axmap/checkpoints', commit)

    const r = bm(repo, ['audit'])
    assert.notEqual(r.status, 0, `깨진 체크포인트를 없는 것으로 넘겼다: ${r.stdout}`)
    assert.match(r.stderr, /체크포인트를 읽을 수 없습니다/)
  })
})
