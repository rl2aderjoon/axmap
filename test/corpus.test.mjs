/**
 * 코퍼스 기준(SSOT) 집계.
 *
 * 🔴 이 테스트가 지키는 것은 하나다. **모르는 것을 지어내지 않는다.**
 *
 * 기준은 사람에게 "이렇게 하세요" 라고 말한다. 틀린 기준은 틀린 그래프보다
 * 나쁘다 — 그래프는 안 믿으면 그만이지만, 기준은 코드를 바꾸게 만든다.
 * 그래서 표본이 모자라면 답을 내지 않는 쪽이 언제나 맞다.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  BINS, MIN_REPOS, addLink, addRepo, addTo, binOf, bucketOf, cellKey, cellUsable,
  emptyCell, emptyHist, emptyLink, linkTable, mergeCell, mergeHist, percentileOf,
  quantile, snapshot, trend,
} from '../corpus/stats.mjs'

// ---------------------------------------------------------------------------

describe('히스토그램', () => {
  it('값이 맞는 칸에 들어간다', () => {
    const e = [0, 10, 20, 30]
    assert.equal(binOf(e, 0), 0)
    assert.equal(binOf(e, 9), 0)
    assert.equal(binOf(e, 10), 1)
    assert.equal(binOf(e, 25), 2)
    assert.equal(binOf(e, 999), 3, '마지막은 열린 칸')
  })

  it('숫자가 아니면 세지 않는다', () => {
    // 🔴 null 을 0 으로 치면 분포가 왼쪽으로 쏠린다. 히스토리가 없는 파일을
    //    "완벽한 파일" 로 세는 셈이 된다.
    const h = emptyHist([0, 10, 20])
    addTo(h, null)
    addTo(h, undefined)
    addTo(h, NaN)
    assert.equal(h.n, 0)
  })

  it('합치는 것이 덧셈이다 — 부분 결과를 언제든 합칠 수 있다', () => {
    const a = emptyHist([0, 10, 20]); addTo(a, 5); addTo(a, 15)
    const b = emptyHist([0, 10, 20]); addTo(b, 5)
    const m = mergeHist(a, b)
    assert.equal(m.n, 3)
    assert.deepEqual(m.counts, [2, 1, 0])
  })

  it('분위수가 대략 맞는다', () => {
    const h = emptyHist([0, 100, 200, 300, 400])
    for (let i = 0; i < 100; i++) addTo(h, 50)    // 0~100 칸에 100개
    for (let i = 0; i < 100; i++) addTo(h, 250)   // 200~300 칸에 100개
    assert.ok(quantile(h, 0.25) < 100)
    assert.ok(quantile(h, 0.75) >= 200 && quantile(h, 0.75) <= 300)
  })

  it('🔴 열린 칸에서 바깥으로 외삽하지 않는다', () => {
    // "10,000줄 이상" 을 12,345줄이라고 지어내면 안 된다.
    const h = emptyHist([0, 100])
    for (let i = 0; i < 10; i++) addTo(h, 5000)
    assert.equal(quantile(h, 0.99), 100, '마지막 경계값을 그대로 준다')
  })

  it('빈 히스토그램은 null 이다', () => {
    assert.equal(quantile(emptyHist([0, 10]), 0.5), null)
    assert.equal(percentileOf(emptyHist([0, 10]), 5), null)
  })

  it('백분위를 낸다', () => {
    const h = emptyHist([0, 10, 20, 30])
    for (let i = 0; i < 10; i++) addTo(h, 5)
    for (let i = 0; i < 10; i++) addTo(h, 25)
    const p = percentileOf(h, 25)
    assert.ok(p > 0.5 && p <= 1, `${p}`)
  })
})

// ---------------------------------------------------------------------------

describe('결과 신호 — 이게 "인기 따라하기" 와 가르는 자리', () => {
  it('구간별 평균을 낸다', () => {
    const l = emptyLink([0, 100, 200])
    for (let i = 0; i < 50; i++) addLink(l, 50, 0.1)
    for (let i = 0; i < 50; i++) addLink(l, 150, 0.5)
    const t = linkTable(l, { minPerBin: 10 })
    assert.equal(t[0].mean.toFixed(2), '0.10')
    assert.equal(t[1].mean.toFixed(2), '0.50')
  })

  it('🔴 표본이 적은 구간은 값 대신 null 이다', () => {
    const l = emptyLink([0, 100, 200])
    addLink(l, 50, 0.9)   // 1개뿐
    const t = linkTable(l, { minPerBin: 30 })
    assert.equal(t[0].mean, null, '1개로 평균을 내면 그건 평균이 아니라 그 값이다')
  })

  it('추세가 있으면 up 이라고 말한다', () => {
    const l = emptyLink([0, 100, 200, 300, 400, 500])
    const vals = [0.05, 0.08, 0.12, 0.2, 0.3]
    vals.forEach((v, i) => { for (let k = 0; k < 40; k++) addLink(l, i * 100 + 10, v) })
    const t = trend(l)
    assert.equal(t.usable, true)
    assert.equal(t.direction, 'up')
  })

  it('🔴 관계가 없으면 flat 이라고 말한다 — 없는 지침을 만들지 않는다', () => {
    const l = emptyLink([0, 100, 200, 300, 400, 500])
    for (let i = 0; i < 5; i++) for (let k = 0; k < 40; k++) addLink(l, i * 100 + 10, 0.2)
    assert.equal(trend(l).direction, 'flat')
  })

  it('🔴 구간이 모자라면 판정하지 않는다', () => {
    const l = emptyLink([0, 100, 200, 300])
    for (let k = 0; k < 40; k++) addLink(l, 10, 0.1)
    const t = trend(l)
    assert.equal(t.usable, false)
    assert.match(t.why, /구간/)
  })
})

// ---------------------------------------------------------------------------

describe('적용 조건 — 칸', () => {
  it('언어와 규모로 칸을 가른다', () => {
    assert.equal(cellKey('python', 900), 'python/small')
    assert.equal(cellKey('python', 3000), 'python/mid')
    assert.equal(cellKey('go', 20000), 'go/large')
  })

  it('🔴 규모가 작으면 칸이 없다 — 장난감과 커널을 같은 분포에 넣지 않는다', () => {
    assert.equal(bucketOf(50), null)
    assert.equal(cellKey('python', 50), null)
  })

  it('언어를 모르면 칸이 없다', () => {
    assert.equal(cellKey(null, 3000), null)
  })
})

// ---------------------------------------------------------------------------

describe('표본이 모자라면 답하지 않는다', () => {
  const rec = (n, lines) => ({
    lang: 'python', commits: 3000, parseCoverage: 0.8,
    files: Array.from({ length: n }, () => ({ lines, commits: 5, depth: 2, fanout: 3, fixRate: 0.2 })),
  })

  it('저장소가 적으면 쓸 수 없다', () => {
    const c = emptyCell()
    for (let i = 0; i < 3; i++) addRepo(c, rec(500, 100))
    const u = cellUsable(c)
    assert.equal(u.ok, false)
    assert.match(u.why, new RegExp(String(MIN_REPOS)))
  })

  it('저장소는 많은데 파일이 적어도 쓸 수 없다', () => {
    const c = emptyCell()
    for (let i = 0; i < MIN_REPOS + 5; i++) addRepo(c, rec(2, 100))
    assert.equal(cellUsable(c).ok, false)
  })

  it('둘 다 넉넉하면 쓸 수 있다', () => {
    const c = emptyCell()
    for (let i = 0; i < MIN_REPOS + 1; i++) addRepo(c, rec(50, 100 + i))
    assert.equal(cellUsable(c).ok, true)
  })

  it('스냅샷이 쓸 수 없는 칸도 이유와 함께 낸다', () => {
    const c = emptyCell()
    addRepo(c, rec(10, 100))
    const s = snapshot({ 'python/mid': c }, { at: 'T' })
    assert.equal(s.cells['python/mid'].usable, false)
    assert.ok(s.cells['python/mid'].why)
    // 🔴 근사값이라는 사실을 숨기지 않는다
    assert.equal(s.approx, true)
  })
})

// ---------------------------------------------------------------------------

describe('우리 자신의 커버리지', () => {
  it('🔴 칸마다 파서 커버리지를 함께 낸다', () => {
    // 이걸 안 내면 우리가 못 읽는 언어에서 "결합이 적다" 는 틀린 기준이 나간다.
    // 실측으로 겪었다 — syft(Go) 정적 엣지 1개, baritone(Java) 0개.
    const c = emptyCell()
    for (let i = 0; i < MIN_REPOS + 1; i++) {
      addRepo(c, {
        lang: 'go', commits: 3000, parseCoverage: 0.1,
        files: Array.from({ length: 50 }, () => ({ lines: 100, commits: 3, depth: 2, fanout: 1, fixRate: 0.1 })),
      })
    }
    const s = snapshot({ 'go/mid': c })
    assert.ok(Math.abs(s.cells['go/mid'].parseCoverage - 0.1) < 1e-9)
  })
})

// ---------------------------------------------------------------------------

describe('칸을 합쳐도 결과가 같다 — 중간에 죽어도 이어서 할 수 있다', () => {
  it('나눠 넣고 합친 것과 한 번에 넣은 것이 같다', () => {
    const mk = (lines) => ({
      lang: 'python', commits: 3000, parseCoverage: 0.5,
      files: [{ lines, commits: 4, depth: 1, fanout: 2, fixRate: 0.3 }],
    })
    const whole = emptyCell()
    const a = emptyCell()
    const b = emptyCell()
    for (const v of [10, 50, 120, 400]) { addRepo(whole, mk(v)) }
    for (const v of [10, 50]) addRepo(a, mk(v))
    for (const v of [120, 400]) addRepo(b, mk(v))
    const merged = mergeCell(a, b)
    assert.equal(merged.repos, whole.repos)
    assert.deepEqual(merged.fileLines.counts, whole.fileLines.counts)
    assert.deepEqual(merged.linesToFix.n, whole.linesToFix.n)
  })
})

// ---------------------------------------------------------------------------

describe('🔴 없는 것과 못 센 것을 같은 값으로 말하지 않는다', () => {
  it('countRecords 는 셀 수 없으면 null 을 낸다', async () => {
    // 실측: repos.jsonl 이 958MB 가 되자 readFileSync 가 V8 문자열 한계
    // (Cannot create a string longer than 0x1fffffe8 characters)에 걸려 던졌고,
    // catch 가 그것을 삼켜 0 을 냈다. 화면에는 "기록 0" 으로 떴다 —
    // 저장소 7,107개를 모아둔 채로.
    //
    // 이 저장소가 락에서 뿌리뽑은 fail-open 이 코퍼스 쪽에 그대로 있었다.
    const { countRecords } = await import('../corpus/serve.mjs')
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-count-'))
    try {
      const f = path.join(d, 'r.jsonl')
      // 없는 파일은 진짜로 0 이다 — 0 과 null 의 뜻이 다르다
      assert.equal(countRecords(path.join(d, '없다.jsonl')), 0)
      fs.writeFileSync(f, '{"a":1}\n{"a":2}\n{"a":3}\n')
      assert.equal(countRecords(f), 3)
      // 크기가 그대로면 다시 세지 않는다 (덧붙이기 전용 파일이라 안전하다)
      assert.equal(countRecords(f), 3)
      fs.appendFileSync(f, '{"a":4}\n')
      assert.equal(countRecords(f), 4, '커진 것을 못 알아챘다')
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })
})

describe('🔴 파서 버전별 커버리지', () => {
  /**
   * `parseCoverage` 는 레코드 수만 개의 평균이다. c·rust·ruby 파서를 새로
   * 붙여도 새 레코드 몇백 개로는 평균이 안 움직이고, 결합 판정 게이트는
   * 영원히 안 열린다. 옛 기록은 "그때 우리가 파서가 없었다" 를 말하는데
   * 화면은 그것을 "이 언어는 결합을 볼 수 없다" 로 읽는다.
   */
  const OLD = 'go,java,js,python,ts'
  const NEW = 'c,cpp,go,java,js,python,ruby,rust,ts'
  const cellWith = (oldN, newN) => {
    const c = emptyCell()
    for (let i = 0; i < oldN; i++) addRepo(c, { parseCoverage: 0.08, parser: OLD, files: [] })
    for (let i = 0; i < newN; i++) addRepo(c, { parseCoverage: 0.95, parser: NEW, files: [] })
    return c
  }
  /**
   * 🔴 칸 이름을 `ruby/mid` 로 둔다. 판정이 **칸의 언어**에 달렸기 때문이다 —
   *    OLD 도장에는 ruby 가 없고 NEW 에는 있다. 이름 없는 칸(`x`)으로 두면
   *    어떤 도장도 그 언어를 못 읽는 것이 되어 늘 unsupported 가 된다.
   */
  const cov = (c, parser) => snapshot({ 'ruby/mid': c }, { parser }).cells['ruby/mid']

  it('지금 파서로 잰 것이 충분하면 그것만 쓴다', () => {
    const s = cov(cellWith(20, MIN_REPOS), NEW)
    assert.ok(Math.abs(s.parseCoverage - 0.95) < 1e-9, `${s.parseCoverage}`)
    assert.equal(s.coverage.from, 'current')
    assert.equal(s.coverage.repos, MIN_REPOS)
  })

  it('🔴 모자라면 섞인 평균으로 떨어지되 떨어졌다고 말한다', () => {
    // 조용히 섞으면 새 파서를 붙여도 게이트가 안 열리고 이유를 아무도 모른다
    const s = cov(cellWith(20, 3), NEW)
    assert.ok(s.parseCoverage > 0.08 && s.parseCoverage < 0.95, '섞인 값이어야 한다')
    assert.equal(s.coverage.from, 'mixed')
    assert.equal(s.coverage.repos, 3)
    assert.equal(s.coverage.needs, MIN_REPOS, '얼마나 더 재야 하는지 알려준다')
  })

  it('지금 파서로 잰 것이 하나도 없으면 stale 이라고 말한다', () => {
    const s = cov(cellWith(20, 0), NEW)
    assert.equal(s.coverage.from, 'stale')
    assert.equal(s.coverage.repos, 0)
  })

  it('도장이 없는 옛 레코드도 버리지 않고 unknown 으로 센다', () => {
    // 지어내지 않는다. 파서 버전을 남기기 전에 잰 것이라는 사실 자체가 정보다.
    const c = emptyCell()
    addRepo(c, { parseCoverage: 0.5, files: [] })
    assert.equal(c.coverageBy.unknown.n, 1)
    assert.equal(cov(c, NEW).coverage.from, 'stale')
  })

  it('도장을 안 넘기면 예전처럼 전체 평균', () => {
    // 뒤로 호환된다 — 부르는 쪽이 안 고쳐도 깨지지 않는다
    const s = cov(cellWith(1, 1), null)
    assert.ok(Math.abs(s.parseCoverage - 0.515) < 1e-9)
  })

  it('칸을 합쳐도 버전이 유지된다 — 합치기는 덧셈이다', () => {
    const a = cellWith(0, 2)
    const b = cellWith(0, 3)
    const m = mergeCell(a, b)
    assert.equal(m.coverageBy[NEW].n, 5)
  })
})

describe('🔴 도장은 언어별로 본다 — 통째로가 아니라', () => {
  /**
   * 처음에는 도장 문자열이 정확히 같은 레코드만 셌다. 그래서 c#·php·kotlin·
   * scala 파서를 더한 순간 도장이 바뀌면서 **이미 판정된 21칸이 5칸으로
   * 무너졌다.** ruby/small 은 22개를 재서 100% 로 확정돼 있었는데 21%(옛
   * 기록이 섞인 값)로 되돌아갔다.
   *
   * 파서를 늘릴수록 아는 것이 줄어드는 설계였다. 정반대여야 한다.
   */
  const OLD = 'c,cpp,go,java,js,python,ruby,rust,ts'
  const NEW = 'c,cpp,csharp,go,java,js,kotlin,php,python,ruby,rust,scala,ts'
  const cellOf = (stamp, n, cov = 1) => {
    const c = emptyCell()
    for (let i = 0; i < n; i++) addRepo(c, { parseCoverage: cov, parser: stamp, files: [] })
    return c
  }
  const cov = (key, c, parser) => snapshot({ [key]: c }, { parser }).cells[key].coverage

  it('파서를 더해도 이미 판정된 언어는 그대로다', () => {
    const r = cov('ruby/small', cellOf(OLD, MIN_REPOS + 5), NEW)
    assert.equal(r.from, 'current', 'c# 파서를 붙인 것이 ruby 측정을 무효로 만들었다')
    assert.equal(r.repos, MIN_REPOS + 5)
  })

  it('도장이 달라도 그 언어를 읽었으면 합쳐 센다', () => {
    const c = emptyCell()
    for (let i = 0; i < 8; i++) addRepo(c, { parseCoverage: 1, parser: OLD, files: [] })
    for (let i = 0; i < 8; i++) addRepo(c, { parseCoverage: 1, parser: NEW, files: [] })
    assert.equal(cov('go/mid', c, NEW).repos, 16)
  })

  it('🔴 파서가 없는 언어는 unsupported — 더 모아도 안 올라간다', () => {
    // "아직 못 쟀다" 와 "읽을 파서가 없다" 는 다른 말이다. 앞엣것은 기다리면
    // 풀리고 뒤엣것은 파서를 만들어야 풀린다.
    const r = cov('swift/small', cellOf(NEW, 30, 0.09), NEW)
    assert.equal(r.from, 'unsupported')
    assert.equal(r.repos, 0)
  })

  it('새로 추가된 언어는 그 도장부터 센다', () => {
    // c# 은 NEW 도장에만 있다. OLD 로 잰 것은 근거가 될 수 없다.
    const c = emptyCell()
    for (let i = 0; i < 30; i++) addRepo(c, { parseCoverage: 0.04, parser: OLD, files: [] })
    for (let i = 0; i < 3; i++) addRepo(c, { parseCoverage: 0.5, parser: NEW, files: [] })
    const r = cov('c#/mid', c, NEW)
    assert.equal(r.from, 'mixed')
    assert.equal(r.repos, 3, 'OLD 로 잰 것까지 세면 안 된다')
  })

  it('코퍼스 이름과 파서 이름이 다른 것도 맞춘다', () => {
    // c# → csharp · c++ → cpp · javascript → js · typescript → ts
    for (const [key, n] of [['c#/mid', MIN_REPOS], ['c++/mid', MIN_REPOS],
      ['javascript/mid', MIN_REPOS], ['typescript/mid', MIN_REPOS]]) {
      assert.equal(cov(key, cellOf(NEW, n), NEW).from, 'current', key)
    }
  })
})
