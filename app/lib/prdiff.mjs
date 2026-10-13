/**
 * PR 화면 — "이 작업이 뭘 바꿨고 어디까지 영향 갔나" (D2 의 사후 검증, F2).
 *
 * 🔴 지금 있는 흐름 ①~⑤ 는 작업 **전** 화면이다. 이건 작업 **후** 화면이다.
 *
 * 둘은 같은 데이터를 쓰지만 묻는 것이 다르다.
 *
 *   흐름   "이 문제를 이해하려면 어디를 읽어야 하나"   (F1 · 이해)
 *   PR    "이 변경이 뭘 바꿨고 어디까지 갔나"          (F2 · 검증)
 *
 * D2 는 둘을 "같은 일을 하는 두 방법이 아니라 서로 다른 두 문제" 라고 못박았다.
 * 그래서 화면을 나누고 질문도 다시 세운다.
 *
 *   Q1 무엇이 바뀌었나
 *   Q2 어디까지 번지나                       ← 바뀐 것을 import 하는 쪽 (역방향)
 *   Q3 같이 바뀌었어야 하는데 안 바뀐 것      ← 🔴 이 화면의 핵심
 *   Q4 이번 변경이 평소와 다른가
 *
 * ---
 *
 * 🔴 Q3 하나 때문에 이 화면이 있다.
 *
 * Q1 은 `git diff --stat` 이 이미 준다. Q2 는 IDE 의 "find usages" 가 준다.
 * 아무도 안 주는 것은 **diff 에 없는 파일**에 대한 이야기다. F2("AI 가 뭘
 * 망가뜨렸는지 모른다")의 실체가 정확히 그것이다 — 바뀐 것은 눈에 보이고,
 * 바뀌었어야 하는데 안 바뀐 것은 아무 데도 안 나온다.
 *
 * D12 의 실측이 그 자리를 가리킨다. immich 의 `asset.service.ts` 는
 * `stack`·`trash`·`duplicate` 를 **하나도 import 하지 않는데** 반복해서 함께
 * 바뀌었고, 커밋 `a0c7b8114` 가 정확히 그 자리에서 난 버그다 —
 * *"자산을 지웠는데 스택이 안 풀린다"*, 고친 파일은 `asset.service.ts` 하나뿐.
 * 정적 파싱에도 안 보이고 리뷰어 눈에도 안 보인다. 히스토리에만 보인다.
 *
 * 🔴 그래서 문턱을 보수적으로 잡는다 (아래 Q3_* 상수의 근거 주석).
 *
 * 오탐이 한 번 나오면 사람은 이 목록 전체를 무시하게 된다. 그때부터 이 화면은
 * 없는 것보다 나쁘다 — 확인했다는 착각만 남기기 때문이다.
 * **확신 없는 것은 내지 않는다.** 대신 왜 안 냈는지를 `gaps` 로 말한다.
 *
 * ---
 *
 * flow.mjs 와 같은 규칙을 따른다.
 *   · 질문마다 근거(`evidence`)와 못 알아낸 것(`gaps`)을 함께 낸다.
 *   · 근거가 없으면 "모른다" 를 답으로 낸다. 추측을 답으로 내지 않는다.
 *   · 순수 함수만. git 호출·파일 I/O·시계는 전부 server.mjs 가 한다.
 */

// ---------------------------------------------------------------------------
// 입력 정규화
// ---------------------------------------------------------------------------

const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '')

/** git status/diff 의 상태 문자. 화면과 판정이 같은 말을 쓰도록 한 곳에 둔다. */
const CODE_LABEL = {
  A: '추가', M: '수정', D: '삭제', R: '이름변경', C: '복사', T: '형식변경', U: '충돌', '?': '추적안됨',
}

/**
 * 변경 목록을 표준형으로 만든다.
 *
 * 문자열도 받고 `{path, code}` 도 받는다. server 가 `git diff --name-status`
 * 와 `git status --porcelain` 두 곳에서 만들어 오기 때문이다.
 */
export function normalizeChanged(changed = []) {
  const out = new Map()
  for (const c of changed) {
    const path = norm(typeof c === 'string' ? c : c?.path ?? '')
    if (!path) continue
    const code = (typeof c === 'object' && c?.code ? String(c.code) : 'M').trim()
    const head = code[0] ?? 'M'
    const prev = out.get(path)
    // 같은 파일이 커밋 diff 와 작업트리 양쪽에 나올 수 있다. 뒤에 오는 것이
    // **작업트리**(더 최신)이므로 상태를 갱신하되, 출처는 둘 다 남긴다.
    out.set(path, {
      path,
      code: head,
      label: CODE_LABEL[head] ?? head,
      where: [...new Set([...(prev?.where ?? []), (typeof c === 'object' && c?.where) || 'diff'])],
    })
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
}

/** freq 는 Map 으로도 평범한 객체로도 온다 (서버 안에서는 Map, JSON 을 거치면 객체). */
const freqOf = (freq, p) => {
  if (!freq) return 0
  if (typeof freq.get === 'function') return freq.get(p) ?? 0
  return freq[p] ?? 0
}

// ---------------------------------------------------------------------------
// Q1 · 무엇이 바뀌었나
// ---------------------------------------------------------------------------

/**
 * 변경 파일을 폴더로 묶는다.
 *
 * 🔴 폴더로 묶는다. 기능(featuregraph)으로 묶지 않는다.
 *
 * 기능 이름은 README 나 커밋 제목에서 온 **추론**이고, 여기서 틀리면 리뷰어가
 * "이 PR 은 인증을 건드렸다" 라는 틀린 요약을 읽게 된다. 폴더는 추론이 아니라
 * 사실이다. 사후 검증 화면에서는 틀릴 수 있는 요약보다 맞는 사실이 낫다.
 */
export function groupChanges(changed, nodes = []) {
  const lines = new Map(nodes.map((n) => [n.id, n.lines ?? 0]))
  const known = new Set(nodes.map((n) => n.id))

  const byDir = new Map()
  const offGraph = []
  for (const c of changed) {
    if (!known.has(c.path)) { offGraph.push(c); continue }
    const i = c.path.lastIndexOf('/')
    const dir = i < 0 ? '(최상위)' : c.path.slice(0, i)
    if (!byDir.has(dir)) byDir.set(dir, { dir, files: [], lines: 0 })
    const g = byDir.get(dir)
    g.files.push({ ...c, lines: lines.get(c.path) ?? 0 })
    g.lines += lines.get(c.path) ?? 0
  }

  return {
    groups: [...byDir.values()].sort((a, b) => b.files.length - a.files.length || (a.dir < b.dir ? -1 : 1)),
    // 🔴 그래프에 없는 파일을 조용히 버리지 않는다.
    //
    // 문서·설정·잠금파일은 노드가 아니라서 Q2·Q3 가 아무 말도 못 한다.
    // 그 사실을 말하지 않으면 "영향 없음" 으로 읽힌다 — 그런데 `package.json`
    // 이나 마이그레이션 파일이 거기 들어 있으면 영향은 오히려 가장 크다.
    offGraph,
  }
}

function q1(changed, nodes) {
  const { groups, offGraph } = groupChanges(changed, nodes)
  const gaps = []
  const inGraph = changed.length - offGraph.length

  if (!changed.length) gaps.push('바뀐 파일이 하나도 없다 — base 와 지금이 같다')
  else if (!inGraph) {
    gaps.push(
      `바뀐 ${changed.length}개가 전부 그래프 밖 파일(문서·설정 등)이다 —`
      + ' 아래 Q2·Q3 는 이 변경에 대해 아무 말도 할 수 없다',
    )
  } else if (offGraph.length) {
    gaps.push(
      `${offGraph.length}개는 그래프에 없는 파일이라 번짐·누락 판정에서 빠졌다`
      + ` (${offGraph.slice(0, 3).map((c) => c.path).join(', ')}${offGraph.length > 3 ? ' …' : ''})`,
    )
  }

  const added = changed.filter((c) => c.code === 'A').length
  const removed = changed.filter((c) => c.code === 'D').length

  return {
    n: 1,
    key: 'what',
    question: '무엇이 바뀌었나',
    why: '먼저 변경 자체를 한눈에 본다. 여기서 놀랄 것이 있으면 나머지는 볼 필요도 없다.',
    headline: `파일 ${changed.length}개 · 폴더 ${groups.length}곳`
      + (added ? ` · 새 파일 ${added}` : '') + (removed ? ` · 지운 파일 ${removed}` : ''),
    answer: {
      total: changed.length,
      inGraph,
      added,
      removed,
      groups,
      offGraph,
      lines: groups.reduce((a, g) => a + g.lines, 0),
    },
    focus: changed.map((c) => c.path),
    focusKind: 'file',
    gaps,
  }
}

// ---------------------------------------------------------------------------
// Q2 · 어디까지 번지나
// ---------------------------------------------------------------------------

/**
 * 바뀐 파일을 **import 하는 쪽**으로 역방향 BFS.
 *
 * 🔴 방향이 반대다. 흐름 ③(`layersFrom`)은 "그 다음에 무엇이 불리나" 라서
 *    나가는 방향으로 넓혔다. 여기 질문은 "이걸 고치면 누가 영향을 받나" 이므로
 *    **들어오는 방향**이다. `analyze.mjs` 의 엣지는 `source` 가 `target` 을
 *    import 한다(쓰는 쪽 → 쓰이는 쪽). 그러니 `target` 이 바뀌면 `source` 가 흔들린다.
 *
 * 🔴 공변경 엣지는 쓰지 않는다. 방향이 없어서 "번진다" 를 말할 수 없다.
 *    공변경으로 이어진 것은 Q3 가 따로 다룬다 — 둘을 섞으면 근거가 뭉개진다.
 *
 * 🔴 허브 엣지도 뺀다 (D9). 전역 신호를 참고할 뿐인 파일까지 "영향 받는 곳" 에
 *    넣으면 깊이 1에서 이미 저장소 절반이 물든다.
 *
 * @param {number} maxDepth 기본 2. D7 은 색을 끝까지 칠하라고 했지만 그건 *이해*
 *   화면의 이야기다. 리뷰는 유한한 시간 안에 끝내야 하고, 3겹 밖까지 "확인해야
 *   할 곳" 으로 내밀면 아무도 확인하지 않는다. 대신 몇 개가 더 있는지는 센다.
 */
export function impactedBy(changedPaths, edges = [], { maxDepth = 2, nodes = null } = {}) {
  const changed = new Set(changedPaths)
  const known = nodes ? new Set(nodes.map((n) => n.id)) : null

  // 역방향 인접: 이 파일이 바뀌면 흔들리는 쪽
  const rev = new Map()
  const push = (from, to, e) => {
    if (!rev.has(from)) rev.set(from, new Map())
    if (!rev.get(from).has(to)) rev.get(from).set(to, e)
  }
  for (const e of edges) {
    if (e.hub) continue
    if (e.origin === 'cochange') continue
    if (known && (!known.has(e.source) || !known.has(e.target))) continue
    push(e.target, e.source, e)
    // 방향을 모르는 엣지는 양쪽으로 통과시킨다 — 모른다고 없는 것으로 치면
    // 조용히 빠뜨린다 (analyze.mjs·flow.mjs 의 같은 판단).
    if (e.directed === false) push(e.source, e.target, e)
  }

  const seen = new Set(changed)
  const layers = []
  let frontier = [...changed]
  let beyond = 0
  for (let d = 1; ; d++) {
    const next = []
    const rows = []
    for (const p of frontier) {
      for (const [q, e] of rev.get(p) ?? []) {
        if (seen.has(q)) continue
        seen.add(q)
        next.push(q)
        rows.push({ path: q, via: p, kind: e.kind ?? 'import', origin: e.origin ?? 'static' })
      }
    }
    if (!rows.length) break
    if (d > maxDepth) { beyond += rows.length; frontier = next; continue }
    layers.push({ depth: d, count: rows.length, files: rows })
    frontier = next
  }

  return { layers, total: layers.reduce((a, l) => a + l.count, 0), beyond }
}

/** 정적 파싱이 눈이 먼 상태인가. 그러면 Q2 의 "번짐 없음" 은 결과가 아니라 침묵이다. */
function unparsedRatio(nodes = []) {
  const parseable = nodes.filter((n) => n.confidence !== 'history-only')
  if (!parseable.length) return 0
  return parseable.filter((n) => n.confidence === 'unparsed').length / parseable.length
}

function q2(changed, nodes, edges, { maxDepth = 2 } = {}) {
  const paths = changed.map((c) => c.path)
  const r = impactedBy(paths, edges, { maxDepth, nodes })
  const gaps = []

  const blind = unparsedRatio(nodes)
  if (blind >= 0.3) {
    // 🔴 syft(Go) 에서 노드의 98.6%가 파싱 실패였는데 화면은 그 상태를
    //    결과처럼 보여줬다. 여기서 침묵하면 "아무 데도 안 번진다" 가 된다.
    gaps.push(
      `파일의 ${Math.round(blind * 100)}%는 import 를 읽지 못했다 —`
      + ' 여기 안 나온다고 영향이 없는 것이 아니다. "연결을 보지 못했다" 이다',
    )
  }
  // 삭제된 파일은 특히 위험하다. 지워진 파일을 import 하던 쪽은 그냥 깨진다.
  const deleted = changed.filter((c) => c.code === 'D').map((c) => c.path)
  const brokenBy = deleted.filter((p) => r.layers[0]?.files.some((f) => f.via === p))
  if (brokenBy.length) {
    gaps.push(`지운 파일 ${brokenBy.length}개를 아직 import 하는 곳이 있다 — ${brokenBy.slice(0, 3).join(', ')}`)
  }
  if (!r.total && !blind) {
    gaps.push('이 파일들을 import 하는 곳이 없다 — 진입점이거나, 아직 아무도 안 쓰는 새 코드다')
  }

  return {
    n: 2,
    key: 'spread',
    question: '어디까지 번지나',
    why: '바뀐 파일을 쓰는 쪽은 코드를 안 고쳤어도 동작이 바뀐다. 리뷰가 닿아야 하는 범위다.',
    headline: r.total
      ? `${r.total}개가 이 변경을 import 한다 (1겹 ${r.layers[0]?.count ?? 0}${r.layers[1] ? ` · 2겹 ${r.layers[1].count}` : ''})`
      : 'import 로 이어진 곳이 없다',
    answer: { ...r, maxDepth },
    focus: r.layers.flatMap((l) => l.files.map((f) => f.path)),
    focusKind: 'file',
    gaps,
  }
}

// ---------------------------------------------------------------------------
// Q3 · 같이 바뀌었어야 하는데 안 바뀐 것        ← 이 화면의 핵심
// ---------------------------------------------------------------------------

/**
 * 문턱 넷. 전부 **오탐을 줄이는 쪽**으로 골랐고, 각각 다른 실패를 막는다.
 *
 * | 상수 | 값 | 막는 것 |
 * |---|---|---|
 * | `Q3_MIN_SUPPORT` | 5 | 우연히 두세 번 겹친 쌍 |
 * | `Q3_MIN_FREQ`    | 8 | 분모가 작아 conf 가 1.0 으로 튀는 것 |
 * | `Q3_MIN_CONF`    | 0.5 | "평소에도 절반은 따로 바뀌던" 쌍 |
 * | `Q3_MIN_LIFT`    | 2 | 아무거나와 함께 바뀌는 파일 (CHANGELOG·버전파일) |
 *
 * **왜 5·8 인가 — 지어낸 숫자가 아니라 화면이 이미 쓰는 숫자다.**
 * `overlay.js` 의 "표본 충분한 것만" 이 `STRONG_SUP=5` · `STRONG_FREQ=8` 이다.
 * 같은 저장소에서 사분면 화면은 "표본이 부족하다" 며 숨긴 쌍을 PR 화면은
 * "빠뜨렸습니다" 라고 단언하면, 두 화면이 서로를 반박한다. 문턱은 같아야 한다.
 *
 * **왜 conf 0.5 인가.** conf = support / (그 파일이 바뀐 커밋 수) 이고
 * "이 파일을 고친 지난 N번 중 M번은 저것도 함께 고쳤다" 는 뜻이다.
 * 절반에 못 미치면 **따로 바뀌는 것이 기본값**이라는 말이므로, 그걸 누락이라고
 * 부르면 그 자체가 틀린 주장이다. 0.5 는 "평소에 더 자주 함께 바뀌었다" 의 경계다.
 *
 * **왜 lift 2 인가.** conf 만으로는 자주 바뀌는 파일을 못 거른다. 전체 커밋의
 * 60% 에 등장하는 파일은 무엇과 짝지어도 conf 0.6 이 나오지만 lift 는 1 근처다.
 * lift 2 = "우연보다 두 배는 자주" 이고, cochange.mjs 가 엣지를 만들 때 쓰는
 * 최소 문턱(support 3)보다 훨씬 위다.
 *
 * 🔴 이 값들을 내리면 통과가 늘어난다. 내릴 때는 **왜 늘려도 되는지** 근거를
 *    여기 남긴다 (CLAUDE.md 의 fail-closed 규칙).
 */
export const Q3_MIN_SUPPORT = 5
export const Q3_MIN_FREQ = 8
export const Q3_MIN_CONF = 0.5
export const Q3_MIN_LIFT = 2

/**
 * 이번 diff 에 없는데, 히스토리가 "보통 같이 바뀐다" 고 말하는 파일.
 *
 * @param {string[]} changedPaths
 * @param {object[]} coEdges cochange.mjs 의 엣지 {source,target,support,confA,confB,lift}
 * @param {Map|object} freq 파일별 등장 커밋 수
 */
export function missingCoChanges(changedPaths, coEdges = [], freq = null, {
  minSupport = Q3_MIN_SUPPORT,
  minFreq = Q3_MIN_FREQ,
  minConf = Q3_MIN_CONF,
  minLift = Q3_MIN_LIFT,
  limit = 12,
  exclude = null,   // 판정에서 뺄 경로 (예: 그래프에 이미 없는 파일)
} = {}) {
  const changed = new Set(changedPaths)
  const best = new Map()
  const dropped = { support: 0, conf: 0, lift: 0, shortHistory: 0 }
  const shortHistory = new Set()
  let considered = 0

  for (const e of coEdges) {
    const aIn = changed.has(e.source)
    const bIn = changed.has(e.target)
    // 양쪽 다 바뀌었으면 잘한 것이고, 양쪽 다 안 바뀌었으면 이 PR 과 무관하다.
    if (aIn === bIn) continue
    const from = aIn ? e.source : e.target      // 이번에 바뀐 쪽
    const to = aIn ? e.target : e.source        // 안 바뀐 쪽 = 후보
    if (exclude?.has(to)) continue
    considered++

    const n = freqOf(freq, from)
    /**
     * 🔴 히스토리가 짧은 파일에 대해서는 **아무 말도 하지 않는다.**
     *
     * conf 는 support/n 이라 n 이 3이면 3번 중 3번으로 1.0 이 나온다.
     * 그 숫자는 "언제나 함께 바뀐다" 가 아니라 "표본이 3개다" 라는 뜻인데,
     * 화면에는 100% 로 찍힌다. 확신 있게 틀린 답이 가장 해롭다 (D5).
     */
    if (n < minFreq) { dropped.shortHistory++; shortHistory.add(from); continue }

    const support = e.support ?? 0
    if (support < minSupport) { dropped.support++; continue }

    /**
     * conf 는 엣지에 실려 온 것을 쓰지 않고 여기서 다시 계산한다.
     * `confA`/`confB` 는 source/target 기준이라 어느 쪽이 바뀐 쪽인지에 따라
     * 분모가 달라진다. 방향을 잘못 집으면 조용히 다른 질문에 답하게 된다.
     */
    const conf = support / n
    if (conf < minConf) { dropped.conf++; continue }
    if ((e.lift ?? 0) < minLift) { dropped.lift++; continue }

    const row = {
      path: to,
      support,
      of: n,
      conf: +conf.toFixed(3),
      lift: e.lift ?? 0,
      from,
      // 🔴 근거를 문장으로 함께 낸다. 숫자만 주면 관찰자 셋이 전부
      //    "이 숫자가 뭐냐" 고 물었다 (overlay.js 의 TERMS 와 같은 이유).
      evidence: `${from} 를 고친 지난 ${n}번 중 ${support}번 함께 바뀌었다`
        + ` (${Math.round(conf * 100)}% · 우연의 ${e.lift ?? 0}배)`,
      alsoFrom: [],
    }
    const prev = best.get(to)
    if (!prev) { best.set(to, row); continue }
    // 같은 후보를 여러 변경 파일이 가리키면 **가장 센 근거**를 대표로 삼고
    // 나머지는 옆에 붙인다. 근거가 여럿이라는 사실 자체가 신호다.
    if (conf > prev.conf || (conf === prev.conf && support > prev.support)) {
      row.alsoFrom = [...prev.alsoFrom, prev.from]
      best.set(to, row)
    } else {
      prev.alsoFrom.push(from)
    }
  }

  const rows = [...best.values()].sort(
    (a, b) => b.conf - a.conf || b.support - a.support || (a.path < b.path ? -1 : 1),
  )
  return {
    rows: rows.slice(0, limit),
    truncated: Math.max(0, rows.length - limit),
    stats: { considered, dropped, shortHistory: [...shortHistory] },
    thresholds: { minSupport, minFreq, minConf, minLift },
  }
}

function q3(changed, coEdges, freq, opts) {
  const paths = changed.map((c) => c.path)
  // 지운 파일은 짝을 부를 자격이 있다(지웠으면 쓰던 쪽도 고쳐야 한다).
  // 다만 후보로는 나오면 안 된다 — 이번에 지운 파일을 "안 바꿨다" 고 할 수는 없다.
  const r = missingCoChanges(paths, coEdges, freq, opts)
  const gaps = []

  if (!coEdges.length) {
    gaps.push('공변경 엣지가 하나도 없다 — 히스토리가 짧거나(커밋 부족) 이름이 바뀐 파일이 많다. Q3 는 판정하지 못했다')
  } else if (r.stats.shortHistory.length) {
    /**
     * 🔴 "빠진 것 없음" 과 "판정할 수 없었음" 은 다른 말이다.
     *
     * 화면에서 이 둘이 같아 보이면 사용자는 확인했다고 믿는다.
     * 새로 만든 파일이나 최근에 추가된 파일은 대부분 여기 걸린다.
     */
    gaps.push(
      `${r.stats.shortHistory.length}개 파일은 히스토리가 ${Q3_MIN_FREQ}커밋 미만이라 판정하지 않았다`
      + ` (${r.stats.shortHistory.slice(0, 3).join(', ')}${r.stats.shortHistory.length > 3 ? ' …' : ''})`,
    )
  }
  if (!r.rows.length && r.stats.considered > 0) {
    const d = r.stats.dropped
    gaps.push(
      `문턱을 넘은 후보가 없다 — 검토한 쌍 ${r.stats.considered}개 중`
      + ` 표본 부족 ${d.support + d.shortHistory} · 동반율 미달 ${d.conf} · lift 미달 ${d.lift}`,
    )
  }

  return {
    n: 3,
    key: 'missing',
    question: '같이 바뀌었어야 하는데 안 바뀐 것',
    why: '바뀐 것은 diff 에 보인다. 안 바뀐 것은 아무 데도 안 나온다 — 그 자리에서 사고가 난다 (D12).',
    headline: r.rows.length
      ? `${r.rows.length}개가 평소 함께 바뀌던 파일인데 이번 diff 에 없다`
      : (coEdges.length ? '문턱을 넘는 누락 후보가 없다' : '판정할 히스토리가 없다'),
    answer: r,
    focus: r.rows.map((x) => x.path),
    focusKind: 'file',
    gaps,
  }
}

// ---------------------------------------------------------------------------
// Q4 · 이번 변경이 평소와 다른가
// ---------------------------------------------------------------------------

/** 비교할 과거 커밋이 이보다 적으면 "평소" 라는 말 자체를 못 한다. */
export const Q4_MIN_COMMITS = 5
/** 쌍 분석을 포기하는 크기. 200개 diff 면 쌍이 2만 개라 재미도 뜻도 없다. */
const Q4_MAX_PAIRS_FILES = 60

/**
 * 평소 이 파일들이 함께 바뀌던 범위와 이번 변경을 비교한다.
 *
 * 두 가지를 본다.
 *   크기   평소 이 파일들이 낀 커밋은 몇 개짜리였나 (중앙값)
 *   조합   이번에 함께 바뀐 쌍 중 과거에도 함께 바뀐 적 있는 비율
 *
 * 🔴 조합 쪽이 크기보다 중요하다. 큰 PR 이 나쁜 것은 아니다. 나쁜 것은
 *    **평소 아무 상관 없던 파일들이 한 커밋에 들어오는 것**이고, 그건 보통
 *    "AI 가 시킨 것 말고 다른 것도 건드렸다" 이거나 관심사가 섞인 것이다.
 *    D3 이 말한 "선언 ⊂ 실제" 를 히스토리 쪽에서 재는 방법이다.
 *
 * 🔴 중앙값을 쓴다. 평균은 대량 포맷팅 커밋 하나에 통째로 끌려간다
 *    (cochange.mjs 가 454파일 커밋을 버리는 것과 같은 이유).
 */
export function compareWithUsual(changedPaths, commits = []) {
  const changed = new Set(changedPaths)
  const related = commits.filter((c) => (c.files ?? []).some((f) => changed.has(f)))

  const sizes = related.map((c) => c.files.length).sort((a, b) => a - b)
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : null
  const p90 = sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.9))] : null

  // 과거에 함께 바뀐 적 있는 쌍
  const seenPairs = new Set()
  for (const c of related) {
    const inDiff = (c.files ?? []).filter((f) => changed.has(f)).sort()
    for (let i = 0; i < inDiff.length; i++) {
      for (let j = i + 1; j < inDiff.length; j++) seenPairs.add(`${inDiff[i]}\0${inDiff[j]}`)
    }
  }
  const list = [...changed].sort()
  let pairsTotal = 0
  let pairsSeen = 0
  const newPairs = []
  const pairable = list.length <= Q4_MAX_PAIRS_FILES
  if (pairable) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        pairsTotal++
        if (seenPairs.has(`${list[i]}\0${list[j]}`)) pairsSeen++
        else if (newPairs.length < 8) newPairs.push([list[i], list[j]])
      }
    }
  }

  const touched = new Set(related.flatMap((c) => c.files ?? []))
  const firstTime = list.filter((p) => !touched.has(p))

  return {
    relatedCommits: related.length,
    median,
    p90,
    thisSize: list.length,
    pairsTotal,
    pairsSeen,
    // 🔴 pairsTotal 이 0 이면 비율은 "0%" 가 아니라 **없음**이다.
    //    0 을 내놓으면 "한 번도 같이 안 바뀌었다" 로 읽힌다.
    familiarity: pairsTotal ? +(pairsSeen / pairsTotal).toFixed(3) : null,
    newPairs,
    firstTime,
    pairable,
    samples: related.slice(0, 5).map((c) => ({
      subject: c.subject ?? '',
      size: c.files.length,
      hit: (c.files ?? []).filter((f) => changed.has(f)).length,
    })),
  }
}

function q4(changed, commits) {
  const paths = changed.map((c) => c.path)
  const r = compareWithUsual(paths, commits)
  const gaps = []
  const flags = []

  if (r.relatedCommits < Q4_MIN_COMMITS) {
    // 🔴 "평소" 를 말하려면 평소가 있어야 한다. 커밋 두 개로 평균을 내고
    //    "평소보다 넓습니다" 라고 말하는 것은 근거 없는 단정이다.
    gaps.push(
      `이 파일들이 낀 과거 커밋이 ${r.relatedCommits}개뿐이라 "평소" 를 말할 수 없다`
      + ` (${Q4_MIN_COMMITS}개 이상 필요)`,
    )
  } else {
    if (r.median != null && r.thisSize > Math.max(r.p90, r.median + 3)) {
      flags.push({
        key: 'wide',
        text: `평소 이 파일들은 ${r.median}개짜리 커밋에서 바뀌었는데 이번은 ${r.thisSize}개다`
          + ` (상위 10% 커밋도 ${r.p90}개)`,
      })
    }
    if (r.pairable && r.familiarity != null && r.familiarity < 0.2 && r.thisSize >= 3) {
      flags.push({
        key: 'unfamiliar',
        text: `함께 바뀐 쌍 ${r.pairsTotal}개 중 과거에도 함께 바뀐 적 있는 것은 ${r.pairsSeen}개뿐이다`
          + ' — 평소 따로 움직이던 것들이 한 번에 들어왔다. 관심사가 섞였는지 확인할 것',
      })
    }
    if (r.firstTime.length) {
      flags.push({
        key: 'first',
        text: `${r.firstTime.length}개는 이 파일들과 함께 바뀐 적이 한 번도 없다`
          + ` (${r.firstTime.slice(0, 3).join(', ')}${r.firstTime.length > 3 ? ' …' : ''})`,
      })
    }
  }
  if (!r.pairable) {
    gaps.push(`변경 파일이 ${r.thisSize}개라 조합 분석은 건너뛰었다 (${Q4_MAX_PAIRS_FILES}개까지)`)
  }
  if (!commits.length) gaps.push('커밋 히스토리를 못 읽어 비교할 것이 없다')

  return {
    n: 4,
    key: 'usual',
    question: '이번 변경이 평소와 다른가',
    why: '같은 코드를 고치던 지난 커밋들과 모양이 다르면, 그 다름 자체가 봐야 할 이유다 (D3).',
    headline: r.relatedCommits < Q4_MIN_COMMITS
      ? '비교할 히스토리가 부족하다'
      : flags.length
        ? `평소와 다른 점 ${flags.length}가지`
        : `평소 범위 안이다 (과거 ${r.relatedCommits}개 커밋 기준)`,
    answer: { ...r, flags },
    focus: r.firstTime,
    focusKind: 'file',
    gaps,
  }
}

// ---------------------------------------------------------------------------

/**
 * 네 질문에 답한다.
 *
 * @param {object} input
 *   changed   변경 파일 [{path, code}] 또는 [string]
 *   nodes     그래프 노드
 *   edges     오버레이 엣지 (origin 포함)
 *   coEdges   공변경 엣지
 *   freq      파일별 등장 커밋 수 (Map 또는 객체)
 *   commits   커밋별 파일 목록 [{subject, files}]
 */
export function prReview({
  changed = [], nodes = [], edges = [], coEdges = [], freq = null, commits = [],
} = {}, opts = {}) {
  const list = normalizeChanged(changed)
  const known = new Set(nodes.map((n) => n.id))

  // 🔴 이번에 지운 파일은 Q3 후보에서 뺀다. "지운 파일을 안 바꿨다" 는 말이
  //    안 되고, 그래프에도 이미 없다.
  const exclude = new Set(list.filter((c) => c.code === 'D').map((c) => c.path))

  const questions = [
    q1(list, nodes),
    q2(list, nodes, edges, opts),
    q3(list.filter((c) => known.has(c.path) || freqOf(freq, c.path) > 0), coEdges, freq, { ...opts, exclude }),
    q4(list, commits),
  ]

  /**
   * 🔴 변경이 없으면 Q2~Q4 는 입을 다문다.
   *
   * 그냥 두면 빈 입력에 대고 "이 파일들을 import 하는 곳이 없다 — 진입점이거나
   * 아직 아무도 안 쓰는 새 코드다" 같은 말을 한다. 사실도 아니고(파일이 없다)
   * 읽는 사람에게는 **답처럼 보인다.** 답할 것이 없을 때 답처럼 보이는 문장을
   * 내놓는 것이 이 도구가 가장 조심해야 하는 실패다.
   */
  if (!list.length) {
    for (const q of questions.slice(1)) {
      q.headline = '변경이 없어 답할 것이 없다'
      q.gaps = []
    }
  }

  return {
    changed: list,
    questions,
    // 흐름과 같은 규칙 — 질문마다 gaps 를 내도 사용자가 넷을 다 읽지는 않는다.
    gaps: questions.flatMap((q) => q.gaps.map((text) => ({ q: q.n, text }))),
    stats: {
      changed: list.length,
      nodes: nodes.length,
      coEdges: coEdges.length,
      commits: commits.length,
    },
  }
}
