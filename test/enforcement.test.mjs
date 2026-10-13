/**
 * I5 · 강제 — "아무도 잡지 않은 파일이 고쳐졌나".
 *
 * 이 검사가 없으면 claim 은 권고 사항이다. 그래서 여기서 증명해야 하는 것은
 * "통과한다" 가 아니라 **"위반을 실제로 잡는다"** 쪽이다. 잡는 쪽을 안 재면
 * 늘 통과하는 검사기를 만들어 놓고 보호받고 있다고 믿게 된다.
 *
 * 순수 함수라 git 도 파일시스템도 필요 없다.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { auditLedger, enforcementViolations } from '../src/invariants.mjs'

const T0 = Date.parse('2026-09-01T00:00:00.000Z')
const MIN = 60_000

/** 장부 스냅샷 하나. time 은 커밋 시각, claims 는 그 시점의 레코드 전부. */
const snap = (atMs, claims) => ({ commit: 'ledger' + atMs, time: atMs, subject: 'claim', claims })

/** claim 레코드 하나. 기본 TTL 30분. */
const claim = (agent, paths, sinceMs, ttlMs = 30 * MIN) => ({
  agent,
  paths,
  since: new Date(sinceMs).toISOString(),
  ttlMs,
})

/** 코드 커밋 하나. */
const commit = (sha, author, atMs, files) => ({ sha, author, time: atMs, subject: sha, files })

test('잡은 파일을 고친 커밋은 위반이 아니다', () => {
  const snaps = [snap(T0, [claim('agent-a', ['src/a.mjs'], T0)])]
  const r = enforcementViolations(snaps, [commit('c1', 'janghyojoon', T0 + MIN, ['src/a.mjs'])])
  assert.equal(r.violations.length, 0)
  assert.equal(r.skipped.length, 0)
})

test('아무도 안 잡은 파일을 고치면 I5 로 잡힌다', () => {
  const snaps = [snap(T0, [claim('agent-a', ['src/a.mjs'], T0)])]
  const r = enforcementViolations(snaps, [commit('c2', 'janghyojoon', T0 + MIN, ['src/b.mjs'])])
  assert.equal(r.violations.length, 1)
  assert.equal(r.violations[0].invariant, 'I5')
  assert.match(r.violations[0].message, /src\/b\.mjs/)
  assert.deepEqual(r.violations[0].agents, ['janghyojoon'])
  assert.equal(r.violations[0].commit, 'c2')
})

test('디렉터리를 잡으면 그 아래 파일도 덮는다', () => {
  const snaps = [snap(T0, [claim('agent-a', ['docs'], T0)])]
  const r = enforcementViolations(snaps, [commit('c3', 'x', T0 + MIN, ['docs/깊은/곳.md'])])
  assert.equal(r.violations.length, 0)
})

test('TTL 이 지난 뒤의 커밋은 잡히지 않은 것으로 본다', () => {
  // 🔴 이것이 이 검사의 핵심이다. 만료를 무시하면 한 번 잡은 사람이 영원히
  //    통과하고, 그러면 장부가 "지금 누가 잡고 있나" 를 말하지 못하게 된다.
  const snaps = [snap(T0, [claim('agent-a', ['src/a.mjs'], T0, 10 * MIN)])]
  const r = enforcementViolations(snaps, [commit('c4', 'x', T0 + 20 * MIN, ['src/a.mjs'])])
  assert.equal(r.violations.length, 1)
  assert.equal(r.violations[0].invariant, 'I5')
})

test('장부보다 앞선 커밋은 건너뛰되 세어서 보고한다', () => {
  // 조용히 빼면 "위반 0" 이 "검사했고 깨끗함" 으로 읽힌다.
  const snaps = [snap(T0, [claim('agent-a', ['src/a.mjs'], T0)])]
  const r = enforcementViolations(snaps, [commit('c5', 'x', T0 - MIN, ['src/a.mjs'])])
  assert.equal(r.violations.length, 0)
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].commit, 'c5')
})

test('나중 스냅샷이 앞 커밋의 판정을 바꾸지 않는다', () => {
  // 커밋 시각에 유효했던 마지막 스냅샷으로만 판정한다. 미래의 claim 은 소급되지 않는다.
  const snaps = [
    snap(T0, [claim('agent-a', ['src/a.mjs'], T0)]),
    snap(T0 + 10 * MIN, [claim('agent-a', ['src/a.mjs'], T0), claim('agent-b', ['src/b.mjs'], T0 + 10 * MIN)]),
  ]
  const r = enforcementViolations(snaps, [commit('c6', 'x', T0 + 5 * MIN, ['src/b.mjs'])])
  assert.equal(r.violations.length, 1, 'b 는 5분 시점엔 아직 아무도 안 잡았다')
})

test('auditLedger 는 코드 위반을 합쳐서 ok 를 내린다', () => {
  const snaps = [snap(T0, [claim('agent-a', ['src/a.mjs'], T0)])]

  const clean = auditLedger(snaps, [commit('c7', 'x', T0 + MIN, ['src/a.mjs'])])
  assert.equal(clean.ok, true)
  assert.equal(clean.codeChecked, 1)

  const dirty = auditLedger(snaps, [commit('c8', 'x', T0 + MIN, ['src/z.mjs'])])
  assert.equal(dirty.ok, false)
  assert.equal(dirty.violations.length, 1)
})

test('--code 를 안 주면 코드 대조를 안 했다고 표시한다', () => {
  // 🔴 "안 했다" 와 "했는데 깨끗했다" 가 같아 보이면 안 된다.
  const r = auditLedger([snap(T0, [])], null)
  assert.equal(r.ok, true)
  assert.equal(r.codeChecked, null)
})
