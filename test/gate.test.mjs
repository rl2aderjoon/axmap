/**
 * 합의 게이트 · 투표 CLI 테스트 — **진짜 git 저장소를 만들어 진짜로 돌린다.**
 *
 * `test/governance.test.mjs` 는 순수 판정만 본다. 이 파일은 그 아래층,
 * **git 에서 재료를 모으는 부분**을 본다. 두 층을 나눈 이유는 이 저장소가
 * `protocol.mjs` 와 `bin/axmap.mjs` 를 나눈 이유와 같다 — 그리고 `cli.test.mjs`
 * 가 증명했듯이 **판정은 맞는데 바깥에 전하는 신호가 틀린** 사고가 실제로 난다.
 *
 * 🔴 여기 있는 것의 대부분은 **음성 테스트**(**막아야 하는 것이 실제로 막히는지
 *    보는 테스트**)다. 한 번도 실패하지 않는 검사기는 검사기가 아니다.
 *    특히 **G2**(정책은 언제나 타깃 브랜치에서 읽는다)는 이 층에만 있는 성질이라,
 *    여기서 안 잡으면 아무 데서도 안 잡힌다 — 그리고 그게 뚫리면 정족수를 1 로
 *    낮추는 MR 이 자기가 낮춘 규칙으로 통과한다.
 *
 * 판정은 언제나 **종료 코드**다 (0 충족 / 2 미달 / 1 판정 불가 / 4 정책 깨짐).
 * 개수는 어디에도 적지 않는다.
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'governance', 'gate.mjs')
const VOTE = path.join(ROOT, 'governance', 'vote.mjs')

/**
 * 정책 파일의 자리 — **저장소 루트 기준**이고 `axmap/` 안이 아니다.
 * 도구(axMap)는 곧 자기 저장소로 나가고, 그때도 정책은 팀 저장소에 남아야 한다.
 */
const POLICY_PATH = 'governance/policy.json'

/**
 * 공개 배포 예제도 실제 게이트로 검증한다.
 * 정책은 사용하는 저장소의 데이터다. axMap 테스트가 다른 팀 저장소나
 * 부모 폴더를 탐색하면 독립 clone에서 실행할 수 없으므로 예제를 명시한다.
 */
function readExamplePolicy() {
  const from = path.join(ROOT, 'governance', 'policy.example.json')
  return { text: fs.readFileSync(from, 'utf8'), from }
}

/** 폴백이 생기지 않았는지 확인할 때 쓰는 **옛** 자리. 지금은 아무도 여기를 안 본다. */
const OLD_POLICY_PATH = 'axmap/governance/policy.json'

const BRANCH = 'feat/S15P21E201-144-login'

const ALICE = { name: 'alice', email: 'alice@example.com' }
const BOB = { name: 'bob', email: 'bob@example.com' }
const CAROL = { name: 'carol', email: 'carol@example.com' }
/** 명단에 없는 사람. 기능 브랜치를 쓰는 쪽이라 G1 에 걸릴 일이 없다. */
const DAVE = { name: 'dave', email: 'dave@example.com' }
const MALLORY = { name: 'mallory', email: 'mallory@example.com' }

// ---------------------------------------------------------------------------
// 저장소 만들기
// ---------------------------------------------------------------------------

const madeRepos = []

after(() => {
  for (const d of madeRepos) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ }
  }
})

/**
 * git 한 번. 기본은 **실패하면 던진다** — 픽스처가 조용히 반쯤 만들어지면
 * 그 뒤의 단언이 엉뚱한 것을 재게 된다.
 */
function g(repo, args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
    input: opts.input,
    env: { ...process.env, ...(opts.env ?? {}) },
  })
  if (!opts.allowFail && (r.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(' ')} 실패 (${r.status})\n${r.stderr}`)
  }
  return (r.stdout ?? '').trim()
}

function commitAs(repo, who, message) {
  g(repo, ['add', '-A'])
  g(repo, ['commit', '-q', '-m', message], {
    env: {
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
      GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email,
    },
  })
}

function writeIn(repo, rel, content) {
  const full = path.join(repo, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

/** 통과하는 정책. 각 테스트는 여기서 한 군데만 바꾼다. */
function basePolicy(over = {}) {
  return {
    version: 1,
    voters: [
      { id: ALICE.name, email: ALICE.email },
      { id: BOB.name, email: BOB.email },
      { id: CAROL.name, email: CAROL.email },
    ],
    amendment: { paths: [POLICY_PATH], threshold: 3 },
    default: { threshold: 2 },
    rules: [],
    succession: { window_days: 90, top: 3 },
    ...over,
  }
}

/**
 * `main` 하나와 기능 브랜치 하나가 있는 저장소.
 *
 * 🔴 main 의 커밋을 **투표권자 세 명이 나눠서** 쓴다. 안 그러면 "살아 있는
 *    투표권자" 가 0 명이 되어 **승계가 발동하고**, 그러면 이 테스트들이 재려던
 *    것 대신 승계를 재게 된다. 승계 자체는 governance.test.mjs 가 본다.
 */
function makeRepo(name, {
  policy = basePolicy(),
  policyRaw = null,
  // 정책을 어디에 두는가. 자리를 바꿔도 게이트가 따라오는지 보려고 열어 둔다.
  policyPath = POLICY_PATH,
  // 타깃(main)에만 있는 추가 파일들. 정책을 두 자리에 두는 시험에 쓴다.
  // 갈림점 이전에 들어가므로 MR 의 "바뀐 파일" 로는 세지지 않는다.
  mainFiles = {},
  featureAuthor = DAVE,
  featureFiles = { 'src/app.js': 'export const a = 2\n' },
} = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `axmap-gate-${name}-`))
  madeRepos.push(repo)

  g(repo, ['init', '-q'])
  // 기본 브랜치 이름을 환경에 맡기지 않는다 (`init -b` 는 옛 git 에 없다).
  g(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  g(repo, ['config', 'user.name', 'tester'])
  g(repo, ['config', 'user.email', 'tester@example.com'])
  g(repo, ['config', 'commit.gpgsign', 'false'])
  // 줄바꿈 변환이 켜져 있으면 내용이 흔들린다. 판정과 무관하게 만든다.
  g(repo, ['config', 'core.autocrlf', 'false'])

  writeIn(repo, 'README.md', 'hello\n')
  commitAs(repo, ALICE, 'first')
  writeIn(repo, 'src/app.js', 'export const a = 1\n')
  commitAs(repo, BOB, 'second')
  writeIn(repo, policyPath, policyRaw ?? `${JSON.stringify(policy, null, 2)}\n`)
  for (const [rel, content] of Object.entries(mainFiles)) {
    writeIn(repo, rel, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  }
  commitAs(repo, CAROL, 'policy')
  const mainHead = g(repo, ['rev-parse', 'HEAD'])

  g(repo, ['checkout', '-q', '-b', BRANCH])
  for (const [rel, content] of Object.entries(featureFiles)) writeIn(repo, rel, content)
  commitAs(repo, featureAuthor, 'feature work')
  const head = g(repo, ['rev-parse', 'HEAD'])

  return { repo, head, mainHead }
}

// ---------------------------------------------------------------------------
// 표 심기 — 커밋의 committer 까지 마음대로 정할 수 있어야 한다
// ---------------------------------------------------------------------------

let indexSeq = 0

/**
 * `axmap/votes` 브랜치에 표 파일 하나를 얹는다.
 *
 * worktree 를 붙이지 않고 plumbing(**git 의 저수준 명령**)으로 만든다. 이유는
 * 하나 — **커밋의 committer 를 표에 적힌 email 과 다르게** 만들 수 있어야 하기
 * 때문이다. 그게 위조 탐지의 음성 테스트다. `--orphan` worktree 는 옛 git 에 없다.
 */
function addVote(repo, relPath, body, committer) {
  const idx = path.join(repo, '.git', `vote-index-${++indexSeq}`)
  const env = {
    GIT_INDEX_FILE: idx,
    GIT_AUTHOR_NAME: committer.name,
    GIT_AUTHOR_EMAIL: committer.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
  }
  const parent = g(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/axmap/votes'], { allowFail: true })
  if (parent) g(repo, ['read-tree', parent], { env })

  const text = typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`
  const blob = g(repo, ['hash-object', '-w', '--stdin'], { input: text })
  g(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${relPath}`], { env })
  const tree = g(repo, ['write-tree'], { env })

  const args = ['commit-tree', tree, '-m', `vote ${relPath}`]
  if (parent) args.push('-p', parent)
  const commit = g(repo, args, { env })
  g(repo, ['update-ref', 'refs/heads/axmap/votes', commit])
  fs.rmSync(idx, { force: true })
  return commit
}

/** 표 한 장. 기본은 "멀쩡한 찬성표" 이고, 각 테스트가 한 군데만 망가뜨린다. */
function ballot(who, sha, over = {}) {
  return {
    voter: who.name,
    email: who.email,
    branch: BRANCH,
    sha,
    vote: 'approve',
    at: new Date().toISOString(),
    ...over,
  }
}

/** 표를 그 사람 자신이 커밋한, 정상적인 경로. */
function castVote(repo, who, sha, over = {}, committer = null) {
  const rec = ballot(who, sha, over)
  const file = `votes/${BRANCH}/${who.name}-${String(rec.sha).slice(0, 8)}.json`
  return addVote(repo, file, rec, committer ?? who)
}

// ---------------------------------------------------------------------------
// 게이트 / 투표 실행
// ---------------------------------------------------------------------------

/**
 * 게이트를 돌린다.
 *
 * 🔴 CI 변수를 **지우고** 시작한다. 이 테스트를 CI 의 MR 파이프라인 안에서
 *    돌리면 진짜 MR 의 브랜치 이름이 새어 들어와, 로컬에서는 초록인데 CI 에서만
 *    빨간(혹은 그 반대) 테스트가 된다.
 */
function gate(repo, args = [], extraEnv = {}) {
  const env = { ...process.env }
  delete env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME
  delete env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME
  delete env.AXMAP_REMOTE
  // 같은 이유로 정책 자리도 지운다. 돌리는 사람의 셸에 남아 있으면 이 테스트가
  // 재려던 것 대신 그 사람의 환경을 재게 된다.
  delete env.AXMAP_POLICY_PATH
  Object.assign(env, extraEnv)
  return spawnSync(process.execPath, [GATE, ...args], {
    cwd: repo, env, encoding: 'utf8', windowsHide: true,
  })
}

function vote(repo, args = [], extraEnv = {}) {
  const env = { ...process.env }
  delete env.AXMAP_REMOTE
  delete env.AXMAP_POLICY_PATH
  Object.assign(env, extraEnv)
  return spawnSync(process.execPath, [VOTE, ...args], {
    cwd: repo, env, encoding: 'utf8', windowsHide: true,
  })
}

const both = (r) => `${r.stdout}\n${r.stderr}`

// ---------------------------------------------------------------------------

describe('게이트 — 재료 모으기', () => {
  it('소스·타깃을 모르면 추측하지 않고 판정 불가(1)로 멈춘다', () => {
    const { repo } = makeRepo('nobranch')
    const r = gate(repo, [])
    assert.equal(r.status, 1, `종료 코드가 ${r.status} 였다: ${both(r)}`)
    assert.match(r.stderr, /CI_MERGE_REQUEST_SOURCE_BRANCH_NAME/, '무엇을 주면 되는지 안 알려준다')
  })

  it('CI 환경변수로도 돌고, 플래그가 있으면 플래그가 이긴다', () => {
    const { repo } = makeRepo('cienv')
    const viaEnv = gate(repo, [], {
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: BRANCH,
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'main',
    })
    assert.equal(viaEnv.status, 2, `환경변수 경로가 깨졌다: ${both(viaEnv)}`)

    // 환경변수에는 없는 브랜치를 넣어 둔다. 플래그가 이기지 않으면 1(판정 불가)이 난다.
    const viaFlag = gate(repo, ['--source', BRANCH, '--target', 'main'], {
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'no/such/branch',
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'no/such/target',
    })
    assert.equal(viaFlag.status, 2, `플래그가 환경변수를 못 이겼다: ${both(viaFlag)}`)
  })

  it('한글 경로가 든 변경도 그대로 읽는다 (quotepath 로 데인 자리)', () => {
    const { repo } = makeRepo('hangul', {
      featureFiles: { 'src/app.js': 'export const a = 2\n', 'docs/한글-문서.md': '내용\n' },
    })
    const r = gate(repo, ['--source', BRANCH, '--target', 'main', '--json'])
    assert.equal(r.status, 2, both(r))
    const verdict = JSON.parse(r.stdout)
    const paths = verdict.need.perPath.map((e) => e.path)
    assert.ok(
      paths.some((p) => p.includes('한글-문서.md')),
      `한글 경로가 목록에 없다: ${JSON.stringify(paths)}`,
    )
    assert.ok(
      !paths.some((p) => p.startsWith('"')),
      `경로가 따옴표로 감싸여 왔다 (core.quotepath): ${JSON.stringify(paths)}`,
    )
  })
})

describe('게이트 — 정족수', () => {
  it('표가 0장이면 미달(2)이다. 판정 불가(1)가 아니다', () => {
    const { repo } = makeRepo('novotes')
    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(
      r.status, 2,
      `아무도 투표 안 한 것은 고장이 아니라 "아직 아니다" 다. 종료 코드 ${r.status}: ${both(r)}`,
    )
    assert.match(r.stdout, /합의 미달/)
    assert.match(r.stderr, /axmap\/votes 브랜치가 아직 없습니다/, '표 브랜치가 없다는 사실이 안 보인다')
  })

  it('유효한 표가 문턱을 채우면 통과(0)한다 — 이 통제군이 없으면 나머지가 무의미하다', () => {
    const { repo, head } = makeRepo('pass')
    castVote(repo, ALICE, head)
    castVote(repo, BOB, head)
    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 0, `통과해야 하는데 ${r.status} 였다: ${both(r)}`)
    assert.match(r.stdout, /합의 충족/)
  })
})

describe('게이트 — 음성 테스트 (막아야 하는 것이 막히는가)', () => {
  it('🔴 G1 · 자기 표만 있으면 미달(2)이고, 안 센 이유가 보인다', () => {
    // 문턱 1 짜리 정책이라 표 한 장이면 통과해야 정상이다. 그런데 그 한 장이
    // 브랜치를 쓴 사람 자신의 것이므로 안 세진다.
    const { repo, head } = makeRepo('selfvote', {
      policy: basePolicy({ default: { threshold: 1 } }),
      featureAuthor: ALICE,
    })
    castVote(repo, ALICE, head)

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 2, `자기 표가 세졌다 (G1 구멍). 종료 코드 ${r.status}: ${both(r)}`)
    assert.match(r.stdout, /안 센 표/)
    assert.match(r.stdout, /자기 표/, '왜 안 셌는지가 안 보인다')

    // 같은 저장소에서 남의 표 한 장이면 통과한다 — 위 실패가 문턱 탓이 아니라
    // G1 탓임을 못 박는다.
    castVote(repo, BOB, head)
    const ok = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(ok.status, 0, `남의 표 한 장으로는 통과해야 한다: ${both(ok)}`)
  })

  it('🔴 G3 · 표의 sha 가 헤드와 다르면 안 세지고, 사라지지 않고 "안 센 표" 로 보인다', () => {
    const { repo, head, mainHead } = makeRepo('stalesha', {
      policy: basePolicy({ default: { threshold: 1 } }),
    })
    assert.notEqual(mainHead, head)
    // 승인은 했는데 그 뒤로 헤드가 바뀐 상황. 표는 옛 커밋을 가리킨다.
    castVote(repo, ALICE, mainHead)

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 2, `헤드가 바뀐 표가 세졌다 (G3 구멍). 종료 코드 ${r.status}: ${both(r)}`)
    assert.match(r.stdout, /안 센 표/, '만료된 표를 지워버렸다 — 왜 표가 없는지 아무도 못 푼다')
    assert.match(r.stdout, /효력 없음/)
  })

  it('🔴 표의 email 과 그 표를 추가한 커밋의 committer 가 다르면 안 세진다', () => {
    const { repo, head } = makeRepo('forged', {
      policy: basePolicy({ default: { threshold: 1 } }),
    })
    // alice 의 이름으로 적혀 있지만 커밋한 것은 mallory 다.
    castVote(repo, ALICE, head, {}, MALLORY)

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 2, `위조된 표가 세졌다. 종료 코드 ${r.status}: ${both(r)}`)
    assert.match(r.stdout, /위조 의심/, '대조가 돌지 않았거나 이유를 안 보여준다')
  })

  it('🔴 표 파일이 committerEmail 을 스스로 적어도 그 값을 믿지 않는다', () => {
    const { repo, head } = makeRepo('selfreport', {
      policy: basePolicy({ default: { threshold: 1 } }),
    })
    // 파일에는 "내 committer 는 alice 다" 라고 적어 두고, 실제로는 mallory 가 커밋한다.
    castVote(repo, ALICE, head, { committerEmail: ALICE.email }, MALLORY)

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 2, `자기 신고를 그대로 믿었다. 종료 코드 ${r.status}: ${both(r)}`)
    assert.match(r.stdout, /위조 의심/)
  })

  it('🔴 G2 · 소스 브랜치에서 정책을 고쳐 문턱을 낮춰도 판정이 안 바뀐다', () => {
    // 타깃(main)의 정책 : default 2, 개정 3
    // 소스 브랜치의 정책: default 1, 개정 1  ← 이걸로 판정하면 표 한 장에 통과한다
    const lowered = basePolicy({ default: { threshold: 1 }, amendment: { paths: [POLICY_PATH], threshold: 1 } })
    const { repo, head } = makeRepo('g2', {
      featureFiles: {
        'src/app.js': 'export const a = 2\n',
        [POLICY_PATH]: `${JSON.stringify(lowered, null, 2)}\n`,
      },
    })

    // 픽스처가 실제로 문턱을 낮췄는지 먼저 확인한다. 안 낮췄으면 이 테스트는
    // 아무것도 재지 않는다.
    const onDisk = JSON.parse(fs.readFileSync(path.join(repo, ...POLICY_PATH.split('/')), 'utf8'))
    assert.equal(onDisk.default.threshold, 1, '픽스처가 소스의 문턱을 안 낮췄다')

    castVote(repo, ALICE, head)

    const r = gate(repo, ['--source', BRANCH, '--target', 'main', '--json'])
    assert.equal(
      r.status, 2,
      `소스 브랜치의 정책으로 판정했다 (G2 구멍). 정족수를 낮추는 MR 이 자기가 낮춘 규칙으로 통과한다.\n${both(r)}`,
    )
    const verdict = JSON.parse(r.stdout)
    assert.equal(verdict.threshold, 3, `타깃의 개정 문턱(3)이 아니라 ${verdict.threshold} 로 판정했다`)
    assert.equal(verdict.need.source, 'amendment')
    assert.equal(verdict.approvals, 1)
  })

  it('🔴 정책 JSON 이 깨지면 절대 0 이 아니다 (1 이나 4)', () => {
    const { repo } = makeRepo('brokenjson', { policyRaw: '{ "voters": [ \n' })
    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.notEqual(r.status, 0, `깨진 정책으로 통과했다: ${both(r)}`)
    assert.ok([1, 4].includes(r.status), `종료 코드가 ${r.status} 였다: ${both(r)}`)
    assert.match(r.stderr, /정책 JSON/, '무엇이 깨졌는지 안 알려준다')
  })

  it('🔴 정책이 성립하지 않으면 정책 깨짐(4)이다 — 못 세면 통과가 아니다 (G5)', () => {
    // 개정 경로가 정책 파일 자신을 안 덮는다. 그러면 정책을 고치는 변경이
    // 기본 문턱으로 통과하게 되고, 그 순간 이 층은 끝난다.
    const { repo } = makeRepo('badpolicy', {
      policy: basePolicy({ amendment: { paths: ['docs'], threshold: 3 } }),
    })
    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 4, `종료 코드가 ${r.status} 였다: ${both(r)}`)
    assert.match(r.stdout, /amendment-not-self-covering/)
  })

  it('타깃 브랜치에 정책이 없으면 소스의 것으로 대신하지 않고 판정 불가(1)로 멈춘다', () => {
    const { repo } = makeRepo('nopolicy')
    // 정책을 지운 타깃을 만든다. 소스 브랜치에는 그대로 남아 있다.
    g(repo, ['checkout', '-q', 'main'])
    g(repo, ['rm', '-q', '-r', 'governance'])
    commitAs(repo, CAROL, 'drop policy')
    g(repo, ['checkout', '-q', BRANCH])

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 1, `종료 코드가 ${r.status} 였다: ${both(r)}`)
    assert.match(r.stderr, /G2/, '왜 소스의 정책을 안 쓰는지가 안 보인다')
  })
})

describe('게이트 — 정책 파일의 자리', () => {
  it('🔴 정책이 없으면 판정 불가(1)다 — 옛 자리에 있어도 거기로 찾아가지 않는다', () => {
    // axMap 이 자기 저장소로 떨어져 나가면서 정책은 `axmap/governance/` 에서
    // 저장소 루트의 `governance/` 로 옮겨 왔다. 옛 자리를 자동으로 대신 보는
    // 폴백을 넣고 싶은 유혹이 다음 사람에게도 온다. 이 테스트가 그것을 막는다.
    //
    // 🔴 옛 자리에는 **통과하는** 정책을 둔다. 폴백이 생기면 아래 표 한 장으로
    //    종료 코드가 0 이 되어, 이 테스트가 소리를 낸다.
    const lenient = basePolicy({
      default: { threshold: 1 },
      amendment: { paths: [OLD_POLICY_PATH], threshold: 1 },
    })
    const { repo, head } = makeRepo('oldplace', { policyPath: OLD_POLICY_PATH, policy: lenient })
    castVote(repo, ALICE, head)

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(
      r.status, 1,
      `옛 자리의 정책을 찾아가 판정했다 (폴백이 생겼다). 종료 코드 ${r.status}: ${both(r)}`,
    )
    assert.match(r.stderr, /governance\/policy\.json/, '어디를 봤는지 안 알려준다')
    assert.match(r.stderr, /--policy/, '자리를 어떻게 바꾸는지 안 알려준다')
    assert.match(r.stderr, /AXMAP_POLICY_PATH/, '환경변수로도 된다는 사실이 안 보인다')

    // 통제군 — 그 파일 자체는 멀쩡하다. 위의 1 은 "정책이 깨져서" 가 아니라
    // "그 자리를 안 봐서" 다. 이 줄이 없으면 픽스처가 망가져도 테스트가 초록이다.
    const pointed = gate(repo, ['--source', BRANCH, '--target', 'main', '--policy', OLD_POLICY_PATH])
    assert.equal(pointed.status, 0, `자리를 알려줬는데도 못 읽었다: ${both(pointed)}`)
  })

  it('--policy 로 준 자리에서 읽는다', () => {
    const AT = 'ops/consensus.json'
    const { repo, head } = makeRepo('policyflag', {
      policyPath: AT,
      policy: basePolicy({ default: { threshold: 1 }, amendment: { paths: [AT], threshold: 1 } }),
    })
    castVote(repo, ALICE, head)

    // 기본 자리에는 아무것도 없으므로, 플래그가 안 먹으면 1 이 난다.
    const r = gate(repo, ['--source', BRANCH, '--target', 'main', '--policy', AT])
    assert.equal(r.status, 0, `--policy 가 안 먹었다: ${both(r)}`)
    assert.match(r.stderr, new RegExp(AT.replace('/', '\\/')), '어느 파일로 판정했는지가 안 보인다')
  })

  it('AXMAP_POLICY_PATH 로도 읽는다', () => {
    const AT = 'ops/consensus.json'
    const { repo, head } = makeRepo('policyenv', {
      policyPath: AT,
      policy: basePolicy({ default: { threshold: 1 }, amendment: { paths: [AT], threshold: 1 } }),
    })
    castVote(repo, ALICE, head)

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'], { AXMAP_POLICY_PATH: AT })
    assert.equal(r.status, 0, `AXMAP_POLICY_PATH 가 안 먹었다: ${both(r)}`)
  })

  it('🔴 --policy 가 AXMAP_POLICY_PATH 를 이긴다 — 이 저장소의 다른 CLI 와 같은 관례', () => {
    // 두 자리에 문턱이 **다른** 정책을 둔다. 어느 쪽으로 판정했는지가 숫자로 보인다.
    const LOW = 'ops/low.json'
    const HIGH = 'ops/high.json'
    const { repo } = makeRepo('policyprec', {
      policyPath: LOW,
      policy: basePolicy({ default: { threshold: 1 }, amendment: { paths: [LOW], threshold: 1 } }),
      mainFiles: {
        [HIGH]: basePolicy({ default: { threshold: 3 }, amendment: { paths: [HIGH], threshold: 3 } }),
      },
    })

    const envOnly = gate(repo, ['--source', BRANCH, '--target', 'main', '--json'], { AXMAP_POLICY_PATH: LOW })
    assert.equal(envOnly.status, 2, both(envOnly))
    assert.equal(JSON.parse(envOnly.stdout).threshold, 1, `환경변수가 안 먹었다: ${both(envOnly)}`)

    const flagWins = gate(
      repo,
      ['--source', BRANCH, '--target', 'main', '--json', '--policy', HIGH],
      { AXMAP_POLICY_PATH: LOW },
    )
    assert.equal(flagWins.status, 2, both(flagWins))
    assert.equal(
      JSON.parse(flagWins.stdout).threshold, 3,
      `플래그가 환경변수를 못 이겼다 — 환경변수 쪽 문턱(1)으로 판정했다: ${both(flagWins)}`,
    )
  })

  it('🔴 --policy 가 가리키는 자리가 비어 있으면 기본 자리로 흘러내리지 않는다', () => {
    // 기본 자리에는 멀쩡한 정책이 있다. 그런데도 없는 자리를 가리켰으면 멈춰야
    // 한다 — 조용히 다른 파일로 판정하면 "무엇으로 판정했나" 를 아무도 못 푼다.
    const { repo } = makeRepo('policymissing')
    const r = gate(repo, ['--source', BRANCH, '--target', 'main', '--policy', 'ops/nope.json'])
    assert.equal(r.status, 1, `없는 자리를 줬는데 다른 파일로 판정했다: ${both(r)}`)
    assert.match(r.stderr, /ops\/nope\.json/, '어디를 봤는지 안 알려준다')
  })
})

describe('게이트 — 과반(majority) 문턱', () => {
  // 문턱 = floor((작성자를 제외한 유효 투표권자 수) / 2) + 1

  it('명단 3명 · 작성자가 명단 밖이면 문턱은 2다', () => {
    const { repo, head } = makeRepo('maj3', {
      policy: basePolicy({ default: { threshold: 'majority' }, amendment: { paths: [POLICY_PATH], threshold: 'majority' } }),
    })
    castVote(repo, ALICE, head)
    const one = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(one.status, 2, `3명 중 1표로 통과했다 (과반은 2): ${both(one)}`)
    assert.match(one.stdout, /필요 2/)
    assert.match(one.stdout, /과반/, '왜 2표인지가 판정문에 안 보인다')

    castVote(repo, BOB, head)
    const two = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(two.status, 0, `과반 2표를 채웠는데 통과 못 했다: ${both(two)}`)
  })

  it('🔴 명단이 둘일 때 작성자를 빼지 않으면 영원히 막힌다 — 그래서 뺀다', () => {
    // 투표권자 둘, 그중 하나가 이 MR 을 썼다. 작성자를 분모에 남기면 과반이 2 인데
    // 자기 표는 안 세지므로(G1) 나머지 한 명이 다 줘도 1 표뿐이라 **절대 못 채운다.**
    // 작성자를 빼면 분모가 1 이라 과반은 1 이고, 남은 한 명의 표로 통과한다.
    const { repo, head } = makeRepo('maj2', {
      policy: basePolicy({
        voters: [{ id: ALICE.name, email: ALICE.email }, { id: BOB.name, email: BOB.email }],
        default: { threshold: 'majority' },
        amendment: { paths: [POLICY_PATH], threshold: 'majority' },
      }),
      featureAuthor: ALICE,
    })

    const none = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(none.status, 2, both(none))
    assert.match(none.stdout, /필요 1/, `작성자를 분모에서 안 뺐다 — 이 팀은 첫날부터 막힌다:\n${both(none)}`)

    // 작성자 자신의 표는 여전히 안 세진다 (G1 은 예외가 없다).
    castVote(repo, ALICE, head)
    const self = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(self.status, 2, `분모에서 뺐다고 자기 표까지 세면 안 된다: ${both(self)}`)

    castVote(repo, BOB, head)
    const ok = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(ok.status, 0, `남은 한 명의 표로 통과해야 한다: ${both(ok)}`)
  })

  it('배포된 정책 예제가 실제 게이트에서 성립한다', () => {
    const found = readExamplePolicy()
    const real = JSON.parse(found.text)
    const { repo } = makeRepo('realpolicy', { policy: real })
    // 정책이 안 성립하면 4 가 난다. 표가 없으니 2 여야 정상이다.
    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 2, `${found.from} 의 policy.json 이 성립하지 않는다: ${both(r)}`)
  })
})

describe('게이트 — 출력', () => {
  it('--json 은 stdout 에 파싱 가능한 판정을 낸다 (사람이 읽는 쪽은 stderr)', () => {
    const { repo, head } = makeRepo('json')
    castVote(repo, ALICE, head)
    const r = gate(repo, ['--source', BRANCH, '--target', 'main', '--json'])
    assert.equal(r.status, 2, both(r))
    const verdict = JSON.parse(r.stdout)
    assert.equal(verdict.exit, r.status, '판정의 exit 와 실제 종료 코드가 다르다')
    assert.equal(verdict.sha, head)
    assert.equal(verdict.branch, BRANCH)
    assert.match(r.stderr, /합의 미달/, '사람이 읽는 판정문이 어디에도 없다')
  })
})

describe('vote.mjs — 표를 던지는 쪽', () => {
  it('표를 쓰고, 게이트가 그것을 세어 통과시킨다', () => {
    const { repo, head } = makeRepo('votecli', {
      policy: basePolicy({ default: { threshold: 1 } }),
    })
    g(repo, ['config', 'user.name', ALICE.name])
    g(repo, ['config', 'user.email', ALICE.email])

    const v = vote(repo, ['--branch', BRANCH, '--note', '확인함'])
    assert.equal(v.status, 0, `표를 못 던졌다: ${both(v)}`)
    assert.match(v.stdout, new RegExp(`votes/${BRANCH}/${ALICE.name}-${head.slice(0, 8)}\\.json`))

    // 🔴 committerEmail 을 파일에 적지 않아야 한다. 적으면 대조가 자기 신고가 된다.
    const raw = g(repo, ['show', `refs/heads/axmap/votes:votes/${BRANCH}/${ALICE.name}-${head.slice(0, 8)}.json`])
    const rec = JSON.parse(raw)
    assert.equal(rec.committerEmail, undefined, '표 파일이 committerEmail 을 스스로 적었다')
    assert.equal(rec.sha, head, 'sha 를 40자 전체로 안 적었다')
    assert.equal(rec.vote, 'approve', '--vote 를 생략하면 approve 여야 한다')

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 0, `방금 던진 표를 게이트가 못 셌다: ${both(r)}`)
  })

  it('🔴 자기 표는 경고하고 멈춘다. --force 로만 쓰고, 그때도 안 세진다', () => {
    const { repo, head } = makeRepo('voteself', {
      policy: basePolicy({ default: { threshold: 1 } }),
      featureAuthor: ALICE,
    })
    g(repo, ['config', 'user.name', ALICE.name])
    g(repo, ['config', 'user.email', ALICE.email])

    const blocked = vote(repo, ['--branch', BRANCH])
    assert.notEqual(blocked.status, 0, `자기 표를 조용히 썼다: ${both(blocked)}`)
    assert.match(blocked.stderr, /자기 표/)
    assert.equal(
      g(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/axmap/votes'], { allowFail: true }),
      '',
      '멈췄다면서 표 브랜치를 만들어 놨다',
    )

    const forced = vote(repo, ['--branch', BRANCH, '--force'])
    assert.equal(forced.status, 0, `--force 로도 못 썼다: ${both(forced)}`)

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 2, `--force 로 쓴 자기 표가 세졌다: ${both(r)}`)
    assert.match(r.stdout, /자기 표/)
    void head
  })

  // ---------------------------------------------------------------------------
  // 🔴 `self_vote` 는 **쓰는 쪽도 읽어야 한다**
  //
  // 실측 사고 (2026-09-12, 팀 저장소 S15P21E201 의 `common/dev → main`):
  // 정책이 `self_vote: "tip"` 이라 세는 쪽은 **맨 위 커밋 author 한 명만** 뺐는데,
  // 쓰는 쪽(`warnIfSelfVote`)은 정책을 아예 안 보고 **언제나 모든 author** 를 막았다.
  // 그래서 던질 수 있는 사람이 5명인데 2명으로 보였고, 정족수가 2표라 **그 2명이
  // 둘 다 던져야만** 통과하는 상태가 됐다.
  //
  // 더 아픈 것은 정책이 **정확히 그 교착을 피하려고** `"tip"` 으로 바꿔 둔 것이었다는
  // 점이다. 정책은 고쳤는데 도구가 그 정책을 안 읽어서, 고친 줄 알고 지나갈 뻔했다.
  //
  // 아래 셋은 짝이다 — **막아야 할 것이 막히고, 통과해야 할 것이 통과하는지**를
  // 같이 본다. 한쪽만 있으면 "전부 막는" 구현도 통과한다.
  // ---------------------------------------------------------------------------

  /** 기능 브랜치에 커밋을 하나 더 얹어 **옛 author 와 맨 위 author 를 가른다.** */
  const twoAuthorBranch = (name, over) => {
    const made = makeRepo(name, { policy: basePolicy(over), featureAuthor: ALICE })
    writeIn(made.repo, 'src/app.js', 'export const a = 3\n')
    commitAs(made.repo, DAVE, 'tip work')
    return made
  }

  it('🔴 self_vote 가 "tip" 이면 옛 커밋의 author 는 안 막는다 — 세는 쪽이 그 표를 세기 때문이다', () => {
    const { repo } = twoAuthorBranch('votetipold', { self_vote: 'tip', default: { threshold: 1 } })
    // ALICE 는 옛 커밋의 author 지만 **맨 위가 아니다.**
    g(repo, ['config', 'user.name', ALICE.name])
    g(repo, ['config', 'user.email', ALICE.email])

    const v = vote(repo, ['--branch', BRANCH, '--note', '확인함'])
    assert.equal(v.status, 0, `tip 모드인데 옛 커밋 author 를 막았다: ${both(v)}`)

    // 🔴 여기가 핵심이다 — 던질 때 통과한 표가 **셀 때도 세어져야** 한다.
    //    둘이 갈리면 사람은 던졌다고 믿고 아무도 안 세는 표를 기다린다.
    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 0, `던질 땐 통과인데 셀 땐 안 셌다: ${both(r)}`)
  })

  it('🔴 self_vote 가 "tip" 이어도 맨 위 커밋의 author 는 막는다 — 범위를 좁힌 것이지 끈 것이 아니다', () => {
    const { repo } = twoAuthorBranch('votetiptop', { self_vote: 'tip', default: { threshold: 1 } })
    g(repo, ['config', 'user.name', DAVE.name])
    g(repo, ['config', 'user.email', DAVE.email])

    const blocked = vote(repo, ['--branch', BRANCH, '--note', '확인함'])
    assert.notEqual(blocked.status, 0, `맨 위 커밋 author 의 자기 표를 그냥 썼다: ${both(blocked)}`)
    assert.match(blocked.stderr, /자기 표/)
    // 왜 막혔는지에 **어느 모드 때문인지**가 보여야 한다. 안 보이면 같은 혼란이 또 난다.
    assert.match(blocked.stderr, /self_vote = "tip"/, '어느 모드가 막았는지가 안 보인다')
  })

  it('🔴 self_vote 가 "off" 면 아무도 안 막는다 — G1 자체를 끈 것이다', () => {
    // 🔴 **맨 위 커밋 author 를 명단에 넣는다.** 안 넣으면 "투표권자가 아님" 으로
    //    빠져서, off 가 듣는지 안 듣는지와 무관하게 표가 안 세진다 — 그러면 이
    //    시험은 off 를 재는 것이 아니라 명단을 재게 된다.
    const { repo } = twoAuthorBranch('voteoff', {
      self_vote: 'off',
      default: { threshold: 1 },
      voters: [
        { id: ALICE.name, email: ALICE.email },
        { id: BOB.name, email: BOB.email },
        { id: CAROL.name, email: CAROL.email },
        { id: DAVE.name, email: DAVE.email },
      ],
    })
    g(repo, ['config', 'user.name', DAVE.name])
    g(repo, ['config', 'user.email', DAVE.email])

    const v = vote(repo, ['--branch', BRANCH, '--note', '확인함'])
    assert.equal(v.status, 0, `off 인데 막았다: ${both(v)}`)

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 0, `off 인데 그 표를 안 셌다: ${both(r)}`)
  })

  // ---------------------------------------------------------------------------
  // 🔴 쓰는 쪽과 세는 쪽이 **같은 판단**을 하는가
  //
  // 실측 사고 (2026-09-07, 팀 저장소 S15P21E201 의 `front/dev → front/main`):
  // 세는 쪽은 1.2.0 에서 G1 해제를 얻었는데 쓰는 쪽은 그것을 몰라, **세어질 표를
  // "안 세어집니다" 라며 막았다.** 팀은 반나절을 교착이라고 믿었다. 아래 두 테스트가
  // 그 어긋남을 고정한다 — 하나는 해제가 걸리는 경우, 하나는 안 걸리는 경우다.
  // 둘 중 하나만 있으면 "전부 막는" 코드도 "전부 통과시키는" 코드도 초록이 된다.
  // ---------------------------------------------------------------------------

  /** 명단 세 명이 **전원** 소스 브랜치의 author 인 저장소. 던질 수 있는 사람이 0명이다. */
  function makeDeadlockRepo(name) {
    const made = makeRepo(name, { featureAuthor: ALICE }) // default.threshold = 2
    writeIn(made.repo, 'src/b.js', 'export const b = 1\n')
    commitAs(made.repo, BOB, 'bob work')
    writeIn(made.repo, 'src/c.js', 'export const c = 1\n')
    commitAs(made.repo, CAROL, 'carol work')
    return { ...made, head: g(made.repo, ['rev-parse', 'HEAD']) }
  }

  it('🔴 해제가 걸리는 판정에서는 자기 표를 --force 없이 써 주고, 그 표가 실제로 세진다', () => {
    const { repo, head } = makeDeadlockRepo('votewaived')

    // 던질 수 있는 사람이 0명 < 정족수 2 → 세는 쪽이 G1 을 푼다. 쓰는 쪽도 같아야 한다.
    g(repo, ['config', 'user.name', ALICE.name])
    g(repo, ['config', 'user.email', ALICE.email])
    const a = vote(repo, ['--branch', BRANCH, '--note', '정족수와 명단을 안 건드리는 것을 확인했다'])
    assert.equal(a.status, 0, `해제가 걸리는데도 자기 표를 막았다: ${both(a)}`)
    assert.match(a.stderr, /해제/, '왜 그냥 써 줬는지를 안 알려줬다')
    assert.match(
      a.stderr, /유효 투표권자 0명 < 정족수 2/,
      `해제 근거(몇 명 < 정족수 얼마)를 안 찍었다: ${both(a)}`,
    )
    assert.doesNotMatch(a.stderr, /--force 를 붙이세요/, '세어질 표에 --force 를 요구했다')

    g(repo, ['config', 'user.name', BOB.name])
    g(repo, ['config', 'user.email', BOB.email])
    const b = vote(repo, ['--branch', BRANCH, '--note', '바뀐 파일을 전부 읽었고 되돌릴 수 있다'])
    assert.equal(b.status, 0, `두 번째 자기 표도 막혔다: ${both(b)}`)

    // 🔴 진짜 기준은 여기다 — 쓰는 쪽이 통과시킨 표를 **세는 쪽이 실제로 센다.**
    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 0, `쓰는 쪽은 써 줬는데 세는 쪽이 안 셌다: ${both(r)}`)
    assert.match(r.stdout, /해제/, '해제가 조용히 발동했다 — 판정문이 찍어야 한다')
    void head
  })

  it('🔴 해제가 안 걸리면 자기 표는 여전히 --force 를 요구한다', () => {
    // 명단 3명 중 author 는 ALICE 하나뿐 → 던질 수 있는 사람 2명 ≥ 정족수 2.
    // G1 이 만든 교착이 아니므로 해제가 걸리면 안 된다.
    const { repo, head } = makeRepo('votenowaiver', { featureAuthor: ALICE })
    g(repo, ['config', 'user.name', ALICE.name])
    g(repo, ['config', 'user.email', ALICE.email])

    const blocked = vote(repo, ['--branch', BRANCH, '--note', '내가 쓴 것이지만 확인은 했다'])
    assert.notEqual(blocked.status, 0, `해제가 아닌데 자기 표를 그냥 썼다: ${both(blocked)}`)
    assert.match(blocked.stderr, /자기 표라 세지지 않습니다/, both(blocked))
    assert.doesNotMatch(blocked.stderr, /해제/, '해제가 아닌데 해제라고 안내했다')
    assert.equal(
      g(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/axmap/votes'], { allowFail: true }),
      '',
      '멈췄다면서 표 브랜치를 만들어 놨다',
    )

    // --force 는 그대로 남아 있다. 그리고 그렇게 쓴 표는 여전히 안 세진다.
    const forced = vote(repo, ['--branch', BRANCH, '--force', '--note', '내가 쓴 것이지만 확인은 했다'])
    assert.equal(forced.status, 0, `--force 가 사라졌다: ${both(forced)}`)
    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 2, `해제가 아닌데 자기 표가 세졌다: ${both(r)}`)
    void head
  })

  it('email 이 없으면 던지지 않는다 — 표의 유일 키가 email 이다', () => {
    const { repo } = makeRepo('noemail')
    g(repo, ['config', '--unset', 'user.email'], { allowFail: true })
    // 전역 설정이 있으면 저장소 설정만 지워도 남는다. 그때는 이 테스트를 건너뛴다
    // (조건을 못 만들었는데 통과했다고 적으면 그게 더 나쁜 기준이 된다).
    const still = g(repo, ['config', 'user.email'], { allowFail: true })
    if (still) return

    const v = vote(repo, ['--branch', BRANCH])
    assert.notEqual(v.status, 0, `email 없이 표를 썼다: ${both(v)}`)
    assert.match(v.stderr, /email/)
  })

  it('명단을 찾는 자리도 --policy → AXMAP_POLICY_PATH → 기본값 순서다', () => {
    // 보이는 효과: `voter` 칸은 **정책 명단이 정한다.** 명단을 못 읽으면
    // `git config user.name` 이 그대로 남으므로, 파일 이름만 봐도 어느 정책을
    // 읽었는지 알 수 있다. 게이트와 순서가 갈리면 게이트가 보는 정책과 여기서
    // 보는 명단이 서로 다른 파일이 된다.
    const AT = 'ops/consensus.json'
    const OFFICIAL = 'alice-official'
    const { repo, head } = makeRepo('voterpolicy', {
      policyPath: AT,
      policy: basePolicy({
        voters: [
          { id: OFFICIAL, email: ALICE.email },
          { id: BOB.name, email: BOB.email },
          { id: CAROL.name, email: CAROL.email },
        ],
        amendment: { paths: [AT], threshold: 3 },
      }),
    })
    g(repo, ['config', 'user.name', ALICE.name])
    g(repo, ['config', 'user.email', ALICE.email])
    const sha8 = head.slice(0, 8)

    // 기본 자리에는 정책이 없다 → 명단을 못 읽으니 이름을 못 고친다.
    const plain = vote(repo, ['--branch', BRANCH])
    assert.equal(plain.status, 0, both(plain))
    assert.match(plain.stdout, new RegExp(`${ALICE.name}-${sha8}\\.json`), both(plain))

    const viaFlag = vote(repo, ['--branch', BRANCH, '--policy', AT])
    assert.equal(viaFlag.status, 0, both(viaFlag))
    assert.match(viaFlag.stdout, new RegExp(`${OFFICIAL}-${sha8}\\.json`), `--policy 가 안 먹었다: ${both(viaFlag)}`)

    const viaEnv = vote(repo, ['--branch', BRANCH], { AXMAP_POLICY_PATH: AT })
    assert.match(viaEnv.stdout, new RegExp(`${OFFICIAL}-${sha8}\\.json`), `AXMAP_POLICY_PATH 가 안 먹었다: ${both(viaEnv)}`)

    // 🔴 플래그가 이긴다 — 없는 자리를 가리키면 환경변수 쪽으로 흘러내리지 않는다.
    const flagWins = vote(repo, ['--branch', BRANCH, '--policy', 'ops/nope.json'], { AXMAP_POLICY_PATH: AT })
    assert.match(
      flagWins.stdout, new RegExp(`${ALICE.name}-${sha8}\\.json`),
      `플래그가 환경변수를 못 이겼다: ${both(flagWins)}`,
    )
  })

  it('reject 는 세지 않지만 판정문에는 보인다', () => {
    const { repo, head } = makeRepo('rejectvote', {
      policy: basePolicy({ default: { threshold: 1 } }),
    })
    castVote(repo, ALICE, head, { vote: 'reject' })
    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 2, `반대표가 찬성으로 세졌다: ${both(r)}`)
    assert.match(r.stdout, /반대/, '반대표가 판정문에서 사라졌다 — 사람이 읽어야 한다')
  })
})

// ---------------------------------------------------------------------------
// 표에 이유를 남기게 하는 구조 — `vote_note` 와 `agent.shown`
//
// 🔴 강제는 **두 곳**에서 한다.
//    쓰는 쪽(`vote.mjs`)의 거부는 **친절함**이다 — 던지기 전에 알려준다.
//    세는 쪽(`src/governance.mjs`)의 무효 처리가 **진짜 문**이다 — CI 에서 돌고,
//    `git pull` 을 안 한 사람의 옛 vote.mjs 도 여기는 못 지나간다.
//    아래에 둘 다 있고, "쓰는 쪽을 건너뛴" 경우를 재는 음성 테스트가 따로 있다.
// ---------------------------------------------------------------------------

describe('vote_note — 이유 없는 표는 쓰지도 세지도 않는다', () => {
  /** 이유를 요구하는 정책. 시행일은 이미 지났다. */
  const strict = (over = {}) => basePolicy({
    default: { threshold: 1 },
    vote_note: { min_chars: 20, since: '2026-01-01' },
    ...over,
  })

  /** 스무 글자가 넘는 진짜 이유. */
  const REASON = '정족수와 투표권자 명단을 안 건드리는 것을 확인했다.'

  /** 표를 던지는 사람으로 이 저장소를 맞춘다. 기능 브랜치는 DAVE 가 썼다 (G1 회피). */
  function asAlice(repo) {
    g(repo, ['config', 'user.name', ALICE.name])
    g(repo, ['config', 'user.email', ALICE.email])
  }

  /** 방금 쓰인 표 파일을 읽는다. */
  function written(repo, who, sha) {
    return JSON.parse(g(repo, ['show', `refs/heads/axmap/votes:votes/${BRANCH}/${who.name}-${sha.slice(0, 8)}.json`]))
  }

  const noVotesBranch = (repo) =>
    g(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/axmap/votes'], { allowFail: true }) === ''

  // ── 쓰는 쪽 ────────────────────────────────────────────────────────────

  it('🔴 --note 없이는 쓰지 않는다 (종료 코드 ≠ 0, 표 브랜치도 안 생긴다)', () => {
    const { repo } = makeRepo('votenote-missing', { policy: strict() })
    asAlice(repo)

    const v = vote(repo, ['--branch', BRANCH])
    assert.notEqual(v.status, 0, `이유 없는 표를 조용히 썼다: ${both(v)}`)
    assert.match(v.stderr, /이유/, `왜 거부됐는지를 안 말했다: ${both(v)}`)
    assert.ok(noVotesBranch(repo), '거부했다면서 표 브랜치를 만들어 놨다')
  })

  it('🔴 min_chars 미만이면 거부한다 — "확인함" 은 이유가 아니라 서명이다', () => {
    const { repo } = makeRepo('votenote-short', { policy: strict() })
    asAlice(repo)

    const v = vote(repo, ['--branch', BRANCH, '--note', '확인함'])
    assert.notEqual(v.status, 0, `세 글자짜리 서명을 이유로 받았다: ${both(v)}`)
    assert.match(v.stderr, /3자.*20자/, `몇 글자가 모자란지를 안 알려줬다: ${both(v)}`)
    assert.ok(noVotesBranch(repo))
  })

  it('🔴 --force 로는 못 넘긴다 — --force 는 자기 표(G1) 경고 전용이다', () => {
    const { repo } = makeRepo('votenote-force', { policy: strict() })
    asAlice(repo)

    const v = vote(repo, ['--branch', BRANCH, '--force'])
    assert.notEqual(v.status, 0, `--force 가 이유 요구까지 뚫었다: ${both(v)}`)
    assert.ok(noVotesBranch(repo))
  })

  it('🔴 reject 에도 이유를 요구한다 — 반대야말로 이유가 필요하다', () => {
    const { repo, head } = makeRepo('votenote-reject', { policy: strict() })
    asAlice(repo)

    const blocked = vote(repo, ['--branch', BRANCH, '--vote', 'reject'])
    assert.notEqual(blocked.status, 0, `이유 없는 반대를 그냥 받았다: ${both(blocked)}`)
    assert.ok(noVotesBranch(repo))

    const ok = vote(repo, ['--branch', BRANCH, '--vote', 'reject', '--note', REASON])
    assert.equal(ok.status, 0, both(ok))
    assert.equal(written(repo, ALICE, head).vote, 'reject')
  })

  it('이유가 충분하면 쓰이고, 게이트가 그것을 세어 통과시킨다', () => {
    const { repo, head } = makeRepo('votenote-ok', { policy: strict() })
    asAlice(repo)

    const v = vote(repo, ['--branch', BRANCH, '--note', REASON])
    assert.equal(v.status, 0, `이유를 적었는데 못 던졌다: ${both(v)}`)
    assert.equal(written(repo, ALICE, head).note, REASON, '이유가 표에 안 적혔다')

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 0, `이유 있는 표를 게이트가 못 셌다: ${both(r)}`)
  })

  it('🔴 vote_note 가 없는 정책에서는 아무것도 요구하지 않는다 — 옛 저장소의 동작 그대로', () => {
    // 이 불변식이 깨지면 axMap 을 올리는 것만으로 남의 저장소가 멈춘다.
    const { repo } = makeRepo('votenote-absent', { policy: basePolicy({ default: { threshold: 1 } }) })
    asAlice(repo)

    const v = vote(repo, ['--branch', BRANCH])
    assert.equal(v.status, 0, `vote_note 가 없는데 이유를 요구했다: ${both(v)}`)
  })

  it('🔴 시행일 이전이면 쓰는 쪽도 요구하지 않는다 (소급 금지)', () => {
    const { repo } = makeRepo('votenote-notyet', {
      policy: strict({ vote_note: { min_chars: 20, since: '2099-01-01' } }),
    })
    asAlice(repo)

    const v = vote(repo, ['--branch', BRANCH])
    assert.equal(v.status, 0, `시행 전인데 이유를 요구했다: ${both(v)}`)
  })

  // ── 세는 쪽 — 진짜 문 ──────────────────────────────────────────────────

  it('🔴 쓰는 쪽을 건너뛴 표도 안 세진다 — 옛 vote.mjs 는 이 규칙을 모른다', () => {
    // `castVote` 는 vote.mjs 를 안 거치고 표 파일을 직접 심는다. 즉 `git pull` 을
    // 안 한 팀원의 옛 vote.mjs 가 쓴 표와 같은 모양이다. 쓰는 쪽에만 규칙을
    // 두었다면 이 표가 그대로 통과한다.
    const { repo, head } = makeRepo('votenote-bypass', { policy: strict() })
    castVote(repo, ALICE, head)

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 2, `이유 없는 표가 세져서 통과했다: ${both(r)}`)
    assert.match(r.stdout, /이유\(note\)/, `왜 안 셌는지가 판정문에 없다: ${both(r)}`)
  })

  it('🔴 시행일 이전에 던져진 표는 세는 쪽에서도 그대로 유효하다 (소급 금지)', () => {
    // 규칙을 고치는 사람이 남의 지난 표를 지울 수 있으면 그건 규칙이 아니다.
    const { repo, head } = makeRepo('votenote-grandfather', {
      policy: strict({ vote_note: { min_chars: 20, since: '2099-01-01' } }),
    })
    castVote(repo, ALICE, head) // 이유 없는 표. at 은 지금 = 시행일 이전

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 0, `시행일 이전의 표를 소급해서 무효로 만들었다: ${both(r)}`)
  })

  it('짧은 이유는 세는 쪽에서도 무효다', () => {
    const { repo, head } = makeRepo('votenote-shortcount', { policy: strict() })
    castVote(repo, ALICE, head, { note: '내용 확인함' })

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 2, `짧은 이유가 세졌다: ${both(r)}`)
    assert.match(r.stdout, /짧/, both(r))
  })
})

describe('agent.shown — 던질 때 실제로 보였던 것은 프로그램이 잰다', () => {
  const REASON = '변경 내용을 전부 읽었고 정족수 계산에 영향이 없음을 확인했다.'

  function asAlice(repo) {
    g(repo, ['config', 'user.name', ALICE.name])
    g(repo, ['config', 'user.email', ALICE.email])
  }

  function written(repo, sha) {
    return JSON.parse(g(repo, ['show', `refs/heads/axmap/votes:votes/${BRANCH}/${ALICE.name}-${sha.slice(0, 8)}.json`]))
  }

  /** 두 파일이 바뀌는 기능 브랜치. 한 파일짜리면 숫자가 우연히 맞을 수 있다. */
  const TWO_FILES = {
    'src/app.js': 'export const a = 2\n',
    'src/new.js': 'export const b = 1\nexport const c = 2\n',
  }

  it('🔴 --agent 가 없어도 shown 은 채워진다. id 는 "none" 이다', () => {
    const { repo, head } = makeRepo('shown-noagent', {
      policy: basePolicy({ default: { threshold: 1 } }),
      featureFiles: TWO_FILES,
    })
    asAlice(repo)

    const v = vote(repo, ['--branch', BRANCH, '--note', REASON])
    assert.equal(v.status, 0, both(v))

    const rec = written(repo, head)
    assert.equal(rec.agent.id, 'none', '--agent 를 안 줬는데 다른 값이 들어갔다')
    assert.equal(rec.agent.summary, undefined, '안 준 요약을 지어냈다')
    assert.ok(rec.agent.shown, 'shown 이 아예 없다 — 이건 플래그가 아니라 측정이다')
    assert.equal(typeof rec.agent.shown.files, 'number')
    assert.equal(typeof rec.agent.shown.gate, 'string')
  })

  it('--agent · --agent-summary 는 그대로 적힌다. 값 없이 주면 거부한다', () => {
    const { repo, head } = makeRepo('shown-agent', {
      policy: basePolicy({ default: { threshold: 1 } }),
    })
    asAlice(repo)

    const v = vote(repo, [
      '--branch', BRANCH, '--note', REASON,
      '--agent', 'claude-opus-5',
      '--agent-summary', 'src/app.js 한 줄만 바뀐다. 정족수·명단 불변.',
    ])
    assert.equal(v.status, 0, both(v))

    const rec = written(repo, head)
    assert.equal(rec.agent.id, 'claude-opus-5')
    assert.match(rec.agent.summary, /정족수/)

    // 🔴 이름을 주려다 실패한 것과 안 준 것은 다른 일이다. 조용히 "none" 으로
    //    떨어뜨리면 "AI 가 안 도왔다" 는 거짓말이 표에 남는다.
    const bare = vote(repo, ['--branch', BRANCH, '--note', REASON, '--agent'])
    assert.notEqual(bare.status, 0, `값 없는 --agent 를 조용히 삼켰다: ${both(bare)}`)
  })

  it('🔴 shown 의 숫자가 실제 git diff --numstat 과 같다 — 자기 신고가 아니다', () => {
    const { repo, head } = makeRepo('shown-numstat', {
      policy: basePolicy({ default: { threshold: 1 } }),
      featureFiles: TWO_FILES,
    })
    asAlice(repo)
    assert.equal(vote(repo, ['--branch', BRANCH, '--note', REASON]).status, 0)

    // 기대값을 손으로 적지 않는다. 손으로 적으면 픽스처를 바꾼 날 이 테스트가
    // 재려던 것 대신 낡은 숫자를 재게 된다.
    const rows = g(repo, ['diff', '--numstat', `main...${BRANCH}`])
      .split('\n').filter(Boolean).map((l) => l.split('\t'))
    const expected = {
      files: rows.length,
      insertions: rows.reduce((s, r) => s + Number(r[0]), 0),
      deletions: rows.reduce((s, r) => s + Number(r[1]), 0),
      paths: rows.map((r) => r[2]).sort(),
    }
    assert.ok(expected.files >= 2, '픽스처가 한 파일뿐이라 이 테스트가 약해졌다')

    const shown = written(repo, head).agent.shown
    assert.equal(shown.files, expected.files, '파일 수가 실제 diff 와 다르다')
    assert.equal(shown.insertions, expected.insertions, '더한 줄 수가 실제 diff 와 다르다')
    assert.equal(shown.deletions, expected.deletions, '지운 줄 수가 실제 diff 와 다르다')
    assert.deepEqual([...shown.paths].sort(), expected.paths, '경로 목록이 실제 diff 와 다르다')
  })

  it('shown.gate 는 던지기 **직전**의 판정이다 — 이 표는 아직 안 세어져 있다', () => {
    const { repo, head } = makeRepo('shown-gate', {
      policy: basePolicy({ default: { threshold: 1 } }),
    })
    asAlice(repo)
    assert.equal(vote(repo, ['--branch', BRANCH, '--note', REASON]).status, 0)

    // 표가 하나도 없던 시점의 판정. 0/1 이 아니라 1/1 이면 자기 표를 세고 있다.
    assert.equal(written(repo, head).agent.shown.gate, '미달 0/1')

    // 그리고 지금은 통과한다 — 같은 저장소, 같은 커밋, 표 하나 차이.
    assert.equal(gate(repo, ['--source', BRANCH, '--target', 'main']).status, 0)
  })

  it('사본 출처(SOURCE.json)가 없으면 axmap 은 둘 다 null 이다 — 지어내지 않는다', () => {
    const { repo, head } = makeRepo('shown-nosource', {
      policy: basePolicy({ default: { threshold: 1 } }),
    })
    asAlice(repo)
    assert.equal(vote(repo, ['--branch', BRANCH, '--note', REASON]).status, 0)

    assert.deepEqual(written(repo, head).agent.shown.axmap, { commit: null, behind: null })
  })

  it('🔴 원격에 못 닿아도 표는 던져진다 — behind 만 null 이다', () => {
    // axMap 이 잠깐 죽거나 접근 권한이 만료된 날 팀의 투표가 멈추면 안 된다.
    // 사본(벤더링)을 두는 이유와 정확히 같은 이유다.
    const FAKE = '6d9fe68050baed93b06b7c563b15ac638defd65e'
    const { repo, head } = makeRepo('shown-unreachable', {
      policy: basePolicy({ default: { threshold: 1 } }),
      mainFiles: {
        'ci/axmap/SOURCE.json': {
          source: {
            repository: '/axmap-저장소가-여기-없다.git',
            commit: FAKE,
            branch: 'team-sync',
          },
        },
      },
    })
    asAlice(repo)

    const v = vote(repo, ['--branch', BRANCH, '--note', REASON])
    assert.equal(v.status, 0, `원격에 못 닿는다고 표를 못 던졌다: ${both(v)}`)

    const axmap = written(repo, head).agent.shown.axmap
    assert.equal(axmap.commit, FAKE, '사본 출처를 못 읽었다')
    assert.equal(axmap.behind, null, '못 쟀는데 숫자를 지어냈다')
  })

  it('🔴 게이트가 이 표를 깨진 것으로 보지 않는다 — agent 칸은 판정에 안 쓰인다', () => {
    // 새 필드가 늘 때마다 옛 게이트가 표를 깨진 것으로 보면 사본을 못 올린다.
    const { repo } = makeRepo('shown-compat', {
      policy: basePolicy({ default: { threshold: 1 } }),
    })
    asAlice(repo)
    assert.equal(vote(repo, ['--branch', BRANCH, '--note', REASON, '--agent', 'claude-opus-5']).status, 0)

    const r = gate(repo, ['--source', BRANCH, '--target', 'main'])
    assert.equal(r.status, 0, `agent 칸이 붙은 표를 못 셌다: ${both(r)}`)
  })
})
