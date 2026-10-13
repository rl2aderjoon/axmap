/**
 * PR 화면 (D2) — 네 질문.
 *
 * 이 테스트가 지키는 것은 세 가지다.
 *   ① Q2 의 **방향** — 번짐은 "나를 import 하는 쪽" 이다. 뒤집히면 조용히 다른 답을 낸다.
 *   ② Q3 의 **경계** — 오탐 한 번이면 사람은 이 목록 전체를 무시한다.
 *      그래서 문턱 넷을 각각 위·아래에서 고정한다. 한 번도 실패하지 않는
 *      검사기는 검사기가 아니다.
 *   ③ 못 알아낸 것을 **말한다**는 것. "빠진 것 없음" 과 "판정 못 함" 은 다른 말이다.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  Q3_MIN_CONF, Q3_MIN_FREQ, Q3_MIN_LIFT, Q3_MIN_SUPPORT,
  compareWithUsual, groupChanges, impactedBy, missingCoChanges, normalizeChanged, prReview,
} from '../app/lib/prdiff.mjs'

const node = (id, extra = {}) => ({ id, lang: 'js', lines: 10, ...extra })

// ---------------------------------------------------------------------------

describe('변경 목록 정규화', () => {
  it('문자열도 받고 {path,code} 도 받는다', () => {
    const r = normalizeChanged(['a.mjs', { path: 'b.mjs', code: 'A' }])
    assert.deepEqual(r.map((x) => x.path), ['a.mjs', 'b.mjs'])
    assert.equal(r[0].code, 'M')
    assert.equal(r[1].label, '추가')
  })

  it('역슬래시와 ./ 를 정리하고 같은 파일을 한 번만 낸다', () => {
    // git diff 와 git status 를 둘 다 읽으므로 같은 파일이 두 번 온다.
    // 두 번 세면 Q4 의 "이번 변경 크기" 가 부풀고 Q1 의 파일 수가 틀린다.
    const r = normalizeChanged([{ path: './app\\lib\\x.mjs', where: 'diff' }, { path: 'app/lib/x.mjs', code: 'M', where: 'worktree' }])
    assert.equal(r.length, 1)
    assert.equal(r[0].path, 'app/lib/x.mjs')
    assert.deepEqual(r[0].where.sort(), ['diff', 'worktree'])
  })
})

// ---------------------------------------------------------------------------

describe('Q1 무엇이 바뀌었나', () => {
  it('폴더로 묶고, 그래프에 없는 파일은 따로 뺀다', () => {
    const nodes = [node('app/lib/a.mjs'), node('app/lib/b.mjs'), node('src/c.mjs')]
    const r = groupChanges(normalizeChanged(['app/lib/a.mjs', 'app/lib/b.mjs', 'src/c.mjs', 'README.md']), nodes)
    assert.deepEqual(r.groups.map((g) => g.dir), ['app/lib', 'src'])
    assert.equal(r.groups[0].files.length, 2)
    // 🔴 문서·설정을 조용히 버리면 "영향 없음" 으로 읽힌다.
    assert.deepEqual(r.offGraph.map((c) => c.path), ['README.md'])
  })

  it('🔴 전부 그래프 밖 파일이면 그렇다고 말한다', () => {
    const r = prReview({ changed: ['README.md', 'docs/x.md'], nodes: [node('a.mjs')] })
    assert.match(r.questions[0].gaps.join(' '), /그래프 밖/)
  })

  it('바뀐 것이 없으면 없다고 말한다', () => {
    const r = prReview({ changed: [], nodes: [node('a.mjs')] })
    assert.equal(r.questions[0].answer.total, 0)
    assert.ok(r.questions[0].gaps.length)
  })

  it('🔴 변경이 없으면 나머지 질문은 답처럼 보이는 말을 하지 않는다', () => {
    // 빈 입력에 대고 "이 파일들을 import 하는 곳이 없다 — 진입점이거나 아직
    // 아무도 안 쓰는 새 코드다" 라고 말하고 있었다. 사실도 아니고 답처럼 보인다.
    const r = prReview({ changed: [], nodes: [node('a.mjs')], commits: [] })
    for (const q of r.questions.slice(1)) {
      assert.match(q.headline, /답할 것이 없다/)
      assert.deepEqual(q.gaps, [])
    }
  })
})

// ---------------------------------------------------------------------------

describe('Q2 어디까지 번지나', () => {
  const nodes = ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs'].map((x) => node(x))
  // a → b → c   (a 가 b 를 import, b 가 c 를 import)
  const edges = [
    { source: 'a.mjs', target: 'b.mjs', directed: true, origin: 'both', kind: 'import' },
    { source: 'b.mjs', target: 'c.mjs', directed: true, origin: 'static', kind: 'import' },
  ]

  it('🔴 방향은 역방향이다 — 나를 import 하는 쪽', () => {
    // c 를 고치면 b 가 흔들리고(1겹) 그 다음 a 가 흔들린다(2겹).
    const r = impactedBy(['c.mjs'], edges, { nodes })
    assert.deepEqual(r.layers[0].files.map((f) => f.path), ['b.mjs'])
    assert.deepEqual(r.layers[1].files.map((f) => f.path), ['a.mjs'])
    assert.equal(r.layers[1].files[0].via, 'b.mjs', '어느 파일을 거쳐 닿았는지가 근거다')
  })

  it('🔴 반대로 가지 않는다 — a 를 고쳐도 b·c 는 영향받지 않는다', () => {
    // 흐름 ③ 은 나가는 방향이고 여기는 들어오는 방향이다. 뒤집히면
    // "이 변경이 어디에 영향을 준다" 자리에 "이 변경이 무엇을 쓴다" 가 나온다.
    assert.equal(impactedBy(['a.mjs'], edges, { nodes }).total, 0)
  })

  it('공변경 엣지는 번짐에 쓰지 않는다', () => {
    // 방향이 없어서 "번진다" 를 말할 수 없다. 그건 Q3 의 몫이다.
    const e = [{ source: 'd.mjs', target: 'c.mjs', origin: 'cochange', support: 9 }]
    assert.equal(impactedBy(['c.mjs'], e, { nodes }).total, 0)
  })

  it('허브 경유 엣지도 쓰지 않는다 (D9)', () => {
    const e = [{ source: 'd.mjs', target: 'c.mjs', directed: true, hub: true }]
    assert.equal(impactedBy(['c.mjs'], e, { nodes }).total, 0)
  })

  it('방향을 모르는 엣지는 양쪽으로 통과시킨다', () => {
    const e = [{ source: 'c.mjs', target: 'd.mjs', directed: false, origin: 'static' }]
    assert.equal(impactedBy(['c.mjs'], e, { nodes }).total, 1)
  })

  it('2겹까지만 목록에 넣고, 그 밖은 세기만 한다', () => {
    const ns = ['e0', 'e1', 'e2', 'e3'].map((x) => node(`${x}.mjs`))
    const chain = [
      { source: 'e1.mjs', target: 'e0.mjs', directed: true },
      { source: 'e2.mjs', target: 'e1.mjs', directed: true },
      { source: 'e3.mjs', target: 'e2.mjs', directed: true },
    ]
    const r = impactedBy(['e0.mjs'], chain, { nodes: ns, maxDepth: 2 })
    assert.equal(r.layers.length, 2)
    assert.equal(r.beyond, 1, '3겹은 목록에서 빼되 몇 개인지는 말해야 한다')
  })

  it('🔴 import 를 못 읽은 저장소에서 "번짐 없음" 이라고 단언하지 않는다', () => {
    // syft(Go) 에서 노드의 98.6%가 파싱 실패였는데 화면은 그 상태를 결과처럼
    // 보여줬다. 침묵으로 실패하고 그 침묵을 답으로 내놓는 것이 최악이다.
    const ns = [node('a.go', { confidence: 'unparsed' }), node('b.go', { confidence: 'unparsed' })]
    const r = prReview({ changed: ['a.go'], nodes: ns, edges: [] })
    assert.match(r.questions[1].gaps.join(' '), /읽지 못했다/)
  })

  it('지운 파일을 아직 import 하는 곳이 있으면 경고한다', () => {
    const r = prReview({
      changed: [{ path: 'c.mjs', code: 'D' }],
      nodes,
      edges,
    })
    assert.match(r.questions[1].gaps.join(' '), /지운 파일/)
  })
})

// ---------------------------------------------------------------------------
// Q3 — 문턱의 위·아래를 각각 고정한다.
//
// 여기가 이 화면의 전부다. 오탐이 한 번 나오면 사람은 목록 전체를 무시하고,
// 미탐이 나오면 이 화면이 있을 이유가 없다.
// ---------------------------------------------------------------------------

describe('Q3 같이 바뀌었어야 하는데 안 바뀐 것', () => {
  /** 문턱을 넉넉히 넘는 기준 쌍. 각 테스트는 여기서 하나씩만 흔든다. */
  const edge = (over = {}) => ({
    source: 'changed.mjs', target: 'partner.mjs',
    support: 8, lift: 6, confA: 0.8, confB: 0.8, ...over,
  })
  const freq = { 'changed.mjs': 10, 'partner.mjs': 10 }

  it('평소 함께 바뀌던 파일이 diff 에 없으면 잡는다', () => {
    const r = missingCoChanges(['changed.mjs'], [edge()], freq)
    assert.equal(r.rows.length, 1)
    assert.equal(r.rows[0].path, 'partner.mjs')
    assert.equal(r.rows[0].support, 8)
    assert.equal(r.rows[0].of, 10)
    // 근거를 문장으로 함께 낸다 — 숫자만 주면 아무도 안 읽는다.
    assert.match(r.rows[0].evidence, /지난 10번 중 8번/)
  })

  it('이미 diff 에 있는 파일은 당연히 안 낸다', () => {
    const r = missingCoChanges(['changed.mjs', 'partner.mjs'], [edge()], freq)
    assert.equal(r.rows.length, 0)
  })

  it('양쪽 다 이번 변경과 무관하면 보지도 않는다', () => {
    const r = missingCoChanges(['other.mjs'], [edge()], { ...freq, 'other.mjs': 20 })
    assert.equal(r.stats.considered, 0)
  })

  // ── 문턱 넷, 각각 위와 아래 ──────────────────────────────────────────────

  it(`support 는 ${Q3_MIN_SUPPORT} 부터 낸다 (${Q3_MIN_SUPPORT - 1} 은 안 낸다)`, () => {
    const f = { 'changed.mjs': 8, 'partner.mjs': 8 }
    assert.equal(missingCoChanges(['changed.mjs'], [edge({ support: Q3_MIN_SUPPORT })], f).rows.length, 1)
    const below = missingCoChanges(['changed.mjs'], [edge({ support: Q3_MIN_SUPPORT - 1 })], f)
    assert.equal(below.rows.length, 0)
    assert.equal(below.stats.dropped.support, 1)
  })

  it(`🔴 히스토리 ${Q3_MIN_FREQ}커밋 미만이면 아무 말도 하지 않는다`, () => {
    // conf 는 support/n 이라 n=6, support=6 이면 100% 가 찍힌다. 그건
    // "언제나 함께 바뀐다" 가 아니라 "표본이 6개다" 라는 뜻이다.
    const f = { 'changed.mjs': Q3_MIN_FREQ - 1, 'partner.mjs': 20 }
    const r = missingCoChanges(['changed.mjs'], [edge({ support: 6 })], f)
    assert.equal(r.rows.length, 0)
    assert.deepEqual(r.stats.shortHistory, ['changed.mjs'])

    // 문턱에 닿으면 낸다
    const ok = missingCoChanges(['changed.mjs'], [edge({ support: 6 })], { ...f, 'changed.mjs': Q3_MIN_FREQ })
    assert.equal(ok.rows.length, 1)
  })

  it(`동반율이 ${Q3_MIN_CONF} 미만이면 안 낸다`, () => {
    // 20번 중 9번(45%) — 평소에도 절반 넘게 따로 바뀌던 쌍을 "빠뜨렸다" 고
    // 부르면 그 주장 자체가 틀렸다.
    const f = { 'changed.mjs': 20, 'partner.mjs': 20 }
    const below = missingCoChanges(['changed.mjs'], [edge({ support: 9 })], f)
    assert.equal(below.rows.length, 0)
    assert.equal(below.stats.dropped.conf, 1)
    assert.equal(missingCoChanges(['changed.mjs'], [edge({ support: 10 })], f).rows.length, 1)
  })

  it(`lift 가 ${Q3_MIN_LIFT} 미만이면 안 낸다 — 아무거나와 함께 바뀌는 파일`, () => {
    // CHANGELOG·버전 파일은 전체 커밋의 절반에 등장한다. conf 는 높게 나오지만
    // lift 는 1 근처다. conf 만 보면 모든 PR 마다 같은 오탐이 뜬다.
    const below = missingCoChanges(['changed.mjs'], [edge({ lift: Q3_MIN_LIFT - 0.5 })], freq)
    assert.equal(below.rows.length, 0)
    assert.equal(below.stats.dropped.lift, 1)
    assert.equal(missingCoChanges(['changed.mjs'], [edge({ lift: Q3_MIN_LIFT })], freq).rows.length, 1)
  })

  it('🔴 동반율의 분모는 **바뀐 쪽**이다 (엣지의 source 가 아니다)', () => {
    // 엣지가 반대로 저장돼 있을 때 confA 를 그대로 쓰면 조용히 다른 질문에
    // 답하게 된다. partner 는 100번 바뀌었고 changed 는 10번 바뀌었는데
    // 그중 6번이 함께였다 → "changed 를 고칠 때 60% 는 partner 도 고쳤다" 가
    // 우리가 묻는 것이다. confA(6/100=0.06)를 쓰면 이걸 놓친다.
    const e = { source: 'partner.mjs', target: 'changed.mjs', support: 6, lift: 4, confA: 0.06, confB: 0.6 }
    const f = { 'changed.mjs': 10, 'partner.mjs': 100 }
    const r = missingCoChanges(['changed.mjs'], [e], f)
    assert.equal(r.rows.length, 1, '방향을 뒤집어 잡으면 여기서 0개가 된다')
    assert.equal(r.rows[0].conf, 0.6)
  })

  it('여러 변경 파일이 같은 후보를 가리키면 한 줄로 합치고 근거를 모은다', () => {
    const es = [
      { source: 'x.mjs', target: 'p.mjs', support: 6, lift: 5 },
      { source: 'y.mjs', target: 'p.mjs', support: 9, lift: 5 },
    ]
    const f = { 'x.mjs': 10, 'y.mjs': 10, 'p.mjs': 20 }
    const r = missingCoChanges(['x.mjs', 'y.mjs'], es, f)
    assert.equal(r.rows.length, 1)
    assert.equal(r.rows[0].from, 'y.mjs', '가장 센 근거가 대표가 된다')
    assert.deepEqual(r.rows[0].alsoFrom, ['x.mjs'])
  })

  it('많으면 자르되 몇 개를 잘랐는지 말한다', () => {
    const es = Array.from({ length: 5 }, (_, i) => ({ source: 'c.mjs', target: `p${i}.mjs`, support: 8, lift: 5 }))
    const f = { 'c.mjs': 10 }
    const r = missingCoChanges(['c.mjs'], es, f, { limit: 2 })
    assert.equal(r.rows.length, 2)
    assert.equal(r.truncated, 3)
  })

  it('🔴 "빠진 것 없음" 과 "판정 못 함" 을 구분해서 말한다', () => {
    // 히스토리가 없는 저장소에서 조용히 빈 목록을 내면 사용자는 확인했다고
    // 믿는다. 이 화면이 없는 것보다 나쁜 상태가 정확히 그것이다.
    const none = prReview({ changed: ['a.mjs'], nodes: [node('a.mjs')], coEdges: [], freq: {} })
    assert.match(none.questions[2].gaps.join(' '), /공변경 엣지가 하나도 없다/)

    // 후보는 봤는데 전부 문턱 아래인 경우도 이유를 말한다
    const weak = prReview({
      changed: ['a.mjs'],
      nodes: [node('a.mjs')],
      coEdges: [{ source: 'a.mjs', target: 'b.mjs', support: 3, lift: 9 }],
      freq: { 'a.mjs': 20, 'b.mjs': 20 },
    })
    assert.match(weak.questions[2].gaps.join(' '), /문턱을 넘은 후보가 없다/)
  })

  it('이번에 지운 파일은 후보로 나오지 않는다', () => {
    // "지운 파일을 안 바꿨다" 는 말이 안 된다.
    const r = prReview({
      changed: [{ path: 'a.mjs', code: 'M' }, { path: 'gone.mjs', code: 'D' }],
      nodes: [node('a.mjs')],
      coEdges: [{ source: 'a.mjs', target: 'gone.mjs', support: 9, lift: 8 }],
      freq: { 'a.mjs': 10, 'gone.mjs': 10 },
    })
    assert.equal(r.questions[2].answer.rows.length, 0)
  })
})

// ---------------------------------------------------------------------------

describe('Q4 이번 변경이 평소와 다른가', () => {
  const commits = (n, files) => Array.from({ length: n }, (_, i) => ({ subject: `c${i}`, files }))

  it('평소 커밋 크기를 중앙값으로 재고 이번과 비교한다', () => {
    const past = commits(6, ['a.mjs', 'b.mjs'])
    const r = compareWithUsual(['a.mjs', 'b.mjs'], past)
    assert.equal(r.relatedCommits, 6)
    assert.equal(r.median, 2)
    assert.equal(r.familiarity, 1, '이 쌍은 과거에도 늘 함께 바뀌었다')
  })

  it('🔴 과거 커밋이 적으면 "평소" 라는 말을 하지 않는다', () => {
    // 커밋 두 개로 평균을 내고 "평소보다 넓습니다" 라고 말하는 것은
    // 근거 없는 단정이다.
    const r = prReview({
      changed: ['a.mjs', 'b.mjs', 'c.mjs'],
      nodes: [node('a.mjs'), node('b.mjs'), node('c.mjs')],
      commits: commits(2, ['a.mjs']),
    })
    assert.equal(r.questions[3].answer.flags.length, 0)
    assert.match(r.questions[3].gaps.join(' '), /평소.*말할 수 없다/)
  })

  it('평소보다 훨씬 넓으면 말한다', () => {
    const past = commits(8, ['a.mjs', 'b.mjs'])
    const changed = ['a.mjs', 'b.mjs', 'x1.mjs', 'x2.mjs', 'x3.mjs', 'x4.mjs', 'x5.mjs']
    const r = prReview({ changed, nodes: changed.map((x) => node(x)), commits: past })
    const keys = r.questions[3].answer.flags.map((f) => f.key)
    assert.ok(keys.includes('wide'), JSON.stringify(r.questions[3].answer.flags))
  })

  it('평소 따로 움직이던 것들이 한 번에 들어오면 말한다', () => {
    // 크기는 평소와 같은데 조합이 처음이다 — 관심사가 섞였을 때의 모양이다.
    const past = [
      ...commits(4, ['a.mjs', 'b.mjs']),
      ...commits(4, ['c.mjs', 'd.mjs']),
    ]
    const r = compareWithUsual(['a.mjs', 'c.mjs'], past)
    assert.equal(r.pairsTotal, 1)
    assert.equal(r.pairsSeen, 0)
    assert.equal(r.familiarity, 0)
  })

  it('🔴 쌍이 하나도 없으면 비율은 0% 가 아니라 없음이다', () => {
    // 파일 하나짜리 PR 에서 0% 를 보여주면 "한 번도 같이 안 바뀌었다" 로 읽힌다.
    const r = compareWithUsual(['a.mjs'], commits(5, ['a.mjs']))
    assert.equal(r.pairsTotal, 0)
    assert.equal(r.familiarity, null)
  })

  it('이 파일들과 한 번도 함께 바뀐 적 없는 파일을 짚는다', () => {
    const r = compareWithUsual(['a.mjs', 'new.mjs'], commits(5, ['a.mjs', 'b.mjs']))
    assert.deepEqual(r.firstTime, ['new.mjs'])
  })

  it('변경이 너무 크면 조합 분석을 건너뛰고 그 사실을 말한다', () => {
    const changed = Array.from({ length: 80 }, (_, i) => `f${i}.mjs`)
    const r = prReview({ changed, nodes: changed.map((x) => node(x)), commits: [] })
    assert.equal(r.questions[3].answer.pairable, false)
    assert.match(r.questions[3].gaps.join(' '), /조합 분석은 건너뛰었다/)
  })
})

// ---------------------------------------------------------------------------

describe('네 질문 전체', () => {
  const nodes = ['a.mjs', 'b.mjs', 'c.mjs'].map((x) => node(x))

  it('번호 순서로 넷이 나오고, 각각 질문·근거·gaps 를 갖는다', () => {
    const r = prReview({ changed: ['a.mjs'], nodes })
    assert.deepEqual(r.questions.map((q) => q.n), [1, 2, 3, 4])
    assert.deepEqual(r.questions.map((q) => q.key), ['what', 'spread', 'missing', 'usual'])
    for (const q of r.questions) {
      assert.ok(q.question, `${q.key} 에 질문이 없다`)
      assert.ok(q.why, `${q.key} 에 why 가 없다`)
      assert.ok(q.headline, `${q.key} 에 한 줄 답이 없다`)
      assert.ok(Array.isArray(q.gaps), `${q.key} 에 gaps 가 없다`)
      assert.ok(Array.isArray(q.focus), `${q.key} 에 focus 가 없다`)
    }
  })

  it('전체 gaps 에 어느 질문의 것인지가 붙는다', () => {
    const r = prReview({ changed: [], nodes })
    assert.ok(r.gaps.every((g) => g.q >= 1 && g.q <= 4 && g.text))
  })

  it('실제 모양 한 번 — 바뀐 것 · 번지는 곳 · 빠진 것이 각각 나온다', () => {
    const r = prReview({
      changed: ['b.mjs'],
      nodes,
      edges: [{ source: 'a.mjs', target: 'b.mjs', directed: true, origin: 'both' }],
      coEdges: [{ source: 'b.mjs', target: 'c.mjs', support: 9, lift: 7 }],
      freq: { 'a.mjs': 12, 'b.mjs': 12, 'c.mjs': 12 },
      commits: Array.from({ length: 6 }, () => ({ subject: 'x', files: ['b.mjs', 'c.mjs'] })),
    })
    assert.deepEqual(r.questions[0].focus, ['b.mjs'])
    assert.deepEqual(r.questions[1].focus, ['a.mjs'])
    assert.deepEqual(r.questions[2].focus, ['c.mjs'])
    // 세 집합이 서로 겹치지 않아야 화면에서 색이 뜻을 갖는다
    assert.equal(new Set([...r.questions[0].focus, ...r.questions[1].focus, ...r.questions[2].focus]).size, 3)
  })
})
