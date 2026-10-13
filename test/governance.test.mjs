/**
 * 합의제 MR 판정 테스트.
 *
 * 🔴 이 파일의 절반은 **음성 테스트**다. 한 번도 실패하지 않는 검사기는 검사기가
 *    아니다 (INVARIANTS.md 의 "검증기 자체를 검증한다" 와 같은 규칙).
 *    G1~G5 각각에 대해 "막아야 하는데 안 막히면 빨개지는" 케이스를 둔다.
 *
 * 시각은 전부 인자로 넣는다. 승계 창(90일)을 실제로 90일 기다려서 확인할 수는 없다.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXIT,
  GovernanceError,
  validatePolicy,
  rulesFor,
  countVotes,
  deriveVoters,
  judge,
  formatVerdict,
  majorityThreshold,
  selfVoteMode,
  DEFAULT_SELF_VOTE,
  SELF_VOTE_MODES,
  voteNoteRule,
  voteNoteProblem,
  DEFAULT_VOTE_NOTE_MIN_CHARS,
} from '../src/governance.mjs'

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
const OTHER = '0f1e2d3c4b5a69788796a5b4c3d2e1f009182736'
const NOW = Date.parse('2026-08-25T06:00:00Z')
const BRANCH = 'feat/S15P21E201-144-login'

/** 통과하는 정책. 각 테스트는 여기서 한 군데만 망가뜨린다. */
const policy = (over = {}) => ({
  voters: [
    { id: 'kojh0124', email: 'kojh@example.com' },
    { id: 'masdf13', email: 'jaehyun@example.com' },
    { id: 'yeaseung', email: 'yeaseung@example.com' },
  ],
  default: { threshold: 2 },
  rules: [{ paths: ['FE'], threshold: 1 }],
  amendment: { paths: ['governance/policy.json'], threshold: 3 },
  succession: { window_days: 90, top: 3 },
  ...over,
})

const vote = (over = {}) => ({
  voter: 'kojh0124',
  email: 'kojh@example.com',
  branch: BRANCH,
  sha: HEAD,
  vote: 'approve',
  at: '2026-08-25T05:00:00Z',
  // 게이트가 채우는 칸 — 이 표 파일을 만든 커밋의 committer.
  committerEmail: 'kojh@example.com',
  ...over,
})

/** 세 사람 모두 최근에 커밋했다 = 승계가 돌지 않는 평시 상태. */
const livingTeam = () => [
  { email: 'kojh@example.com', name: '고지혁', at: '2026-08-20T00:00:00Z' },
  { email: 'jaehyun@example.com', name: '박재현', at: '2026-08-21T00:00:00Z' },
  { email: 'yeaseung@example.com', name: '이예승', at: '2026-08-22T00:00:00Z' },
]

const codes = (r) => r.problems.map((p) => p.code)

/**
 * 던져진 예외를 돌려준다. `assert.throws` 는 예외를 돌려주지 않으므로
 * **종료 코드까지 확인하려면** 이렇게 받아야 한다. 이 층에서는 "던졌다" 만으로는
 * 부족하다 — 1(판정 불가)과 4(정책 깨짐)를 가르는 것이 계약의 절반이다.
 */
function thrown(fn) {
  try {
    fn()
  } catch (e) {
    return e
  }
  return null
}

/** GovernanceError 를 던졌고 그 종료 코드가 맞는가. */
function assertThrowsExit(fn, exit, msg = '') {
  const e = thrown(fn)
  assert.ok(e instanceof GovernanceError, `GovernanceError 를 안 던졌다: ${e} ${msg}`)
  assert.equal(e.exit, exit, `${msg} — 종료 코드가 ${e.exit} 였다: ${e.message}`)
  return e
}

// ---------------------------------------------------------------------------

describe('validatePolicy — 정책 자체가 성립하는가', () => {
  it('멀쩡한 정책은 통과한다', () => {
    const r = validatePolicy(policy())
    assert.equal(r.ok, true, JSON.stringify(r.problems))
    assert.equal(r.exit, EXIT.OK)
  })

  it('🔴 email 이 중복이면 거부한다 — 한 사람이 두 표가 된다 (G4)', () => {
    const p = policy()
    p.voters[1].email = 'KOJH@example.com' // 대소문자만 다르다
    const r = validatePolicy(p)
    assert.equal(r.ok, false)
    assert.equal(r.exit, EXIT.POLICY_BROKEN)
    assert.ok(codes(r).includes('voter-email-duplicate'), codes(r).join(','))
  })

  it('🔴 id 가 중복이어도 거부한다', () => {
    const p = policy()
    p.voters[1].id = 'kojh0124'
    assert.ok(codes(validatePolicy(p)).includes('voter-id-duplicate'))
  })

  it('🔴 규칙이 기본보다 높으면 거부한다 — 새 폴더가 기존 폴더보다 싸진다', () => {
    // default 2 인데 FE 규칙이 3 이면, FE 를 고치는 대신 FE2 를 새로 만들면 2표다.
    const p = policy({ rules: [{ paths: ['FE'], threshold: 3 }] })
    const r = validatePolicy(p)
    assert.equal(r.exit, EXIT.POLICY_BROKEN)
    assert.ok(codes(r).includes('hierarchy-rule'), codes(r).join(','))
  })

  it('🔴 개정이 기본보다 낮으면 거부한다', () => {
    const p = policy({ amendment: { paths: ['governance/policy.json'], threshold: 1 } })
    assert.ok(codes(validatePolicy(p)).includes('hierarchy-amendment'))
  })

  it('🔴 amendment.paths 가 정책 파일 자신을 안 덮으면 거부한다', () => {
    // 안 덮으면 threshold 를 1 로 낮추는 MR 이 **기본 문턱**으로 통과한다.
    const p = policy({ amendment: { paths: ['governance/GOVERNANCE.md'], threshold: 3 } })
    const r = validatePolicy(p)
    assert.equal(r.exit, EXIT.POLICY_BROKEN)
    assert.ok(codes(r).includes('amendment-not-self-covering'), codes(r).join(','))
  })

  it('폴더로 덮어도 자기 포함으로 친다', () => {
    const p = policy({
      // 규칙이 개정 경로와 겹치지 않게 옮긴다 (아래 겹침 테스트 참고).
      amendment: { paths: ['governance'], threshold: 3 },
    })
    assert.equal(validatePolicy(p).ok, true)
  })

  it('🔴 threshold 가 투표권자 수보다 크면 거부한다 — 채울 수 없는 문턱', () => {
    const p = policy({ default: { threshold: 2 }, amendment: { paths: ['governance/policy.json'], threshold: 9 } })
    const r = validatePolicy(p)
    assert.equal(r.exit, EXIT.POLICY_BROKEN)
    assert.ok(codes(r).includes('threshold-over-voters'), codes(r).join(','))
  })

  it('🔴 정족수 0 은 정족수가 아니다 — 거부한다', () => {
    const p = policy({ default: { threshold: 0 } })
    assert.ok(codes(validatePolicy(p)).includes('threshold-invalid'))
  })

  it('🔴 규칙이 개정 경로에 걸치면 거부한다 — 규칙이 거짓말을 하게 된다', () => {
    // rules 에 governance 가 있으면 사람은 "governance 는 1표" 로 읽지만
    // 실제로는 개정 문턱이 이긴다.
    const p = policy({ rules: [{ paths: ['governance'], threshold: 1 }] })
    assert.ok(codes(validatePolicy(p)).includes('rule-overlaps-amendment'))
  })

  it('🔴 정책이 아예 없으면 4 가 아니라 1 이다 — "깨졌다" 보다 "못 읽었다" 가 근본적이다', () => {
    for (const bad of [null, undefined, [], 'policy']) {
      const r = validatePolicy(bad)
      assert.equal(r.exit, EXIT.UNDECIDABLE, `${JSON.stringify(bad)} 를 4 로 판정했다`)
    }
  })

  it('문제를 하나만 찾고 멈추지 않는다', () => {
    const p = policy({ voters: [{ id: 'a', email: 'a@x.com' }, { id: 'a', email: 'A@X.com' }] })
    const r = validatePolicy(p)
    assert.ok(r.problems.length >= 2, JSON.stringify(r.problems))
  })
})

// ---------------------------------------------------------------------------

describe('rulesFor — 이 변경에 몇 표가 필요한가', () => {
  it('규칙이 걸리면 규칙의 값이다 (기본보다 낮아도 된다)', () => {
    const r = rulesFor(['FE/src/pages/Trip.tsx'], policy())
    assert.equal(r.threshold, 1)
    assert.equal(r.source, 'rules')
  })

  it('규칙이 안 걸리면 기본값이다', () => {
    const r = rulesFor(['BE/src/user.py'], policy())
    assert.equal(r.threshold, 2)
    assert.equal(r.source, 'default')
  })

  it('🔴 규칙 둘이 걸리면 최댓값이다 — 최솟값이면 규칙을 하나 더 얹어 문턱을 낮출 수 있다', () => {
    const p = policy({
      rules: [{ paths: ['FE'], threshold: 1 }, { paths: ['FE/src/auth'], threshold: 2 }],
    })
    assert.equal(rulesFor(['FE/src/auth/login.ts'], p).threshold, 2)
  })

  it('정책 파일을 건드리면 개정 문턱이다', () => {
    const r = rulesFor(['governance/policy.json'], policy())
    assert.equal(r.threshold, 3)
    assert.equal(r.source, 'amendment')
    assert.equal(r.amendment, true)
  })

  it('여러 경로가 섞이면 가장 높은 문턱을 쓴다', () => {
    const r = rulesFor(['FE/src/a.tsx', 'BE/b.py', 'governance/policy.json'], policy())
    assert.equal(r.threshold, 3)
    assert.equal(r.top.path, 'governance/policy.json')
  })

  it('경로 매칭은 / 경계로 한다 — FE 가 FEED 를 잡아먹지 않는다', () => {
    // protocol.mjs 의 coversPath 를 그대로 쓰므로 이 성질이 저장소에 하나만 있다.
    assert.equal(rulesFor(['FEED/x.ts'], policy()).threshold, 2)
  })

  it('🔴 바뀐 경로가 비면 기본값이 아니라 판정 불가(1) 다', () => {
    // 빈 목록의 현실적인 원인은 "안 바뀐 MR" 이 아니라 게이트가 diff 를 못 뜬 것이다.
    assertThrowsExit(() => rulesFor([], policy()), EXIT.UNDECIDABLE, '빈 diff')
    assertThrowsExit(() => rulesFor(undefined, policy()), EXIT.UNDECIDABLE, 'diff 없음')
  })
})

// ---------------------------------------------------------------------------

describe('countVotes — 유효 찬성 수', () => {
  const base = (over = {}) => ({
    policy: policy(),
    votes: [],
    authorEmails: ['author@example.com'],
    sha: HEAD,
    now: NOW,
    branch: BRANCH,
    ...over,
  })

  it('멀쩡한 표 둘은 둘로 센다', () => {
    const r = countVotes(base({
      votes: [vote(), vote({ voter: 'masdf13', email: 'jaehyun@example.com', committerEmail: 'jaehyun@example.com' })],
    }))
    assert.equal(r.approvals, 2)
    assert.equal(r.invalid.length, 0)
  })

  it('🔴 G1 · 자기 표는 안 센다', () => {
    const r = countVotes(base({
      authorEmails: ['kojh@example.com'], // 이 MR 을 kojh 가 썼다
      votes: [vote()],
    }))
    assert.equal(r.approvals, 0)
    assert.equal(r.invalid[0].reason, 'self-vote')
  })

  it('🔴 G1 · 대소문자가 달라도 자기 표다', () => {
    const r = countVotes(base({ authorEmails: ['KOJH@Example.com'], votes: [vote()] }))
    assert.equal(r.approvals, 0)
    assert.equal(r.invalid[0].reason, 'self-vote')
  })

  it('🔴 G3 · sha 가 다른 표는 안 세지만 사라지지도 않는다', () => {
    // 만료된 claim 과 같은 취급이다 — 레코드는 남고 효력만 잃는다 (SPEC §5).
    const r = countVotes(base({ votes: [vote({ sha: OTHER })] }))
    assert.equal(r.approvals, 0)
    assert.equal(r.invalid.length, 1)
    assert.equal(r.invalid[0].reason, 'stale-sha')
  })

  it('축약 sha 는 8자 이상일 때만 같은 커밋으로 본다', () => {
    assert.equal(countVotes(base({ votes: [vote({ sha: HEAD.slice(0, 8) })] })).approvals, 1)
    assert.equal(countVotes(base({ votes: [vote({ sha: HEAD.slice(0, 7) })] })).approvals, 0)
  })

  it('🔴 G4 · 같은 사람의 두 번째 표는 안 센다', () => {
    const r = countVotes(base({ votes: [vote(), vote({ voter: 'kojh0124', at: '2026-08-25T05:30:00Z' })] }))
    assert.equal(r.approvals, 1)
    assert.equal(r.invalid[0].reason, 'duplicate')
  })

  it('명단에 없는 사람의 표는 안 센다', () => {
    const r = countVotes(base({ votes: [vote({ voter: 'stranger', email: 'x@example.com', committerEmail: 'x@example.com' })] }))
    assert.equal(r.invalid[0].reason, 'not-a-voter')
  })

  it('email 은 맞는데 이름이 명단과 다르면 안 센다', () => {
    const r = countVotes(base({ votes: [vote({ voter: 'masdf13' })] }))
    assert.equal(r.invalid[0].reason, 'identity-mismatch')
  })

  it('🔴 표를 만든 커밋의 committer 가 다르면 안 센다 — 위조 의심', () => {
    const r = countVotes(base({ votes: [vote({ committerEmail: 'someone@else.com' })] }))
    assert.equal(r.invalid[0].reason, 'committer-mismatch')
  })

  it('🔴 committer 를 확인 못 했으면 세지 않는다 (fail-closed)', () => {
    const v = vote()
    delete v.committerEmail
    const r = countVotes(base({ votes: [v] }))
    assert.equal(r.approvals, 0)
    assert.equal(r.invalid[0].reason, 'committer-unknown')
  })

  it('다른 브랜치의 표는 안 센다', () => {
    const r = countVotes(base({ votes: [vote({ branch: 'feat/other' })] }))
    assert.equal(r.invalid[0].reason, 'wrong-branch')
  })

  it('반대표는 정족수 계산에 들어가지 않지만 출력에는 남는다', () => {
    const r = countVotes(base({ votes: [vote({ vote: 'reject' })] }))
    assert.equal(r.approvals, 0)
    assert.equal(r.rejections.length, 1)
    assert.equal(r.invalid.length, 0)
  })

  it('미래 시각으로 적힌 표는 안 센다', () => {
    const r = countVotes(base({ votes: [vote({ at: '2026-09-30T00:00:00Z' })] }))
    assert.equal(r.invalid[0].reason, 'future-dated')
  })

  it('🔴 깨진 표는 건너뛰지 않고 전체를 중단한다 (exit 1)', () => {
    // 건너뛰면 깨진 표가 "없는 표" 가 되고, 없는 표는 아무 경고도 만들지 않는다.
    for (const broken of [
      { ...vote(), sha: 'zzzz' },
      { ...vote(), vote: 'approve!' },
      { ...vote(), email: 'not-an-email' },
      { ...vote(), at: '어제' },
      (() => { const v = vote(); delete v.voter; return v })(),
      'just a string',
      null,
    ]) {
      assertThrowsExit(
        () => countVotes(base({ votes: [broken] })),
        EXIT.UNDECIDABLE,
        `깨진 표를 조용히 넘겼다: ${JSON.stringify(broken)}`,
      )
    }
  })

  it('🔴 표 목록을 못 받으면 "0표" 가 아니라 판정 불가다', () => {
    // tools/bus.mjs 의 `catch { return [] }` 를 여기로 가져오면 표가 사라진 MR 이
    // 0표로 보인다. 쪽지에서는 맞는 선택이지만 투표에서는 fail-open 이다.
    assertThrowsExit(() => countVotes(base({ votes: null })), EXIT.UNDECIDABLE, '표 목록 없음')
  })

  it('🔴 소스 브랜치 author 를 못 받으면 세지 않는다 — 자기 표를 못 거른다', () => {
    assertThrowsExit(() => countVotes(base({ authorEmails: [], votes: [vote()] })), EXIT.UNDECIDABLE, '빈 author')
    assertThrowsExit(() => countVotes(base({ authorEmails: undefined, votes: [vote()] })), EXIT.UNDECIDABLE, 'author 없음')
  })

  it('머지 대상 sha 를 모르면 판정 불가다', () => {
    assert.throws(() => countVotes(base({ sha: null, votes: [vote()] })), GovernanceError)
  })
})

// ---------------------------------------------------------------------------

/**
 * 자기 표 배제(G1)의 **해제** — 던질 수 있는 사람이 정족수보다 적을 때만 풀린다.
 *
 * 🔴 이 블록의 절반은 "안 풀려야 하는 자리에서 안 풀리는가" 다. 해제가 넓어지면
 *    G1 은 있으나 마나가 되고, 그때는 아무 에러 없이 판정만 물러진다.
 */
describe('countVotes — G1(자기 표 배제) 해제', () => {
  /** 명단 3명 · 정족수 2. 각 테스트는 저자 목록만 바꾼다. */
  const base = (over = {}) => ({
    policy: policy(),
    votes: [],
    authorEmails: ['author@example.com'],
    sha: HEAD,
    now: NOW,
    branch: BRANCH,
    threshold: 2,
    ...over,
  })

  /** 명단에 있는 사람의 멀쩡한 표. */
  const ballot = (email, voter) => vote({ voter, email, committerEmail: email })

  it('🔴 (a) 던질 수 있는 사람이 정족수만큼 남아 있으면 자기 표는 여전히 거부된다', () => {
    // 저자는 셋 중 하나. 남은 둘 = 정족수 2. 교착이 아니므로 풀 이유가 없다.
    const r = countVotes(base({
      authorEmails: ['kojh@example.com'],
      votes: [ballot('kojh@example.com', 'kojh0124')],
    }))
    assert.equal(r.g1Waived, false, '해제되면 안 되는 자리에서 해제됐다')
    assert.equal(r.eligibleCount, 2)
    assert.equal(r.approvals, 0)
    assert.equal(r.invalid[0].reason, 'self-vote')
  })

  it('🔴 (b) 명단 전원이 저자라 던질 수 있는 사람이 0 이면 자기 표를 센다', () => {
    const r = countVotes(base({
      authorEmails: ['kojh@example.com', 'jaehyun@example.com', 'yeaseung@example.com'],
      votes: [
        ballot('kojh@example.com', 'kojh0124'),
        ballot('jaehyun@example.com', 'masdf13'),
      ],
    }))
    assert.equal(r.g1Waived, true)
    assert.equal(r.eligibleCount, 0)
    assert.equal(r.threshold, 2)
    assert.equal(r.approvals, 2)
    assert.equal(r.invalid.length, 0)
    assert.deepEqual(r.selfVoted.map((s) => s.email).sort(), ['jaehyun@example.com', 'kojh@example.com'])
  })

  it('던질 수 있는 사람이 1명뿐이어도(정족수 2) 풀린다 — 미달이 아니라 교착이다', () => {
    const r = countVotes(base({
      authorEmails: ['kojh@example.com', 'jaehyun@example.com'],
      votes: [ballot('kojh@example.com', 'kojh0124')],
    }))
    assert.equal(r.g1Waived, true)
    assert.equal(r.eligibleCount, 1)
    assert.equal(r.approvals, 1)
  })

  it('🔴 정족수를 안 받으면 해제하지 않는다 — 모르면 안 푸는 쪽이 fail-closed 다', () => {
    const r = countVotes(base({
      threshold: null,
      authorEmails: ['kojh@example.com', 'jaehyun@example.com', 'yeaseung@example.com'],
      votes: [ballot('kojh@example.com', 'kojh0124')],
    }))
    assert.equal(r.g1Waived, false)
    assert.equal(r.approvals, 0)
    assert.equal(r.invalid[0].reason, 'self-vote')
  })

  it('🔴 G1 이 아무도 안 뺐으면 해제하지 않는다 — 그건 막힌 저장소지 G1 교착이 아니다', () => {
    // 명단 3명 중 저자가 하나도 없는데 정족수만 4. 자기 표를 풀어도 아무도 안 는다.
    const r = countVotes(base({
      policy: policy({ default: { threshold: 4 } }),
      threshold: 4,
      authorEmails: ['stranger@example.com'],
      votes: [ballot('kojh@example.com', 'kojh0124')],
    }))
    assert.equal(r.g1Waived, false)
    assert.equal(r.eligibleCount, 3)
    assert.equal(r.approvals, 1)
  })

  it('🔴 저자 목록을 못 받으면 해제가 아니라 판정 불가다 (fail-closed)', () => {
    // "저자를 모른다" 는 해제 조건이 아니다. 여기로 새면 G1 은 끄는 스위치가 된다.
    assertThrowsExit(
      () => countVotes(base({ authorEmails: [], votes: [ballot('kojh@example.com', 'kojh0124')] })),
      EXIT.UNDECIDABLE,
      '빈 author',
    )
    assertThrowsExit(
      () => countVotes(base({ authorEmails: undefined, votes: [ballot('kojh@example.com', 'kojh0124')] })),
      EXIT.UNDECIDABLE,
      'author 없음',
    )
  })

  it('🔴 해제돼도 G3(표는 커밋에 묶인다)·G4(중복 표)·committer 대조는 그대로 돈다', () => {
    const authorEmails = ['kojh@example.com', 'jaehyun@example.com', 'yeaseung@example.com']
    const r = countVotes(base({
      authorEmails,
      votes: [
        ballot('kojh@example.com', 'kojh0124'),
        // G3 — 헤드가 바뀐 뒤의 표
        vote({ voter: 'masdf13', email: 'jaehyun@example.com', committerEmail: 'jaehyun@example.com', sha: OTHER }),
        // G4 — 같은 사람의 두 번째 표
        ballot('kojh@example.com', 'kojh0124'),
        // committer 대조 — 표의 email 과 커밋 신원이 다르다
        vote({ voter: 'yeaseung', email: 'yeaseung@example.com', committerEmail: 'someone@else.com' }),
        // 브랜치 대조
        vote({ voter: 'kojh0124', email: 'kojh@example.com', committerEmail: 'kojh@example.com', branch: 'feat/other' }),
      ],
    }))
    assert.equal(r.g1Waived, true)
    assert.equal(r.approvals, 1, '해제가 다른 검사까지 열어 버렸다')
    const reasons = r.invalid.map((b) => b.reason).sort()
    assert.deepEqual(reasons, ['committer-mismatch', 'duplicate', 'stale-sha', 'wrong-branch'])
  })

  it('self_vote 가 "off" 면 해제할 것이 없다 — 표식도 안 켠다', () => {
    const r = countVotes(base({
      policy: policy({ self_vote: 'off' }),
      authorEmails: ['kojh@example.com', 'jaehyun@example.com', 'yeaseung@example.com'],
      votes: [ballot('kojh@example.com', 'kojh0124')],
    }))
    assert.equal(r.g1Waived, false)
    assert.equal(r.eligibleCount, 3)
    assert.equal(r.approvals, 1)
  })
})

// ---------------------------------------------------------------------------

describe('deriveVoters — 승계', () => {
  it('살아 있는 사람이 충분하면 승계가 돌지 않는다', () => {
    const r = deriveVoters({ policy: policy(), contributors: livingTeam(), now: NOW, threshold: 2 })
    assert.equal(r.triggered, false)
    assert.equal(r.succeeded.length, 0)
    assert.equal(r.voters.length, 3)
    assert.equal(r.short, 0)
  })

  it('🔴 살아 있는 사람이 필요 표보다 적으면 승계가 발동한다', () => {
    const contributors = [
      { email: 'kojh@example.com', name: '고지혁', at: '2026-08-20T00:00:00Z' }, // 유일한 생존자
      { email: 'new1@example.com', name: '신입1', at: '2026-08-21T00:00:00Z' },
      { email: 'new1@example.com', name: '신입1', at: '2026-08-22T00:00:00Z' },
      { email: 'new2@example.com', name: '신입2', at: '2026-08-23T00:00:00Z' },
      { email: 'new3@example.com', name: '신입3', at: '2026-08-24T00:00:00Z' },
      { email: 'new4@example.com', name: '신입4', at: '2026-08-24T00:00:00Z' },
      { email: 'old@example.com', name: '옛사람', at: '2026-01-01T00:00:00Z' }, // 창 밖
    ]
    const r = deriveVoters({ policy: policy(), contributors, now: NOW, threshold: 2 })
    assert.equal(r.triggered, true)
    assert.equal(r.alive.length, 1)
    assert.equal(r.succeeded.length, 3, '상위 3명만 들어온다')
    assert.equal(r.succeeded[0].email, 'new1@example.com', '커밋이 많은 순')
    assert.ok(!r.succeeded.some((s) => s.email === 'old@example.com'), '창 밖 사람이 들어왔다')
    assert.equal(r.short, 0)
  })

  it('🔴 정책에 적힌 사람은 살아 있지 않아도 투표권을 잃지 않는다', () => {
    // 생사는 "승계를 켤지" 만 정한다. 두 달 자리를 비운 사람이 돌아와 던진 표가
    // 안 세지면 그건 fail-closed 가 아니라 그냥 틀린 판정이다.
    const r = deriveVoters({ policy: policy(), contributors: [], now: NOW, threshold: 2 })
    assert.equal(r.voters.filter((v) => v.via === 'policy').length, 3)
  })

  it('🔴 승계로도 못 채우면 막힌 채로 둔다 — 탈출구를 만들지 않는다', () => {
    const r = deriveVoters({ policy: policy(), contributors: [], now: NOW, threshold: 2 })
    assert.equal(r.triggered, true)
    assert.equal(r.succeeded.length, 0)
    assert.equal(r.short, 2)
  })

  it('🔴 승계를 따져야 하는데 이력을 못 받으면 판정 불가다', () => {
    assertThrowsExit(
      () => deriveVoters({ policy: policy(), contributors: null, now: NOW, threshold: 2 }),
      EXIT.UNDECIDABLE,
      '이력 없이 승계 판정',
    )
  })

  it('승계가 필요 없으면 이력이 없어도 판정한다', () => {
    // 살아 있는 사람이 충분한데 이력 조회가 실패했다고 멈추면 평시가 마비된다.
    const r = deriveVoters({ policy: policy({ default: { threshold: 1 } }), contributors: livingTeam(), now: NOW })
    assert.equal(r.triggered, false)
  })

  it('같은 입력에는 같은 답 — 동점은 결정론적으로 갈린다', () => {
    const tie = [
      { email: 'b@example.com', at: '2026-08-20T00:00:00Z' },
      { email: 'a@example.com', at: '2026-08-20T00:00:00Z' },
    ]
    const p = policy({ succession: { window_days: 90, top: 1 } })
    const first = deriveVoters({ policy: p, contributors: tie, now: NOW, threshold: 2 })
    const again = deriveVoters({ policy: p, contributors: [...tie].reverse(), now: NOW, threshold: 2 })
    assert.deepEqual(first.succeeded.map((s) => s.email), again.succeeded.map((s) => s.email))
  })

  it('🔴 승계로 들어온 사람도 자기 표는 못 센다 (G1)', () => {
    const contributors = [
      { email: 'kojh@example.com', at: '2026-08-20T00:00:00Z' },
      { email: 'new1@example.com', name: '신입1', at: '2026-08-21T00:00:00Z' },
    ]
    const roster = deriveVoters({ policy: policy(), contributors, now: NOW, threshold: 2 })
    assert.ok(roster.succeeded.some((s) => s.email === 'new1@example.com'))

    const r = countVotes({
      policy: policy(),
      voters: roster.voters,
      votes: [vote({ voter: '신입1', email: 'new1@example.com', committerEmail: 'new1@example.com' })],
      authorEmails: ['new1@example.com'], // 승계로 들어온 사람이 이 MR 을 썼다
      sha: HEAD,
      now: NOW,
      branch: BRANCH,
    })
    assert.equal(r.approvals, 0)
    assert.equal(r.invalid[0].reason, 'self-vote')
  })

  it('승계로 들어온 사람은 이름이 명단에 없으므로 email 로만 맞춘다', () => {
    const contributors = [
      { email: 'kojh@example.com', at: '2026-08-20T00:00:00Z' },
      { email: 'new1@example.com', name: '신입1', at: '2026-08-21T00:00:00Z' },
    ]
    const roster = deriveVoters({ policy: policy(), contributors, now: NOW, threshold: 2 })
    const r = countVotes({
      policy: policy(),
      voters: roster.voters,
      votes: [vote({ voter: 'whatever', email: 'new1@example.com', committerEmail: 'new1@example.com' })],
      authorEmails: ['author@example.com'],
      sha: HEAD,
      now: NOW,
      branch: BRANCH,
    })
    assert.equal(r.approvals, 1)
  })
})

// ---------------------------------------------------------------------------

describe('judge — 종료 코드까지', () => {
  const run = (over = {}) => judge({
    policy: policy(),
    changed: ['BE/src/user.py'],
    votes: [
      vote({ voter: 'kojh0124', email: 'kojh@example.com', committerEmail: 'kojh@example.com' }),
      vote({ voter: 'masdf13', email: 'jaehyun@example.com', committerEmail: 'jaehyun@example.com' }),
    ],
    authorEmails: ['yeaseung@example.com'],
    sha: HEAD,
    contributors: livingTeam(),
    now: NOW,
    branch: BRANCH,
    ...over,
  })

  it('정족수를 채우면 0 이다', () => {
    const v = run()
    assert.equal(v.exit, EXIT.OK)
    assert.equal(v.approvals, 2)
    assert.equal(v.threshold, 2)
  })

  it('🔴 미달은 2 다 — "아직 아니다" 이지 고장이 아니다', () => {
    const v = run({ votes: [vote()] })
    assert.equal(v.exit, EXIT.SHORT)
    assert.match(formatVerdict(v), /1표가 필요/)
  })

  it('🔴 판정 불가는 1 이다 — 2 와 섞이면 에이전트가 고장을 기다림으로 읽는다', () => {
    assert.equal(run({ votes: null }).exit, EXIT.UNDECIDABLE)
    assert.equal(run({ changed: [] }).exit, EXIT.UNDECIDABLE)
    assert.equal(run({ policy: null }).exit, EXIT.UNDECIDABLE)
  })

  it('🔴 정책이 깨졌으면 4 다', () => {
    const p = policy()
    p.voters[1].email = p.voters[0].email
    const v = run({ policy: p })
    assert.equal(v.exit, EXIT.POLICY_BROKEN)
    assert.match(formatVerdict(v), /개정 문턱/)
  })

  it('정책 파일을 건드리는 MR 은 개정 문턱을 넘어야 한다', () => {
    const v = run({ changed: ['governance/policy.json'] })
    assert.equal(v.threshold, 3)
    assert.equal(v.exit, EXIT.SHORT)
  })

  it('🔴 승계가 발동하면 출력에 반드시 드러난다 — 조용한 승계는 우회로다', () => {
    const v = run({
      contributors: [
        { email: 'kojh@example.com', at: '2026-08-20T00:00:00Z' },
        { email: 'new1@example.com', name: '신입1', at: '2026-08-21T00:00:00Z' },
      ],
    })
    assert.equal(v.roster.triggered, true)
    const out = formatVerdict(v)
    assert.match(out, /승계 발동/)
    assert.match(out, /신입1/)
  })

  it('🔴 막힌 저장소는 막혔다고 말한다', () => {
    const v = run({ contributors: [], votes: [] })
    assert.equal(v.exit, EXIT.SHORT)
    const out = formatVerdict(v)
    assert.match(out, /막혀 있습니다/)
    assert.match(out, /fork/)
  })

  it('안 센 표는 사유와 함께 출력된다 — 왜 빨간지 사람이 알아야 고친다', () => {
    const v = run({ votes: [vote({ sha: OTHER })] })
    const out = formatVerdict(v)
    assert.match(out, /안 센 표/)
    assert.match(out, /G3/)
  })

  it('🔴 (c) G1 해제는 판정문에 반드시 드러난다 — 조용한 해제는 예외가 아니라 우회로다', () => {
    // 명단 3명이 전원 소스 브랜치의 저자다. 던질 수 있는 사람 0 < 정족수 2.
    const v = run({
      authorEmails: ['kojh@example.com', 'jaehyun@example.com', 'yeaseung@example.com'],
    })
    assert.equal(v.tally.g1Waived, true)
    assert.equal(v.tally.eligibleCount, 0)
    assert.equal(v.tally.threshold, 2)
    // 정족수 자체는 안 바뀐다. 푸는 것은 "누가 던질 수 있는가" 하나다.
    assert.equal(v.threshold, 2)
    assert.equal(v.approvals, 2)
    assert.equal(v.exit, EXIT.OK)

    const out = formatVerdict(v)
    assert.match(out, /G1\(자기 표 배제\)이 해제된 판정입니다/)
    assert.match(out, /유효 투표권자 0명 < 정족수 2/)
    assert.match(out, /정족수 숫자는 그대로입니다/)
    // 해제 덕분에 센 사람의 이름이 남는다.
    assert.match(out, /kojh0124/)
  })

  it('🔴 평시 판정에는 해제 줄이 없다 — 있으면 매 MR 이 예외처럼 보인다', () => {
    const v = run()
    assert.equal(v.tally.g1Waived, false)
    assert.equal(v.tally.eligibleCount, 2) // 저자 1명을 뺀 나머지
    assert.doesNotMatch(formatVerdict(v), /해제된 판정/)
  })

  it('우리 버그는 판정 불가로 위장하지 않는다', () => {
    // GovernanceError 가 아닌 예외는 그대로 올라와야 한다.
    const poison = policy()
    Object.defineProperty(poison, 'rules', { get() { throw new TypeError('boom') } })
    assert.throws(() => judge({
      policy: poison,
      changed: ['a.txt'],
      votes: [],
      authorEmails: ['a@b.com'],
      sha: HEAD,
      contributors: [],
      now: NOW,
    }), TypeError)
  })
})

// ---------------------------------------------------------------------------

/**
 * `self_vote` — 자기 표 배제(G1)의 **범위**.
 *
 * 🔴 여기서 제일 중요한 테스트는 "새 값이 동작한다" 가 아니라 **"필드를 안 적으면
 *    아무것도 안 바뀐다"** 다. 이 옵션이 옛 저장소의 판정을 조용히 바꾸면, 그건
 *    기능이 아니라 우회로다.
 *
 * 시나리오는 팀 저장소에서 실제로 막힌 모양을 그대로 옮겼다 — 투표권자 4명,
 * 그중 3명이 소스 브랜치에 커밋했고, 맨 위 커밋은 그중 한 명이 썼다.
 */
describe('self_vote — 자기 표 배제의 범위', () => {
  /** 투표권자 4명. 실측한 `common/dev` 와 같은 모양이다. */
  const four = (over = {}) => policy({
    voters: [
      { id: 'kojh0124', email: 'kojh@example.com' },
      { id: 'masdf13', email: 'jaehyun@example.com' },
      { id: 'yeaseung', email: 'yeaseung@example.com' },
      { id: 'jinmiri', email: 'jinmiri@example.com' },
    ],
    ...over,
  })

  /** 소스 브랜치에 커밋한 세 사람. 맨 위 커밋은 kojh 가 썼다. */
  const AUTHORS = ['kojh@example.com', 'jaehyun@example.com', 'yeaseung@example.com']
  const TIP = 'kojh@example.com'

  /** kojh(맨 위 커밋의 author)와 jaehyun(그 아래 커밋만 쓴 사람)의 표 둘. */
  const twoVotes = () => [
    vote(),
    vote({ voter: 'masdf13', email: 'jaehyun@example.com', committerEmail: 'jaehyun@example.com' }),
  ]

  const count = (over = {}) => countVotes({
    policy: four(),
    votes: twoVotes(),
    authorEmails: AUTHORS,
    tipAuthorEmail: TIP,
    sha: HEAD,
    now: NOW,
    branch: BRANCH,
    ...over,
  })

  // -- 기본값이 안 바뀐다 -----------------------------------------------

  it('🔴 필드가 없으면 "authors" 다 — 옛 저장소의 판정이 조용히 바뀌면 안 된다', () => {
    assert.equal(DEFAULT_SELF_VOTE, 'authors')
    assert.equal(selfVoteMode({}), 'authors')
    assert.equal(selfVoteMode(null), 'authors')
    assert.equal(selfVoteMode({ self_vote: undefined }), 'authors')
  })

  it('필드가 없으면 소스 브랜치의 모든 author 가 배제된다', () => {
    const r = count()
    assert.equal(r.approvals, 0)
    assert.deepEqual(r.invalid.map((i) => i.reason), ['self-vote', 'self-vote'])
  })

  it('"authors" 를 명시한 결과는 안 적은 것과 완전히 같다', () => {
    const bare = count()
    const named = count({ policy: four({ self_vote: 'authors' }) })
    assert.equal(named.approvals, bare.approvals)
    assert.deepEqual(named.invalid.map((i) => i.reason), bare.invalid.map((i) => i.reason))
  })

  // -- "tip" ------------------------------------------------------------

  it('🔴 "tip" — 맨 위 커밋의 author 만 무효, 그 아래 커밋만 쓴 사람은 유효하다', () => {
    const r = count({ policy: four({ self_vote: 'tip' }) })
    assert.equal(r.approvals, 1)
    assert.equal(r.counted[0].email, 'jaehyun@example.com')
    assert.equal(r.invalid.length, 1)
    assert.equal(r.invalid[0].email, 'kojh@example.com')
    assert.equal(r.invalid[0].reason, 'self-vote')
  })

  it('"tip" 도 대소문자를 접어서 본다', () => {
    const r = count({ policy: four({ self_vote: 'tip' }), tipAuthorEmail: 'KOJH@Example.com' })
    assert.equal(r.approvals, 1)
    assert.equal(r.invalid[0].reason, 'self-vote')
  })

  it('🔴 "tip" 인데 맨 위 커밋의 author 를 못 받으면 판정 불가다 — 미달이 아니다', () => {
    const e = assertThrowsExit(
      () => count({ policy: four({ self_vote: 'tip' }), tipAuthorEmail: null }),
      EXIT.UNDECIDABLE,
      'tip author 없음',
    )
    assert.equal(e.code, 'tip-author-missing')
  })

  // -- "off" ------------------------------------------------------------

  it('"off" — author 여도 표가 유효하다', () => {
    const r = count({ policy: four({ self_vote: 'off' }) })
    assert.equal(r.approvals, 2)
    assert.equal(r.invalid.length, 0)
  })

  // -- authors-missing 가드 ---------------------------------------------

  it('🔴 "authors" · "tip" 에서는 author 목록이 없으면 여전히 안 센다', () => {
    for (const mode of [undefined, 'authors', 'tip']) {
      const p = mode === undefined ? four() : four({ self_vote: mode })
      const e = assertThrowsExit(
        () => count({ policy: p, authorEmails: [] }),
        EXIT.UNDECIDABLE,
        `self_vote=${mode}`,
      )
      assert.equal(e.code, 'authors-missing')
    }
  })

  it('"off" 일 때만 author 목록 없이도 셀 수 있다 — 그때만 안 쓰이기 때문이다', () => {
    const r = count({ policy: four({ self_vote: 'off' }), authorEmails: undefined })
    assert.equal(r.approvals, 2)
  })

  // -- 잘못된 값 ---------------------------------------------------------

  it('🔴 잘못된 값은 정책 검증에서 잡히고 판정 불가(1)다 — 조용한 기본값 대체가 아니다', () => {
    for (const bad of ['tips', 'TIP', 'none', '', true, 3, {}]) {
      const r = validatePolicy(four({ self_vote: bad }))
      assert.equal(r.ok, false, `통과해 버렸다: ${JSON.stringify(bad)}`)
      assert.ok(codes(r).includes('self-vote-invalid'), `코드가 없다: ${JSON.stringify(bad)}`)
      assert.equal(r.exit, EXIT.UNDECIDABLE, `종료 코드가 ${r.exit} 였다: ${JSON.stringify(bad)}`)
    }
  })

  it('세 값은 모두 정책 검증을 통과한다', () => {
    for (const mode of SELF_VOTE_MODES) {
      assert.equal(validatePolicy(four({ self_vote: mode })).ok, true, mode)
    }
  })

  it('정책 검증을 건너뛰고 불러도 조용히 기본값으로 떨어지지 않는다', () => {
    const e = assertThrowsExit(() => selfVoteMode({ self_vote: 'tips' }), EXIT.UNDECIDABLE, 'selfVoteMode')
    assert.equal(e.code, 'self-vote-invalid')
    assertThrowsExit(
      () => majorityThreshold(four().voters, AUTHORS, { selfVote: 'tips' }),
      EXIT.UNDECIDABLE,
      'majorityThreshold',
    )
  })

  // -- 분모 (majorityThreshold) ------------------------------------------

  it('🔴 majorityThreshold 가 세 값에서 각각 맞는 분모를 낸다', () => {
    const voters = four().voters // 4명 중 3명이 author, 맨 위는 kojh
    // authors — 남는 사람 1명 → floor(1/2)+1 = 1
    assert.equal(majorityThreshold(voters, AUTHORS, { selfVote: 'authors' }), 1)
    // tip — 남는 사람 3명 → floor(3/2)+1 = 2
    assert.equal(majorityThreshold(voters, AUTHORS, { selfVote: 'tip', tipAuthorEmail: TIP }), 2)
    // off — 남는 사람 4명 → floor(4/2)+1 = 3
    assert.equal(majorityThreshold(voters, AUTHORS, { selfVote: 'off' }), 3)
  })

  it('🔴 두 인자로 부르던 기존 호출은 그대로 "authors" 다 — 시그니처를 안 깬다', () => {
    const voters = four().voters
    assert.equal(majorityThreshold(voters, AUTHORS), majorityThreshold(voters, AUTHORS, { selfVote: 'authors' }))
  })

  it('"tip" 인데 맨 위 커밋의 author 가 없으면 분모도 못 낸다', () => {
    assertThrowsExit(
      () => majorityThreshold(four().voters, AUTHORS, { selfVote: 'tip' }),
      EXIT.UNDECIDABLE,
      'majorityThreshold tip',
    )
  })

  // -- 분자와 분모가 같은 설정을 본다 -------------------------------------

  const livingFour = () => [
    { email: 'kojh@example.com', name: '고지혁', at: '2026-08-20T00:00:00Z' },
    { email: 'jaehyun@example.com', name: '박재현', at: '2026-08-21T00:00:00Z' },
    { email: 'yeaseung@example.com', name: '이예승', at: '2026-08-22T00:00:00Z' },
    { email: 'jinmiri@example.com', name: '진미리', at: '2026-08-22T00:00:00Z' },
  ]

  /** 문턱을 `"majority"` 로 두면 분모(문턱)와 분자(표)가 같은 설정을 봐야만 맞는다. */
  const judgeMajority = (mode) => judge({
    policy: four({
      self_vote: mode,
      default: { threshold: 'majority' },
      amendment: { paths: ['governance/policy.json'], threshold: 'majority' },
      rules: [],
    }),
    changed: ['BE/src/user.py'],
    votes: twoVotes(),
    authorEmails: AUTHORS,
    tipAuthorEmail: TIP,
    sha: HEAD,
    contributors: livingFour(),
    now: NOW,
    branch: BRANCH,
  })

  it('🔴 judge 에서 문턱과 표가 같은 self_vote 를 본다 — 어긋나면 판정만 조용히 틀린다', () => {
    // authors: 문턱 1, 그런데 셀 수 있는 표가 0장 → 미달
    const a = judgeMajority('authors')
    assert.equal(a.threshold, 1)
    assert.equal(a.approvals, 0)
    assert.equal(a.exit, EXIT.SHORT)

    // tip: 문턱 2, 셀 수 있는 표는 jaehyun 하나 → 아직 미달이지만 셀 수는 있다
    const t = judgeMajority('tip')
    assert.equal(t.threshold, 2)
    assert.equal(t.approvals, 1)
    assert.equal(t.exit, EXIT.SHORT)

    // off: 문턱 3, 표 둘 → 미달
    const o = judgeMajority('off')
    assert.equal(o.threshold, 3)
    assert.equal(o.approvals, 2)
    assert.equal(o.exit, EXIT.SHORT)
  })

  it('🔴 judge 는 잘못된 self_vote 를 정책 단계에서 1 로 막는다', () => {
    const v = judge({
      policy: four({ self_vote: 'tips' }),
      changed: ['BE/src/user.py'],
      votes: [],
      authorEmails: AUTHORS,
      tipAuthorEmail: TIP,
      sha: HEAD,
      contributors: livingFour(),
      now: NOW,
      branch: BRANCH,
    })
    assert.equal(v.stage, 'policy')
    assert.equal(v.exit, EXIT.UNDECIDABLE)
    assert.match(formatVerdict(v), /self-vote-invalid/)
  })

  it('🔴 "tip" 이 잠긴 저장소를 푼다 — 던질 수 있는 사람 1명에서 3명으로', () => {
    /** 이 사람이 혼자 표를 던지면 그 표가 세어지는가. */
    const canVote = (mode, v) => countVotes({
      policy: four({ self_vote: mode }),
      votes: [vote({ voter: v.id, email: v.email, committerEmail: v.email })],
      authorEmails: AUTHORS,
      tipAuthorEmail: TIP,
      sha: HEAD,
      now: NOW,
      branch: BRANCH,
    }).approvals === 1

    const eligible = (mode) => four().voters.filter((v) => canVote(mode, v)).length

    assert.equal(eligible('authors'), 1) // 필요 2표 → 영구히 잠긴다
    assert.equal(eligible('tip'), 3) // 필요 2표 → 풀린다
    assert.equal(eligible('off'), 4)
  })
})

// ---------------------------------------------------------------------------
// 표에 이유를 요구한다 — `vote_note`
//
// 🔴 여기서 재는 것은 **세는 쪽**이다. 쓰는 쪽(`governance/vote.mjs`)의 거부는
//    `test/gate.test.mjs` 가 진짜 저장소에서 본다. 두 층을 나눈 이유는 이 파일
//    머리말에 적힌 것과 같다 — 그리고 **세는 쪽이 진짜 문**이다. 쓰는 쪽만
//    막으면 `git pull` 을 안 한 사람의 옛 vote.mjs 가 그대로 우회한다.
// ---------------------------------------------------------------------------

describe('vote_note — 이유 없는 표는 안 센다', () => {
  /** 시행일이 이미 지난 정책. 표의 `at` 이 2026-08-25 이므로 요구가 발동한다. */
  const strict = (over = {}) => policy({ vote_note: { min_chars: 20, since: '2026-01-01' }, ...over })

  const REASON = '정족수와 투표권자 명단을 안 건드리는 것을 확인했다.'

  const count = (over = {}) => countVotes({
    policy: strict(),
    votes: [vote({ note: REASON })],
    authorEmails: ['dave@example.com'],
    sha: HEAD,
    now: NOW,
    branch: BRANCH,
    ...over,
  })

  const reasonsOf = (r) => r.invalid.map((b) => b.reason)

  it('🔴 필드가 아예 없으면 아무것도 요구하지 않는다 — 옛 저장소의 판정이 안 바뀐다', () => {
    // 이 불변식이 깨지면 axMap 을 올리는 것만으로 남의 저장소에 쌓인 표가
    // 통째로 무효가 된다. self_vote 때와 같은 자리다.
    const r = count({ policy: policy(), votes: [vote()] })
    assert.equal(r.approvals, 1, `vote_note 가 없는데 이유를 요구했다: ${JSON.stringify(r.invalid)}`)
    assert.deepEqual(r.invalid, [])
  })

  it('이유가 충분하면 세진다', () => {
    assert.equal(count().approvals, 1)
  })

  it('이유가 없으면 안 세고, 무효 사유로 보인다', () => {
    const r = count({ votes: [vote()] })
    assert.equal(r.approvals, 0, '이유 없는 표가 세졌다')
    assert.deepEqual(reasonsOf(r), ['note-missing'])
  })

  it('빈 문자열·공백만 적은 것은 이유가 아니다', () => {
    for (const bad of ['', '   ', '\n\t ']) {
      const r = count({ votes: [vote({ note: bad })] })
      assert.equal(r.approvals, 0, `공백을 이유로 셌다: ${JSON.stringify(bad)}`)
      assert.deepEqual(reasonsOf(r), ['note-missing'], JSON.stringify(bad))
    }
  })

  it('min_chars 미만이면 안 센다 — "내용 확인함" 은 이유가 아니라 서명이다', () => {
    const r = count({ votes: [vote({ note: '내용 확인함' })] })
    assert.equal(r.approvals, 0, '여섯 글자짜리 서명이 이유로 세졌다')
    assert.deepEqual(reasonsOf(r), ['note-short'])
    // 몇 글자였고 몇 글자가 필요한지가 보여야 한다. 안 보이면 사람이 얼마나
    // 더 써야 하는지 모른 채 다시 던진다.
    assert.match(r.invalid[0].detail, /6자.*20자/)
  })

  it('길이는 앞뒤 공백을 뗀 뒤에 센다 — 공백으로 길이를 채우지 못한다', () => {
    const padded = `${' '.repeat(40)}짧다${' '.repeat(40)}`
    const r = count({ votes: [vote({ note: padded })] })
    assert.equal(r.approvals, 0, '공백 80자가 이유로 세졌다')
    assert.deepEqual(reasonsOf(r), ['note-short'])
  })

  it('🔴 reject 에도 이유를 요구한다 — 반대야말로 이유가 필요하다', () => {
    const r = count({ votes: [vote({ vote: 'reject' })] })
    assert.deepEqual(reasonsOf(r), ['note-missing'], '이유 없는 반대가 그냥 들어갔다')
    assert.equal(r.rejections.length, 0, '이유 없는 반대가 판정문의 반대 목록에 들어갔다')

    const withReason = count({ votes: [vote({ vote: 'reject', note: REASON })] })
    assert.equal(withReason.rejections.length, 1, '이유 있는 반대까지 사라졌다')
    assert.equal(withReason.approvals, 0)
  })

  it('🔴 소급 금지 — 시행일 이전에 던져진 표는 이유가 없어도 유효하다', () => {
    // 규칙을 고치는 사람이 남의 지난 표를 지울 수 있으면 그건 규칙이 아니다.
    const r = count({
      policy: strict({ vote_note: { min_chars: 20, since: '2026-08-25T05:30:00Z' } }),
      votes: [vote()], // at: 2026-08-25T05:00:00Z — 시행 30분 전
    })
    assert.equal(r.approvals, 1, `시행일 이전의 표를 소급해서 무효로 만들었다: ${JSON.stringify(r.invalid)}`)
  })

  it('시행일 이후의 표는 이유가 없으면 안 센다 — 같은 정책, 같은 사람', () => {
    const r = count({
      policy: strict({ vote_note: { min_chars: 20, since: '2026-08-25T04:30:00Z' } }),
      votes: [vote()], // at: 2026-08-25T05:00:00Z — 시행 30분 뒤
    })
    assert.equal(r.approvals, 0, '시행일 이후인데 이유 없는 표가 세졌다')
    assert.deepEqual(reasonsOf(r), ['note-missing'])
  })

  it('since 를 안 적으면 시행일 제한이 없다 (= 모든 표에 요구)', () => {
    const r = count({ policy: policy({ vote_note: { min_chars: 20 } }), votes: [vote()] })
    assert.deepEqual(reasonsOf(r), ['note-missing'])
  })

  it(`min_chars 를 안 적으면 ${DEFAULT_VOTE_NOTE_MIN_CHARS} — 한 글자라도 적으면 된다`, () => {
    const p = policy({ vote_note: {} })
    const one = (over) => countVotes({
      policy: p, votes: [vote(over)], authorEmails: ['dave@example.com'],
      sha: HEAD, now: NOW, branch: BRANCH,
    }).approvals
    assert.equal(one({ note: '음' }), 1)
    assert.equal(one({}), 0)
  })

  it('🔴 이유 없는 첫 표가 뒤에 온 제대로 된 표를 중복(G4)으로 막지 않는다', () => {
    // 순서가 뒤집히면 사람은 "이미 표를 던졌다" 는 말을 듣고 영원히 못 센다.
    const r = count({
      votes: [
        vote({ at: '2026-08-25T05:00:00Z' }), // 이유 없음
        vote({ at: '2026-08-25T05:10:00Z', note: REASON }), // 다시 던진 것
      ],
    })
    assert.equal(r.approvals, 1, `다시 던진 표가 중복으로 떨어졌다: ${JSON.stringify(r.invalid)}`)
    assert.deepEqual(reasonsOf(r), ['note-missing'])
  })

  it('judge 도 같은 답을 낸다 — 이유가 모자라면 미달(2)이다', () => {
    const base = {
      changed: ['FE/src/pages/Trip.tsx'], // rules → 1표
      authorEmails: ['dave@example.com'],
      sha: HEAD,
      contributors: livingTeam(),
      now: NOW,
      branch: BRANCH,
    }
    const short = judge({ ...base, policy: strict(), votes: [vote()] })
    assert.equal(short.exit, EXIT.SHORT, `이유 없는 표로 통과했다: ${formatVerdict(short)}`)

    const ok = judge({ ...base, policy: strict(), votes: [vote({ note: REASON })] })
    assert.equal(ok.exit, EXIT.OK, formatVerdict(ok))
  })

  it('판정문에 왜 안 셌는지가 보인다 — 안 보이면 아무도 못 고친다', () => {
    const v = judge({
      policy: strict(),
      changed: ['FE/src/pages/Trip.tsx'],
      votes: [vote()],
      authorEmails: ['dave@example.com'],
      sha: HEAD,
      contributors: livingTeam(),
      now: NOW,
      branch: BRANCH,
    })
    assert.match(formatVerdict(v), /이유\(note\)/)
  })
})

describe('vote_note — 정책 검증과 규칙 읽기', () => {
  it('멀쩡한 vote_note 는 통과한다', () => {
    const r = validatePolicy(policy({ vote_note: { min_chars: 20, since: '2026-09-01' } }))
    assert.equal(r.ok, true, JSON.stringify(r.problems))
  })

  it('필드가 없어도 통과한다 — 선택 필드다', () => {
    assert.equal(validatePolicy(policy()).ok, true)
    assert.equal(voteNoteRule(policy()), null)
    assert.equal(voteNoteRule({}), null)
    assert.equal(voteNoteRule(null), null)
  })

  it('🔴 이상한 값은 판정 불가(1)다 — 깨진 정책(4)이 아니다', () => {
    // self_vote 와 같은 등급이다. 이 값이 이상하면 **어떤 표가 유효한지 자체를
    // 모른다.** 그 상태에서 센 숫자는 미달인지 충족인지조차 알 수 없다 (G5).
    const bads = [
      [{ min_chars: 0 }, 'vote-note-min-chars'],
      [{ min_chars: -1 }, 'vote-note-min-chars'],
      [{ min_chars: 2.5 }, 'vote-note-min-chars'],
      [{ min_chars: '20' }, 'vote-note-min-chars'],
      [{ since: '어제' }, 'vote-note-since'],
      [{ since: 20260901 }, 'vote-note-since'],
      ['20', 'vote-note-malformed'],
      [[], 'vote-note-malformed'],
      [true, 'vote-note-malformed'],
    ]
    for (const [bad, code] of bads) {
      const r = validatePolicy(policy({ vote_note: bad }))
      assert.equal(r.ok, false, `안 잡았다: ${JSON.stringify(bad)}`)
      assert.ok(codes(r).includes(code), `${JSON.stringify(bad)} → ${codes(r).join(',')}`)
      assert.equal(r.exit, EXIT.UNDECIDABLE, `${JSON.stringify(bad)} 의 종료 코드가 ${r.exit} 였다`)
    }
  })

  it('voteNoteRule 은 이상한 값에 던진다 — 조용히 기본값으로 안 떨어진다', () => {
    assertThrowsExit(() => voteNoteRule(policy({ vote_note: { min_chars: 0 } })), EXIT.UNDECIDABLE)
    assertThrowsExit(() => voteNoteRule(policy({ vote_note: 'yes' })), EXIT.UNDECIDABLE)
  })

  it('countVotes 도 이상한 vote_note 를 통과시키지 않는다 (검증을 건너뛰고 부르는 쪽)', () => {
    assertThrowsExit(() => countVotes({
      policy: policy({ vote_note: { min_chars: 0 } }),
      votes: [vote()],
      authorEmails: ['dave@example.com'],
      sha: HEAD,
      now: NOW,
      branch: BRANCH,
    }), EXIT.UNDECIDABLE)
  })

  it('voteNoteProblem — 규칙이 없으면 무엇을 줘도 null 이다', () => {
    assert.equal(voteNoteProblem({ note: null, at: '2026-08-25T05:00:00Z', rule: null }), null)
  })

  it('🔴 표에 적힌 note 가 문자열이 아니면 표 자체가 깨진 것이다 (판정 불가)', () => {
    // 빈 문자열은 여기서 안 던진다 — 무효표 한 장이지 MR 전체의 중단이 아니다.
    const one = (over) => countVotes({
      policy: policy(),
      votes: [vote(over)],
      authorEmails: ['dave@example.com'],
      sha: HEAD,
      now: NOW,
      branch: BRANCH,
    })
    assertThrowsExit(() => one({ note: { text: '어쩌고' } }), EXIT.UNDECIDABLE)
    assert.equal(one({ note: '' }).approvals, 1, '빈 note 한 장이 MR 전체를 멈췄다')
  })
})

// ---------------------------------------------------------------------------

describe('명단 없음 — 저장소에 커밋한 사람이 곧 명단이다', () => {
  /** 명단만 지운 정책. 나머지는 평시와 같다. */
  const noRoster = (over = {}) => policy({ voters: [], ...over })

  it('명단이 비어 있어도 정책은 성립한다', () => {
    const r = validatePolicy(noRoster())
    assert.equal(r.ok, true, JSON.stringify(r.problems))
  })

  it('명단 칸이 아예 없어도 성립한다 — 안 적은 것과 비운 것은 같은 뜻이다', () => {
    const p = policy()
    delete p.voters
    assert.equal(validatePolicy(p).ok, true)
  })

  it('🔴 명단이 배열이 아니면 거부한다 — 비운 것과 잘못 적은 것은 다르다', () => {
    assert.ok(codes(validatePolicy(policy({ voters: 'kojh0124' }))).includes('voters-malformed'))
  })

  it('🔴 명단 없이 과반은 거부한다 — 분모가 커밋마다 달라지면 문턱이 아니다', () => {
    const r = validatePolicy(noRoster({ default: { threshold: 'majority' } }))
    assert.equal(r.ok, false)
    assert.ok(codes(r).includes('majority-without-roster'), JSON.stringify(codes(r)))
  })

  it('창 안에 커밋한 사람 전원이 투표권자가 된다', () => {
    const r = deriveVoters({ policy: noRoster(), contributors: livingTeam(), now: NOW, threshold: 2 })
    assert.equal(r.derived, true)
    assert.equal(r.voters.length, 3)
    assert.ok(r.voters.every((v) => v.via === 'contributors'), JSON.stringify(r.voters))
    assert.equal(r.short, 0)
  })

  it('🔴 상위 몇 명으로 자르지 않는다 — 자르는 것은 승계의 일이다', () => {
    // 승계 규칙(top: 3)이 잘못 적용되면 다섯 중 셋만 들어온다.
    const many = ['a', 'b', 'c', 'd', 'e'].map((x, i) => ({
      email: `${x}@example.com`, name: x.toUpperCase(), at: `2026-08-2${i}T00:00:00Z`,
    }))
    const r = deriveVoters({ policy: noRoster(), contributors: many, now: NOW, threshold: 2 })
    assert.equal(r.voters.length, 5, '승계의 상한이 명단에 잘못 적용됐다')
  })

  it('창 밖에서 커밋한 사람은 안 들어온다', () => {
    const r = deriveVoters({
      policy: noRoster(),
      contributors: [...livingTeam(), { email: 'old@example.com', name: '옛사람', at: '2026-01-01T00:00:00Z' }],
      now: NOW,
      threshold: 2,
    })
    assert.ok(!r.voters.some((v) => v.email === 'old@example.com'))
  })

  it('승계는 돌지 않는다 — 메울 빈자리가 없다', () => {
    const r = deriveVoters({ policy: noRoster(), contributors: livingTeam(), now: NOW, threshold: 2 })
    assert.equal(r.triggered, false)
    assert.equal(r.succeeded.length, 0)
  })

  it('🔴 커밋한 사람이 필요 표보다 적으면 막힌 채로 둔다 — 탈출구를 만들지 않는다', () => {
    const one = [{ email: 'kojh@example.com', name: '고지혁', at: '2026-08-20T00:00:00Z' }]
    const r = deriveVoters({ policy: noRoster(), contributors: one, now: NOW, threshold: 2 })
    assert.equal(r.short, 1)
  })

  it('🔴 이력을 못 받으면 판정 불가다 — 모르는 것을 "아무도 없다" 로 읽지 않는다', () => {
    assertThrowsExit(
      () => deriveVoters({ policy: noRoster(), contributors: null, now: NOW, threshold: 2 }),
      EXIT.UNDECIDABLE,
      '명단도 이력도 없이 판정',
    )
  })

  it('같은 입력에는 같은 답 — 이력의 순서가 바뀌어도 명단은 안 흔들린다', () => {
    const c = livingTeam()
    const a = deriveVoters({ policy: noRoster(), contributors: c, now: NOW, threshold: 2 })
    const b = deriveVoters({ policy: noRoster(), contributors: [...c].reverse(), now: NOW, threshold: 2 })
    assert.deepEqual(a.voters.map((v) => v.email), b.voters.map((v) => v.email))
  })

  it('🔴 이름이 달라도 email 로 맞춘다 — git 표시 이름은 PC 마다 흔들린다', () => {
    const p = noRoster()
    const roster = deriveVoters({ policy: p, contributors: livingTeam(), now: NOW, threshold: 2 })
    const r = countVotes({
      policy: p,
      voters: roster.voters,
      votes: [vote({ voter: '전혀 다른 이름', email: 'kojh@example.com', committerEmail: 'kojh@example.com' })],
      authorEmails: ['author@example.com'],
      sha: HEAD,
      now: NOW,
      branch: BRANCH,
    })
    assert.equal(r.approvals, 1, JSON.stringify(r.invalid))
  })

  it('🔴 명단 없이 정해졌다는 사실이 출력에 드러난다 — 조용하면 아무도 모른다', () => {
    const v = judge({
      policy: noRoster(),
      changed: ['BE/src/user.py'],
      votes: [
        vote({ voter: 'kojh0124', email: 'kojh@example.com', committerEmail: 'kojh@example.com' }),
        vote({ voter: 'masdf13', email: 'jaehyun@example.com', committerEmail: 'jaehyun@example.com' }),
      ],
      authorEmails: ['yeaseung@example.com'],
      sha: HEAD,
      contributors: livingTeam(),
      now: NOW,
      branch: BRANCH,
    })
    assert.equal(v.roster.derived, true)
    const out = formatVerdict(v)
    assert.match(out, /명단 없음/)
    assert.match(out, /고지혁/, '누가 투표권자인지가 안 보인다')
  })
})
