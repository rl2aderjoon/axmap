/**
 * 모델 검증기.
 *
 * 무작위 연산 수열을 만들고 매 단계마다 docs/INVARIANTS.md 의 불변식을 검사한다.
 * 데모와 달리 순서를 사람이 정하지 않는다. 락 프로토콜의 버그는
 * 대개 "내가 생각하지 못한 순서"에 숨어 있기 때문이다.
 *
 * 제품이 실제로 쓰는 함수(applyClaim 등)를 그대로 부른다.
 * 검증기가 로직을 다시 구현하면 검증 대상이 제품이 아니라 검증기가 된다.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyClaim, applyRelease, applyRenew } from '../src/protocol.mjs'
import {
  auditLedger,
  lossViolations,
  mutualExclusionViolations,
  resurrectionViolations,
} from '../src/invariants.mjs'

// ---------------------------------------------------------------------------
// 씨드 고정 난수. 반례가 나오면 씨드 하나로 완전히 재현된다.
// ---------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 겹치기 쉽도록 얕은 트리를 쓴다. src 같은 넓은 디렉터리와
// authz 처럼 prefix 함정이 되는 형제를 일부러 넣었다.
const PATHS = [
  'src',
  'src/auth',
  'src/auth/login.ts',
  'src/auth/token.ts',
  'src/authz',
  'src/authz/policy.ts',
  'src/user',
  'src/user/profile.ts',
  'src/core/config.ts',
  'src/api/one.ts',
  'src/api/two.ts',
]
const AGENTS = ['a', 'b', 'c', 'd', 'e', 'f']

/**
 * 겹침 판정의 독립적인 참조 구현.
 *
 * checkOverlap 으로 기대값을 만들면 그 함수가 스스로를 검증하는 셈이 된다.
 * 여기서는 경로를 '/' 로 쪼개 세그먼트 단위로 비교하는 다른 방식으로 구현해
 * 두 구현의 답을 대조한다.
 */
function oracleBlocked(requested, claims, me, now) {
  const seg = (p) => p.split('/').filter(Boolean)
  for (const c of claims) {
    if (c.agent === me) continue
    if (Date.parse(c.since) + c.ttlMs <= now) continue // 만료된 것은 막지 못한다
    for (const w of requested) {
      for (const h of c.paths) {
        const a = seg(w)
        const b = seg(h)
        const k = Math.min(a.length, b.length)
        let prefix = true
        for (let i = 0; i < k; i++) {
          if (a[i] !== b[i]) {
            prefix = false
            break
          }
        }
        if (prefix) return true // 한쪽이 다른 쪽의 조상이거나 같은 경로
      }
    }
  }
  return false
}

// ---------------------------------------------------------------------------

function runScenario(seed, steps) {
  const rnd = mulberry32(seed)
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
  const int = (n) => Math.floor(rnd() * n)

  let claims = []
  let clock = Date.parse('2026-01-01T00:00:00.000Z')
  const log = []

  const fail = (msg, details) => {
    assert.fail(
      `씨드 ${seed}, ${log.length}단계에서 위반\n\n  ${msg}\n\n재현 수열:\n` +
        log.map((l, i) => `  ${String(i + 1).padStart(3)}. ${l}`).join('\n') +
        (details ? `\n\n상세:\n${JSON.stringify(details, null, 2)}` : ''),
    )
  }
  const check = (violations) => {
    if (violations.length) fail(violations[0].message, violations[0])
  }

  for (let step = 0; step < steps; step++) {
    clock += int(25 * 60_000) // 0~25분 경과
    const me = pick(AGENTS)
    const before = claims

    switch (pick(['claim', 'claim', 'claim', 'release', 'renew', 'idle'])) {
      case 'claim': {
        const requested = [...new Set(Array.from({ length: 1 + int(3) }, () => pick(PATHS)))]
        const ttlMs = (5 + int(60)) * 60_000
        log.push(`${me} claim [${requested.join(' ')}] ttl=${ttlMs / 60000}m  (t+${clock % 1e9})`)

        const expectBlocked = oracleBlocked(requested, claims, me, clock)
        const res = applyClaim({ claims, me, requested, now: clock, ttlMs })

        // I3 · 진행성 — 겹치지 않으면 반드시 성공해야 한다 (거짓 거부 금지)
        if (!expectBlocked && !res.ok) {
          fail(`I3: 겹치지 않는데 거부되었다 (${me} → ${requested.join(' ')})`, res.blocks)
        }
        // 반대 방향 — 겹치는데 통과하면 I1 이 곧 깨진다
        if (expectBlocked && res.ok) {
          fail(`I1: 겹치는데 통과되었다 (${me} → ${requested.join(' ')})`, res.record)
        }
        if (!res.ok) break

        check(lossViolations({ requested, record: res.record })) // I2
        check(resurrectionViolations({ before, after: res.claims, requested, me, now: clock })) // I6
        claims = res.claims
        break
      }

      case 'release': {
        const drop = rnd() < 0.5 ? [] : [pick(PATHS)]
        log.push(`${me} release [${drop.join(' ') || 'all'}]`)
        claims = applyRelease({ claims, me, drop }).claims
        break
      }

      case 'renew': {
        const ttlMs = (5 + int(60)) * 60_000
        log.push(`${me} renew ttl=${ttlMs / 60000}m`)
        const res = applyRenew({ claims, me, now: clock, ttlMs })
        if (res.ok) claims = res.claims
        break
      }

      default:
        log.push('(시간만 경과)')
    }

    // I1 · 상호배제 — 매 단계 전수 검사
    check(mutualExclusionViolations(claims, clock))

    // I4 · 회수 — 만료된 claim 이 아무것도 막지 못하는지 실제로 찔러본다
    for (const c of claims) {
      if (Date.parse(c.since) + c.ttlMs > clock) continue
      const other = AGENTS.find((a) => a !== c.agent)
      for (const p of c.paths) {
        if (oracleBlocked([p], claims, other, clock)) continue // 다른 유효 claim 이 막는 중
        const probe = applyClaim({ claims, me: other, requested: [p], now: clock, ttlMs: 60_000 })
        if (!probe.ok) fail(`I4: 만료된 ${c.agent} 의 ${p} 가 아직 막고 있다`, probe.blocks)
      }
    }
  }
}

// ---------------------------------------------------------------------------

test('모델 검증 - 무작위 시나리오 400개 × 60단계에서 I1~I4, I6 유지', () => {
  for (let seed = 1; seed <= 400; seed++) runScenario(seed, 60)
})

test('모델 검증 - 긴 수열 (씨드 20개 × 500단계)', () => {
  for (let seed = 1000; seed < 1020; seed++) runScenario(seed, 500)
})

// ---------------------------------------------------------------------------
// 검증기 자체를 검증한다.
// 한 번도 실패하지 않는 검사기는 검사기가 아니다.
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-01-01T00:10:00.000Z')
const rec = (agent, paths, opts = {}) => ({
  agent,
  task: null,
  intent: null,
  since: opts.since ?? '2026-01-01T00:00:00.000Z',
  ttlMs: opts.ttlMs ?? 30 * 60_000,
  paths,
})

test('검증기 자체 검사 - 상호배제 위반을 실제로 잡는다', () => {
  const bad = [rec('a', ['src/auth']), rec('b', ['src/auth/login.ts'])]
  const v = mutualExclusionViolations(bad, NOW)
  assert.equal(v.length, 1)
  assert.equal(v[0].invariant, 'I1')
  assert.deepEqual(v[0].agents.sort(), ['a', 'b'])

  // 대조군 - 겹치지 않으면 잡지 않는다
  assert.equal(mutualExclusionViolations([rec('a', ['src/auth']), rec('b', ['src/authz'])], NOW).length, 0)
})

test('검증기 자체 검사 - 만료된 쪽은 위반이 아니다', () => {
  const expired = rec('a', ['src/auth'], { since: '2025-12-31T00:00:00.000Z' })
  assert.equal(mutualExclusionViolations([expired, rec('b', ['src/auth/login.ts'])], NOW).length, 0)
})

test('검증기 자체 검사 - 부활을 실제로 잡는다', () => {
  const before = [rec('a', ['src/foo'], { since: '2025-12-31T00:00:00.000Z' })] // 만료됨
  const after = [rec('a', ['src/foo', 'src/bar'])] // src/foo 가 딸려 들어옴
  const v = resurrectionViolations({ before, after, requested: ['src/bar'], me: 'a', now: NOW })
  assert.equal(v.length, 1)
  assert.equal(v[0].invariant, 'I6')
  assert.deepEqual(v[0].paths, ['src/foo'])

  // 대조군 - 유효한 claim 에서 이어받은 것은 부활이 아니다
  const live = [rec('a', ['src/foo'])]
  assert.equal(
    resurrectionViolations({ before: live, after, requested: ['src/bar'], me: 'a', now: NOW }).length,
    0,
  )
})

test('검증기 자체 검사 - 무손실 위반을 실제로 잡는다', () => {
  const v = lossViolations({ requested: ['src/a', 'src/b'], record: rec('a', ['src/a']) })
  assert.equal(v.length, 1)
  assert.deepEqual(v[0].paths, ['src/b'])
  assert.equal(lossViolations({ requested: ['src/a'], record: rec('a', ['src/a']) }).length, 0)
})

test('검증기 자체 검사 - audit 이 위반 스냅샷을 지목한다', () => {
  const snapshots = [
    { commit: 'aaa1111', subject: 'ok', time: Date.parse('2026-01-01T00:00:00Z'), claims: [rec('a', ['src/auth'])] },
    {
      commit: 'bbb2222',
      subject: 'bad',
      time: Date.parse('2026-01-01T00:05:00Z'),
      claims: [rec('a', ['src/auth']), rec('b', ['src/auth/login.ts'], { since: '2026-01-01T00:05:00.000Z' })],
    },
  ]
  const report = auditLedger(snapshots)
  assert.equal(report.ok, false)
  assert.equal(report.checked, 2)
  assert.equal(report.violations.length, 1)
  assert.equal(report.violations[0].commit, 'bbb2222')

  assert.equal(auditLedger([snapshots[0]]).ok, true)
})

test('검증기 자체 검사 - 시계를 옮긴 스냅샷도 논리 시각으로 판정한다', () => {
  // AXMAP_NOW 로 시계를 앞당긴 테스트 데이터는 커밋 시각과 since 가 어긋난다.
  // since 는 논리적으로 미래일 수 없으므로 늦은 쪽이 그 스냅샷의 시각이다.
  const snapshots = [
    {
      commit: 'ccc3333',
      subject: 'clock-skewed',
      time: Date.parse('2026-01-01T00:00:00Z'), // 벽시계
      claims: [
        rec('a', ['src/auth']), // 00:00 시작, 00:30 만료
        rec('b', ['src/auth/login.ts'], { since: '2026-01-01T02:00:00.000Z' }), // 2시간 뒤
      ],
    },
  ]
  // 논리 시각 02:00 에서 a 는 이미 만료 -> 위반 아님
  assert.equal(auditLedger(snapshots).ok, true)
})
