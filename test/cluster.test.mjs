/**
 * 군집기와 채점기 회귀 테스트.
 *
 * 여기 있는 검사 중 셋은 **설계 근거 자체**라 이유 없이 지우지 않는다.
 *
 *   "refine 은 끊어진 블록을 반드시 쪼갠다"
 *       Louvain 대신 Leiden 을 쓰는 이유 전부가 이 한 줄이다.
 *       🔴 처음에는 "Leiden 결과에 끊어진 블록이 없다" 로 썼는데 **Louvain 도
 *       통과했다** (그래프 25종 × 300회, 한 번도 안 갈림). 결과만 보는 검사는
 *       정련이 통째로 사라져도 초록이라 정련의 계약을 직접 본다.
 *
 *   "씨앗이 같으면 답이 같다"
 *       안정성을 재는 도구가 스스로 불안정하면 측정값이 전부 잡음이다.
 *       `Math.random()` 이 어딘가로 들어오면 이 검사가 먼저 죽는다.
 *
 *   "잘게 쪼개도 ARI 가 올라가지 않는다"
 *       일치율 대신 ARI 를 고른 이유. 자가 속으면 모든 숫자가 거짓말이 된다.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildGraph, cluster, labelPropagation, leiden, louvain, quality, refine, rng,
} from '../corpus/cluster.mjs'
import {
  agreement, ari, containment, directoryPartition, LIMITS, rank, shape,
} from '../corpus/clusterscore.mjs'
import { LIMITS as SWEEP_LIMITS, voterCount } from '../corpus/clustersweep.mjs'

// ---------------------------------------------------------------------------
// 거들기
// ---------------------------------------------------------------------------

/** 완전그래프 여러 개를 다리로 이은 그래프. 정답 블록을 우리가 안다. */
function cliques(count, size, { bridges = 1, prefix = 'c' } = {}) {
  const ids = []
  for (let c = 0; c < count; c++) for (let i = 0; i < size; i++) ids.push(`${prefix}${c}/f${i}.js`)
  const edges = []
  const at = (c, i) => `${prefix}${c}/f${i}.js`
  for (let c = 0; c < count; c++) {
    for (let i = 0; i < size; i++) {
      for (let j = i + 1; j < size; j++) edges.push({ source: at(c, i), target: at(c, j), origin: 'static' })
    }
  }
  for (let c = 0; c + 1 < count; c++) {
    for (let b = 0; b < bridges; b++) edges.push({ source: at(c, b), target: at(c + 1, b), origin: 'static' })
  }
  return { ids, edges, truth: Int32Array.from(ids.map((_, i) => Math.floor(i / size))) }
}

/** 블록 안이 실제로 이어져 있는가. Leiden 이 보장한다고 주장하는 바로 그 성질. */
function blocksAreConnected(g, membership) {
  const byBlock = new Map()
  for (let i = 0; i < membership.length; i++) {
    if (!byBlock.has(membership[i])) byBlock.set(membership[i], [])
    byBlock.get(membership[i]).push(i)
  }
  for (const [, nodes] of byBlock) {
    if (nodes.length < 2) continue
    const inBlock = new Set(nodes)
    const seen = new Set([nodes[0]])
    const stack = [nodes[0]]
    while (stack.length) {
      const v = stack.pop()
      for (const w of g.nbr[v]) {
        if (inBlock.has(w) && !seen.has(w)) { seen.add(w); stack.push(w) }
      }
    }
    if (seen.size !== nodes.length) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 그래프 만들기
// ---------------------------------------------------------------------------

test('buildGraph — 문턱을 못 넘은 공변경은 0 이 아니라 아예 없다', () => {
  const ids = ['a.js', 'b.js', 'c.js']
  const g = buildGraph(ids, [
    { source: 'a.js', target: 'b.js', origin: 'cochange', support: 9, lift: 4 },
    { source: 'b.js', target: 'c.js', origin: 'cochange', support: 1, lift: 4 },  // support 미달
    { source: 'a.js', target: 'c.js', origin: 'cochange', support: 9, lift: 0.2 }, // lift 미달
  ], { minSupport: 3, minLift: 1 })

  assert.equal(g.nbr[0].length, 1, 'a 는 b 하고만 이어져야 한다')
  assert.equal(g.nbr[2].length, 0, 'c 는 아무하고도 안 이어진다')
})

test('buildGraph — both 는 공변경이 문턱을 못 넘어도 정적 엣지로 남는다', () => {
  const ids = ['a.js', 'b.js']
  const g = buildGraph(ids, [
    { source: 'a.js', target: 'b.js', origin: 'both', support: 1, lift: 9 },
  ], { minSupport: 3 })
  assert.equal(g.nbr[0].length, 1)
  assert.equal(g.wgt[0][0], 1, 'import 은 살아 있어야 한다')
})

test('buildGraph — coWeight 가 공변경의 발언권을 실제로 바꾼다', () => {
  const ids = ['a.js', 'b.js']
  const e = [{ source: 'a.js', target: 'b.js', origin: 'cochange', support: 20, lift: 5 }]
  const quiet = buildGraph(ids, e, { coWeight: 0.1 })
  const loud = buildGraph(ids, e, { coWeight: 10 })
  assert.ok(loud.wgt[0][0] > quiet.wgt[0][0] * 50, '배율이 무게에 그대로 실려야 한다')
})

test('buildGraph — 같은 쌍이 여러 번 나와도 엣지는 하나다', () => {
  const ids = ['a.js', 'b.js']
  const g = buildGraph(ids, [
    { source: 'a.js', target: 'b.js', origin: 'static' },
    { source: 'b.js', target: 'a.js', origin: 'static' },
  ])
  assert.equal(g.nbr[0].length, 1, '방향만 뒤집힌 중복은 합쳐져야 한다')
})

// ---------------------------------------------------------------------------
// 알고리즘이 아는 구조를 찾아내는가
// ---------------------------------------------------------------------------

for (const name of ['leiden', 'louvain', 'labelprop']) {
  test(`${name} — 다리 하나로 이은 완전그래프 셋을 셋으로 나눈다`, () => {
    const { ids, edges, truth } = cliques(3, 7)
    const g = buildGraph(ids, edges)
    const { membership } = cluster(name, g, { seed: 7 })
    assert.equal(shape(membership).usableBlocks, 3)
    assert.ok(ari(membership, truth) > 0.95, `정답과 거의 같아야 한다 (ARI ${ari(membership, truth)})`)
  })
}

test('Leiden — 블록 안이 끊어져 있지 않다', () => {
  const { ids, edges } = cliques(6, 5, { bridges: 2 })
  const g = buildGraph(ids, edges)
  for (let seed = 1; seed <= 12; seed++) {
    const { membership } = leiden(g, { seed, resolution: 0.6 })
    assert.ok(blocksAreConnected(g, membership), `씨앗 ${seed} 에서 블록이 끊어졌다`)
  }
})

/**
 * 🔴 위 검사만으로는 부족하다 — **Louvain 도 통과한다.**
 *
 * 계획군집·허브·다리 모양 25종을 300회 돌려봤지만 Louvain 이 블록을 끊어놓는
 * 경우를 한 번도 못 만들었다. 즉 저 검사는 Leiden 을 쓰는 이유를 증명하지
 * 못한다. 그러면 정련이 통째로 no-op 이 되어도 초록이다.
 *
 * 그래서 정련의 **계약을 직접** 검사한다. 아래 둘이 진짜 판별기다.
 */
test('refine — 끊어진 블록을 받으면 반드시 쪼갠다', () => {
  // 서로 안 닿는 삼각형 둘을 한 블록이라고 우겨서 넣는다.
  const ids = ['a/0.js', 'a/1.js', 'a/2.js', 'b/0.js', 'b/1.js', 'b/2.js']
  const edges = []
  for (const p of ['a', 'b']) {
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      edges.push({ source: `${p}/${i}.js`, target: `${p}/${j}.js`, origin: 'static' })
    }
  }
  const g = buildGraph(ids, edges)
  const base = Int32Array.from([0, 0, 0, 0, 0, 0])

  const out = refine(g, base, { resolution: 1, objective: 'modularity', rand: rng(3), theta: 0.01 })
  // 두 삼각형이 같은 하위블록에 들어가면 정련이 일을 안 한 것이다.
  for (let i = 0; i < 3; i++) for (let j = 3; j < 6; j++) {
    assert.notEqual(out[i], out[j], `안 이어진 ${ids[i]} 와 ${ids[j]} 가 한 덩어리가 됐다`)
  }
})

test('refine — 원래 블록 경계를 넘지 않는다', () => {
  const { ids, edges } = cliques(4, 5)
  const g = buildGraph(ids, edges)
  const base = Int32Array.from(ids.map((_, i) => Math.floor(i / 5)))
  const out = refine(g, base, { resolution: 0.5, objective: 'modularity', rand: rng(11), theta: 0.01 })
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (out[i] === out[j]) {
      assert.equal(base[i], base[j], `정련이 블록 ${base[i]} 와 ${base[j]} 를 섞었다`)
    }
  }
})

test('씨앗이 같으면 답이 같다 — 세 알고리즘 모두', () => {
  const { ids, edges } = cliques(4, 6)
  const g = buildGraph(ids, edges)
  for (const name of ['leiden', 'louvain', 'labelprop']) {
    const a = cluster(name, g, { seed: 42 }).membership
    const b = cluster(name, g, { seed: 42 }).membership
    assert.deepEqual([...a], [...b], `${name} 이 같은 씨앗에서 다른 답을 냈다`)
  }
})

test('rng — 씨앗이 다르면 순서가 다르다', () => {
  const a = Array.from({ length: 8 }, rng(1))
  const b = Array.from({ length: 8 }, rng(2))
  assert.notDeepEqual(a, b)
})

test('해상도를 올리면 블록이 잘게 쪼개진다', () => {
  const { ids, edges } = cliques(8, 6)
  const g = buildGraph(ids, edges)
  const low = shape(leiden(g, { resolution: 0.2, seed: 5 }).membership).usableBlocks
  const high = shape(leiden(g, { resolution: 3, seed: 5 }).membership).usableBlocks
  assert.ok(high >= low, `γ 를 올렸는데 블록이 줄었다 (${low} → ${high})`)
})

test('CPM 과 modularity 는 서로 다른 분할을 낼 수 있다', () => {
  const { ids, edges } = cliques(6, 5)
  const g = buildGraph(ids, edges)
  const m = leiden(g, { objective: 'modularity', resolution: 1, seed: 3 }).membership
  const c = leiden(g, { objective: 'cpm', resolution: 0.05, seed: 3 }).membership
  assert.ok(shape(m).usableBlocks >= 1 && shape(c).usableBlocks >= 1)
  // 둘 다 뭔가는 찾아야 한다. 한쪽이 통째로 실패하면 목적함수 배선이 잘못된 것이다.
  assert.ok(ari(m, c) > 0, '목적함수를 바꿨더니 아무 관계도 없는 답이 나왔다')
})

test('quality — 정답 분할이 아무렇게나 나눈 것보다 점수가 높다', () => {
  const { ids, edges, truth } = cliques(4, 6)
  const g = buildGraph(ids, edges)
  const junk = Int32Array.from(ids.map((_, i) => i % 4))
  assert.ok(quality(g, truth) > quality(g, junk), '모듈도가 구조를 못 알아본다')
})

test('cluster() 는 모르는 이름을 기본값으로 삼키지 않는다', () => {
  const g = buildGraph(['a.js'], [])
  assert.throws(() => cluster('leidenn', g), /모르는 군집 알고리즘/)
})

// ---------------------------------------------------------------------------
// 채점기
// ---------------------------------------------------------------------------

test('ARI — 이름만 바꾼 같은 분할은 1 이다', () => {
  const a = Int32Array.from([0, 0, 1, 1, 2, 2])
  const b = Int32Array.from([5, 5, 9, 9, 3, 3])
  assert.equal(ari(a, b), 1)
})

test('ARI — 잘게 쪼개서 일치를 부풀릴 수 없다', () => {
  const truth = Int32Array.from([0, 0, 0, 1, 1, 1])
  const allAlone = Int32Array.from([0, 1, 2, 3, 4, 5])
  // 단순 "같은 블록인가" 일치율이면 전부 혼자일 때 쌍의 대부분이 맞다고 나온다.
  // ARI 는 우연의 몫을 빼므로 0 근처여야 한다.
  assert.ok(Math.abs(ari(truth, allAlone)) < 0.15, `ARI ${ari(truth, allAlone)}`)
})

test('ARI — 전부 한 덩어리도 부풀지 않는다', () => {
  const truth = Int32Array.from([0, 0, 0, 1, 1, 1])
  const oneBlob = Int32Array.from([0, 0, 0, 0, 0, 0])
  assert.ok(Math.abs(ari(truth, oneBlob)) < 0.15)
})

test('shape — 부스러기에 가린 얼룩을 잡아낸다', () => {
  // 블록은 11개지만 하나가 70%를 갖고 있다. 개수만 세면 이 사실이 안 보인다.
  const m = Int32Array.from([...Array(70).fill(0), ...Array(10).keys()].map((v, i) => (i < 70 ? 0 : v + 1)))
  const s = shape(m)
  assert.ok(s.blocks > 10)
  assert.ok(s.maxShare > 0.6, `maxShare ${s.maxShare}`)
  assert.ok(s.usableBlocks < 2, '혼자인 것은 블록으로 세지 않는다')
})

test('containment — 만드는 데 안 쓴 엣지로 잰다', () => {
  const ids = ['a.js', 'b.js', 'c.js', 'd.js']
  const m = Int32Array.from([0, 0, 1, 1])
  const future = [
    { source: 'a.js', target: 'b.js', support: 10 },   // 같은 블록 — 맞힘
    { source: 'c.js', target: 'd.js', support: 10 },   // 같은 블록 — 맞힘
    { source: 'a.js', target: 'd.js', support: 20 },   // 블록을 넘음 — 놓침
  ]
  const r = containment(ids, future, m)
  assert.equal(r.pairs, 3)
  assert.equal(r.unweighted, 2 / 3)
  assert.equal(r.weighted, 20 / 40, 'support 무게가 반영돼야 한다')
})

test('directoryPartition — 최상위 폴더로 나눈다', () => {
  const ids = ['src/a.js', 'src/b.js', 'test/c.js']
  const d = directoryPartition(ids)
  assert.equal(d[0], d[1])
  assert.notEqual(d[0], d[2])
})

test('agreement — 평균만이 아니라 최악도 낸다', () => {
  const runs = [
    Int32Array.from([0, 0, 1, 1]),
    Int32Array.from([0, 0, 1, 1]),
    Int32Array.from([0, 1, 0, 1]),
  ]
  const a = agreement(runs)
  assert.equal(a.n, 3)
  assert.ok(a.min < a.mean, '한 번의 붕괴가 평균에 묻히면 안 된다')
})

// ---------------------------------------------------------------------------
// 고르기 — 제약을 먼저, 목적은 하나
// ---------------------------------------------------------------------------

const candidate = (over) => ({
  shape: { blocks: 8, usableBlocks: 8, maxShare: 0.2, singletonShare: 0.1, entropy: 0.9, medSize: 5 },
  stability: { mean: 0.8, min: 0.7, n: 3 },
  dirAgreement: 0.3,
  heldOut: { weighted: 0.5, unweighted: 0.5, pairs: 100 },
  ...over,
})

test('rank — 예측력이 높아도 불안정하면 뽑히지 않는다', () => {
  const r = rank([
    candidate({ heldOut: { weighted: 0.9, pairs: 10 }, stability: { mean: 0.1, min: 0.05, n: 3 }, label: '불안정' }),
    candidate({ heldOut: { weighted: 0.5, pairs: 10 }, label: '멀쩡' }),
  ])
  assert.equal(r.best.label, '멀쩡')
  assert.ok(r.judged.find((c) => c.label === '불안정').fail.some((f) => /씨앗/.test(f)))
})

test('rank — 한 블록이 다 삼킨 분할은 예측력이 1 이어도 탈락한다', () => {
  const r = rank([
    candidate({
      shape: { blocks: 2, usableBlocks: 2, maxShare: 0.95, singletonShare: 0, entropy: 0.2, medSize: 50 },
      heldOut: { weighted: 1, pairs: 10 },
      label: '얼룩',
    }),
  ])
  assert.equal(r.best, null)
  assert.match(r.why, /제약/)
})

test('rank — 폴더를 다시 발견한 분할은 탈락한다', () => {
  const r = rank([candidate({ dirAgreement: 0.97, label: '폴더' })])
  assert.equal(r.best, null)
  assert.ok(r.judged[0].fail.some((f) => /폴더/.test(f)))
})

test('rank — 아무도 통과 못 하면 후보를 지어내지 않는다', () => {
  const r = rank([])
  assert.equal(r.best, null)
  assert.match(r.why, /후보가 없다/)
})

test('LIMITS 는 한 곳에서만 정의된다', () => {
  // 제약이 여기저기 흩어지면 세 도구의 판정이 조용히 갈린다 (invariants.mjs 와 같은 이유).
  assert.ok(LIMITS.maxBlobShare > 0 && LIMITS.maxBlobShare < 1)
  assert.ok(LIMITS.minStability > 0 && LIMITS.minStability <= 1)

  /**
   * 🔴 이 테스트는 오랫동안 제 이름을 검사하지 않았다. 위 두 줄은 값의 범위만 보고,
   * "한 곳에서만" 은 한 번도 확인하지 않았다. 그동안 clustersweep.mjs 가 자기 LIMITS 를
   * 따로 갖고 있었고 이름까지 달랐는데(`maxShare`) 이 테스트는 내내 초록이었다.
   *
   * 이름이 주장하는 것과 몸통이 검사하는 것이 다르면, 목록을 읽는 사람은 그 성질이
   * 지켜진다고 믿는다. 없는 검사보다 나쁘다. 같은 객체인지를 실제로 본다.
   */
  assert.strictEqual(SWEEP_LIMITS, LIMITS, 'clustersweep 이 자기 LIMITS 를 따로 갖고 있다')
})

// ---------------------------------------------------------------------------
// 투표자 셈 — 설정 여럿이 실제로 몇 사람인가
// ---------------------------------------------------------------------------

test('voterCount — 똑같은 답을 내는 설정 셋은 한 사람이다', () => {
  // 이 검사가 곧 실 A 의 명제다. 부풀림을 못 잡으면 합의가 장식이 된다.
  const 같은답 = [0, 0, 0, 1, 1, 1]
  const v = voterCount([{ m: 같은답 }, { m: 같은답 }, { m: 같은답 }])
  assert.equal(v.settings, 3)
  assert.equal(v.effective, 1, '같은 분할 셋이 3명으로 세어졌다')
  assert.equal(v.median, 1)
})

test('voterCount — 서로 다른 답은 따로 센다', () => {
  const v = voterCount([
    { m: [0, 0, 0, 1, 1, 1] },
    { m: [0, 1, 0, 1, 0, 1] },   // 완전히 다른 나눔
    { m: [0, 0, 0, 0, 0, 0] },   // 전부 한 덩어리
  ])
  assert.equal(v.effective, 3)
  assert.ok(v.median < 0.8, `설정 간 중앙값이 ${v.median} — 다른 답인데 같다고 봤다`)
})

test('voterCount — 문턱 아래로 붙은 것만 합친다', () => {
  const a = [0, 0, 0, 1, 1, 1]
  const b = [0, 0, 0, 1, 1, 2]   // 한 칸만 다르다 → ARI 는 높지만 1.0 은 아니다
  const 느슨 = voterCount([{ m: a }, { m: b }], { cut: 0.3 })
  const 빡빡 = voterCount([{ m: a }, { m: b }], { cut: 0.99 })
  assert.equal(느슨.effective, 1)
  assert.equal(빡빡.effective, 2, '문턱을 올렸는데도 합쳐졌다 — cut 이 안 먹는다')
})

test('voterCount — 잴 수 없으면 null 이지 0 이 아니다', () => {
  // "투표자 0명" 과 "못 쟀다" 를 같은 값으로 만들면 코퍼스 집계가 조용히 틀어진다.
  assert.equal(voterCount([]), null)
  assert.equal(voterCount([{ m: [0, 0, 1] }]), null)
})

test('buildGraph — origin 없는 엣지를 정적 엣지로 삼키지 않는다', () => {
  // 실제로 물렸던 자리다. coChange().edges 에는 origin 이 없어서, 이 검사가
  // 없으면 공변경 전체가 정적 엣지가 되고 coWeight 축이 조용히 죽는다.
  assert.throws(
    () => buildGraph(['a.js', 'b.js'], [{ source: 'a.js', target: 'b.js', support: 5, lift: 3 }]),
    /origin 이 없거나 모르는 값/,
  )
  assert.throws(
    () => buildGraph(['a.js', 'b.js'], [{ source: 'a.js', target: 'b.js', origin: 'guess' }]),
    /origin 이 없거나 모르는 값/,
  )
})
