/**
 * 그래프를 블록으로 나눈다 — Leiden · Louvain · label propagation, 순수 함수로.
 *
 * D17 이 남긴 숙제를 실행하는 파일이다. 그 결정은 후보를 넷으로 좁히고
 * **"어느 것을 고르는가는 벤치로 정한다"** 라고 적었다. 벤치를 돌리려면 먼저
 * 후보들이 같은 입력을 먹고 같은 모양을 뱉어야 한다. 여기가 그 자리다.
 *
 * 🔴 이 파일에는 부수효과가 없다. git 도 fs 도 시계도 없다.
 *    난수조차 씨앗을 인자로 받는다 — 씨앗을 바꿔 가며 같은 그래프를 여러 번
 *    나눠 보는 것이 **안정성 측정 그 자체**이기 때문이다. `Math.random()` 을
 *    쓰면 그 측정이 불가능해진다.
 *
 * 출력은 언제나 `membership: Int32Array` 다. 파일 i 가 몇 번 블록인가, 그것뿐.
 * `corpus/terms.mjs` 의 `labelBlocks()` 가 정확히 이 모양을 받는다 — 군집을
 * 무엇으로 만들었는지 몰라도 이름이 붙는다는 D17 의 경계가 여기서 지켜진다.
 *
 * 목적함수 둘을 함께 둔다.
 *
 *   modularity  "우연보다 얼마나 촘촘한가". 표준. 단 **해상도 한계**가 있어
 *               큰 그래프에서 작은 블록을 못 본다 (Fortunato-Barthélemy).
 *   cpm         "내부 밀도가 γ 를 넘는가". 해상도 한계가 없고 γ 가 밀도라는
 *               **읽을 수 있는 뜻**을 가진다. 사람에게 설명할 수 있다는 것이
 *               D17 의 결정적 이유였으므로 이쪽을 버리지 않는다.
 */

// ---------------------------------------------------------------------------
// 난수 — 씨앗을 받는다
// ---------------------------------------------------------------------------

/**
 * mulberry32. 짧고, 빠르고, 씨앗이 같으면 결과가 같다.
 *
 * 암호용이 아니다. 여기서 난수가 하는 일은 노드를 훑는 순서를 섞는 것뿐이고,
 * 그 순서가 결과를 바꾼다는 사실 자체가 우리가 재려는 대상이다.
 */
export function rng(seed) {
  let a = (seed >>> 0) || 1
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 제자리 셔플. 순서가 결과를 바꾸므로 씨앗 하나에 순서 하나가 대응해야 한다. */
function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t
  }
  return arr
}

// ---------------------------------------------------------------------------
// 그래프
// ---------------------------------------------------------------------------

/**
 * 인접 리스트 그래프. 집계(aggregation)를 거쳐도 같은 모양을 유지한다.
 *
 * `selfLoop` 이 필요한 이유: 블록을 하나의 노드로 접고 나면 그 블록 안에 있던
 * 엣지들이 갈 곳이 없다. 자기 자신으로 가는 엣지로 남겨야 다음 단계의
 * 모듈도(度)가 맞는다. 이걸 빠뜨리면 접을 때마다 내부 결합이 증발하고
 * 알고리즘이 실제보다 잘게 쪼갠다.
 *
 * `size` 는 "이 노드 안에 원래 파일이 몇 개인가". CPM 의 벌점이 노드 수에
 * 비례하므로 접힌 뒤에도 원래 개수를 알아야 한다.
 */
function emptyGraph(n) {
  return {
    n,
    nbr: Array.from({ length: n }, () => []),
    wgt: Array.from({ length: n }, () => []),
    selfLoop: new Float64Array(n),
    strength: new Float64Array(n),
    size: new Float64Array(n).fill(1),
    m2: 0,
  }
}

/**
 * 엣지가 어디서 왔는가. 아는 값만 받는다 — 모르는 값은 거부한다.
 *
 *   static    import·참조로 이어졌다 (analyze.build)
 *   cochange  같이 바뀐 적이 있다 (cochange.coChange)
 *   both      둘 다
 */
export const ORIGINS = new Set(['static', 'cochange', 'both'])

/**
 * 노드·엣지 목록을 군집기가 먹는 그래프로 바꾼다.
 *
 * 🔴 정적 엣지와 공변경 엣지는 **단위가 다르다.** import 는 있거나 없거나(1)
 *    인데 공변경은 "몇 번 같이 바뀌었나"(support)라는 횟수다. 그냥 더하면
 *    커밋이 많은 저장소에서 공변경이 import 를 덮어버린다.
 *
 *    그래서 공변경을 `coWeight` 배율 하나로 눌러 넣고, **그 배율 자체를
 *    하이퍼파라미터로 취급한다.** 어느 쪽을 얼마나 믿을지는 눈으로 고를 값이
 *    아니라 재서 정할 값이다 — 이 저장소가 임계값을 다루는 방식 그대로다.
 *
 * @param ids    파일 경로 배열. 인덱스가 곧 노드 번호다
 * @param edges  {source,target,origin,support,lift} — analyze.build 와 cochange 의 합집합
 */
export function buildGraph(ids, edges, {
  coWeight = 1,
  minSupport = 3,
  minLift = 1,
  staticWeight = 1,
} = {}) {
  const index = new Map()
  ids.forEach((id, i) => index.set(id, i))

  // 같은 쌍이 정적으로도 공변경으로도 이어질 수 있다. 합쳐서 한 엣지로 만든다.
  const pair = new Map()
  for (const e of edges) {
    const a = index.get(e.source)
    const b = index.get(e.target)
    if (a === undefined || b === undefined || a === b) continue

    /**
     * 🔴 origin 이 없으면 **거부한다.** 정적 엣지로 치지 않는다.
     *
     * 실제로 물렸다. `cochange.mjs` 의 `coChange().edges` 에는 origin 이 없고
     * (붙이는 것은 `overlayEdges` 다), 그걸 그대로 넘겼더니 공변경 엣지 전부가
     * 정적 엣지 취급을 받았다. 결과는 조용했다 — 에러도 경고도 없이 `coWeight`
     * 축이 죽어서 0·0.5·1·2 가 **한 글자도 다르지 않은 답**을 냈다. 격자를
     * 168칸 돌고 표를 눈으로 보고서야 알았다.
     *
     * 치환은 서로 다른 두 입력을 같은 것으로 만든다(CLAUDE.md). 여기서는
     * "import 로 이어졌다" 와 "같이 바뀐 적 있다" 가 같은 것이 됐고,
     * 그 둘을 가르는 것이 이 제품의 핵심 주장이다.
     */
    if (!ORIGINS.has(e.origin)) {
      throw new Error(
        `엣지에 origin 이 없거나 모르는 값이다: ${JSON.stringify(e.origin)}`
        + ` (${e.source} → ${e.target}). 있는 것: ${[...ORIGINS].join(', ')}`,
      )
    }

    let w
    if (e.origin === 'cochange' || e.origin === 'both') {
      const sup = e.support ?? 0
      const lift = e.lift ?? 0
      // 🔴 문턱을 못 넘은 공변경은 **0 이 아니라 아예 없는 것**으로 친다.
      //    0 으로 넣으면 이웃 목록에는 남아서 이후 계산이 그것을 이웃으로 센다.
      if (sup < minSupport || lift < minLift) {
        if (e.origin === 'cochange') continue
        w = staticWeight
      } else {
        // support 를 그대로 쓰면 커밋 많은 저장소에서 한 쌍이 수백이 된다.
        // log 로 눌러 "몇 번인가" 보다 "자주인가" 에 가깝게 만든다.
        w = coWeight * Math.log1p(sup) + (e.origin === 'both' ? staticWeight : 0)
      }
    } else {
      w = staticWeight
    }
    if (!(w > 0)) continue

    const key = a < b ? `${a},${b}` : `${b},${a}`
    pair.set(key, (pair.get(key) ?? 0) + w)
  }

  const g = emptyGraph(ids.length)
  for (const [key, w] of pair) {
    const [a, b] = key.split(',').map(Number)
    g.nbr[a].push(b); g.wgt[a].push(w)
    g.nbr[b].push(a); g.wgt[b].push(w)
    g.strength[a] += w
    g.strength[b] += w
    g.m2 += 2 * w
  }
  return g
}

/** 블록 배정에 따라 그래프를 접는다. 접힌 그래프는 원래 것과 같은 모양이다. */
function aggregate(g, membership, k) {
  const out = emptyGraph(k)
  out.size.fill(0)
  for (let i = 0; i < g.n; i++) {
    const c = membership[i]
    out.size[c] += g.size[i]
    out.selfLoop[c] += g.selfLoop[i]
  }
  const acc = new Map()
  for (let i = 0; i < g.n; i++) {
    const ci = membership[i]
    const nb = g.nbr[i], wg = g.wgt[i]
    for (let x = 0; x < nb.length; x++) {
      const cj = membership[nb[x]]
      if (cj === ci) {
        // 같은 블록 안으로 들어간 엣지. 양쪽에서 한 번씩 세므로 절반만 더한다.
        out.selfLoop[ci] += wg[x] / 2
      } else if (ci < cj) {
        const key = `${ci},${cj}`
        acc.set(key, (acc.get(key) ?? 0) + wg[x])
      }
    }
  }
  for (const [key, w] of acc) {
    const [a, b] = key.split(',').map(Number)
    out.nbr[a].push(b); out.wgt[a].push(w)
    out.nbr[b].push(a); out.wgt[b].push(w)
  }
  for (let i = 0; i < k; i++) {
    let s = 2 * out.selfLoop[i]
    for (const w of out.wgt[i]) s += w
    out.strength[i] = s
    out.m2 += s
  }
  return out
}

/** 블록 번호를 0..k-1 로 다시 매긴다. 번호에 구멍이 있으면 집계가 헛돈다. */
function compact(membership) {
  const map = new Map()
  for (let i = 0; i < membership.length; i++) {
    const c = membership[i]
    if (!map.has(c)) map.set(c, map.size)
    membership[i] = map.get(c)
  }
  return map.size
}

// ---------------------------------------------------------------------------
// 목적함수
// ---------------------------------------------------------------------------

/**
 * 노드 i 를 블록 C 로 옮길 때의 이득. 목적함수 둘이 여기서만 갈린다.
 *
 * modularity: kIn - γ·k_i·Σ_tot / m2
 * cpm:        kIn - γ·n_i·n_C
 *
 * 둘 다 "안으로 들어오는 무게 − 벌점" 이라 같은 루프를 쓴다. 다른 것은
 * 벌점을 **무엇에 비례시키는가** 뿐이다 — 모듈도는 이웃 수에, CPM 은 식구 수에.
 */
function gainOf(objective, kIn, resolution, ki, sizeI, totStrength, totSize, m2) {
  if (objective === 'cpm') return kIn - resolution * sizeI * totSize
  return kIn - (resolution * ki * totStrength) / m2
}

/**
 * 이 분할의 품질. 알고리즘끼리 비교하려면 같은 자로 재야 한다.
 *
 * 🔴 CPM 값과 modularity 값을 **서로 비교하지 않는다.** 단위가 다르다.
 *    같은 목적함수 안에서만 크고 작음을 말할 수 있다.
 */
export function quality(g, membership, { resolution = 1, objective = 'modularity' } = {}) {
  const k = Math.max(0, ...membership) + 1
  const inner = new Float64Array(k)
  const tot = new Float64Array(k)
  const size = new Float64Array(k)
  for (let i = 0; i < g.n; i++) {
    const c = membership[i]
    tot[c] += g.strength[i]
    size[c] += g.size[i]
    inner[c] += g.selfLoop[i]
    const nb = g.nbr[i], wg = g.wgt[i]
    for (let x = 0; x < nb.length; x++) if (membership[nb[x]] === c) inner[c] += wg[x] / 2
  }
  let q = 0
  if (objective === 'cpm') {
    for (let c = 0; c < k; c++) q += inner[c] - resolution * (size[c] * (size[c] - 1)) / 2
    return q
  }
  if (!g.m2) return 0
  for (let c = 0; c < k; c++) q += (2 * inner[c]) / g.m2 - resolution * (tot[c] / g.m2) ** 2
  return q
}

// ---------------------------------------------------------------------------
// 지역 이동 — Louvain 과 Leiden 이 공유한다
// ---------------------------------------------------------------------------

function localMove(g, membership, { resolution, objective, rand, maxPasses = 32 }) {
  const tot = new Float64Array(g.n)
  const size = new Float64Array(g.n)
  for (let i = 0; i < g.n; i++) {
    tot[membership[i]] += g.strength[i]
    size[membership[i]] += g.size[i]
  }

  const order = shuffle([...Array(g.n).keys()], rand)
  const kIn = new Map()
  let moved = true
  let passes = 0

  while (moved && passes++ < maxPasses) {
    moved = false
    for (const i of order) {
      const from = membership[i]
      const ki = g.strength[i]
      const ni = g.size[i]

      kIn.clear()
      kIn.set(from, 0)
      const nb = g.nbr[i], wg = g.wgt[i]
      for (let x = 0; x < nb.length; x++) {
        const c = membership[nb[x]]
        kIn.set(c, (kIn.get(c) ?? 0) + wg[x])
      }

      // 자기를 빼고 나서 비교한다. 빼지 않으면 자기 무게가 원래 블록 편을 든다.
      tot[from] -= ki
      size[from] -= ni

      let best = from
      let bestGain = gainOf(objective, kIn.get(from) ?? 0, resolution, ki, ni, tot[from], size[from], g.m2)
      for (const [c, w] of kIn) {
        if (c === from) continue
        const gain = gainOf(objective, w, resolution, ki, ni, tot[c], size[c], g.m2)
        // 동점이면 옮기지 않는다. 옮기면 씨앗만 바뀌어도 답이 달라지고,
        // 그 불안정이 바로 D17 이 spectral 을 버린 이유다.
        if (gain > bestGain) { bestGain = gain; best = c }
      }

      tot[best] += ki
      size[best] += ni
      if (best !== from) { membership[i] = best; moved = true }
    }
  }
  return membership
}

// ---------------------------------------------------------------------------
// Louvain
// ---------------------------------------------------------------------------

/**
 * Louvain. 지역 이동 → 접기 → 반복.
 *
 * ⚠️ 알려진 결함: **블록 안이 끊어져 있을 수 있다.** 지역 이동이 어떤 노드를
 *    옮기면서 원래 블록을 두 조각으로 갈라놓아도, 다음 단계는 그 블록을 이미
 *    하나의 노드로 접어버려 갈라진 것을 영영 못 본다. 화면에 "한 덩어리" 라고
 *    그려놓고 실제로는 서로 안 닿는 두 무리인 경우가 생긴다.
 *    Leiden 이 정확히 이것을 고친다.
 */
export function louvain(g, { resolution = 1, objective = 'modularity', seed = 1 } = {}) {
  const rand = rng(seed)
  let level = g
  let membership = new Int32Array(g.n).map((_, i) => i)
  const chain = [membership]

  for (let depth = 0; depth < 32; depth++) {
    const local = new Int32Array(level.n).map((_, i) => i)
    localMove(level, local, { resolution, objective, rand })
    const k = compact(local)
    if (k === level.n) break
    chain.push(local)
    level = aggregate(level, local, k)
  }
  return { membership: flatten(chain, g.n), levels: chain.length - 1 }
}

/** 층층이 쌓인 배정을 원래 노드까지 펼친다. */
function flatten(chain, n) {
  const out = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    let c = i
    for (let d = 1; d < chain.length; d++) c = chain[d][c]
    out[i] = c
  }
  compact(out)
  return out
}

// ---------------------------------------------------------------------------
// Leiden
// ---------------------------------------------------------------------------

/**
 * Leiden. Louvain 에 **정련(refinement)** 단계를 끼운다.
 *
 * 정련은 지역 이동이 만든 블록 하나하나를 다시 들여다보면서, 그 안에서
 * **잘 이어진 부분끼리만** 뭉치게 한다. 그리고 접을 때는 정련된 쪽으로 접되
 * 다음 층의 출발점은 정련 전 배정으로 잡는다. 이 두 겹 덕분에
 * "블록 안이 끊어져 있는" Louvain 의 결함이 구조적으로 못 생긴다.
 *
 * 🔴 정련에서 후보를 **무작위로** 고른다 (θ 로 조절). 항상 최선만 고르면
 *    지역해에 갇히기 때문이다. 대신 그 무작위가 씨앗에 묶여 있어야
 *    "씨앗을 바꾸면 답이 얼마나 흔들리나" 를 잴 수 있다.
 */
export function leiden(g, {
  resolution = 1,
  objective = 'modularity',
  seed = 1,
  theta = 0.01,
  iterations = 2,
} = {}) {
  const rand = rng(seed)
  let membership = new Int32Array(g.n).map((_, i) => i)
  let levels = 0

  for (let iter = 0; iter < iterations; iter++) {
    let level = g
    // 원래 노드 i 가 지금 층에서 몇 번 노드인가. 층을 접을 때마다 갱신한다.
    const levelOf = new Int32Array(g.n).map((_, i) => i)
    // 출발 분할은 **지난 회차의 답**이다. 여기서 이어받는 것이 iterations 의 뜻이다.
    let part = Int32Array.from(membership)
    compact(part)
    let guard = 0

    for (;;) {
      localMove(level, part, { resolution, objective, rand })
      const k = compact(part)
      if (k === level.n || guard++ > 32) break

      const refined = refine(level, part, { resolution, objective, rand, theta })
      const rk = compact(refined)

      // 🔴 접는 것은 **정련된** 쪽이고, 다음 층의 출발점은 **정련 전** 쪽이다.
      //    이 두 겹이 Leiden 의 전부다. 하나로 합치면 Louvain 이 된다.
      const parent = new Int32Array(rk)
      for (let i = 0; i < level.n; i++) parent[refined[i]] = part[i]

      for (let i = 0; i < g.n; i++) levelOf[i] = refined[levelOf[i]]
      level = aggregate(level, refined, rk)
      part = parent
      levels++
    }

    const next = new Int32Array(g.n)
    for (let i = 0; i < g.n; i++) next[i] = part[levelOf[i]]
    compact(next)
    membership = next
  }
  return { membership, levels }
}

/**
 * 블록 안을 다시 나눈다. 블록 경계는 절대 넘지 않는다 — 정련은 **세분**이지
 * 재배치가 아니다. 넘게 두면 위층이 이미 내린 판단을 아래층이 뒤집는다.
 *
 * 🔴 테스트를 위해 내보낸다. 이 함수가 Leiden 과 Louvain 을 가르는 전부이고,
 *    통째로 no-op 이 되어도 바깥 동작은 대체로 멀쩡해 보인다 — 실제로 그래서
 *    "Louvain 과 비교하면 잡힌다" 는 검사가 25개 그래프 300회에서 한 번도
 *    안 잡혔다. 계약을 직접 검사하는 수밖에 없다.
 */
export function refine(g, base, { resolution, objective, rand, theta }) {
  const out = new Int32Array(g.n).map((_, i) => i)
  const tot = new Float64Array(g.n)
  const size = new Float64Array(g.n)
  for (let i = 0; i < g.n; i++) { tot[i] = g.strength[i]; size[i] = g.size[i] }

  // 블록별 식구 목록
  const members = new Map()
  for (let i = 0; i < g.n; i++) {
    if (!members.has(base[i])) members.set(base[i], [])
    members.get(base[i]).push(i)
  }

  const kIn = new Map()
  for (const group of members.values()) {
    if (group.length < 3) continue
    for (const i of shuffle([...group], rand)) {
      // 아직 혼자인 노드만 옮긴다. 이미 뭉친 것을 다시 흩으면 정련이 아니다.
      if (out[i] !== i) continue

      kIn.clear()
      const nb = g.nbr[i], wg = g.wgt[i]
      for (let x = 0; x < nb.length; x++) {
        const j = nb[x]
        if (base[j] !== base[i]) continue      // 🔴 블록 밖으로는 안 나간다
        kIn.set(out[j], (kIn.get(out[j]) ?? 0) + wg[x])
      }
      if (!kIn.size) continue

      const ki = g.strength[i], ni = g.size[i]
      tot[out[i]] -= ki; size[out[i]] -= ni

      const cand = []
      let sum = 0
      for (const [c, w] of kIn) {
        if (c === i) continue
        const gain = gainOf(objective, w, resolution, ki, ni, tot[c], size[c], g.m2)
        if (gain <= 0) continue
        const p = Math.exp(Math.min(50, gain / theta))
        cand.push([c, p]); sum += p
      }

      let pickC = i
      if (cand.length) {
        let r = rand() * sum
        for (const [c, p] of cand) { r -= p; if (r <= 0) { pickC = c; break } }
        if (pickC === i) pickC = cand[cand.length - 1][0]
      }
      tot[pickC] += ki; size[pickC] += ni
      out[i] = pickC
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Label propagation — 대조군
// ---------------------------------------------------------------------------

/**
 * 이웃의 다수결 표를 따라간다. 파라미터가 사실상 없다.
 *
 * D17 이 이것을 기준선으로 지목한 이유가 여기 있다 — **휴리스틱이 실제로
 * 이겼는가**를 재려면 아무 조절도 안 한 것과 비교해야 한다. Leiden 이
 * label propagation 을 못 이기면 γ 를 아무리 잘 골라도 의미가 없다.
 */
export function labelPropagation(g, { seed = 1, maxIter = 64 } = {}) {
  const rand = rng(seed)
  const membership = new Int32Array(g.n).map((_, i) => i)
  const order = [...Array(g.n).keys()]
  const votes = new Map()

  for (let it = 0; it < maxIter; it++) {
    shuffle(order, rand)
    let moved = false
    for (const i of order) {
      votes.clear()
      const nb = g.nbr[i], wg = g.wgt[i]
      if (!nb.length) continue
      for (let x = 0; x < nb.length; x++) {
        const c = membership[nb[x]]
        votes.set(c, (votes.get(c) ?? 0) + wg[x])
      }
      let best = membership[i]
      let bestW = votes.get(best) ?? -1
      for (const [c, w] of votes) {
        // 동점이면 번호가 작은 쪽. 무작위 tie-break 은 수렴을 막는다.
        if (w > bestW || (w === bestW && c < best)) { bestW = w; best = c }
      }
      if (best !== membership[i]) { membership[i] = best; moved = true }
    }
    if (!moved) break
  }
  compact(membership)
  return { membership, levels: 1 }
}

// ---------------------------------------------------------------------------

/** 이름으로 고른다. 벤치가 알고리즘을 문자열로 받아 돌릴 수 있게. */
export const ALGORITHMS = {
  leiden,
  louvain,
  labelprop: labelPropagation,
}

export function cluster(name, g, opts = {}) {
  const fn = ALGORITHMS[name]
  // 🔴 모르는 이름을 기본값으로 떨어뜨리지 않는다. 오타 하나가 벤치 전체를
  //    조용히 다른 알고리즘 결과로 채운다 — 애매하면 거부한다(CLAUDE.md).
  if (!fn) throw new Error(`모르는 군집 알고리즘: ${name} (있는 것: ${Object.keys(ALGORITHMS).join(', ')})`)
  return fn(g, opts)
}
