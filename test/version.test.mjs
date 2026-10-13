/**
 * 버전 계산. 순수 함수라 시계도 git 도 필요 없다.
 *
 * 🔴 여기서 지키는 것은 **아래 자리를 0 으로 되돌리는 것**이다. 1.2.3 에서 minor 를
 *    올리면 1.3.0 이지 1.3.3 이 아니다. 안 되돌리면 patch 자리가 계속 남아 서로 다른
 *    두 갈래의 이력이 한 숫자에 섞이고, 그때부터 버전은 아무것도 가리키지 않는다.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { levelOf, parseVersion, nextVersion, latestVersion, planBump, formatVersion, partOf, isNonProductPart, NON_PRODUCT_PARTS } from '../src/version.mjs'

describe('브랜치 이름에서 단계를 읽는다', () => {
  it('접두사는 무시한다 — fe/dev 도 be_system/dev 도 dev 다', () => {
    assert.equal(levelOf('dev'), 'dev')
    assert.equal(levelOf('fe/dev'), 'dev')
    assert.equal(levelOf('be_system/dev'), 'dev')
    assert.equal(levelOf('func'), 'func')
    assert.equal(levelOf('ai/func'), 'func')
    assert.equal(levelOf('main'), 'main')
    assert.equal(levelOf('master'), 'main')
  })

  it('기능 브랜치는 단계가 없다 — 버전을 올리지 않는다', () => {
    // feat/S15P21E201-144-login 에서 태그가 붙으면 브랜치마다 번호가 갈린다.
    assert.equal(levelOf('feat/S15P21E201-144-login'), null)
    assert.equal(levelOf('fix/S15P21E201-145-socket'), null)
    assert.equal(levelOf(''), null)
    assert.equal(levelOf(null), null)
  })
})

describe('버전을 읽는다', () => {
  it('v 가 있어도 없어도 읽는다', () => {
    assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3 })
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 })
  })

  it('🔴 못 읽으면 0.0.0 으로 치지 않고 null 이다', () => {
    // 0 으로 떨어뜨리면 이미 나간 번호를 다시 발급하게 되고,
    // 그때부터 같은 번호가 서로 다른 코드를 가리킨다.
    for (const bad of ['v1.2', 'vNext', 'v-old', '1.2.3.4', '', null, undefined]) {
      assert.equal(parseVersion(bad), null, `${bad} 를 버전으로 읽었다`)
    }
  })
})

describe('다음 버전', () => {
  const at = (s) => parseVersion(s)

  it('dev 는 patch 를 올린다 — 1.0.0 → 1.0.1', () => {
    assert.equal(formatVersion(nextVersion(at('1.0.0'), 'dev')), '1.0.1')
    assert.equal(formatVersion(nextVersion(at('1.0.1'), 'dev')), '1.0.2')
  })

  it('🔴 func 는 minor 를 올리고 patch 를 0 으로 되돌린다 — 1.0.3 → 1.1.0', () => {
    assert.equal(formatVersion(nextVersion(at('1.0.3'), 'func')), '1.1.0')
    assert.equal(formatVersion(nextVersion(at('1.1.0'), 'func')), '1.2.0')
  })

  it('🔴 main 은 major 를 올리고 아래를 전부 0 으로 되돌린다 — 1.2.0 → 2.0.0', () => {
    assert.equal(formatVersion(nextVersion(at('1.2.0'), 'main')), '2.0.0')
    assert.equal(formatVersion(nextVersion(at('1.2.7'), 'main')), '2.0.0')
  })

  it('첫 버전은 단계와 무관하게 1.0.0 이다', () => {
    // dev 에서 시작했다고 0.0.1 을 주면 사람이 "아직 아무것도 없다" 로 읽는데,
    // 실제로는 첫 기능이 들어간 상태다.
    for (const lv of ['dev', 'func', 'main']) {
      assert.equal(formatVersion(nextVersion(null, lv)), '1.0.0')
    }
  })

  it('요구한 흐름을 그대로 재현한다 — 하루치 → 다음날 → 한 주 뒤', () => {
    let v = null
    v = nextVersion(v, 'dev');  assert.equal(formatVersion(v), '1.0.0')  // 첫 작업
    v = nextVersion(v, 'dev');  assert.equal(formatVersion(v), '1.0.1')  // 다음 작업
    v = nextVersion(v, 'dev');  assert.equal(formatVersion(v), '1.0.2')
    v = nextVersion(v, 'func'); assert.equal(formatVersion(v), '1.1.0')  // 다음날, dev → func
    v = nextVersion(v, 'dev');  assert.equal(formatVersion(v), '1.1.1')
    v = nextVersion(v, 'func'); assert.equal(formatVersion(v), '1.2.0')  // 그 다음날
    v = nextVersion(v, 'main'); assert.equal(formatVersion(v), '2.0.0')  // 한 주 뒤, func → main
  })

  it('모르는 단계는 거부한다', () => {
    assert.throws(() => nextVersion(parseVersion('1.0.0'), 'feat'), /알 수 없는 단계/)
  })
})

describe('가장 높은 태그를 고른다', () => {
  it('🔴 문자열이 아니라 숫자로 센다 — v1.10.0 이 v1.9.0 보다 높다', () => {
    // 문자열 정렬은 "1.10.0" < "1.9.0" 이라고 답한다. 그대로 믿으면
    // 다음 버전이 이미 나간 번호가 된다.
    const best = latestVersion(['v1.9.0', 'v1.10.0', 'v1.2.0'])
    assert.equal(formatVersion(best), '1.10.0')
  })

  it('버전이 아닌 태그는 건너뛴다', () => {
    const best = latestVersion(['v-old', 'vNext', 'v1.0.0', 'release'])
    assert.equal(formatVersion(best), '1.0.0')
  })

  it('하나도 없으면 null', () => {
    assert.equal(latestVersion([]), null)
    assert.equal(latestVersion(['v-old']), null)
  })
})

describe('planBump — 브랜치와 태그를 합쳐 다음 태그까지', () => {
  it('func 브랜치에서 dev 작업분을 걷어 올린다', () => {
    const p = planBump('fe/func', ['v1.0.0', 'v1.0.1', 'v1.0.2'])
    assert.equal(p.level, 'func')
    assert.equal(p.from, '1.0.2')
    assert.equal(p.tag, 'v1.1.0')
  })

  it('🔴 기능 브랜치에서는 거부한다 — 브랜치마다 번호가 갈리면 버전이 무의미해진다', () => {
    assert.throws(
      () => planBump('feat/S15P21E201-144-login', ['v1.0.0']),
      /버전을 올리는 브랜치가 아닙니다/,
    )
  })
})

/**
 * 🔴 파트 브랜치를 최상위로 읽으면 버전이 무의미해진다.
 *
 * 팀이 실제로 만든 브랜치는 `back/main` · `front/main` 이다 (옛 저장소의
 * `be_system/main` 과 같은 컨벤션). 접두사를 통째로 버리면 이것들이 `main` 과
 * 같아져 **파트에 머지할 때마다 major 가 올라간다.** 하루 두 번이면 이틀 만에
 * 5.0.0 이고, 그 숫자는 아무것도 가리키지 않는다.
 */
describe('최상위 main 과 파트의 main 을 가른다', () => {
  it('🔴 back/main 은 파트 브랜치다 — major 가 아니라 minor', () => {
    assert.equal(levelOf('back/main'), 'func')
    assert.equal(levelOf('front/main'), 'func')
    assert.equal(levelOf('be_system/main'), 'func')
  })

  it('접두사 없는 main 만 최상위다', () => {
    assert.equal(levelOf('main'), 'main')
    assert.equal(levelOf('master'), 'main')
  })

  it('실제 팀 브랜치로 흐름을 재현한다', () => {
    let v = null
    v = nextVersion(v, levelOf('back/dev'));   assert.equal(formatVersion(v), '1.0.0')
    v = nextVersion(v, levelOf('back/dev'));   assert.equal(formatVersion(v), '1.0.1')
    v = nextVersion(v, levelOf('back/main'));  assert.equal(formatVersion(v), '1.1.0')  // 파트로 올림
    v = nextVersion(v, levelOf('front/main')); assert.equal(formatVersion(v), '1.2.0')  // 다른 파트도 minor
    v = nextVersion(v, levelOf('main'));       assert.equal(formatVersion(v), '2.0.0')  // 최상위만 major
  })
})

/**
 * 🔴 파트 브랜치를 최상위로 읽으면 버전이 무의미해진다.
 *
 * 팀이 실제로 만든 브랜치는 `back/main` · `front/main` 이다 (옛 저장소의
 * `be_system/main` 과 같은 컨벤션). 접두사를 통째로 버리면 이것들이 `main` 과
 * 같아져 **파트에 머지할 때마다 major 가 올라간다.** 하루 두 번이면 이틀 만에
 * 5.0.0 이고, 그 숫자는 아무것도 가리키지 않는다.
 */
describe('최상위 main 과 파트의 main 을 가른다', () => {
  it('🔴 back/main 은 파트 브랜치다 — major 가 아니라 minor', () => {
    assert.equal(levelOf('back/main'), 'func')
    assert.equal(levelOf('front/main'), 'func')
    assert.equal(levelOf('be_system/main'), 'func')
  })

  it('접두사 없는 main 만 최상위다', () => {
    assert.equal(levelOf('main'), 'main')
    assert.equal(levelOf('master'), 'main')
  })

  it('실제 팀 브랜치로 흐름을 재현한다', () => {
    let v = null
    v = nextVersion(v, levelOf('back/dev'));   assert.equal(formatVersion(v), '1.0.0')
    v = nextVersion(v, levelOf('back/dev'));   assert.equal(formatVersion(v), '1.0.1')
    v = nextVersion(v, levelOf('back/main'));  assert.equal(formatVersion(v), '1.1.0')  // 파트로 올림
    v = nextVersion(v, levelOf('front/main')); assert.equal(formatVersion(v), '1.2.0')  // 다른 파트도 minor
    v = nextVersion(v, levelOf('main'));       assert.equal(formatVersion(v), '2.0.0')  // 최상위만 major
  })
})

/**
 * 🔴 제품 코드가 없는 파트는 버전을 갖지 않는다.
 *
 * 이 테스트가 지키는 것은 **"고장" 과 "해당 없음" 을 가르는 것**이다.
 * `common/dev` 에서 planBump 가 던지면 CI 의 version 잡이 빨개지는데, 그건
 * 고칠 것이 있다는 뜻이 아니라 여긴 버전이 없다는 뜻이다. 둘을 같은 색으로
 * 칠하면 사람이 매번 "왜 빨간가" 를 다시 찾는다.
 */
describe('제품이 아닌 파트는 버전을 안 갖는다', () => {
  it('common 은 목록에 있다', () => {
    assert.equal(NON_PRODUCT_PARTS.has('common'), true)
    assert.equal(isNonProductPart('common/dev'), true)
    assert.equal(isNonProductPart('common/main'), true)
  })

  it('제품 파트는 그대로다 — 예외가 번지면 아무도 버전을 안 갖는다', () => {
    assert.equal(isNonProductPart('back/dev'), false)
    assert.equal(isNonProductPart('front/main'), false)
    assert.equal(isNonProductPart('bigData/dev'), false)
    assert.equal(isNonProductPart('main'), false)      // 파트가 없다
    assert.equal(isNonProductPart('feat/S15P21E201-144-login'), false)
  })

  it('🔴 planBump 이 던지지 않고 skip 을 준다 — 종료 코드 0 이어야 한다', () => {
    const p = planBump('common/dev', ['v1.2.3'])
    assert.equal(p.skip, true)
    assert.equal(p.part, 'common')
    assert.equal(p.tag, undefined)      // 태그를 만들 거리가 없어야 한다
    assert.match(p.reason, /버전을 올리지 않습니다/)
  })

  it('제품 파트는 여전히 태그를 계산한다', () => {
    assert.equal(planBump('back/dev', ['v1.2.3']).tag, 'v1.2.4')
    assert.equal(planBump('back/main', ['v1.2.3']).tag, 'v1.3.0')
    assert.equal(planBump('main', ['v1.2.3']).tag, 'v2.0.0')
  })

  it('partOf 는 여기가 원본이다 — mrtarget 이 가져다 쓴다', () => {
    assert.equal(partOf('front/dev'), 'front')
    assert.equal(partOf('docs/common/S15P21E201-35-x'), 'docs/common')
    assert.equal(partOf('main'), null)
  })
})
