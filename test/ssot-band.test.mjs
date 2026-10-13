/**
 * 날 숫자를 코퍼스 분포에 대는 부분.
 *
 * 🔴 `go.mod 865회` 를 보고 신입이 할 수 있는 판단은 없다. 865가 많은 건지
 *    원래 그런 건지 알 방법이 없기 때문이다.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bandOf, cellFor } from '../app/lib/ssot.mjs'

const D = { p25: 2, p50: 4, p75: 9, p90: 20, p95: 34, p99: 103, n: 167445 }

describe('bandOf', () => {
  it('띠를 가른다', () => {
    assert.equal(bandOf(D, 200).band, 'top1')
    assert.equal(bandOf(D, 103).band, 'top1')
    assert.equal(bandOf(D, 40).band, 'top5')
    assert.equal(bandOf(D, 25).band, 'top10')
    assert.equal(bandOf(D, 10).band, 'top25')
    assert.equal(bandOf(D, 5).band, 'mid')
    assert.equal(bandOf(D, 3).band, 'low')
    assert.equal(bandOf(D, 1).band, 'bottom')
  })

  it('표본 수를 함께 낸다 — 근거의 크기를 밝힌다', () => {
    assert.equal(bandOf(D, 200).n, 167445)
  })

  it('🔴 분위가 하나라도 비면 판단하지 않는다', () => {
    // 반쪽 분포로 매긴 등수는 등수가 아니다 (fail-closed)
    const half = { ...D, p90: undefined }
    assert.equal(bandOf(half, 200), null)
  })

  it('분포가 없거나 값이 숫자가 아니면 null', () => {
    assert.equal(bandOf(null, 5), null)
    assert.equal(bandOf(D, null), null)
    assert.equal(bandOf(D, NaN), null)
    assert.equal(bandOf(D, '10'), null, '문자열을 숫자로 치환하지 않는다')
  })

  it('🔴 없는 정밀도를 주장하지 않는다', () => {
    // 분위점 사이를 보간해 "상위 3.7%" 라고 쓰면 있지도 않은 정밀도다.
    // 가진 것은 몇 개의 점뿐이므로 띠로만 말한다.
    const labels = new Set([12, 15, 18].map((v) => bandOf(D, v).label))
    assert.equal(labels.size, 1, 'p75~p90 사이는 전부 같은 띠여야 한다')
  })
})

describe('cellFor', () => {
  const base = {
    cells: {
      'go/mid': { usable: true, repos: 237, fileCommits: D },
      'go/large': { usable: false, why: '표본 부족' },
    },
  }

  it('언어·규모로 셀을 찾는다', () => {
    const c = cellFor(base, { lang: 'go', commits: 5000 })
    assert.ok(c)
    assert.equal(c.repos, 237)
  })

  it('🔴 쓸 수 없는 셀은 주지 않는다', () => {
    // 애매하면 거부한다 — 표본이 모자란 셀로 등수를 매기면 그게 거짓말이다.
    // 9000 커밋은 go/large 로 떨어지고, 그 셀은 usable: false 다.
    assert.equal(cellFor(base, { lang: 'go', commits: 9000 }), null)
  })

  it('규모가 코퍼스 범위 밖이면 null', () => {
    // 작은 저장소는 셀 자체가 없다. 없는 셀을 가까운 셀로 치환하지 않는다.
    assert.equal(cellFor(base, { lang: 'go', commits: 10 }), null)
  })

  it('언어를 모르면 null', () => {
    assert.equal(cellFor(base, { lang: null, commits: 5000 }), null)
    assert.equal(cellFor(null, { lang: 'go', commits: 5000 }), null)
  })
})

describe('중앙값 대비 배수', () => {
  const D2 = { p25: 2, p50: 3.1, p75: 9, p90: 16.4, p95: 34, p99: 73.8, n: 244087 }

  it('같은 띠 안에서도 차이를 낸다', () => {
    // 🔴 "가장 자주 바뀌는 곳" 목록은 정의상 전부 상위 1% 라 여섯 줄이
    //    똑같은 말을 한다. 배수가 그 안에서 변별한다.
    const a = bandOf(D2, 865)
    const b = bandOf(D2, 115)
    assert.equal(a.band, b.band, '둘 다 상위 1% 가 맞다')
    assert.ok(Math.round(a.vsMedian) === 279, `279배가 아니라 ${a.vsMedian}`)
    assert.ok(Math.round(b.vsMedian) === 37)
  })

  it('중앙값이 0이면 배수를 만들지 않는다', () => {
    // 0으로 나눈 Infinity 를 "무한배" 라고 쓰면 그건 진술이 아니다
    assert.equal(bandOf({ ...D2, p50: 0 }, 5).vsMedian, null)
  })
})
