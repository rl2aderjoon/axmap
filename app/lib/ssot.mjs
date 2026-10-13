/**
 * 코퍼스 기준(SSOT)을 화면의 판정 문턱값에 붙인다.
 *
 * 🔴 지금까지 문턱값은 전부 **눈으로 고른 상수**였다.
 *
 *   splitOver 300   "300줄 넘으면 큰 파일"
 *   hubCap    6     "6개 넘게 공유되면 허브"
 *
 * 근거가 없다. 저장소 하나만 보고는 정할 수가 없기 때문이다.
 * 그래서 AWS 의 코퍼스가 수천 개 공개 저장소를 돌며 이 값들을 **분포**로 바꾼다.
 * 여기는 그 분포를 받아 이 저장소에 맞는 칸을 골라 쓰는 자리다.
 *
 * 실제로 둘 다 코퍼스보다 빡빡했다 (python/mid, 저장소 119개 기준):
 *
 *   파일 길이 p90 = 554줄   ← 우리는 300 을 "길다" 고 불렀다
 *   import 차수 p90 = 10.5  ← 우리는 6 을 "허브" 라고 불렀다
 *
 * 평범한 파일을 길다고 하고 평범한 채널을 허브라고 부르고 있었다는 뜻이다.
 *
 * ## 애매하면 기본값으로 떨어지되, 조용히 떨어지지 않는다
 *
 * 표본이 모자라거나 파서 커버리지가 낮으면 코퍼스 값을 쓰지 않는다.
 * 한 번 거짓말한 지침은 그 다음부터 전부 무시당한다.
 * 다만 **떨어졌다는 사실과 이유를 반드시 함께 낸다** — 화면이 근거를 표시해야
 * 사람이 그 숫자를 믿을지 말지 정할 수 있다.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cellKey } from '../../corpus/stats.mjs'

/** 코퍼스가 답하지 못할 때 쓰는 값. 지금까지 눈으로 고른 그 값이다. */
export const DEFAULTS = { splitOver: 300, hubCap: 6 }

/**
 * 결합 판정에 요구하는 최소 파서 커버리지.
 *
 * 🔴 우리가 못 읽는 언어에서는 결합이 **0 으로 보인다.** 그 0 을 근거로
 * "아름답게 분리돼 있군요" 라고 말하면 새빨간 거짓말이다. 루비 커버리지는 8% 다.
 *
 * 길이(splitOver)는 파서와 무관하게 줄만 세면 되므로 이 게이트를 받지 않는다.
 * 차수(hubCap)는 import 를 읽어야 나오므로 받는다.
 */
export const MIN_COVERAGE_FOR_COUPLING = 0.6

/**
 * 코퍼스 분포 + 이 저장소의 성격 → 쓸 문턱값과 그 근거.
 *
 * 순수 함수다. 네트워크도 시계도 보지 않는다 — 그래야 표본 부족·커버리지 미달
 * 같은 경계를 실제 서버를 띄우지 않고 검증할 수 있다.
 *
 * @param {object|null} baseline  `/ssot/baseline` 응답 (없으면 null)
 * @param {{lang: string|null, commits: number|null}} repo
 * @returns {{splitOver: number, hubCap: number, cell: string|null,
 *            splitFrom: 'corpus'|'default', hubFrom: 'corpus'|'default',
 *            why: string|null, repos: number|null, at: string|null,
 *            parseCoverage: number|null}}
 */
export function resolveThresholds(baseline, { lang, commits }, defaults = DEFAULTS) {
  const fallback = (why) => ({
    ...defaults,
    cell: null,
    splitFrom: 'default',
    hubFrom: 'default',
    why,
    repos: null,
    at: baseline?.at ?? null,
    parseCoverage: null,
  })

  if (!baseline || !baseline.cells) return fallback('코퍼스 기준을 받지 못했다')

  // 커밋 400개 미만이면 bucketOf 가 null 을 낸다. 히스토리가 얕으면 분포에
  // 넣을 수 없다는 뜻이지, 0 으로 치면 되는 게 아니다.
  const key = cellKey(lang, commits ?? 0)
  if (!key) {
    return fallback(
      lang ? `커밋 ${commits ?? 0}개 — 분포에 넣기엔 히스토리가 얕다 (하한 400)` : '주 언어를 정하지 못했다',
    )
  }

  const cell = baseline.cells[key]
  if (!cell) return fallback(`${key} 칸이 아직 없다`)
  if (!cell.usable) return fallback(`${key}: ${cell.why ?? '표본 부족'}`)

  const cov = typeof cell.parseCoverage === 'number' ? cell.parseCoverage : null

  // 분위수 하나가 망가진 것을 전체 실패로 만들지 않는다. 대신 그 항목만 떨어뜨린다.
  const q = (metric) => {
    const v = cell[metric]?.p90
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
  }

  const lines = q('fileLines')
  const deg = q('deg')

  const couplingOk = cov !== null && cov >= MIN_COVERAGE_FOR_COUPLING

  const notes = []
  if (!lines) notes.push('파일 길이 분위수가 없다')
  /**
   * 🔴 보류하는 것만으로는 부족하다. **왜** 보류인지 말해야 한다.
   *
   * 커버리지는 코퍼스 레코드 수만 개의 평균이다. 그래서 오늘 c·rust·ruby
   * 파서를 붙여도, 그 파서로 다시 잰 저장소가 쌓이기 전까지는 옛 숫자가
   * 나온다. 그 상태에서 "결합 판정 보류" 만 뜨면 사용자는 도구가 그 언어를
   * 영영 못 본다고 읽는다 — 실제로는 **재측정 중**인데.
   *
   * 코퍼스가 `coverage.from` 으로 알려준다 (corpus/stats.mjs):
   *   current  지금 파서로 잰 것만으로 낸 값
   *   mixed    모자라서 옛 기록이 섞였다
   *   stale    지금 파서로 잰 것이 아직 없다
   */
  const cvi = cell.coverage ?? null
  if (!couplingOk) {
    const pct = cov === null ? '미상' : `${Math.round(cov * 100)}%`
    let extra = ''
    /**
     * 🔴 "아직 못 쟀다" 와 "읽을 파서가 없다" 는 다른 말이다.
     *
     * 앞엣것은 기다리면 풀린다. 뒤엣것은 저장소를 아무리 더 모아도 안 풀린다 —
     * 파서를 만들어야 한다. 둘을 같은 문구로 쓰면 사람이 기다리기만 한다.
     */
    if (cvi?.from === 'unsupported') extra = ' (이 언어를 읽는 파서가 아직 없다 — 더 모아도 안 올라간다)'
    else if (cvi?.from === 'stale') extra = ' (지금 파서로 다시 잰 저장소가 아직 없다 — 재측정 중)'
    else if (cvi?.from === 'mixed') extra = ` (지금 파서로 잰 것은 ${cvi.repos}개뿐 — ${cvi.needs}개부터 이 값을 쓴다)`
    notes.push(`파서 커버리지 ${pct} — 결합 판정 보류${extra}`)
  }
  else if (!deg) notes.push('import 차수 분위수가 없다')

  return {
    // 상위 10% 를 "길다" 고 부른다. 같은 언어·같은 규모의 저장소들 기준이다.
    splitOver: lines ? Math.round(lines) : defaults.splitOver,
    /**
     * 🔴 근사다. 근거를 남긴다.
     *
     * hubCap 은 **채널 하나를 몇 개 파일이 공유하는가**를 재고,
     * 코퍼스의 deg 는 **파일 하나에 붙은 import 엣지 수**를 잰다. 단위가 다르다.
     *
     * 다만 채널 하나를 N 개 파일이 공유하면 analyze.mjs 가 그 사이를 거의
     * 완전 그래프로 잇는다(analyze.mjs:625~). 그래서 참여 파일의 차수가 대략
     * N-1 이 된다. 채널 크기를 deg 의 p90 근처에서 자르면 "이 저장소류에서
     * 상위 10% 밖의 차수를 만드는 채널" 을 걷어내는 것과 비슷해진다.
     *
     * 정확히 하려면 코퍼스가 채널 크기 자체를 재야 한다. 아직 안 잰다.
     * 그때까지는 이 근사와 그 한계를 화면에 같이 낸다.
     */
    hubCap: couplingOk && deg ? Math.max(1, Math.round(deg)) : defaults.hubCap,
    cell: key,
    splitFrom: lines ? 'corpus' : 'default',
    hubFrom: couplingOk && deg ? 'corpus' : 'default',
    why: notes.length ? notes.join(' · ') : null,
    repos: cell.repos ?? null,
    at: baseline.at ?? null,
    parseCoverage: cov,
    // 이 커버리지가 지금 파서 것인지, 옛 기록이 섞인 것인지. 화면이 쓴다.
    coverageFrom: cvi?.from ?? null,
    coverageRepos: cvi?.repos ?? null,
  }
}

/**
 * 이 저장소의 주 언어를 정한다 — 파일 수가 가장 많은 확장자.
 *
 * 코퍼스가 GitHub 의 `language` 필드로 칸을 나눴으므로 이름을 그것에 맞춘다.
 * 모르는 확장자만 있으면 **추측하지 않고 null** 을 낸다.
 */
const LANG_BY_EXT = {
  '.py': 'python', '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.go': 'go', '.java': 'java', '.rs': 'rust', '.rb': 'ruby',
  '.php': 'php', '.kt': 'kotlin', '.swift': 'swift', '.scala': 'scala',
  '.cs': 'c#', '.c': 'c', '.h': 'c', '.cc': 'c++', '.cpp': 'c++', '.hpp': 'c++',
}

// ---------------------------------------------------------------------------
// 받아오기 — 여기서부터는 부수효과다
// ---------------------------------------------------------------------------

export const SSOT_URL = process.env.AXMAP_SSOT_URL ?? 'http://127.0.0.1:7902/baseline'

/** 저장소를 더럽히지 않게 OS 임시 디렉터리에 둔다. 지워져도 다시 받으면 그만이다. */
export const CACHE_PATH = path.join(os.tmpdir(), 'axmap-ssot-baseline.json')

/**
 * 코퍼스 기준을 받아온다. 못 받으면 캐시, 캐시도 없으면 null.
 *
 * 🔴 **없다고 서버가 죽으면 안 된다.** 이 도구는 비행기 안에서도 떠야 한다.
 * 기준이 없으면 눈으로 고른 기본값으로 돌아가고, 그 사실을 화면이 말한다.
 * 조용히 기본값을 쓰는 것과 기본값이라고 말하는 것은 완전히 다르다.
 *
 * 캐시를 **먼저 쓰지 않고 나중에 쓰는** 이유: 코퍼스는 지금도 수집 중이라
 * 매 세션 최신을 받는 것이 이 루프의 목적이다. 캐시는 오프라인 대비일 뿐이다.
 */
export async function fetchBaseline({ url = SSOT_URL, cachePath = CACHE_PATH, timeoutMs = 5000 } = {}) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    // 모양을 확인하고 저장한다. 쓰레기를 캐시하면 오프라인일 때 더 나빠진다.
    if (!j || typeof j !== 'object' || !j.cells) throw new Error('cells 가 없다')
    try { fs.writeFileSync(cachePath, JSON.stringify(j)) } catch { /* 캐시 실패는 치명적이지 않다 */ }
    return { baseline: j, from: 'network' }
  } catch (e) {
    try {
      const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
      return { baseline: j, from: 'cache', error: e.message }
    } catch {
      return { baseline: null, from: 'none', error: e.message }
    }
  }
}

export function dominantLang(paths) {
  const n = new Map()
  for (const p of paths) {
    const dot = p.lastIndexOf('.')
    if (dot < 0) continue
    const lang = LANG_BY_EXT[p.slice(dot).toLowerCase()]
    if (!lang) continue
    n.set(lang, (n.get(lang) ?? 0) + 1)
  }
  if (!n.size) return null
  return [...n].sort((a, b) => b[1] - a[1])[0][0]
}

/**
 * 이 값이 코퍼스 분포에서 어디쯤인가.
 *
 * 🔴 날 숫자는 아무것도 말하지 않는다. `go.mod 865회` 를 보고 신입이 할 수
 *    있는 판단은 없다 — 865가 많은 건지 원래 그런 건지 알 방법이 없기 때문이다.
 *    같은 언어·규모 저장소 수천 개의 분포와 대면 그제야 **객관적 진술**이 된다.
 *
 * 🔴 정밀도를 지어내지 않는다. 분위점(p10·p25·…·p99) 사이를 선형 보간해서
 *    "상위 3.7%" 라고 쓰면 있지도 않은 정밀도를 주장하는 것이다. 실제로 가진
 *    것은 몇 개의 점뿐이므로 **띠로만** 말한다.
 *
 * @param {object|null} dist  `{p10,p25,p50,p75,p90,p95,p99,n}` 꼴
 * @param {number|null} value
 * @returns {{band: string, label: string, n: number|null}|null}
 */
export function bandOf(dist, value) {
  if (!dist || typeof value !== 'number' || !Number.isFinite(value)) return null
  const p = ['p99', 'p95', 'p90', 'p75', 'p50', 'p25'].map((k) => [k, dist[k]])
  // 분위가 하나라도 비면 판단하지 않는다. 반쪽 분포로 매긴 등수는 등수가 아니다.
  if (p.some(([, v]) => typeof v !== 'number')) return null
  const n = typeof dist.n === 'number' ? dist.n : null
  /**
   * 중앙값의 몇 배인가.
   *
   * 🔴 띠만으로는 변별이 안 된다. "가장 자주 바뀌는 곳" 목록은 정의상 전부
   *    상위 1% 라서 여섯 줄이 똑같은 말을 한다. 배수는 그 안에서 차이를
   *    낸다 — 865회는 중앙값(3.1)의 279배고, 115회는 37배다. 같은 띠지만
   *    같은 얘기가 아니다.
   *
   *    비율일 뿐 보간이 아니다. 관측한 두 수(값·중앙값)를 나눈 것이라
   *    없는 정밀도를 주장하지 않는다.
   */
  const vsMedian = dist.p50 > 0 ? value / dist.p50 : null
  const at = (band, label) => ({ band, label, n, vsMedian })
  if (value >= dist.p99) return at('top1', '상위 1%')
  if (value >= dist.p95) return at('top5', '상위 5%')
  if (value >= dist.p90) return at('top10', '상위 10%')
  if (value >= dist.p75) return at('top25', '상위 25%')
  if (value >= dist.p50) return at('mid', '중앙값 위')
  if (value >= dist.p25) return at('low', '중앙값 아래')
  return at('bottom', '하위 25%')
}

/** 지금 저장소에 해당하는 코퍼스 셀. 없으면 null. */
export function cellFor(baseline, { lang, commits }) {
  if (!baseline?.cells || !lang) return null
  const key = cellKey(lang, commits ?? 0)
  const c = baseline.cells[key]
  return c?.usable ? { key, ...c } : null
}
