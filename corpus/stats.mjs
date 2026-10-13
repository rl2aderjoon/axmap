/**
 * 기준(SSOT) 집계 — 순수 함수만.
 *
 * ── 왜 히스토그램인가 ─────────────────────────────────────────────────────
 *
 * 저장소 수백 개를 돌면서 **끝없이 누적**해야 하고, 도중에 언제든 기준을 낼 수
 * 있어야 한다. 파일마다 값을 다 들고 있으면 메모리가 저장소 수에 비례해 늘고,
 * 중간에 죽으면 다 잃는다.
 *
 * 그래서 고정 구간 히스토그램에 센다. 메모리가 O(1) 이고, 합치는 것이
 * 덧셈이라 **부분 결과를 언제든 합쳐 스냅샷을 낼 수 있다.**
 *
 * ⚠️ 대신 분위수가 근사값이다. 구간 안에서는 균등분포로 보간한다.
 *    구간을 촘촘히 두는 쪽으로 오차를 줄였고, 응답에 `approx: true` 를 붙여
 *    숨기지 않는다.
 *
 * ── 🔴 인기 ≠ 좋음 ────────────────────────────────────────────────────────
 *
 * 별 많은 저장소를 긁어 "이렇게 하세요" 라고 하면 생존 편향을 규범으로 만드는
 * 것이다. 그래서 **결과 신호**를 함께 센다 —
 *
 *   재수정률(fixRate)  그 파일을 건드린 커밋 중 고침·버그 커밋의 비율
 *
 * 그리고 예측 변수(파일 길이 등)의 구간마다 재수정률을 따로 누적한다.
 * "큰 파일이 정말로 더 자주 고쳐지는가" 를 코퍼스가 직접 답하게 하기 위해서다.
 * 그 답이 "아니오" 면 파일 길이 지침은 내지 않는다.
 */

/** 구간 경계. 값은 `[i-1], [i]` 사이에 들어간다. 마지막은 열려 있다. */
export const BINS = {
  // 파일 길이. 짧은 쪽을 촘촘히 — 실무의 판단이 거기서 갈린다.
  fileLines: [0, 10, 20, 30, 50, 75, 100, 150, 200, 300, 400, 600, 800, 1200, 2000, 3000, 5000, 10000],
  // 그 파일을 건드린 커밋 수. 대략 피보나치 — 로그 스케일에 가깝다.
  fileCommits: [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377],
  // 한 파일과 함께 바뀌는 이웃 수 (공변경 팬아웃)
  fanout: [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
  // 0..1 비율
  ratio: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1],
  // 디렉터리 깊이
  depth: [0, 1, 2, 3, 4, 5, 6, 8, 10],
  // 정적 import 차수 — 이 파일에 붙은 import 엣지 수
  deg: [0, 1, 2, 3, 5, 8, 13, 21, 34, 55],
  // 신입이 첫 커밋에서 이 파일을 만난 사람 수
  firstTouch: [0, 1, 2, 3, 5, 8, 13, 21],
}

/** 값이 들어갈 구간 번호. 경계보다 작으면 0, 마지막 경계 이상이면 마지막 칸. */
export function binOf(edges, v) {
  if (!Number.isFinite(v)) return -1
  let i = 0
  while (i < edges.length && v >= edges[i]) i++
  return Math.max(0, i - 1)
}

export const emptyHist = (edges) => ({ edges, counts: new Array(edges.length).fill(0), n: 0, sum: 0 })

export function addTo(hist, v, times = 1) {
  const b = binOf(hist.edges, v)
  if (b < 0) return hist          // 숫자가 아니면 세지 않는다. 0 으로 치면 분포가 왼쪽으로 쏠린다.
  hist.counts[b] += times
  hist.n += times
  hist.sum += v * times
  return hist
}

export function mergeHist(a, b) {
  if (!a) return b
  if (!b) return a
  const out = { edges: a.edges, counts: a.counts.map((c, i) => c + (b.counts[i] ?? 0)), n: a.n + b.n, sum: a.sum + b.sum }
  return out
}

/**
 * 히스토그램에서 분위수. 구간 안은 균등분포로 본다.
 *
 * 🔴 마지막(열린) 구간에 걸리면 **경계값을 그대로 준다.**
 *    바깥으로 외삽하면 "10,000줄 이상" 을 12,345줄이라고 지어내는 셈이다.
 *    모르는 것을 아는 척하지 않는다 (D5).
 */
export function quantile(hist, q) {
  if (!hist || hist.n === 0) return null
  const target = q * hist.n
  let acc = 0
  for (let i = 0; i < hist.counts.length; i++) {
    const c = hist.counts[i]
    if (acc + c < target) { acc += c; continue }
    const lo = hist.edges[i]
    const hi = hist.edges[i + 1]
    if (hi === undefined) return lo                      // 열린 구간 — 외삽하지 않는다
    const frac = c === 0 ? 0 : (target - acc) / c
    return lo + (hi - lo) * frac
  }
  return hist.edges[hist.edges.length - 1]
}

/** 값이 분포에서 어디쯤인가 (0..1). 같은 구간 안에서는 보간한다. */
export function percentileOf(hist, v) {
  if (!hist || hist.n === 0) return null
  const b = binOf(hist.edges, v)
  if (b < 0) return null
  let below = 0
  for (let i = 0; i < b; i++) below += hist.counts[i]
  const lo = hist.edges[b]
  const hi = hist.edges[b + 1]
  const within = hi === undefined || hi === lo ? 1 : Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
  return (below + hist.counts[b] * within) / hist.n
}

export const stats = (h) => (!h || !h.n ? null : {
  n: h.n,
  mean: h.sum / h.n,
  p10: quantile(h, 0.1),
  p25: quantile(h, 0.25),
  p50: quantile(h, 0.5),
  p75: quantile(h, 0.75),
  p90: quantile(h, 0.9),
  p95: quantile(h, 0.95),
  p99: quantile(h, 0.99),
})

// ---------------------------------------------------------------------------
// 결과 신호 — 예측 변수의 구간마다 재수정률을 따로 센다
// ---------------------------------------------------------------------------

/**
 * 두 축을 엮은 누적기.
 *
 * 예: x = 파일 길이 구간, y = 그 파일의 재수정률.
 * 구간마다 합과 개수를 들고 있다가 평균을 낸다.
 *
 * 🔴 이게 "인기 따라하기" 와 "결과로 판정하기" 를 가르는 자리다.
 *    파일 길이 분포만 내면 "남들은 이만큼 쓴다" 밖에 못 말한다.
 *    길이 구간별 재수정률을 함께 내야 "길면 실제로 더 고치게 된다" 를 말할 수 있다.
 */
export const emptyLink = (edges) => ({ edges, sum: new Array(edges.length).fill(0), n: new Array(edges.length).fill(0) })

export function addLink(link, x, y) {
  const b = binOf(link.edges, x)
  if (b < 0 || !Number.isFinite(y)) return link
  link.sum[b] += y
  link.n[b] += 1
  return link
}

export function mergeLink(a, b) {
  if (!a) return b
  if (!b) return a
  return {
    edges: a.edges,
    sum: a.sum.map((s, i) => s + (b.sum[i] ?? 0)),
    n: a.n.map((c, i) => c + (b.n[i] ?? 0)),
  }
}

/** 구간별 평균. 표본이 적은 구간은 **값 대신 null** 을 준다 (fail-closed). */
export function linkTable(link, { minPerBin = 30 } = {}) {
  if (!link) return []
  return link.edges.map((lo, i) => ({
    from: lo,
    to: link.edges[i + 1] ?? null,
    n: link.n[i],
    mean: link.n[i] >= minPerBin ? link.sum[i] / link.n[i] : null,
  }))
}

/**
 * 추세가 실제로 있는가.
 *
 * 구간별 평균에 단조 증가/감소 경향이 있는지를 아주 거칠게 본다 —
 * 표본이 충분한 구간만 골라 첫 3분의 1과 마지막 3분의 1의 평균을 비교한다.
 *
 * 🔴 상관을 인과로 말하지 않는다. 이 값은 "지침을 낼 만한가" 의 문턱일 뿐이고,
 *    화면에는 언제나 구간표 전체를 함께 낸다. 사람이 직접 보게 한다.
 */
export function trend(link, { minPerBin = 30, minBins = 4 } = {}) {
  const rows = linkTable(link, { minPerBin }).filter((r) => r.mean !== null)
  if (rows.length < minBins) return { usable: false, why: `표본이 충분한 구간이 ${rows.length}개뿐이다 (${minBins}개 필요)` }
  const k = Math.max(1, Math.floor(rows.length / 3))
  const head = rows.slice(0, k)
  const tail = rows.slice(-k)
  const avg = (xs) => xs.reduce((a, r) => a + r.mean, 0) / xs.length
  const lo = avg(head)
  const hi = avg(tail)
  const ratio = lo === 0 ? null : hi / lo
  return {
    usable: true,
    low: lo,
    high: hi,
    ratio,
    // 1.3배는 눈으로 고른 값이 아니라 "이보다 작으면 화면에 적을 말이 없다" 는 뜻이다.
    // 1.1배 차이를 "이렇게 하세요" 로 바꾸면 지침이 소음이 된다.
    direction: ratio === null ? 'unknown' : ratio >= 1.3 ? 'up' : ratio <= 0.77 ? 'down' : 'flat',
    bins: rows.length,
  }
}

// ---------------------------------------------------------------------------
// 저장소를 어느 칸에 넣을 것인가
// ---------------------------------------------------------------------------

/**
 * 🔴 지침에는 **적용 조건**이 붙어야 한다.
 *
 * "함수는 20줄을 넘기지 마세요" 는 점성술이다.
 * "커밋 1,000개 이상 · 파이썬 저장소 340개에서 관찰됐다" 여야 조언이다.
 *
 * 그래서 모든 집계는 (언어, 규모) 칸 안에서만 한다. 칸을 넘어 합치지 않는다 —
 * 커밋 200개짜리 장난감과 커밋 5만 개짜리 커널을 같은 분포에 넣으면
 * 그 분포는 누구에게도 맞지 않는다.
 */
export const SIZE_BUCKETS = [
  { key: 'small', label: '커밋 400~1,500', min: 400, max: 1500 },
  { key: 'mid', label: '커밋 1,500~6,000', min: 1500, max: 6000 },
  { key: 'large', label: '커밋 6,000 이상', min: 6000, max: Infinity },
]

export const bucketOf = (commits) =>
  SIZE_BUCKETS.find((b) => commits >= b.min && commits < b.max)?.key ?? null

export const cellKey = (lang, commits) => {
  const b = bucketOf(commits)
  return lang && b ? `${lang}/${b}` : null
}

// ---------------------------------------------------------------------------
// 스냅샷
// ---------------------------------------------------------------------------

/**
 * 이 칸의 기준을 쓸 수 있는가.
 *
 * 🔴 표본이 적으면 **답을 내지 않는다.** 저장소 3개로 만든 분위수를
 *    "업계 기준" 처럼 보여주면 그건 거짓말이고, 한 번 거짓말한 지침은
 *    그 다음부터 전부 무시당한다.
 */
export const MIN_REPOS = 15
export const MIN_FILES = 300

export function cellUsable(cell) {
  if (!cell) return { ok: false, why: '이 조건(언어·규모)으로 본 저장소가 아직 없다' }
  if (cell.repos < MIN_REPOS) return { ok: false, why: `저장소 ${cell.repos}개뿐이다 (${MIN_REPOS}개 필요)` }
  if ((cell.fileLines?.n ?? 0) < MIN_FILES) return { ok: false, why: `파일 ${cell.fileLines?.n ?? 0}개뿐이다 (${MIN_FILES}개 필요)` }
  return { ok: true }
}

export function emptyCell() {
  return {
    repos: 0,
    // 우리 파서가 이 칸에서 얼마나 보고 있나. 이걸 안 내면 못 본 것을
    // "결합이 없다" 로 오해하게 만든다 (Go·Java 에서 실제로 그랬다).
    parseCoverage: { sum: 0, n: 0 },
    /**
     * 🔴 **파서 버전별** 커버리지. 전체 평균만으로는 안 되는 이유가 있다.
     *
     * `parseCoverage` 는 레코드 수만 개의 평균이다. c·rust·ruby 파서를
     * 새로 붙여도 새 레코드 몇백 개로는 평균이 안 움직이고, 결합 판정
     * 게이트는 영원히 안 열린다. 옛 기록은 "그때 우리가 파서가 없었다" 를
     * 말하는데 화면은 그것을 "이 언어는 결합을 볼 수 없다" 로 읽는다.
     *
     * 히스토그램과 달리 여기서는 옛 것을 **버리는** 것이 아니라 갈라 둔다.
     * 어느 파서로 잰 것이 몇 개인지가 그 자체로 정보다.
     */
    coverageBy: {},
    fileLines: emptyHist(BINS.fileLines),
    fileCommits: emptyHist(BINS.fileCommits),
    fixRate: emptyHist(BINS.ratio),
    fanout: emptyHist(BINS.fanout),
    depth: emptyHist(BINS.depth),
    // 지식이 한 사람에게 몰려 있나 (1 = 그 사람만 안다)
    authorShare: emptyHist(BINS.ratio),
    // 동반 짝이 정해져 있나 (높다 = 모듈, 낮다 = 허브)
    partnerShare: emptyHist(BINS.ratio),
    // 테스트·문서를 같이 고치나
    testWith: emptyHist(BINS.ratio),
    docWith: emptyHist(BINS.ratio),
    // 정적 결합 차수. 파서가 눈먼 저장소는 안 넣는다 (addRepo 참조)
    deg: emptyHist(BINS.deg),
    // 신입이 처음 만난 파일 — 관찰된 진입로
    firstTouch: emptyHist(BINS.firstTouch),

    // 결과 신호: 예측 변수 → 재수정률
    linesToFix: emptyLink(BINS.fileLines),
    fanoutToFix: emptyLink(BINS.fanout),
    depthToFix: emptyLink(BINS.depth),
    // 🔴 우리 제품의 핵심 가설 — 결합이 많으면 정말 더 고치게 되나
    degToFix: emptyLink(BINS.deg),
    // 테스트를 같이 고치는 파일이 실제로 덜 깨지나
    testWithToFix: emptyLink(BINS.ratio),
    // 지식이 몰린 파일이 더 자주 고쳐지나
    authorShareToFix: emptyLink(BINS.ratio),
    // 짝이 정해진 파일(모듈)이 덜 고쳐지나
    partnerShareToFix: emptyLink(BINS.ratio),
  }
}

export function mergeCell(a, b) {
  if (!a) return b
  if (!b) return a
  return {
    repos: a.repos + b.repos,
    parseCoverage: { sum: a.parseCoverage.sum + b.parseCoverage.sum, n: a.parseCoverage.n + b.parseCoverage.n },
    coverageBy: mergeCoverage(a.coverageBy, b.coverageBy),
    fileLines: mergeHist(a.fileLines, b.fileLines),
    fileCommits: mergeHist(a.fileCommits, b.fileCommits),
    fixRate: mergeHist(a.fixRate, b.fixRate),
    fanout: mergeHist(a.fanout, b.fanout),
    depth: mergeHist(a.depth, b.depth),
    authorShare: mergeHist(a.authorShare, b.authorShare),
    partnerShare: mergeHist(a.partnerShare, b.partnerShare),
    testWith: mergeHist(a.testWith, b.testWith),
    docWith: mergeHist(a.docWith, b.docWith),
    deg: mergeHist(a.deg, b.deg),
    firstTouch: mergeHist(a.firstTouch, b.firstTouch),
    linesToFix: mergeLink(a.linesToFix, b.linesToFix),
    fanoutToFix: mergeLink(a.fanoutToFix, b.fanoutToFix),
    depthToFix: mergeLink(a.depthToFix, b.depthToFix),
    degToFix: mergeLink(a.degToFix, b.degToFix),
    testWithToFix: mergeLink(a.testWithToFix, b.testWithToFix),
    authorShareToFix: mergeLink(a.authorShareToFix, b.authorShareToFix),
    partnerShareToFix: mergeLink(a.partnerShareToFix, b.partnerShareToFix),
  }
}

/** 버전별 커버리지를 합친다. 히스토그램 합치기와 같은 성질 — 덧셈이다. */
function mergeCoverage(a = {}, b = {}) {
  const out = {}
  for (const [v, x] of Object.entries(a)) out[v] = { sum: x.sum, n: x.n }
  for (const [v, x] of Object.entries(b)) {
    out[v] ??= { sum: 0, n: 0 }
    out[v].sum += x.sum
    out[v].n += x.n
  }
  return out
}

/** 저장소 레코드 하나를 칸에 더한다. */
export function addRepo(cell, rec) {
  cell.repos += 1
  if (Number.isFinite(rec.parseCoverage)) {
    cell.parseCoverage.sum += rec.parseCoverage
    cell.parseCoverage.n += 1
    // 도장이 없는 레코드는 파서 버전을 남기기 전에 잰 것이다. 지어내지 않고
    // 그렇게 적는다 — 'unknown' 도 하나의 버전으로 센다.
    const v = typeof rec.parser === 'string' && rec.parser ? rec.parser : 'unknown'
    cell.coverageBy[v] ??= { sum: 0, n: 0 }
    cell.coverageBy[v].sum += rec.parseCoverage
    cell.coverageBy[v].n += 1
  }
  for (const f of rec.files ?? []) {
    addTo(cell.fileLines, f.lines)
    addTo(cell.fileCommits, f.commits)
    addTo(cell.depth, f.depth)
    if (Number.isFinite(f.fixRate)) {
      addTo(cell.fixRate, f.fixRate)
      addLink(cell.linesToFix, f.lines, f.fixRate)
      addLink(cell.depthToFix, f.depth, f.fixRate)
      if (Number.isFinite(f.fanout)) addLink(cell.fanoutToFix, f.fanout, f.fixRate)
    }
    if (Number.isFinite(f.fanout)) addTo(cell.fanout, f.fanout)
    if (Number.isFinite(f.authorShare)) addTo(cell.authorShare, f.authorShare)
    if (Number.isFinite(f.partnerShare)) addTo(cell.partnerShare, f.partnerShare)
    if (Number.isFinite(f.testWith)) addTo(cell.testWith, f.testWith)
    if (Number.isFinite(f.docWith)) addTo(cell.docWith, f.docWith)
    if (Number.isFinite(f.firstTouch)) addTo(cell.firstTouch, f.firstTouch)
    /**
     * 🔴 결합도는 **파서가 보고 있는 저장소에서만** 센다.
     *
     * 실측(코퍼스 388개): ruby 커버리지 8% · c# 3%. 그런 저장소는 거의 모든
     * 파일이 결합 0으로 잡힌다. 섞으면 "결합 0인 파일 수만 개" 가 분포를 덮고,
     * 우리 제품의 핵심 가설을 우리 파서의 눈먼 정도로 반박하게 된다.
     */
    if (rec.degUsable && Number.isFinite(f.deg)) {
      addTo(cell.deg, f.deg)
      if (Number.isFinite(f.fixRate)) addLink(cell.degToFix, f.deg, f.fixRate)
    }
    if (Number.isFinite(f.fixRate)) {
      if (Number.isFinite(f.testWith)) addLink(cell.testWithToFix, f.testWith, f.fixRate)
      if (Number.isFinite(f.authorShare)) addLink(cell.authorShareToFix, f.authorShare, f.fixRate)
      if (Number.isFinite(f.partnerShare)) addLink(cell.partnerShareToFix, f.partnerShare, f.fixRate)
    }
  }
  return cell
}

/** 사람이 읽을 수 있는 스냅샷으로 굳힌다. */
/**
 * 이 칸의 커버리지를 **지금 파서 기준**으로 낸다.
 *
 * 🔴 지금 파서로 잰 저장소가 충분하면 그것만 쓴다. 모자라면 전체 평균으로
 *    떨어지되 **떨어졌다고 말한다.** 조용히 섞으면 새 파서를 붙여도 게이트가
 *    안 열리고, 왜 안 열리는지 아무도 모른다.
 *
 * @param parser 지금 쓰는 파서 도장 (`PARSER_VERSION`). null 이면 전체 평균.
 */
/**
 * 코퍼스가 쓰는 언어 이름 → 파서 표(`app/lib/langs.mjs`)의 이름.
 * 나머지는 이름이 같다.
 */
const PARSER_NAME = { 'c#': 'csharp', 'c++': 'cpp', javascript: 'js', typescript: 'ts' }

/** 이 도장이 이 언어를 읽을 수 있었나. */
const canRead = (stamp, lang) =>
  typeof stamp === 'string' && stamp.split(',').includes(PARSER_NAME[lang] ?? lang)

function coverageOf(cell, parser, lang) {
  const all = cell.parseCoverage
  const overall = all.n ? all.sum / all.n : null

  /**
   * 🔴 도장이 **통째로** 같아야 하는 것이 아니다. 이 칸의 언어를 읽을 수
   *    있었느냐만 본다.
   *
   * 처음에는 도장 문자열이 정확히 같은 레코드만 셌다. 그래서 c#·php·kotlin·
   * scala 파서를 더한 순간 도장이 바뀌면서 **이미 판정된 21칸이 5칸으로
   * 무너졌다.** `ruby/small` 은 22개를 재서 100% 로 확정돼 있었는데 21%(옛
   * 기록이 섞인 값)로 되돌아갔다. c# 파서를 붙인 것이 ruby 측정을 무효로
   * 만들 이유가 없는데도 그랬다.
   *
   * 파서를 늘릴수록 아는 것이 줄어드는 설계였다. 정반대여야 한다.
   */
  const want = PARSER_NAME[lang] ?? lang
  if (!canRead(parser, lang)) {
    // 지금 파서가 이 언어를 못 읽는다. 더 재도 안 올라간다 — 파서가 필요하다.
    return { value: overall, from: 'unsupported', repos: 0, needs: MIN_REPOS, parser }
  }
  let sum = 0
  let n = 0
  for (const [stamp, v] of Object.entries(cell.coverageBy ?? {})) {
    if (!canRead(stamp, lang)) continue
    sum += v.sum
    n += v.n
  }
  if (n >= MIN_REPOS) return { value: sum / n, from: 'current', repos: n, parser }
  return {
    value: overall,
    // 이 언어를 읽을 수 있던 도장으로 잰 것이 몇 개인지. 얼마나 더 재야 하는지가 보인다.
    from: n ? 'mixed' : 'stale',
    repos: n,
    needs: MIN_REPOS,
    parser,
  }
}

export function snapshot(cells, { at = null, parser = null } = {}) {
  const out = {}
  for (const [key, c] of Object.entries(cells)) {
    const usable = cellUsable(c)
    // 칸 열쇠가 `go/mid` 꼴이라 앞이 언어다.
    const cov = coverageOf(c, parser, key.split('/')[0])
    out[key] = {
      repos: c.repos,
      usable: usable.ok,
      why: usable.ok ? null : usable.why,
      // 🔴 우리 자신의 커버리지를 언제나 함께 낸다.
      parseCoverage: cov.value,
      // 이 숫자가 지금 파서로 잰 것인지, 옛 기록이 섞인 것인지 밝힌다.
      coverage: { from: cov.from, repos: cov.repos, needs: cov.needs ?? null, parser: cov.parser },
      fileLines: stats(c.fileLines),
      fileCommits: stats(c.fileCommits),
      fixRate: stats(c.fixRate),
      fanout: stats(c.fanout),
      depth: stats(c.depth),
      authorShare: stats(c.authorShare),
      partnerShare: stats(c.partnerShare),
      testWith: stats(c.testWith),
      docWith: stats(c.docWith),
      deg: stats(c.deg),
      firstTouch: stats(c.firstTouch),
      outcome: {
        linesToFix: { table: linkTable(c.linesToFix), trend: trend(c.linesToFix) },
        fanoutToFix: { table: linkTable(c.fanoutToFix), trend: trend(c.fanoutToFix) },
        depthToFix: { table: linkTable(c.depthToFix), trend: trend(c.depthToFix) },
        degToFix: { table: linkTable(c.degToFix), trend: trend(c.degToFix) },
        testWithToFix: { table: linkTable(c.testWithToFix), trend: trend(c.testWithToFix) },
        authorShareToFix: { table: linkTable(c.authorShareToFix), trend: trend(c.authorShareToFix) },
        partnerShareToFix: { table: linkTable(c.partnerShareToFix), trend: trend(c.partnerShareToFix) },
      },
    }
  }
  return { at, cells: out, approx: true, minRepos: MIN_REPOS, minFiles: MIN_FILES, parser }
}
