import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkOverlap,
  coversPath,
  normalizePath,
  pathsOverlap,
  activeClaims,
  myActiveClaim,
  agentNameError,
  claimPathError,
  checkMerge,
  requiredApprovals,
  voteError,
  formatMerge,
  DEFAULT_MERGE_POLICY,
} from '../src/protocol.mjs'
import { gatePrecedenceViolations } from '../src/invariants.mjs'

const NOW = Date.parse('2026-08-15T09:10:00.000Z')
const MIN = 60_000

const claim = (agent, paths, opts = {}) => ({
  agent,
  task: opts.task ?? `task-${agent}`,
  intent: opts.intent ?? null,
  since: opts.since ?? '2026-08-15T09:00:00.000Z',
  ttlMs: opts.ttlMs ?? 30 * MIN,
  paths,
})

// ---------------------------------------------------------------------------
// docs/EXPERIMENT.md 의 3개 케이스를 그대로 옮긴 것.
// git 의 줄 단위 판정은 Case 1 과 Case 2 에 서로 다른 답을 냈다. 입력이 같은데도.
// 파서 판정은 같은 답을 내야 한다. 이게 이 프로젝트가 파서를 고른 이유 전체다.
// ---------------------------------------------------------------------------

test('Case 1 - 서로 다른 경로, 장부가 비어 있음 -> 통과 (git 은 여기서 오탐했다)', () => {
  const claims = [claim('agent-a', ['src/auth/login.ts'])]
  const r = checkOverlap({ requested: ['src/user/profile.ts'], claims, me: 'agent-b', now: NOW })
  assert.equal(r.ok, true)
})

test('Case 2 - 서로 다른 경로, 장부에 제3자 항목이 있음 -> 통과', () => {
  const claims = [
    claim('agent-a', ['src/auth/login.ts']),
    claim('agent-c', ['src/core/config.ts']),
  ]
  const r = checkOverlap({ requested: ['src/user/profile.ts'], claims, me: 'agent-b', now: NOW })
  assert.equal(r.ok, true)
})

test('Case 1 과 Case 2 는 반드시 같은 답이어야 한다 - 무관한 제3자가 결과를 바꾸면 안 된다', () => {
  const requested = ['src/user/profile.ts']
  const sparse = [claim('agent-a', ['src/auth/login.ts'])]
  const dense = [...sparse, claim('agent-c', ['src/core/config.ts'])]
  const a = checkOverlap({ requested, claims: sparse, me: 'agent-b', now: NOW })
  const b = checkOverlap({ requested, claims: dense, me: 'agent-b', now: NOW })
  assert.deepEqual(a.ok, b.ok)
})

test('Case 3 - 같은 경로 -> 거부하고, 누가 왜 막았는지 말한다', () => {
  const claims = [claim('agent-a', ['src/auth/login.ts'], { task: 'task-12' })]
  const r = checkOverlap({ requested: ['src/auth/login.ts'], claims, me: 'agent-b', now: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.blocks.length, 1)
  assert.equal(r.blocks[0].holder, 'agent-a')
  assert.equal(r.blocks[0].task, 'task-12')
})

// ---------------------------------------------------------------------------
// 경로 판정의 함정들
// ---------------------------------------------------------------------------

test('디렉터리 claim 은 그 아래 파일을 덮는다', () => {
  const claims = [claim('agent-a', ['src/auth'])]
  const r = checkOverlap({ requested: ['src/auth/login.ts'], claims, me: 'agent-b', now: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.blocks[0].held, 'src/auth')
})

test('반대 방향도 막는다 - 파일이 잡힌 상태에서 상위 디렉터리 claim', () => {
  const claims = [claim('agent-a', ['src/auth/login.ts'])]
  const r = checkOverlap({ requested: ['src/auth'], claims, me: 'agent-b', now: NOW })
  assert.equal(r.ok, false)
})

test('단순 문자열 prefix 는 겹침이 아니다 - src/auth 가 src/authz 를 잡아먹으면 안 된다', () => {
  assert.equal(pathsOverlap('src/auth', 'src/authz'), false)
  const claims = [claim('agent-a', ['src/auth'])]
  const r = checkOverlap({ requested: ['src/authz/policy.ts'], claims, me: 'agent-b', now: NOW })
  assert.equal(r.ok, true)
})

test('윈도우 역슬래시와 ./ 접두사를 같은 경로로 본다', () => {
  assert.equal(normalizePath('.\\src\\auth\\login.ts'), 'src/auth/login.ts')
  const claims = [claim('agent-a', ['src/auth/login.ts'])]
  const r = checkOverlap({ requested: ['.\\src\\auth\\login.ts'], claims, me: 'agent-b', now: NOW })
  assert.equal(r.ok, false)
})

// ---------------------------------------------------------------------------
// TTL - 죽은 에이전트의 유령 락
// ---------------------------------------------------------------------------

test('만료된 claim 은 아무것도 막지 못한다', () => {
  const dead = claim('agent-a', ['src/auth/login.ts'], {
    since: '2026-08-15T08:00:00.000Z', // 08:30 만료, 지금은 09:10
    ttlMs: 30 * MIN,
  })
  const r = checkOverlap({ requested: ['src/auth/login.ts'], claims: [dead], me: 'agent-b', now: NOW })
  assert.equal(r.ok, true)
})

test('만료 직전 1분 전에는 여전히 막는다', () => {
  const live = claim('agent-a', ['src/auth/login.ts'])
  const justBefore = Date.parse('2026-08-15T09:29:00.000Z')
  const r = checkOverlap({ requested: ['src/auth/login.ts'], claims: [live], me: 'agent-b', now: justBefore })
  assert.equal(r.ok, false)
})

test('activeClaims 는 만료된 것을 걸러낸다', () => {
  const claims = [
    claim('agent-a', ['a'], { since: '2026-08-15T08:00:00.000Z' }),
    claim('agent-b', ['b']),
  ]
  assert.deepEqual(activeClaims(claims, NOW).map((c) => c.agent), ['agent-b'])
})

// ---------------------------------------------------------------------------
// 자기 자신
// ---------------------------------------------------------------------------

test('내 claim 은 나를 막지 않는다 - 작업 도중 경로를 추가할 수 있어야 한다', () => {
  const claims = [claim('agent-a', ['src/auth/login.ts'])]
  const r = checkOverlap({
    requested: ['src/auth/login.ts', 'src/auth/token.ts'],
    claims,
    me: 'agent-a',
    now: NOW,
  })
  assert.equal(r.ok, true)
})

// ---------------------------------------------------------------------------
// pre-commit 검사 (claim 없이 몰래 고치는 것 차단)
// ---------------------------------------------------------------------------

test('coversPath - claim 한 디렉터리 아래 파일은 커밋 가능', () => {
  assert.equal(coversPath(['src/auth'], 'src/auth/login.ts'), true)
  assert.equal(coversPath(['src/auth/login.ts'], 'src/auth/login.ts'), true)
})

test('coversPath - claim 하지 않은 파일은 차단', () => {
  assert.equal(coversPath(['src/auth'], 'src/user/profile.ts'), false)
  assert.equal(coversPath(['src/auth'], 'src/authz/policy.ts'), false)
})

test('coversPath - claim 이 하나도 없으면 전부 차단', () => {
  assert.equal(coversPath([], 'src/auth/login.ts'), false)
})

// ---------------------------------------------------------------------------
// fail-open 방어
//
// 락 시스템에서 최악의 실패는 거부해야 할 것을 조용히 통과시키는 것이다.
// 아래 테스트들은 전부 실제로 발견된 버그를 고정한 것이다.
// ---------------------------------------------------------------------------

test('만료된 내 claim 은 다음 claim 에 합쳐지지 않는다 - 부활 방지', () => {
  // 1. 내가 src/foo 를 잡았다가 만료됐다
  const expiredMine = claim('agent-a', ['src/foo'], { since: '2026-08-15T08:00:00.000Z' })
  // 2. agent-b 가 정당하게 src/foo 를 가져갔다
  const theirs = claim('agent-b', ['src/foo'])
  // 3. 내가 이제 src/bar 를 claim 한다
  const prev = myActiveClaim([expiredMine, theirs], 'agent-a', NOW)

  // 만료된 내 레코드는 합칠 대상이 아니다.
  // 합쳐졌다면 src/foo 가 검사 없이 부활해 agent-b 와 동시 소유가 된다.
  assert.equal(prev, null)
})

test('만료되지 않은 내 claim 은 정상적으로 합쳐진다', () => {
  const mine = claim('agent-a', ['src/foo'])
  const prev = myActiveClaim([mine], 'agent-a', NOW)
  assert.deepEqual(prev.paths, ['src/foo'])
})

test('에이전트 이름은 치환하지 않고 거부한다 - 파일명 충돌 방지', () => {
  // "agent/a" 와 "agent_a" 를 둘 다 agent_a.json 으로 치환하면
  // 서로의 claim 을 덮어써 소유권이 조용히 사라진다.
  assert.ok(agentNameError('agent/a'))
  assert.ok(agentNameError('../etc/passwd'))
  assert.ok(agentNameError('a\\b'))
  assert.ok(agentNameError('a:b'))
  assert.ok(agentNameError(''))
  assert.ok(agentNameError('a'.repeat(65)))
  assert.ok(agentNameError(' x'), '앞뒤 공백은 파일명에서 사라져 다른 이름과 겹칠 수 있다')
  assert.equal(agentNameError('agent-a'), null)
  assert.equal(agentNameError('claude_1.2'), null)
})

test('한글 등 유니코드 이름을 허용한다', () => {
  // 파일 경로를 깨뜨리는 문자만 막는다. 한글까지 막으면 한국 팀이 자기 이름을 못 쓴다.
  assert.equal(agentNameError('나'), null)
  assert.equal(agentNameError('장효준'), null)
  assert.equal(agentNameError('田中'), null)
  assert.equal(agentNameError('백그라운드-1'), null)
})

test('저장소 밖이나 절대 경로는 claim 할 수 없다', () => {
  assert.ok(claimPathError('/etc/passwd'))
  assert.ok(claimPathError('C:/Windows/System32'))
  assert.ok(claimPathError('../other-repo/src'))
  assert.ok(claimPathError('src/../../escape'))
  assert.ok(claimPathError(''))
  assert.equal(claimPathError('src/auth/login.ts'), null)
  assert.equal(claimPathError('./src/auth/'), null)
})

test('저장소 루트 전체는 claim 할 수 없다', () => {
  assert.ok(claimPathError('.'))
  assert.ok(claimPathError('/'))
})

// ---------------------------------------------------------------------------
// 병합 합의 (SPEC 7-3 · INVARIANTS I8)
//
// 게이트는 거부권이고 표는 판단이다. 이 둘을 한 다수결에 섞지 않는 것이
// 이 묶음이 지키는 성질 전부다.
// ---------------------------------------------------------------------------

const GREEN = Object.fromEntries(DEFAULT_MERGE_POLICY.requiredGates.map((g) => [g, { ok: true }]))
const HEAD = '9f3c1a2'

const proposal = (paths, opts = {}) => ({
  id: opts.id ?? 'p-1',
  agent: opts.agent ?? 'agent-a',
  head: opts.head ?? HEAD,
  paths,
})

const vote = (voter, verdict, opts = {}) => ({
  voter,
  verdict,
  head: opts.head ?? HEAD,
  lens: opts.lens ?? null,
  reason: opts.reason ?? null,
})

test('게이트가 빨가면 찬성표가 아무리 많아도 막힌다 - I8', () => {
  const votes = ['b', 'c', 'd', 'e', 'f'].map((n) => vote(`agent-${n}`, 'approve'))
  const r = checkMerge({
    proposal: proposal(['src/protocol.mjs']),
    votes,
    gates: { ...GREEN, test: { ok: false, detail: '3 failing' } },
  })
  assert.equal(r.ok, false)
  assert.ok(r.blocks.some((b) => b.kind === 'gate' && b.gate === 'test'))
  // 표를 아예 세지 않는다. 세기 시작하면 "5 대 0 인데" 라는 질문이 생긴다.
  assert.deepEqual(r.approvals, [])
})

test('안 돌린 게이트는 통과가 아니다 - fail-closed', () => {
  const r = checkMerge({ proposal: proposal(['src/service.mjs']), votes: [vote('agent-b', 'approve')], gates: {} })
  assert.equal(r.ok, false)
  assert.equal(
    r.blocks.filter((b) => b.kind === 'missing-gate').length,
    DEFAULT_MERGE_POLICY.requiredGates.length,
  )
})

test('head 가 바뀌면 표가 리셋된다 - 고친 코드는 다시 봐야 한다', () => {
  const old = ['b', 'c', 'd'].map((n) => vote(`agent-${n}`, 'approve', { head: 'aaaaaaa' }))
  const r = checkMerge({ proposal: proposal(['src/protocol.mjs'], { head: 'bbbbbbb' }), votes: old, gates: GREEN })
  assert.equal(r.ok, false)
  assert.ok(r.blocks.some((b) => b.kind === 'quorum' && b.have === 0 && b.need === 3))
})

test('반대표 하나가 정족수를 이긴다 - 발견은 다수결의 대상이 아니다', () => {
  const votes = [
    ...['b', 'c', 'd'].map((n) => vote(`agent-${n}`, 'approve')),
    vote('agent-e', 'reject', { reason: 'I6 을 깨뜨린다' }),
  ]
  const r = checkMerge({ proposal: proposal(['src/protocol.mjs']), votes, gates: GREEN })
  assert.equal(r.ok, false)
  assert.equal(r.approvals.length, 3, '찬성 3표는 정족수를 채웠는데도')
  assert.ok(r.blocks.some((b) => b.kind === 'reject' && b.voter === 'agent-e'))
})

test('자기 표는 세지 않는다 - 시빌의 가장 싼 형태', () => {
  const mine = checkMerge({
    proposal: proposal(['src/service.mjs'], { agent: 'agent-a' }),
    votes: [vote('agent-a', 'approve')],
    gates: GREEN,
  })
  assert.equal(mine.ok, false)
  assert.ok(mine.blocks.some((b) => b.kind === 'quorum' && b.have === 0))

  const other = checkMerge({
    proposal: proposal(['src/service.mjs'], { agent: 'agent-a' }),
    votes: [vote('agent-a', 'approve'), vote('agent-b', 'approve')],
    gates: GREEN,
  })
  assert.equal(other.ok, true)
  assert.deepEqual(other.approvals, ['agent-b'])
})

test('정족수는 고정값이 아니라 위험 등급별이다', () => {
  assert.equal(requiredApprovals(['src/protocol.mjs']), 3, '심장부')
  assert.equal(requiredApprovals(['src/service.mjs']), 1, '보통')
  assert.equal(requiredApprovals(['docs/INSTALL.md']), 0, '문서는 게이트만')
})

test('여러 등급에 걸치면 가장 높은 쪽을 따른다', () => {
  // docs/ 는 0 이지만 docs/SPEC.md 는 3 이다. 규격이 코드보다 먼저이므로.
  assert.equal(requiredApprovals(['docs/SPEC.md']), 3)
  assert.equal(requiredApprovals(['docs/INSTALL.md', 'src/protocol.mjs']), 3)
})

test('빈 제안을 0표로 통과시키지 않는다', () => {
  // 등급을 알 수 없는 것은 "위험하지 않다" 가 아니다.
  assert.equal(requiredApprovals([]), DEFAULT_MERGE_POLICY.defaultNeed)
  assert.equal(requiredApprovals(undefined), DEFAULT_MERGE_POLICY.defaultNeed)
})

test('게이트 전부 초록이고 정족수를 채우면 병합 가능', () => {
  const votes = ['b', 'c', 'd'].map((n) => vote(`agent-${n}`, 'approve'))
  const r = checkMerge({ proposal: proposal(['src/protocol.mjs']), votes, gates: GREEN })
  assert.equal(r.ok, true)
  assert.equal(r.need, 3)
  assert.deepEqual(r.approvals, ['agent-b', 'agent-c', 'agent-d'])
})

test('표 검증은 claim 의 이름 규칙을 그대로 쓴다', () => {
  // 규칙을 따로 만들면 agent-a 와 agent/a 가 표에서만 같은 파일이 된다.
  assert.ok(voteError({ voter: 'agent/a', verdict: 'approve', head: HEAD }))
  assert.ok(voteError({ voter: 'agent-b', verdict: 'maybe', head: HEAD }))
  assert.ok(voteError({ voter: 'agent-b', verdict: 'approve' }), 'head 없는 표는 어느 코드를 봤는지 모르는 표다')
  assert.equal(voteError({ voter: 'agent-b', verdict: 'approve', head: HEAD }), null)
  assert.equal(voteError({ voter: '장효준', verdict: 'reject', head: HEAD }), null)
})

test('보류 메시지는 무엇을 하면 풀리는지 말한다', () => {
  const r = checkMerge({
    proposal: proposal(['src/protocol.mjs']),
    votes: [vote('agent-e', 'reject', { reason: 'I6 을 깨뜨린다' })],
    gates: GREEN,
  })
  const text = formatMerge(r, proposal(['src/protocol.mjs']))
  assert.match(text, /head 가 바뀌어/, '반대표를 없애는 길을 알려줘야 에이전트가 방향을 튼다')
})

// ---------------------------------------------------------------------------
// 검사기 자체를 검증한다.
// 한 번도 실패하지 않는 검사기는 검사기가 아니다 (docs/INVARIANTS.md).
// ---------------------------------------------------------------------------

test('I8 검사기는 일부러 심은 위반을 잡는다', () => {
  const clean = gatePrecedenceViolations({ merge: { id: 'p-1', gates: GREEN } })
  assert.deepEqual(clean, [])

  const red = gatePrecedenceViolations({
    merge: { id: 'p-2', agent: 'agent-a', gates: { ...GREEN, 'demo:chaos': { ok: false } } },
  })
  assert.equal(red.length, 1)
  assert.equal(red[0].invariant, 'I8')
  assert.equal(red[0].gate, 'demo:chaos')

  // 게이트를 아예 안 돌리고 병합한 것도 위반이다.
  const skipped = gatePrecedenceViolations({ merge: { id: 'p-3', gates: {} } })
  assert.equal(skipped.length, DEFAULT_MERGE_POLICY.requiredGates.length)
})
