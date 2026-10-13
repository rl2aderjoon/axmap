/**
 * 저장소 하나에서 군집 하이퍼파라미터를 쓸어 재고, 폴더와 겨루게 한다.
 *
 * 🔴 순수 함수다. git 도 fs 도 시계도 없다 — 커밋 목록과 그래프를 **받아서**
 *    쓴다. `measure.mjs` 가 이미 읽어둔 것을 다시 읽지 않기 위해서이기도 하고,
 *    파라미터 선택 로직을 테스트에서 30분 기다리지 않고 검증하기 위해서다.
 *
 * ── 무엇을 재는가 ────────────────────────────────────────────────────────
 *
 * 커밋 이력을 앞뒤로 자른다. **앞쪽(과거)만으로** 블록을 나누고, 뒤쪽(미래)에서
 * 실제로 같이 바뀐 쌍을 그 블록이 품고 있었는지 센다. 만든 데 쓴 엣지로
 * 채점하면 동어반복이라 아무 말도 못 한다.
 *
 * ── 🔴 자를 세 번 갈아끼운 끝에 정한 것 ──────────────────────────────────
 *
 * 실험(저장소 29개)에서 자를 두 번 잘못 골랐다. 같은 데이터가 자에 따라
 * 정반대 답을 냈다.
 *
 *   날것 적중률   폴더 압승. 폴더 하나가 전부 삼키면 100% 다 — **굵을수록 이김**
 *   lift          군집 94% 승. vcmi 에서 블록 338개·적중 7.8% 가 1등이 됐다.
 *                 분모(섞었을 때 적중)가 0 에 가까워 터진 것 — **잘수록 이김**
 *   제약 후 적중  군집 62% 승. 이것이 맞다
 *
 * 그래서 **블록 수와 얼룩 크기를 먼저 제약**하고, 통과한 것 안에서만 적중률을
 * 본다. 그리고 폴더에도 **똑같은 제약**을 걸어 겨루게 한다 — 폴더 쪽을 약하게
 * 만들어 놓고 이겼다고 하는 것은 우리 자신을 속이는 것이다.
 *
 * 이 판단의 근거가 되는 수치는 docs/CLUSTER.md 에 있다.
 */
import { buildGraph, cluster } from './cluster.mjs'
import { ari, containment, directoryPartition, LIMITS, shape } from './clusterscore.mjs'

/**
 * 격자.
 *
 * 🔴 γ 하한이 0.25 였을 때 **최적값이 격자의 맨 아래 칸에 몰렸다** — 29개 중
 *    11개가 γ=0.25 를 골랐다. 담 밖에 답이 있다는 신호이므로 아래로 넓혔다.
 *    지금도 하한(0.05)에 몰리면 또 넓혀야 한다. `atFloor` 로 그 사실을 함께 낸다.
 */
export const GRID = {
  algorithm: ['leiden', 'louvain'],
  objective: ['modularity', 'cpm'],
  resolution: [0.05, 0.1, 0.15, 0.25, 0.5, 0.75, 1, 1.5, 2],
  coWeight: [0, 1],
}

/**
 * 🔴 문턱은 `clusterscore.mjs` 것을 그대로 쓴다. 여기서 다시 정의하지 않는다.
 *
 * 전에는 이 파일이 자기 것을 따로 갖고 있었고 이름도 달랐다(`maxShare` vs
 * `maxBlobShare`). 값이 우연히 같았을 뿐이라, 한쪽을 고치면 다른 쪽은 조용히
 * 안 따라온다. 그러면 같은 저장소를 두 도구로 재고 다른 답을 얻는데 왜 다른지
 * 아무도 모르게 된다 — 문서에 대해 되풀이해 말해온 "두 곳에 적으면 한쪽이 먼저
 * 낡는다" 가 코드에서 일어난 것이다.
 */
export { LIMITS }

/**
 * 모양 문 — 사람이 볼 수 있는 지도인가. **군집에도 폴더에도 똑같이 건다.**
 *
 * 🔴 아래 품질 문과 달리 이 셋만 폴더 기준선에 건다. 폴더 분할은 자기 자신과의
 *    ARI 가 1.0 이라 `maxDirAgreement` 를 그대로 걸면 **폴더 기준선이 언제나
 *    탈락**하고, 그러면 `beatsDir`("군집이 폴더를 이겼는가")가 통째로 null 이 된다.
 *    이 도구의 존재 이유를 재는 숫자가 문 하나 때문에 사라지는 것이다.
 */
const passes = (blocks, maxShare, lim = LIMITS) =>
  blocks >= lim.minBlocks && blocks <= lim.maxBlocks && maxShare <= lim.maxBlobShare

/**
 * 품질 문 — 믿을 만한가·새로운가. **군집 후보에만 걸고, `best` 는 안 바꾼다.**
 *
 * 이 셋은 레코드에 적히기만 하고 판정에는 안 쓰였다. 재놓고 안 쓴 것이다.
 * 저장소 셋(axmap·got·express)에서 모양 문을 통과한 후보의 **24~41%** 가 여기 걸린다.
 * 겹치지 않으니 값을 한다.
 *
 * 🔴 그런데 걸면 **우승자가 2/3 에서 바뀐다** (axmap·got). 미래적중도 떨어진다
 *    (got 0.585 → 0.491). 점수가 제일 높던 후보가 불안정하거나 혼자인 파일이
 *    절반을 넘었다는 뜻이다. 어느 쪽이 옳은지는 아직 저장소 셋으로는 못 정한다.
 *
 * 그래서 `best` 는 모양 문으로만 고르고 이 문들로 고른 것을 `bestGated` 로 **나란히**
 * 낸다. 둘 다 쌓이면 "품질 문을 걸었을 때 실제로 무엇이 달라지는가" 를 눈이 아니라
 * 데이터로 답할 수 있다 — `atFloor` 가 격자에 대해 하는 일과 같다.
 *
 * 🔴 `ariDir` 이 null 이면 통과시킨다. 폴더 기준선이 모양 문을 못 지나면(저장소 6개 중
 *    3개가 그랬다) 비교 자체가 정의되지 않는데, 그걸 탈락으로 세면 "나쁘다" 와 "못 쟀다"
 *    가 같은 값이 된다. 그 둘을 구별하는 것이 이 저장소의 규칙이다.
 */
const passesQuality = (c, lim = LIMITS) =>
  (c.stability == null || c.stability >= lim.minStability)
  && (c.ariDir == null || c.ariDir <= lim.maxDirAgreement)
  && c.singletonShare <= lim.maxSingletonShare

/**
 * 투표자 셈 — 설정 여럿이 실제로 몇 사람인가.
 *
 * 합의 군집화는 설정 여럿의 답을 모아 투표시키는 것인데, 설정 A 와 B 가 거의 같은
 * 답을 내면 **표는 2장인데 판단은 1개**다. `docs/SPEC.md` 7-3 이 사람 투표에 대해
 * 적어둔 "같은 모델 3개는 투표자 3명이 아니다" 와 같은 함정이다.
 *
 * 🔴 씨앗 간 ARI(`stability`)와 반드시 함께 읽는다. 씨앗은 코드와 무관한 난수이므로
 *    그걸 바꿔서 답이 흔들리면 잡음이고, **설정**을 바꿔서 답이 달라지는 것은 정보다.
 *    두 값이 비슷하면 설정 축이 아무 일도 안 하고 있다는 뜻이다.
 *
 * 실측(저장소 6개): 씨앗 간 0.73~1.00 vs 설정 간 0.23~0.76 — 6/6 에서 설정 간이 낮다.
 * 유효 투표자는 통과 설정의 23~50%(중앙 ~32%)였다. 표 3장당 판단 1개다.
 *
 * 🔴 멤버십은 여기서만 쓰고 레코드에 남기지 않는다. 옛 repos.jsonl 이 2.29GB 였고,
 *    저장소마다 분할 72개를 통째로 적으면 그 길로 다시 간다.
 */
export function voterCount(list, { cut = 0.8 } = {}) {
  const n = list.length
  if (n < 2) return null
  // 쌍마다 한 번만 잰다. 중앙값과 무리 짓기가 같은 행렬을 쓴다.
  const M = Array.from({ length: n }, () => [])
  const 값 = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = ari(list[i].m, list[j].m)
      M[i][j] = v
      if (v != null) 값.push(v)
    }
  }
  if (!값.length) return null
  값.sort((a, b) => a - b)

  // ARI ≥ cut 이면 같은 사람으로 친다 (단일연결). 무리 수가 곧 유효 투표자다.
  const 부모 = Array.from({ length: n }, (_, i) => i)
  const 찾기 = (x) => (부모[x] === x ? x : (부모[x] = 찾기(부모[x])))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) if (M[i][j] != null && M[i][j] >= cut) 부모[찾기(i)] = 찾기(j)
  }

  return {
    settings: n,
    effective: new Set(부모.map((_, i) => 찾기(i))).size,
    cut,
    median: +값[값.length >> 1].toFixed(3),
    min: +값[0].toFixed(3),
    max: +값[값.length - 1].toFixed(3),
  }
}

/**
 * 커밋 목록에서 공변경 쌍을 센다.
 *
 * `measure.mjs` 의 `readCommits` 가 주는 모양(`{files: [...]}`)을 그대로 먹는다.
 * `cochange.mjs` 를 안 쓰는 이유는 그쪽이 git 을 다시 읽기 때문이다 — 저장소
 * 하나에 git log 를 두 번 돌리면 수집 속도가 그만큼 깎인다.
 *
 * @param maxFiles 이보다 많은 파일을 건드린 커밋은 버린다. 대량 포맷팅·머지
 *                 커밋 하나가 쌍을 수만 개 만들어 분포를 통째로 덮는다
 */
export function coPairs(commits, nodeIds, { maxFiles = 40, minSupport = 1 } = {}) {
  /**
   * 🔴 경로를 이어붙여 키를 만들지 않는다. **번호로 만든다.**
   *
   * 처음에는 `` `${a} ${b}` `` 로 했는데 두 가지가 걸렸다. 파일 경로에는 공백이
   * 들어갈 수 있어 구분자가 경로 안에 나타나면 서로 다른 쌍이 같은 키가 된다
   * (치환은 곧 소유권 충돌이다 — CLAUDE.md). 그래서 NUL 로 바꿨더니 이번엔
   * "소스에 NUL 바이트가 없다" 테스트가 잡았다. 번호는 둘 다 없다.
   */
  const idx = new Map()
  for (const f of nodeIds) idx.set(f, idx.size)
  const names = [...idx.keys()]
  const N = idx.size

  const pair = new Map()
  for (const c of commits) {
    const hit = []
    for (const f of c.files ?? []) { const i = idx.get(f); if (i !== undefined) hit.push(i) }
    if (hit.length < 2 || hit.length > maxFiles) continue
    for (let i = 0; i < hit.length; i++) {
      for (let j = i + 1; j < hit.length; j++) {
        const a = hit[i] < hit[j] ? hit[i] : hit[j]
        const b = hit[i] < hit[j] ? hit[j] : hit[i]
        const key = a * N + b
        pair.set(key, (pair.get(key) ?? 0) + 1)
      }
    }
  }

  const out = []
  for (const [key, support] of pair) {
    if (support < minSupport) continue
    // 🔴 origin 을 반드시 붙인다. 없으면 buildGraph 가 거부한다 — 전에는
    //    조용히 정적 엣지로 삼켜서 coWeight 축이 통째로 죽었다.
    out.push({ source: names[Math.floor(key / N)], target: names[key % N], support, lift: 1, origin: 'cochange' })
  }
  return out
}

/**
 * 저장소 하나를 쓸어 잰다.
 *
 * @param ids          파일 경로 (graph.nodes 의 id)
 * @param staticEdges  import·참조 엣지 (graph.edges)
 * @param commits      최신이 먼저인 커밋 목록 (measure.readCommits)
 * @returns 레코드에 그대로 실을 수 있는 객체. 잴 수 없으면 `{skip}`
 */
export function sweepRepo(ids, staticEdges, commits, {
  holdout = 0.2,
  seeds = 3,
  grid = GRID,
  limits = LIMITS,
  minCommits = 80,
  minFuturePairs = 30,
} = {}) {
  if (ids.length < 40) return { skip: `파일 ${ids.length}개` }
  if (commits.length < minCommits) return { skip: `커밋 ${commits.length}개` }

  const cut = Math.max(15, Math.floor(commits.length * holdout))
  // readCommits 는 **최신이 먼저**다. 앞쪽 slice 가 미래, 뒤쪽이 과거 — 직관과 반대다.
  const future = commits.slice(0, cut)
  const past = commits.slice(cut)

  const nodeIds = new Set(ids)
  const pastCo = coPairs(past, nodeIds, { minSupport: 2 })
  const futureCo = coPairs(future, nodeIds, { minSupport: 1 })
  if (futureCo.length < minFuturePairs) return { skip: `미래 공변경 ${futureCo.length}쌍` }

  const hit = (m) => containment(ids, futureCo, m).weighted

  // ── 폴더 기준선. 깊이를 셋 다 재서 폴더 쪽을 최대한 세운다 ────────────────
  const dirs = [1, 2, 3].map((depth) => {
    const m = directoryPartition(ids, { depth })
    const sh = shape(m)
    return { depth, blocks: sh.usableBlocks, maxShare: sh.maxShare, heldOut: hit(m), m }
  })
  const dirOk = dirs.filter((d) => d.heldOut != null && passes(d.blocks, d.maxShare, limits))
  const dirBest = dirOk.sort((a, b) => b.heldOut - a.heldOut)[0] ?? null

  // ── 격자 ─────────────────────────────────────────────────────────────────
  const cands = []
  for (const coWeight of grid.coWeight) {
    const g = buildGraph(ids, [...staticEdges, ...pastCo], { coWeight, minSupport: 2 })
    for (const algorithm of grid.algorithm) {
      for (const objective of grid.objective) {
        for (const resolution of grid.resolution) {
          const runs = []
          for (let s = 1; s <= seeds; s++) runs.push(cluster(algorithm, g, { resolution, objective, seed: s }).membership)
          const m = runs[0]
          const sh = shape(m)
          let acc = 0, n = 0
          for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
            const v = ari(runs[i], runs[j]); if (v != null) { acc += v; n++ }
          }
          cands.push({
            algorithm, objective, resolution, coWeight,
            blocks: sh.usableBlocks,
            maxShare: +sh.maxShare.toFixed(3),
            singletonShare: +sh.singletonShare.toFixed(3),
            stability: n ? +(acc / n).toFixed(3) : null,
            ariDir: dirBest ? +ari(m, dirBest.m).toFixed(3) : null,
            heldOut: +hit(m).toFixed(4),
            // 🔴 계산용. 반환 직전에 뗀다 — 레코드에 들어가면 파일이 수십 배가 된다.
            m,
          })
        }
      }
    }
  }

  const shaped = cands.filter((c) => Number.isFinite(c.heldOut) && passes(c.blocks, c.maxShare, limits))
  const gated = shaped.filter((c) => passesQuality(c, limits))
  const 적중순 = (a, b) => b.heldOut - a.heldOut
  const best = [...shaped].sort(적중순)[0] ?? null
  const bestGated = [...gated].sort(적중순)[0] ?? null

  /**
   * 문턱이 스스로 의심하게 만든다 — `atFloor` 가 격자에 대해 하는 일과 같은 것이다.
   *
   * 🔴 한 번도 실패하지 않는 검사는 검사가 아니다(INVARIANTS.md). 그런데 지금까지
   *    문턱들은 자기가 일하고 있는지를 말하지 않았다. `blocked`가 0인데 `nearest`가
   *    문턱에서 멀면 그 문은 이 저장소에서 **죽어 있다**. 실측에서 폴더 문(0.9)이
   *    저장소 6개 전부 0번 걸렸고 관측 최대는 0.34 였다 — 상수를 눈으로 고쳐
   *    내리는 대신, 이 신호가 저장소마다 쌓이면 그때 데이터로 정한다.
   *
   * `unknown` 은 판단할 수 없었던 수다. "안 걸렸다" 와 "못 쟀다" 는 다른 말이다.
   */
  const 신호 = (key, cut, 방향) => {
    const 넘음 = (v) => (방향 === '위가나쁨' ? v > cut : v < cut)
    const vals = shaped.map((c) => c[key]).filter((v) => v != null)
    return {
      cut,
      blocked: vals.filter(넘음).length,
      // 문턱에 가장 가까이 간 관측값. blocked 가 0인데 이 값이 cut 에서 멀면 죽은 문이다.
      nearest: vals.length ? +(방향 === '위가나쁨' ? Math.max(...vals) : Math.min(...vals)).toFixed(3) : null,
      unknown: shaped.length - vals.length,
    }
  }

  return {
    commits: { past: past.length, future: future.length },
    coPairs: { past: pastCo.length, future: futureCo.length },
    dirs: dirs.map(({ m, ...d }) => ({ ...d, heldOut: d.heldOut == null ? null : +d.heldOut.toFixed(4) })),
    dirBest: dirBest ? { depth: dirBest.depth, blocks: dirBest.blocks, heldOut: +dirBest.heldOut.toFixed(4) } : null,
    best,
    /**
     * 품질 문까지 걸었을 때의 우승자. `best` 를 대체하지 않고 나란히 둔다.
     * 둘이 다른 저장소가 얼마나 되는지가 "문을 걸어야 하는가" 의 답이 된다.
     */
    bestGated,
    // 🔴 제약을 아무도 통과 못 한 것과 "안 재봤다" 는 다른 말이다. 구별해서 남긴다
    passed: shaped.length,
    // 품질 문까지 통과한 수. passed 와의 차이가 곧 그 문 셋이 실제로 한 일이다.
    passedGated: gated.length,
    tried: cands.length,
    /**
     * 설정 축이 실제로 몇 사람 몫을 하는가. 씨앗 간 ARI 중앙값과 나란히 낸다 —
     * 둘을 함께 보지 않으면 "설정 간이 낮다" 가 좋은 신호인지 나쁜 신호인지 모른다.
     */
    voters: voterCount(shaped),
    seedAri: (() => {
      const v = shaped.map((c) => c.stability).filter((x) => x != null).sort((a, b) => a - b)
      return v.length ? +v[v.length >> 1].toFixed(3) : null
    })(),
    gates: {
      stability: 신호('stability', limits.minStability, '아래가나쁨'),
      dirAgreement: 신호('ariDir', limits.maxDirAgreement, '위가나쁨'),
      singletonShare: 신호('singletonShare', limits.maxSingletonShare, '위가나쁨'),
    },
    /**
     * 군집이 폴더를 이겼는가. 이 저장소가 이 제품을 쓸 이유가 있는가와 같은 말이다.
     * 폴더가 제약을 못 통과하면(예: 최상위 폴더 하나뿐) null — 이겼다고 치지 않는다.
     */
    beatsDir: best && dirBest ? +(best.heldOut - dirBest.heldOut).toFixed(4) : null,
    /**
     * 최적값이 격자 끝에 붙었나. 붙었으면 담 밖에 답이 있다는 뜻이라
     * 이 저장소의 γ 는 "격자가 허락한 최선" 이지 최적이 아니다.
     */
    atFloor: best ? best.resolution === grid.resolution[0] : null,
    atCeil: best ? best.resolution === grid.resolution[grid.resolution.length - 1] : null,
    // 🔴 멤버십(m)을 떼고 낸다. 붙여 두면 저장소마다 분할 72개가 통째로 적히고
    //    옛 repos.jsonl 이 2.29GB 였던 길로 다시 간다.
    candidates: cands.map(({ m, ...c }) => c),
  }
}
