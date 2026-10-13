/**
 * MR 대상 검사 테스트.
 *
 * 🔴 이 파일의 대부분은 **음성 테스트**(막아야 하는 것이 실제로 막히는지 보는
 *    테스트)다. 한 번도 실패하지 않는 검사기는 검사기가 아니다.
 *
 *    특히 `front/dev → back/main` 을 빼면 안 된다. 그 조합은 규칙을 대충 짜면
 *    **통과한다** — 둘 다 "dev 에서 파트 브랜치로" 이기 때문이다. 파트를 대조하지
 *    않으면 프론트에서만 검토된 코드가 백엔드 파트의 릴리스 후보로 들어간다.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EXIT, checkTarget, formatCheck, describeBranch, allowedTargetsOf, partOf } from '../src/mrtarget.mjs'

const FEATURE = 'feat/S15P21E201-144-login'

/** 통과해야 하는 것만 따로 모은다. 여기가 비면 규칙이 아니라 벽이다. */
describe('한 칸씩 올라가는 MR 은 통과한다', () => {
  const pass = [
    [FEATURE, 'front/dev'],
    [FEATURE, 'back/dev'],
    ['fix/S15P21E201-145-crash', 'back/dev'],
    ['front/dev', 'front/main'],
    ['front/dev', 'front/func'], // func 은 main 과 같은 자리다
    ['back/dev', 'back/main'],
    ['front/main', 'main'],
    ['back/func', 'main'],
  ]
  for (const [s, t] of pass) {
    it(`${s} → ${t}`, () => {
      const r = checkTarget(s, t)
      assert.equal(r.exit, EXIT.OK, formatCheck(r))
      assert.equal(r.ok, true)
    })
  }
})

describe('건너뛰는 MR 은 막는다', () => {
  const block = [
    // 기능 브랜치가 갈 수 있는 곳은 파트 dev 하나뿐이다.
    [FEATURE, 'main', 'feature-must-target-dev'],
    [FEATURE, 'front/main', 'feature-must-target-dev'],
    [FEATURE, 'back/func', 'feature-must-target-dev'],
    [FEATURE, 'feat/S15P21E201-146-other', 'feature-must-target-dev'],
    // dev 는 같은 파트의 파트 브랜치로만.
    ['front/dev', 'main', 'dev-must-target-part'],
    ['front/dev', 'back/dev', 'dev-must-target-part'],
    // 🔴 파트를 건너뛰는 것 — 규칙을 대충 짜면 여기가 통과한다.
    ['front/dev', 'back/main', 'part-mismatch'],
    ['back/dev', 'front/func', 'part-mismatch'],
    // 파트 브랜치는 최상위로만.
    ['front/main', 'back/main', 'part-must-target-main'],
    ['front/main', 'front/dev', 'part-must-target-main'],
    // 최상위는 종점이다.
    ['main', 'front/dev', 'top-is-terminal'],
    ['main', 'back/main', 'top-is-terminal'],
  ]
  for (const [s, t, code] of block) {
    it(`${s} → ${t} (${code})`, () => {
      const r = checkTarget(s, t)
      assert.equal(r.exit, EXIT.BLOCKED, `통과하면 안 됩니다: ${s} → ${t}`)
      assert.equal(r.code, code)
    })
  }
})

/**
 * 🔴 사다리에 **일부러 낸 구멍** — 그래서 경계를 더 촘촘히 고정한다.
 *
 * 고장 난 것이 `main` 자신일 때(2026-08-26 의 `.gitlab-ci.yml` 무효처럼) 사다리는
 * 막다른 길이 된다. 그 하나를 위해 `hotfix/` 만 최상위로 올라갈 수 있게 열었다.
 * 열어 둔 문은 **정확히 그만큼만** 열려 있어야 하므로 아래를 못 지나가게 고정한다.
 */
describe('긴급 수정만 최상위로 바로 갈 수 있다', () => {
  const HOTFIX = 'hotfix/common/S15P21E201-22-ci-yaml-invalid'

  it(`${HOTFIX} → main`, () => {
    const r = checkTarget(HOTFIX, 'main')
    assert.equal(r.exit, EXIT.OK, formatCheck(r))
  })

  it('긴급 수정도 파트 dev 로는 갈 수 있다 — 좁히지 않는다', () => {
    assert.equal(checkTarget(HOTFIX, 'front/dev').exit, EXIT.OK)
  })

  it('🔴 긴급이라고 아무 데나 가지는 않는다 — 파트 브랜치는 여전히 막힌다', () => {
    const r = checkTarget(HOTFIX, 'front/main')
    assert.equal(r.exit, EXIT.BLOCKED, '파트 브랜치로 건너뛰는 것까지 열면 사다리가 없는 것과 같다')
    assert.equal(r.code, 'feature-must-target-dev')
  })

  it('🔴 이 문은 기능 브랜치에는 안 열린다 — 열렸다면 사다리 전체가 무의미하다', () => {
    assert.equal(checkTarget(FEATURE, 'main').code, 'feature-must-target-dev')
    assert.equal(checkTarget('fix/S15P21E201-145-crash', 'main').code, 'feature-must-target-dev')
  })

  it('🔴 이름이 비슷한 것으로는 안 열린다 — 접두사는 `hotfix/` 정확히', () => {
    for (const s of ['hotfixes/S15P21E201-1-x', 'hotfix-S15P21E201-1-x', 'my-hotfix/S15P21E201-1-x']) {
      assert.equal(checkTarget(s, 'main').exit, EXIT.BLOCKED, `${s} 가 통과하면 안 됩니다`)
    }
  })

  it('갈 수 있는 곳 안내에도 그 문이 보인다', () => {
    assert.match(allowedTargetsOf(HOTFIX), /main/)
    assert.doesNotMatch(allowedTargetsOf(FEATURE), /최상위/)
  })
})

describe('도구 전용 브랜치는 MR 에 안 쓴다', () => {
  // 장부·표는 코드와 이력을 공유하지 않는 고아 브랜치다. 이름이 `<파트>/<이름>`
  // 모양이라 명시적으로 막지 않으면 기능 브랜치로 취급돼 dev 로 올릴 수 있게 된다.
  for (const b of ['axmap/claims', 'axmap/votes']) {
    it(`${b} 는 소스가 될 수 없다`, () => {
      const r = checkTarget(b, 'front/dev')
      assert.equal(r.exit, EXIT.BLOCKED)
      assert.equal(r.code, 'reserved-source')
    })
    it(`${b} 는 대상이 될 수 없다`, () => {
      const r = checkTarget(FEATURE, b)
      assert.equal(r.exit, EXIT.BLOCKED)
      assert.equal(r.code, 'reserved-target')
    })
  }
})

describe('못 재면 통과가 아니다', () => {
  // 🔴 판정 불가(1)와 규칙 위반(2)을 가른다. 뭉치면 에이전트가 환경 고장을
  //    "대상 브랜치를 바꾸면 되는 일" 로 읽고 엉뚱한 곳을 고친다.
  for (const [s, t] of [['', 'main'], [FEATURE, ''], ['', ''], [null, undefined]]) {
    it(`${JSON.stringify(s)} → ${JSON.stringify(t)} 는 판정 불가(1)다`, () => {
      const r = checkTarget(s, t)
      assert.equal(r.exit, EXIT.UNDECIDABLE)
      assert.notEqual(r.exit, EXIT.OK)
    })
  }

  it('공백만 있는 이름도 판정 불가다', () => {
    assert.equal(checkTarget('   ', 'main').exit, EXIT.UNDECIDABLE)
  })

  it('소스와 대상이 같으면 막는다', () => {
    const r = checkTarget('front/dev', 'front/dev')
    assert.equal(r.exit, EXIT.BLOCKED)
    assert.equal(r.code, 'same-branch')
  })
})

describe('거부하면서 갈 수 있는 곳을 함께 말한다', () => {
  // 이유 없는 거부는 같은 요청을 다시 보내게 만든다. 선점 프로토콜이 거부할 때
  // 점유자·작업·남은 시간을 함께 주는 것과 같은 규칙이다.
  it('기능 브랜치를 최상위로 올리면 dev 로 가라고 알려준다', () => {
    const out = formatCheck(checkTarget(FEATURE, 'main'))
    assert.match(out, /dev/)
    assert.match(out, new RegExp(FEATURE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(out, /갈 수 있는 곳/)
  })

  it('판정 불가 출력은 "대상을 바꿔도 안 풀린다" 를 말한다', () => {
    const out = formatCheck(checkTarget('', 'main'))
    assert.match(out, /환경 문제/)
  })
})

describe('브랜치를 사람 말로 옮긴다', () => {
  // 🔴 `back/main` 이 "최상위" 로 나오면 안 된다. 슬래시가 있으면 최상위가 아니다.
  it('최상위와 파트 브랜치를 가른다', () => {
    assert.equal(describeBranch('main'), '최상위')
    assert.equal(describeBranch('back/main'), '파트 브랜치')
    assert.equal(describeBranch('front/func'), '파트 브랜치')
    assert.equal(describeBranch('front/dev'), '파트 개발 브랜치')
    assert.equal(describeBranch(FEATURE), '기능 브랜치')
    assert.equal(describeBranch('axmap/claims'), '도구 전용 브랜치')
  })

  it('파트 이름을 뽑는다', () => {
    assert.equal(partOf('front/dev'), 'front')
    assert.equal(partOf('main'), null)
  })

  it('최상위에서 갈 곳은 없다고 말한다', () => {
    assert.match(allowedTargetsOf('main'), /종점/)
  })
})

/**
 * 🔴 제품 코드가 없는 파트에는 파트 브랜치 단계가 없다.
 *
 * 이 묶음은 **통과가 늘어나는 변경**을 고정한다 (`common/dev → main`).
 * 늘린 이유: `<파트>/main` 의 뜻은 "이 파트의 릴리스 후보" 인데, 릴리스할 제품이
 * 없는 파트에는 그 칸이 비어 있다. 비어 있는 칸을 지나가라고 요구하면 사다리가
 * 막다른 길이 된다 — 2026-08-27 에 팀 문서가 `common/dev` 에서 멈췄다.
 *
 * 늘어난 통과가 공짜가 아니라는 것도 함께 고정한다: 아래 음성 테스트가 빠지면
 * `common/main` 이 다시 생기고 사다리에 아무도 뜻을 모르는 칸이 하나 붙는다.
 */
describe('제품이 아닌 파트는 파트 단계를 건너뛴다', () => {
  it('common/dev → main 은 통과한다', () => {
    const r = checkTarget('common/dev', 'main')
    assert.equal(r.exit, EXIT.OK, formatCheck(r))
  })

  it('기능 브랜치 → common/dev 는 그대로 통과한다', () => {
    const r = checkTarget('docs/common/S15P21E201-35-local-route-v7', 'common/dev')
    assert.equal(r.exit, EXIT.OK, formatCheck(r))
  })

  it('🔴 common/dev → common/main 은 막는다 — 없는 칸을 만들지 않는다', () => {
    const r = checkTarget('common/dev', 'common/main')
    assert.equal(r.exit, EXIT.BLOCKED)
    assert.equal(r.code, 'nonproduct-must-target-top')
  })

  it('🔴 common/main → main 도 막는다 — 그 브랜치가 있다는 것 자체가 실수다', () => {
    const r = checkTarget('common/main', 'main')
    assert.equal(r.exit, EXIT.BLOCKED)
    assert.equal(r.code, 'nonproduct-has-no-part-branch')
  })

  it('🔴 제품 파트는 안 바뀐다 — 예외가 번지면 사다리가 통째로 사라진다', () => {
    assert.equal(checkTarget('back/dev', 'main').code, 'dev-must-target-part')
    assert.equal(checkTarget('front/dev', 'main').code, 'dev-must-target-part')
    assert.equal(checkTarget('bigData/dev', 'main').code, 'dev-must-target-part')
    assert.equal(checkTarget('back/dev', 'back/main').exit, EXIT.OK)
    assert.equal(checkTarget('front/main', 'main').exit, EXIT.OK)
  })

  it('거부하면서 갈 수 있는 곳을 말한다', () => {
    const out = formatCheck(checkTarget('common/dev', 'common/main'))
    assert.match(out, /파트 브랜치 단계가 없/)
    assert.match(out, /최상위/)
  })

  it('allowedTargetsOf 도 같은 답을 준다', () => {
    assert.match(allowedTargetsOf('common/dev'), /최상위/)
    assert.match(allowedTargetsOf('common/main'), /없다/)
    assert.match(allowedTargetsOf('back/dev'), /back\/main/)
  })
})
