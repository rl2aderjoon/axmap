import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveThresholds, dominantLang, DEFAULTS } from '../app/lib/ssot.mjs'

/** python/mid 를 닮은 최소 골격. 숫자는 실제 스냅샷(v6738)에서 가져왔다. */
const baseline = (over = {}) => ({
  at: '2026-08-19T16:23:53.780Z',
  cells: {
    'python/mid': {
      repos: 119,
      usable: true,
      why: null,
      parseCoverage: 0.98,
      fileLines: { p90: 554.39 },
      deg: { p90: 10.49 },
      ...over,
    },
  },
})

const REPO = { lang: 'python', commits: 3303 }

describe('resolveThresholds — 코퍼스 기준을 문턱값으로', () => {
  it('정상 칸이면 코퍼스 분위수를 쓴다', () => {
    const t = resolveThresholds(baseline(), REPO)
    assert.equal(t.splitOver, 554)
    assert.equal(t.hubCap, 10)
    assert.equal(t.cell, 'python/mid')
    assert.equal(t.splitFrom, 'corpus')
    assert.equal(t.hubFrom, 'corpus')
    assert.equal(t.why, null)
    assert.equal(t.repos, 119)
  })

  it('🔴 눈으로 고른 값보다 느슨하다 — 이 변경의 요점이다', () => {
    const t = resolveThresholds(baseline(), REPO)
    assert.ok(t.splitOver > DEFAULTS.splitOver, '300 을 길다고 부르던 것을 고친다')
    assert.ok(t.hubCap > DEFAULTS.hubCap, '6 을 허브라고 부르던 것을 고친다')
  })

  it('기준을 못 받으면 기본값으로 떨어지되 이유를 말한다', () => {
    const t = resolveThresholds(null, REPO)
    assert.deepEqual({ splitOver: t.splitOver, hubCap: t.hubCap }, DEFAULTS)
    assert.equal(t.splitFrom, 'default')
    assert.equal(t.hubFrom, 'default')
    assert.match(t.why, /받지 못했다/)
  })

  it('🔴 히스토리가 얕으면 분포에 넣지 않는다 (커밋 하한 400)', () => {
    const t = resolveThresholds(baseline(), { lang: 'python', commits: 12 })
    assert.equal(t.cell, null)
    assert.deepEqual({ splitOver: t.splitOver, hubCap: t.hubCap }, DEFAULTS)
    assert.match(t.why, /얕다/)
    // 커밋 수를 그대로 보여줘야 사람이 납득한다
    assert.match(t.why, /12/)
  })

  it('주 언어를 모르면 칸을 고르지 않는다', () => {
    const t = resolveThresholds(baseline(), { lang: null, commits: 3303 })
    assert.equal(t.cell, null)
    assert.match(t.why, /주 언어/)
  })

  it('없는 칸이면 그렇다고 말한다', () => {
    const t = resolveThresholds(baseline(), { lang: 'rust', commits: 3303 })
    assert.equal(t.splitFrom, 'default')
    assert.match(t.why, /rust\/mid/)
  })

  it('usable=false 면 코퍼스가 준 이유를 그대로 전한다', () => {
    const b = baseline({ usable: false, why: '저장소 9개 — 하한 15 미달' })
    const t = resolveThresholds(b, REPO)
    assert.equal(t.splitFrom, 'default')
    assert.match(t.why, /하한 15 미달/)
  })

  it('🔴 커버리지가 낮으면 결합만 보류하고 길이는 그대로 쓴다', () => {
    // 루비 8% 같은 경우. 줄 세기는 파서와 무관하므로 같이 버릴 이유가 없다.
    const t = resolveThresholds(baseline({ parseCoverage: 0.08 }), REPO)
    assert.equal(t.splitFrom, 'corpus', '길이는 파서를 안 탄다')
    assert.equal(t.splitOver, 554)
    assert.equal(t.hubFrom, 'default', '결합은 못 읽는 언어에서 0 으로 보인다')
    assert.equal(t.hubCap, DEFAULTS.hubCap)
    assert.match(t.why, /8%/)
  })

  it('커버리지가 경계값이면 통과시킨다 (0.6 은 미달이 아니다)', () => {
    const t = resolveThresholds(baseline({ parseCoverage: 0.6 }), REPO)
    assert.equal(t.hubFrom, 'corpus')
  })

  it('분위수 하나가 망가져도 나머지는 살린다', () => {
    const t = resolveThresholds(baseline({ fileLines: null }), REPO)
    assert.equal(t.splitFrom, 'default')
    assert.equal(t.splitOver, DEFAULTS.splitOver)
    assert.equal(t.hubFrom, 'corpus', '차수는 멀쩡하다')
    assert.equal(t.hubCap, 10)
  })

  it('🔴 0 이나 음수 분위수는 값으로 치지 않는다', () => {
    // 0 을 그대로 쓰면 모든 파일이 "길다" 가 되고 모든 채널이 "허브" 가 된다.
    const t = resolveThresholds(baseline({ fileLines: { p90: 0 }, deg: { p90: -3 } }), REPO)
    assert.equal(t.splitOver, DEFAULTS.splitOver)
    assert.equal(t.hubCap, DEFAULTS.hubCap)
  })

  it('hubCap 은 1 아래로 내려가지 않는다', () => {
    const t = resolveThresholds(baseline({ deg: { p90: 0.4 } }), REPO)
    assert.ok(t.hubCap >= 1)
  })

  it('같은 입력이면 같은 답이다 — 시계를 안 본다', () => {
    const a = resolveThresholds(baseline(), REPO)
    const b = resolveThresholds(baseline(), REPO)
    assert.deepEqual(a, b)
  })
})

describe('dominantLang — 주 언어', () => {
  it('파일 수가 가장 많은 확장자를 고른다', () => {
    assert.equal(dominantLang(['a.py', 'b.py', 'c.js']), 'python')
  })

  it('한 언어의 여러 확장자를 합친다', () => {
    assert.equal(dominantLang(['a.ts', 'b.tsx', 'c.py']), 'typescript')
  })

  it('🔴 모르는 확장자만 있으면 추측하지 않는다', () => {
    assert.equal(dominantLang(['a.txt', 'b.lock', 'Makefile']), null)
  })

  it('빈 목록이면 null', () => {
    assert.equal(dominantLang([]), null)
  })
})

describe('🔴 커버리지가 옛 파서 것인지 말한다', () => {
  /**
   * 보류하는 것만으로는 부족하다. 오늘 파서를 붙여도 그 파서로 다시 잰
   * 저장소가 쌓이기 전까지는 옛 숫자가 나온다. 그 상태에서 "결합 판정 보류"
   * 만 뜨면 사용자는 도구가 그 언어를 영영 못 본다고 읽는다 — 재측정 중인데.
   */
  const base = (coverage) => ({
    at: '2026-08-20T00:00:00.000Z',
    cells: {
      'rust/mid': {
        usable: true, repos: 100, parseCoverage: 0.1, coverage,
        fileLines: { p90: 600 }, deg: { p90: 12 },
      },
    },
  })
  const at = (coverage) => resolveThresholds(base(coverage), { lang: 'rust', commits: 2000 })

  it('재측정 전이면 그렇다고 적는다', () => {
    assert.match(at({ from: 'stale', repos: 0, needs: 15 }).why, /재측정 중/)
  })

  it('모자라면 얼마나 더 재야 하는지 적는다', () => {
    const why = at({ from: 'mixed', repos: 4, needs: 15 }).why
    assert.match(why, /4개뿐/)
    assert.match(why, /15개부터/)
  })

  it('출처를 결과에 싣는다 — 화면이 쓸 수 있어야 한다', () => {
    assert.equal(at({ from: 'mixed', repos: 4, needs: 15 }).coverageFrom, 'mixed')
    assert.equal(at({ from: 'mixed', repos: 4, needs: 15 }).coverageRepos, 4)
  })

  it('코퍼스가 안 알려주면 지어내지 않는다', () => {
    const r = at(undefined)
    assert.equal(r.coverageFrom, null)
    assert.doesNotMatch(r.why, /재측정 중|개부터/)
  })
})

describe('파서가 없는 언어는 기다려도 안 풀린다고 말한다', () => {
  const base = {
    at: '2026-08-20T00:00:00.000Z',
    cells: {
      'swift/mid': {
        usable: true, repos: 100, parseCoverage: 0.09,
        coverage: { from: 'unsupported', repos: 0, needs: 15 },
        fileLines: { p90: 500 }, deg: { p90: 8 },
      },
    },
  }

  it('🔴 "아직 못 쟀다" 와 "읽을 파서가 없다" 를 가른다', () => {
    // 앞엣것은 기다리면 풀리고 뒤엣것은 파서를 만들어야 풀린다.
    // 같은 문구로 쓰면 사람이 기다리기만 한다.
    const why = resolveThresholds(base, { lang: 'swift', commits: 2000 }).why
    assert.match(why, /파서가 아직 없다/)
    assert.match(why, /더 모아도 안 올라간다/)
    assert.doesNotMatch(why, /재측정 중/)
  })
})
