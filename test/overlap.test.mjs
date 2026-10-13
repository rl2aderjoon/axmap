/**
 * 겹침 경고 테스트.
 *
 * 🔴 이 파일에서 제일 중요한 것은 **"아무것도 없으면 아무 말도 안 한다"** 는 쪽이다.
 *    선점은 하루에 수십 번 도는 자리라, 평소에 조용하지 않으면 사람이 검사를 끈다.
 *    그러면 잡는 건수가 0 이 된다 — 안 만든 것보다 나쁘다.
 *
 *    그리고 **두 검사가 서로를 대신하지 못한다**는 것을 2026-09-10 의 실제 두
 *    사건으로 박아 둔다. 나중에 누가 "하나로 합치자" 고 할 때 이 테스트가 답이다.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compareBranchFor, formatOverlap } from '../src/overlap.mjs'

describe('무엇과 견줄 것인가', () => {
  it('기능 브랜치는 가운데 칸의 파트 dev 와 견준다', () => {
    assert.equal(compareBranchFor('feat/front/S15P21E201-241-photo'), 'front/dev')
    assert.equal(compareBranchFor('fix/back/S15P21E201-816-signup'), 'back/dev')
    assert.equal(compareBranchFor('chore/bigData/S15P21E201-760-price'), 'bigData/dev')
  })

  it('🔴 이미 파트 dev · 파트 브랜치 · 최상위에 있으면 견줄 위쪽이 없다', () => {
    // 없는 것이 고장이 아니다. 여기서 억지로 무언가를 답하면 엉뚱한 것과 견준다.
    assert.equal(compareBranchFor('front/dev'), null)
    assert.equal(compareBranchFor('front/main'), null)
    assert.equal(compareBranchFor('main'), null)
  })

  it('이름이 없거나 파트를 못 읽으면 null', () => {
    assert.equal(compareBranchFor(''), null)
    assert.equal(compareBranchFor(null), null)
    assert.equal(compareBranchFor('team-sync'), null)
  })
})

/**
 * 🔴 **이 검사를 만든 저장소 자신이 이 검사의 보호를 못 받고 있었다.**
 *
 * axMap 의 개발선은 `team-sync` 한 줄이라 브랜치 이름에 파트 칸이 없다. 그래서
 * `compareBranchFor` 가 늘 null 을 냈고, 검사는 **한 번도 돈 적이 없으면서
 * 아무 말도 안 했다.** 그 조용함이 이 파일이 계속 경계하는 바로 그 고장이다.
 *
 * 고친 방법은 **브랜치를 새로 만드는 것이 아니라 견줄 곳을 저장소가 적는 것**이다
 * (git 설정값 `axmap.comparebranch`). 왜 그쪽을 골랐는지는 `src/overlap.mjs`.
 */
describe('🔴 사다리가 없는 저장소는 견줄 곳을 직접 적는다', () => {
  it('설정값이 있으면 그것을 쓴다 — 파트 칸이 없어도 검사가 돈다', () => {
    // axMap 저장소의 실제 모양: 두 칸짜리 브랜치 + `axmap.comparebranch=team-sync`.
    assert.equal(compareBranchFor('fix/bus-local-time', 'team-sync'), 'team-sync')
    assert.equal(compareBranchFor('hotfix/S15P21E201-33-self-vote-scope', 'team-sync'), 'team-sync')
    // 설정값이 슬래시를 품어도 그대로 쓴다 — 판정이 이름을 해석하지 않는다.
    assert.equal(compareBranchFor('feat/g1-quorum-fallback', 'develop/trunk'), 'develop/trunk')
  })

  it('🔴 파트 칸이 먼저다 — 설정값이 파트별 판정을 덮어쓰면 안 된다', () => {
    // 팀 저장소처럼 사다리가 있는 곳에서는 지금 동작이 한 글자도 안 바뀌어야 한다.
    // 설정값을 앞세우면 front 도 back 도 같은 한 곳과 견주게 된다.
    assert.equal(compareBranchFor('feat/front/S15P21E201-241-photo', 'team-sync'), 'front/dev')
    assert.equal(compareBranchFor('fix/back/S15P21E201-816-signup', 'team-sync'), 'back/dev')
  })

  it('🔴 자기 자신과는 안 견준다 — 늘 비어서 있으나 마나 한 검사가 된다', () => {
    // `team-sync` 에 서서 `team-sync` 와 견주면 HEAD..HEAD 라 언제나 0건이다.
    // 그러면 검사가 도는 것처럼 보이면서 아무것도 안 잡는다 — 안 도는 것보다 나쁘다.
    assert.equal(compareBranchFor('team-sync', 'team-sync'), null)
    assert.equal(compareBranchFor('trunk', 'trunk'), null)
    // 공백만 다른 것도 같은 브랜치다 (설정값은 사람이 손으로 적는다).
    assert.equal(compareBranchFor('team-sync', '  team-sync  '), null)
  })

  it('설정값이 비어 있거나 없으면 지금까지와 똑같이 null', () => {
    // git 설정값이 없으면 `--get` 이 아무것도 안 준다. 그 상태가 기본값이다.
    assert.equal(compareBranchFor('fix/bus-local-time'), null)
    assert.equal(compareBranchFor('fix/bus-local-time', ''), null)
    assert.equal(compareBranchFor('fix/bus-local-time', '   '), null)
    assert.equal(compareBranchFor('fix/bus-local-time', null), null)
  })

  it('🔴 이미 위쪽이 없는 자리에서는 설정값도 안 쓴다', () => {
    // `front/dev` 는 "못 읽었다" 가 아니라 "위가 없는 것이 맞다" 이다.
    // 여기에 설정값을 들이면 파트 dev 가 엉뚱한 곳과 견주기 시작한다.
    assert.equal(compareBranchFor('front/dev', 'team-sync'), null)
    assert.equal(compareBranchFor('front/main', 'team-sync'), null)
    assert.equal(compareBranchFor('main', 'team-sync'), null)
  })
})

describe('🔴 겹치는 것이 없으면 한 글자도 안 낸다', () => {
  it('둘 다 비면 null', () => {
    assert.equal(formatOverlap({ compareBranch: 'origin/front/dev', stale: [], unmerged: [] }), null)
  })

  it('인자를 안 줘도 null', () => {
    assert.equal(formatOverlap({ compareBranch: 'origin/front/dev' }), null)
  })
})

describe('두 검사는 서로를 대신하지 못한다 — 2026-09-10 실제 사건', () => {
  /**
   * 20:15 진미리 건. 효준의 작업은 19:46 에 커밋됐지만 front/dev 에 들어간 것은
   * 20:41 이다. 그 사이에는 **어느 dev 에도 없다** — 뒤처짐으로는 못 잡는다.
   */
  it('보이지 않는 창: 뒤처짐은 비어 있고 안 합쳐진 브랜치만 잡는다', () => {
    const msg = formatOverlap({
      compareBranch: 'origin/front/dev',
      stale: [],
      unmerged: [
        {
          hash: 'af63b6fc',
          ref: 'origin/fix/front/S15P21E201-241-camera-mic-leak',
          who: 'janghyojoon',
          subject: '[S15P21E201-241] feat: [Front] 사진첩 목적 문구를 넣고…',
        },
      ],
    })
    assert.ok(msg, '경고가 나와야 한다')
    assert.match(msg, /아직 없는 작업/)
    assert.match(msg, /af63b6fc/)
    assert.match(msg, /camera-mic-leak/)
    assert.doesNotMatch(msg, /내 바탕에는 없는/, '뒤처짐 항목은 뜨면 안 된다')
  })

  /**
   * 22:31 이예승 건. 그때는 이미 20:41 에 머지가 끝나 front/dev 안에 있었다.
   * 안 합쳐진 브랜치로는 못 잡는다 — 이미 합쳐졌기 때문이다.
   */
  it('낡은 바탕: 안 합쳐진 브랜치는 비어 있고 뒤처짐만 잡는다', () => {
    const msg = formatOverlap({
      compareBranch: 'origin/front/dev',
      stale: [
        {
          hash: 'af63b6fc',
          who: 'janghyojoon',
          subject: '[S15P21E201-241] feat: [Front] 사진첩 목적 문구를 넣고…',
        },
      ],
      unmerged: [],
    })
    assert.ok(msg, '경고가 나와야 한다')
    assert.match(msg, /내 바탕에는 없는/)
    assert.match(msg, /af63b6fc/)
    assert.doesNotMatch(msg, /아직 없는 작업/, '안 합쳐진 항목은 뜨면 안 된다')
  })

  it('둘 다 있으면 둘 다 낸다', () => {
    const msg = formatOverlap({
      compareBranch: 'origin/front/dev',
      stale: [{ hash: 'aaaaaaa', who: 'a', subject: 'x' }],
      unmerged: [{ hash: 'bbbbbbb', ref: 'origin/feat/x', who: 'b', subject: 'y' }],
    })
    assert.match(msg, /\[1\]/)
    assert.match(msg, /\[2\]/)
  })
})

describe('경고는 막지 않는다는 것이 문장에 드러난다', () => {
  it('"막지는 않습니다" 가 들어 있다', () => {
    // 🔴 이 문구가 사라지면 사람이 이것을 거부로 읽고 재시도한다.
    //    거부(종료 코드 2)와 조언을 섞으면 에이전트가 엉뚱한 곳을 고친다.
    const msg = formatOverlap({
      compareBranch: 'origin/front/dev',
      stale: [{ hash: 'aaaaaaa', who: 'a', subject: 'x' }],
    })
    assert.match(msg, /막지는 않습니다/)
  })
})

describe('🔴 partOf 를 쓰면 생기던 함정', () => {
  it('기능 브랜치의 파트는 가운데 칸이지 마지막 슬래시 앞이 아니다', () => {
    // partOf('feat/front/S15P21E201-241-photo') 는 'feat/front' 를 준다.
    // 그대로 쓰면 'feat/front/dev' 라는 없는 브랜치와 견주게 되고,
    // 검사는 영원히 조용해진다 — 아무 말도 안 하니 아무도 고장을 모른다.
    assert.equal(compareBranchFor('feat/front/S15P21E201-241-photo'), 'front/dev')
    assert.notEqual(compareBranchFor('feat/front/S15P21E201-241-photo'), 'feat/front/dev')
  })

  it('파트 칸이 없는 두 칸짜리는 견줄 곳이 없다', () => {
    assert.equal(compareBranchFor('hotfix/S15P21E201-33-self-vote-scope'), null)
  })

  it('feature 처럼 다른 접두사여도 가운데 칸을 읽는다', () => {
    assert.equal(compareBranchFor('feature/front/S15P21E201-537-welcome'), 'front/dev')
  })
})
