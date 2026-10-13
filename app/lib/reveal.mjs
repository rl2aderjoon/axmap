/**
 * 점진 공개 — 화면은 지도가 아니라 **내가 읽은 흔적**이다.
 *
 * 🔴 왜 만드는가.
 *
 * 벤치마크 여섯 회차가 전부 같은 자리에서 막혔는데, 원인이 정보 부족이
 * 아니었다. **한꺼번에 다 보여준 것**이었다. 700개가 엉킨 그림 앞에서
 * 사람이 느끼는 것은 구조가 아니라 벽이다.
 *
 * 지금 화면은 "이 저장소는 무엇인가" 에 답한다. 그런데 읽는 사람의 실제
 * 질문은 **"다음에 뭘 알아야 하나"** 다. 그 둘은 다른 질문이고, 뒤엣것은
 * 한 번에 답할 수 없다 — 답이 읽는 사람이 어디까지 왔느냐에 달렸기 때문이다.
 *
 * 그래서 진입점 하나로 시작한다. 왼쪽에서 개념을 누르면 그만큼만 자란다.
 * 열지 않은 것은 화면에 없다.
 *
 * ── 🔴 지켜야 하는 불변식 하나 ────────────────────────────────────────────
 *
 *   **한 번 자리를 잡은 노드는 다시는 움직이지 않는다.**
 *
 * 움직이면 방금 쌓은 지도가 매번 무너진다. 그건 정적인 헤어볼보다 나쁘다 —
 * 헤어볼은 적어도 어제와 같은 자리에 있다. 그래서 힘-지향도, 방사형 트리도
 * 쓸 수 없다(둘 다 노드가 늘면 전부 다시 배치된다).
 *
 * 층별 배치에서 **줄 끝에 덧붙이면** 앞엣것이 밀리지 않는다. 아래·오른쪽으로
 * 자라기만 하고 재배치가 없다. 사다리는 구조가 맞았고 용량이 틀렸을 뿐이다.
 *
 * 순수 함수만 둔다 — fs 도 git 도 시계도 없다 (CLAUDE.md).
 */

/**
 * @typedef {object} Reveal
 * @property {string[]} order   드러난 순서. **이 순서가 곧 자리**다.
 * @property {Record<string, {depth: number, col: number, from: string|null, why: string}>} at
 * @property {string[]} opened  이미 "펼친" 노드 — 두 번 펼치지 않기 위해
 * @property {Record<string, number>} width  층마다 지금까지 몇 개 놓였나
 */

/** 아무것도 안 드러난 상태. */
export function emptyReveal() {
  return { order: [], at: {}, opened: [], width: {} }
}

/**
 * 이 노드가 놓일 층.
 *
 * 🔴 **이미 드러난 것만 본다.** 아직 안 드러난 것을 근거로 층을 정하면,
 *    나중에 그것이 드러났을 때 층이 바뀌어야 하고 그건 불변식 위반이다.
 *
 *   ① 드러난 것 중 이 파일을 부르는 것이 있으면 → 그중 가장 얕은 층 + 1
 *   ② 누가 열었는지 알면 → 그 층 + 1
 *   ③ 둘 다 없으면 → 0 (새 뿌리)
 */
function depthOf(state, id, parent, importers) {
  const from = importers.get(id)
  let best = null
  for (const p of from ?? []) {
    const a = state.at[p]
    if (a && (best === null || a.depth < best)) best = a.depth
  }
  if (best !== null) return best + 1
  if (parent && state.at[parent]) return state.at[parent].depth + 1
  return 0
}

/** target → [source...] — 누가 이 파일을 부르나. 허브·공변경은 빼고 import 만. */
export function importersOf(edges) {
  const m = new Map()
  for (const e of edges) {
    if (e.hub || e.origin === 'cochange') continue
    if (!m.has(e.target)) m.set(e.target, [])
    m.get(e.target).push(e.source)
    // 방향을 모르는 연결은 양쪽으로 둔다. 모르는 것을 없는 것으로 치면
    // 조용히 빠뜨린다 (ladder·flow 의 같은 판단).
    if (e.directed === false) {
      if (!m.has(e.source)) m.set(e.source, [])
      m.get(e.source).push(e.target)
    }
  }
  return m
}

/**
 * 노드 몇 개를 드러낸다. 이미 드러난 것은 **건드리지 않는다.**
 *
 * @param ids     드러낼 것들. 주어진 순서가 그 층 안의 순서가 된다.
 * @param why     화면에 적을 이유. "무엇을 눌러서 나왔나" 를 사람이 알아야 한다.
 * @param parent  눌러서 연 경우 그 노드. 사이드바에서 바로 열었으면 null.
 */
export function reveal(state, ids, { why, parent = null, importers }) {
  const next = {
    order: [...state.order],
    at: { ...state.at },
    opened: [...state.opened],
    width: { ...state.width },
  }
  for (const id of ids) {
    if (next.at[id]) continue     // 이미 있다 — 자리를 바꾸지 않는다
    const depth = depthOf(next, id, parent, importers)
    const col = next.width[depth] ?? 0
    next.width[depth] = col + 1
    next.at[id] = { depth, col, from: parent ?? null, why }
    next.order.push(id)
  }
  if (parent && !next.opened.includes(parent)) next.opened.push(parent)
  return next
}

/**
 * 이 노드를 펼치면 무엇이 새로 나오나 — **누르기 전에** 알려주기 위한 것.
 *
 * 🔴 "몇 개가 나올지 모르고 누르는 것" 이 곧 벽이다. 3개면 눌러도 되고
 *    200개면 마음의 준비가 필요하다. 그 판단을 사람에게 돌려준다.
 */
export function preview(state, id, calls, { limit = 6 } = {}) {
  const out = (calls.get(id) ?? []).filter((x) => !state.at[x])

  /**
   * 🔴 **첫 클릭이 벽이었다.**
   *
   * 예고만으로는 모자랐다. axMap 자신에서 진입점을 한 번 누르면 17개가
   * 한꺼번에 쏟아진다. "+17개" 라고 미리 알려주지만 **알고도 할 수 있는
   * 것이 없다** — 누르거나 안 누르거나 둘뿐이다. 그건 선택이 아니다.
   *
   * 그래서 한 번에 여는 수를 자르고 **무엇을 먼저 열지 정한다.**
   *
   * 순서는 "이 가지가 코드베이스를 얼마나 여는가" 다 — 그 파일이 부르는
   * 것의 수. 큰 파일이 중요한 파일은 아니라는 것을 `importTree` 에서
   * 이미 배웠다. 테스트·예제는 많이 불러도 뒤로 보낸다.
   *
   * 자른 것은 사라지지 않는다. `more` 로 몇 개가 남았는지 내고, 같은
   * 노드를 다시 누르면 이어서 열린다(이미 열린 것은 걸러지므로).
   */
  const isAux = (p) => AUX.test(p) || AUX_FILE.test(p)
  const opens = (p) => (calls.get(p) ?? []).filter((x) => !state.at[x]).length
  const ranked = [...out].sort((a, b) =>
    (isAux(a) ? 1 : 0) - (isAux(b) ? 1 : 0)
    || opens(b) - opens(a)
    || (a < b ? -1 : 1))

  /**
   * 어느 영역이 열리는지도 함께 낸다.
   *
   * 이름 17개를 늘어놓는 것과 "app/lib 15개 · src 1개" 라고 말하는 것은
   * 다르다. 벽이라고 느끼게 하는 것은 개수보다 **구별이 안 되는 이름들**이다.
   */
  const dirs = new Map()
  for (const p of out) {
    const i = p.lastIndexOf('/')
    const d = i < 0 ? '(루트)' : p.slice(0, i)
    dirs.set(d, (dirs.get(d) ?? 0) + 1)
  }

  return {
    count: out.length,
    ids: ranked.slice(0, limit),
    more: Math.max(0, out.length - limit),
    dirs: [...dirs.entries()].sort((a, b) => b[1] - a[1]).map(([dir, n]) => ({ dir, n })),
    why: '부르는 것이 많은 순 (테스트·예제는 뒤로)',
  }
}

/** source → [target...] — 이 파일이 부르는 것. */
export function callsOf(edges) {
  const m = new Map()
  for (const e of edges) {
    if (e.hub || e.origin === 'cochange') continue
    if (!m.has(e.source)) m.set(e.source, [])
    if (!m.get(e.source).includes(e.target)) m.get(e.source).push(e.target)
    if (e.directed === false) {
      if (!m.has(e.target)) m.set(e.target, [])
      if (!m.get(e.target).includes(e.source)) m.get(e.target).push(e.source)
    }
  }
  return m
}

/**
 * 지금 드러난 것을 층으로 낸다. 화면은 이것만 그린다.
 *
 * 층 안의 순서는 `col` 이고, `col` 은 도착 순서다 — 그래서 새것이 들어와도
 * 앞엣것의 자리가 안 바뀐다.
 */
export function layers(state, byId = new Map()) {
  const rows = new Map()
  for (const id of state.order) {
    const a = state.at[id]
    if (!rows.has(a.depth)) rows.set(a.depth, [])
    rows.get(a.depth).push({ id, ...a, lines: byId.get(id)?.lines ?? 0 })
  }
  return [...rows.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([depth, cells]) => ({ depth, cells: cells.sort((x, y) => x.col - y.col) }))
}

/**
 * 여기서 몇 개나 더 닿나 — 화면 가장자리에 적는 수.
 *
 * 🔴 "드러난 것만" 보여주기로 했으므로 규모 감각을 잃는다. 그것을 숫자로
 *    돌려준다. 안 그러면 5개를 보고 "이 저장소는 5개짜리" 로 읽는다.
 *    관측한 것만 센다 — import 로 실제로 닿는 것.
 */
export function reachable(state, calls) {
  const seen = new Set(state.order)
  let frontierN = 0
  const q = [...state.order]
  const counted = new Set(state.order)
  while (q.length) {
    const a = q.shift()
    for (const b of calls.get(a) ?? []) {
      if (counted.has(b)) continue
      counted.add(b)
      if (!seen.has(b)) frontierN++
      q.push(b)
    }
  }
  return { shown: state.order.length, more: frontierN }
}

/* ── 개념 축 ─────────────────────────────────────────────────────────────
 *
 * 🔴 import 사슬만으로는 **저장소의 대부분에 영영 못 간다.**
 *
 * 실측(syft): `cmd/syft/main.go` 에서 import 로 닿는 것이 1,244개 중
 * 19개(1.5%)뿐이다. Go 가 패키지 수준 등록으로 배선되기 때문이다.
 * 네 번 누르면 마르고, 그 뒤로는 갈 곳이 없다.
 *
 * 그래서 두 번째 축이 필요하다 — README 가 이름 붙인 묶음을 여는 길.
 * "README 읽어나가듯이" 라는 말이 이 축이다.
 */

/** 테스트·예제·생성물. 개념의 현관문이 될 수 없다. */
const AUX = /(^|\/)(testdata|examples?|tests?|spec|fixtures?|benchmarks?|mocks?|vendor)(\/|$)/i
const AUX_FILE = /(^|\/)(test_[^/]+|[^/]+_test|[^/]+\.test|[^/]+_spec|[^/]+\.spec)\.[^/.]+$/i

/**
 * 이 묶음의 **현관문** — 바깥에서 가장 많이 불리는 파일들.
 *
 * 🔴 묶음을 통째로 열면 벽이 그대로 돌아온다. syft 의 `syft/pkg` 는
 *    595개다. 한 번 눌러서 595개가 쏟아지면 우리가 없애려던 것을 다시
 *    만드는 것이다.
 *
 * 그럼 무엇을 먼저 보여주나. **다른 코드가 이 묶음으로 들어올 때 통과하는
 * 문**이다 — 바깥에서 들어오는 import 가 많은 파일. 그게 그 개념의 공개된
 * 얼굴이고, 안쪽 구현은 거기서부터 파면 된다.
 *
 * 아무도 바깥에서 안 부르면(내부 전용 묶음) 크기로 줄 세운다. 그때는
 * 근거가 약하다는 것을 `why` 에 적는다 — 지어내지 않는다.
 */
export function frontDoor(paths, edges, byId = new Map(), { limit = 6, skip = null } = {}) {
  const inside = new Set(paths)
  const fromOutside = new Map()
  for (const e of edges) {
    if (e.hub || e.origin === 'cochange') continue
    if (!inside.has(e.target) || inside.has(e.source)) continue
    fromOutside.set(e.target, (fromOutside.get(e.target) ?? 0) + 1)
  }
  const isAux = (p) => AUX.test(p) || AUX_FILE.test(p)
  /**
   * 🔴 이미 드러난 것은 후보에서 뺀다.
   *
   * 실측으로 잡았다. click 에서 `click` 묶음을 누르면 현관문 6개를 고르는데
   * 그중 5개가 이미 화면에 있던 것이라 **실제로 는 것은 1개**였다. 우리
   * 저장소에서는 6개 중 6개가 이미 열려 있어서 **눌렀는데 아무 일도 안 났다.**
   *
   * 현관문은 원래 "많이 불리는 파일" 이고 그건 import 사슬로도 먼저 닿는
   * 파일이다 — 그래서 두 축이 같은 것을 고르는 게 정상이고, 안 빼면 개념 축이
   * 있으나 마나가 된다. import 로 못 가는 곳을 열려고 만든 축이기 때문이다.
   *
   * 안 뺀 채로 "6개 열었다" 고 적으면 그건 화면이 거짓말을 하는 것이다.
   */
  const seen = skip ?? new Set()
  const fresh = paths.filter((p) => !seen.has(p))
  const cand = fresh.filter((p) => !isAux(p))
  const pool = cand.length ? cand : fresh      // 전부 테스트뿐이면 그거라도 낸다
  const ranked = [...pool].sort((a, b) =>
    (fromOutside.get(b) ?? 0) - (fromOutside.get(a) ?? 0)
    || (byId.get(b)?.lines ?? 0) - (byId.get(a)?.lines ?? 0)
    || (a < b ? -1 : 1))
  const ids = ranked.slice(0, limit)
  /**
   * 🔴 근거를 **낸 것에 대해서만** 말한다.
   *
   * 처음에는 "묶음 안에 바깥에서 불리는 파일이 하나라도 있으면" 근거를
   * `바깥에서 부르는 수` 라고 적었다. 실측(syft)에서 5개 중 2개만 불리고
   * 나머지 3개는 크기로 뽑혔는데 화면은 다섯 줄 전부에 같은 근거를 붙였다.
   * 반은 맞고 반은 틀린 설명은 전부 틀린 설명이다 — 읽는 사람이 어느 줄이
   * 어느 근거인지 가릴 수 없기 때문이다.
   */
  const withCallers = ids.filter((p) => (fromOutside.get(p) ?? 0) > 0).length
  const why = !ids.length ? '이 묶음은 이미 다 열려 있다'
    : withCallers === ids.length ? '바깥에서 부르는 수'
      : withCallers === 0 ? '바깥에서 부르는 곳이 없어 크기 순'
        : `${withCallers}개는 바깥에서 부르는 수, 나머지는 크기 순`
  return {
    ids,
    total: paths.length,
    /** 이미 열려 있어서 후보에서 빠진 수. 화면이 "새로 3개 (12개는 이미 열림)" 라고 적을 근거다. */
    already: paths.length - fresh.length,
    why,
    calledFrom: Object.fromEntries(ids.map((p) => [p, fromOutside.get(p) ?? 0])),
  }
}

/**
 * 묶음 하나를 연다 — 현관문만.
 *
 * `why` 에 묶음 이름을 넣는다. 화면에서 "왜 이게 나왔나" 를 읽을 수 있어야
 * 개념이 쌓인다. 파일 이름만 늘어놓으면 그건 다시 목록일 뿐이다.
 */
export function revealFeature(state, feature, { edges, importers, byId = new Map(), limit = 6 }) {
  // 이미 드러난 것을 넘긴다 — 안 넘기면 고른 수와 실제로 는 수가 어긋난다.
  const door = frontDoor(feature.paths ?? [], edges, byId, { limit, skip: new Set(state.order) })
  const next = reveal(state, door.ids, { why: feature.name ?? feature.id, importers })
  return { state: next, door }
}
