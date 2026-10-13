/**
 * 팀 뷰 — D14 3단계("함께 짠다")의 분석 층.
 *
 * ── 왜 이 파일이 필요한가 ────────────────────────────────────────────────────
 *
 * 3단계에서 도구가 하기로 한 일은 이것 하나다.
 *
 *   > 각 팀원도 우리 도구를 쓰면 서로가 뭘 하는지 그래프상에서 알 수 있어서
 *   > 중복되는 작업을 막을 수 있다.
 *
 * 지금 있는 것은 둘뿐이다.
 *
 *   live.mjs      원시 상태 — 누가 어떤 **경로**를 잡았나
 *   adjacent.mjs  기능 인접 경고 — 경로는 안 겹치는데 공변경으로 이어진 claim 쌍
 *
 * 둘 다 맞는 답이지만 **사람이 읽는 답이 아니다.** `app/lib/live.mjs` 를
 * 누가 잡았다는 사실은, 그 파일이 무엇인지 아는 사람에게만 정보다.
 * 3단계의 사용자는 2단계를 막 끝낸 사람이고, 그 사람이 아는 것은
 * 파일 이름이 아니라 **기능 이름**이다 (featuregraph.mjs 가 만든 그것).
 *
 * 이 파일은 그 사이를 잇는다. 경로 단위 장부를 기능 단위 문장으로 올린다.
 *
 * ── 🔴 이것은 전부 경고이지 거부가 아니다 ────────────────────────────────────
 *
 * `checkOverlap` 은 한 줄도 건드리지 않는다. adjacent.mjs 가 같은 판단을
 * 이미 적어 뒀고 이유도 그대로다 —
 *
 *   ① "경로가 겹치면 거부" 는 결정론이고 증명 가능하다(I1). "기능이 겹치면
 *      거부" 는 lift 문턱이라는 **조절 가능한 숫자**에 기댄다.
 *   ② 히스토리가 없는 새 저장소에서는 그 신호가 아예 없다. 락이 그런 것에
 *      기대면 "어떤 저장소에서는 락이 약해진다" 는 상태가 된다.
 *
 * 그래서 여기서 나오는 어떤 값도 게이트로 흘러가면 안 된다. 모든 쌍에
 * `blocking: false` 를 명시적으로 붙여 둔 이유다.
 *
 * ── 🔴 근거 없는 경고는 경고가 아니다 ────────────────────────────────────────
 *
 * 위험도를 네 등급으로 가르고 **등급마다 왜 그렇게 봤는지를 문자열로** 낸다.
 * 등급이 하나뿐이면 사용자는 곧 전부를 같은 소음으로 취급하고, 그때
 * 진짜 경고("같은 파일을 둘이 잡았다")도 같이 묻힌다.
 *
 * ── 🔴 못 알아낸 것은 말한다 ─────────────────────────────────────────────────
 *
 * 함수마다 `gaps` 를 낸다 (flow.mjs 와 같은 규칙). 이 프로젝트에서 실제로
 * 나온 가장 나쁜 버그는 전부 "조용히 0개를 내놓고 그 침묵을 결과로 제시" 였다.
 * 여기서는 더 위험하다 — 경고가 0개면 사용자는 **안전하다고 읽는다.**
 * 히스토리가 없어서 0개인 것과 정말 안 겹쳐서 0개인 것은 다른 사실이다.
 *
 * 순수 함수만 둔다. git 호출·파일 읽기·`Date.now()` 없다. 시각은 인자다.
 */

import {
  claimExpiresAt, coversPath, humanDuration, normalizePath, pathsOverlap,
} from '../../src/protocol.mjs'
import { featureAdjacency } from './adjacent.mjs'
import { modulesOf } from './featuregraph.mjs'

// ---------------------------------------------------------------------------
// 문턱값 — 전부 근거를 함께 적는다
// ---------------------------------------------------------------------------

/**
 * bin/axmap.mjs 의 `parseTtl` 기본값과 같은 30분.
 *
 * 🔴 여기서 다시 적는 이유 — 순수 층은 bin(부수효과 층)을 import 하지 않는다.
 *    bin 의 기본값을 바꾸면 이 상수도 함께 바꾼다. 이 값은 **판정이 아니라
 *    표시 기준**이므로(“기본보다 훨씬 길게 잡았다”) 어긋나도 락은 안 흔들린다.
 */
export const DEFAULT_TTL_MS = 30 * 60_000

/**
 * "곧 만료" 로 볼 남은 시간. 기본 TTL 의 1/6.
 *
 * 근거: `renew` 한 번이 30분을 다시 붙인다. 5분이면 화면을 보고 갱신을
 * 결정하기에 충분하고, 그보다 길게 잡으면 30분짜리 claim 의 태반이
 * 상시 "곧 만료" 로 켜져 있어 표시가 의미를 잃는다.
 */
export const EXPIRING_MS = 5 * 60_000

/**
 * "거의 다 썼다" 로 볼 소진 비율.
 *
 * 근거: 남은 시간(EXPIRING_MS)은 절대값이라 `--ttl 4h` 같은 긴 claim 에는
 * 늦게 켜진다. 비율은 TTL 길이와 무관하게 같은 뜻을 갖는다.
 */
export const SPENT_RATIO = 0.8

/**
 * 공변경을 근거로 인정할 문턱. adjacent.mjs 의 기본값을 그대로 쓴다.
 *
 * 🔴 여기서 값을 다르게 두면 같은 화면의 두 경고가 서로 다른 답을 한다.
 *    adjacent.mjs 가 "경고한다" 고 한 쌍을 여기서 "근거 없음" 으로 깎으면
 *    사용자는 어느 쪽을 믿을지 알 수 없다.
 */
export const MIN_LIFT = 3
export const MIN_SUPPORT = 4

/** 위험 등급 — 센 것부터. */
export const RISK_LEVELS = ['certain', 'high', 'medium', 'low']
const LEVEL_LABEL = { certain: '확실', high: '높음', medium: '중간', low: '낮음' }
const LEVEL_RANK = { certain: 0, high: 1, medium: 2, low: 3 }

/**
 * 쌍을 Map 키로 만들 때 쓰는 구분자.
 *
 * 🔴 소스에는 **이스케이프 표기**로 적는다. featuregraph.mjs 가 같은 자리에
 *    같은 경고를 남겼고, 이 파일은 실제로 한 번 진짜 NUL 바이트가 들어간 채로
 *    저장됐다 — grep 이 "Binary file matches" 라며 내용을 안 보여줬다.
 * 🔴 공백은 쓸 수 없다. 에이전트 이름은 내부 공백을 허용한다("김 민수").
 *    공백으로 이으면 `"a b"+"c"` 와 `"a"+"b c"` 가 같은 키가 된다 — 서로 다른
 *    두 입력을 같은 것으로 만드는 짓이고, 그것이 곧 소유권 충돌이다(CLAUDE.md).
 *    NUL 은 `agentNameError` 가 이름에서 명시적으로 막으므로 안전하다.
 */
const SEP = '\u0000'

// ---------------------------------------------------------------------------
// 공통 — 시각과 만료
// ---------------------------------------------------------------------------

/**
 * 이 레코드가 언제 효력을 잃는가. **판정 불가면 null 을 낸다.**
 *
 * 🔴 모양이 둘이다. 장부 원본은 `since` + `ttlMs` 이고, `readClaims()` 를
 *    거친 것은 `expiresAt`(ISO) 이다. 둘 다 받는다.
 *
 * 🔴 못 읽으면 **0 이나 Infinity 로 치환하지 않는다** (CLAUDE.md).
 *    0 으로 치면 남의 유효한 claim 이 조용히 사라지고, Infinity 로 치면
 *    죽은 claim 이 영원히 남는다. 둘 다 서로 다른 두 입력을 같은 것으로
 *    만드는 짓이다. 모르면 모른다고 내고, 호출부가 `unreadable` 로 드러낸다.
 */
export function expiryOf(claim) {
  if (claim?.expiresAt != null) {
    const t = Date.parse(claim.expiresAt)
    return Number.isFinite(t) ? t : null
  }
  if (claim?.since != null && Number.isFinite(Number(claim?.ttlMs))) {
    const t = claimExpiresAt(claim)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** 이 레코드를 언제 잡았나(= 마지막 갱신 시각). 못 읽으면 null. */
export function heldSince(claim) {
  const t = Date.parse(claim?.since ?? '')
  return Number.isFinite(t) ? t : null
}

/**
 * 레코드를 셋으로 가른다 — 효력 있음 / 만료됨 / 못 읽음.
 *
 * 🔴 만료는 "레코드가 사라짐" 이 아니라 "효력만 잃음" 이다. 그래서 버리지
 *    않고 따로 낸다. 화면이 "아까 그 사람 어디 갔지" 에 답할 수 있어야 한다.
 */
export function partitionClaims(claims, now) {
  const live = []
  const expired = []
  const unreadable = []
  for (const c of claims ?? []) {
    if (c?.broken) { unreadable.push(c); continue }
    if (!Array.isArray(c?.paths)) { unreadable.push(c); continue }
    const exp = expiryOf(c)
    if (exp === null) { unreadable.push(c); continue }
    if (now != null && exp <= now) { expired.push(c); continue }
    live.push(c)
  }
  return { live, expired, unreadable }
}

// ---------------------------------------------------------------------------
// 공통 — 경로
// ---------------------------------------------------------------------------

/** 이 claim 이 실제로 덮는 파일들. `universe` 안에 있는 것만. */
function coveredFiles(claim, universe) {
  const held = (claim.paths ?? []).map(normalizePath)
  const out = new Set()
  for (const f of universe) if (coversPath(held, f)) out.add(f)
  return out
}

/** 파일이 놓인 폴더. 최상위 파일은 폴더가 없다(빈 문자열). */
const folderOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/**
 * `modulesOf` 가 만드는 '나머지' 통. 기능이 아니다.
 *
 * 어디에도 안 들어간 최상위 파일이 여기로 떨어진다. 이것을 기능으로 세면
 * 서로 아무 상관 없는 파일 둘이 "같은 기능" 이 된다.
 */
const isBucket = (dir) => dir === '(최상위)'

/**
 * 이 기능 노드가 실은 '그릇' 인가 — 기능이 아니라 나머지가 모이는 자리.
 *
 * 🔴 실측으로 찾았다. 이 저장소를 자기 자신에게 돌리면 `modulesOf` 가 뿌리를
 *    `app` 으로 잡고, 그러면 뿌리 밑이 아닌 코드가 전부 `app` 모듈로 떨어진다 —
 *
 *      app  ←  app/server.mjs · src/protocol.mjs · bin/axmap.mjs
 *              · mcp/server.mjs · corpus/*.mjs
 *
 *    그 결과 `app/server.mjs` 를 잡은 사람과 `corpus/serve.mjs` 를 잡은 사람이
 *    "같은 기능" 으로 붙었다. 둘은 아무 상관이 없다.
 *
 *    featuregraph.mjs 도 같은 것을 알고 있어서 뿌리를 이름 붙이기에서 뺀다
 *    ("뿌리는 기능이 아니라 담는 그릇이다"). 다만 노드 목록에는 남으므로,
 *    노드만 받는 이쪽에서는 직접 알아봐야 한다.
 *
 *    판별은 노드 자신의 내용으로 한다 — **자기 디렉터리 밖의 파일을 담고 있으면
 *    그것은 경계가 아니다.** 뿌리 이름을 따로 넘겨받지 않아도 되고, 다른
 *    저장소에서 뿌리가 무엇이든 같은 규칙이 걸린다.
 */
function isContainerNode(node) {
  const dir = normalizePath(node?.dir ?? node?.id ?? '')
  const paths = (node?.paths ?? []).map(normalizePath)
  if (!dir || !paths.length) return true
  return paths.some((p) => !p.startsWith(`${dir}/`))
}

/**
 * `freq` 는 Map 으로 오지만 JSON 을 한 번 건너면 평범한 객체가 된다.
 * 둘 다 받는다 — 여기서 조용히 빈 값이 되면 "히스토리 근거 없음" 이
 * 저장소 전체의 답이 되고, 아무도 그것이 버그인 줄 모른다.
 */
const freqKeys = (freq) => {
  if (!freq) return []
  if (typeof freq.keys === 'function') return [...freq.keys()]
  return Object.keys(freq)
}
const freqOf = (freq, f) => {
  if (!freq) return 0
  if (typeof freq.get === 'function') return freq.get(f) ?? 0
  return freq[f] ?? 0
}

// ---------------------------------------------------------------------------
// 한국어 조사 — 문장으로 읽히게
// ---------------------------------------------------------------------------

/**
 * 받침에 맞는 조사를 고른다.
 *
 * 🔴 왜 이런 걸 넣나 — "민수 / Data Mining / 7 / 3" 을 칸에 끼운 것은
 *    문장이 아니라 표다. 3단계 사용자는 코드를 못 읽어서 여기 온 사람이고,
 *    표를 하나 더 주는 것으로는 아무것도 달라지지 않는다.
 *
 * ⚠️ 한글은 종성으로 정확히 판정하고, 그 밖(영문·숫자)은 **추정**이다.
 *    틀려도 어색할 뿐 뜻이 바뀌지 않는다. 이름을 지어내는 것과 달리
 *    사용자를 오도하지 않으므로 추정을 허용한다.
 */
export function josa(word, pair) {
  const [withJong, withoutJong] = pair.split('/')
  const s = String(word ?? '')
  const ch = s.at(-1)
  if (!ch) return withoutJong
  const code = ch.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) {
    return (code - 0xac00) % 28 === 0 ? withoutJong : withJong
  }
  // 영문·숫자는 읽는 소리로 추정한다. 모음으로 끝나면 받침이 없다.
  if (/[aeiouAEIOU]/.test(ch)) return withoutJong
  if (/[2459]/.test(ch)) return withoutJong          // 이·사·오·구
  return withJong
}

const nameList = (names) => names.join('·')

// ---------------------------------------------------------------------------
// ① whoIsWhere — 누가 어느 '기능' 을 잡고 있나
// ---------------------------------------------------------------------------

/**
 * 경로 단위 claim 을 기능 단위로 올린다.
 *
 * 🔴 부분 점유를 반드시 구분한다.
 *
 * "민수가 Data Mining 을 잡고 있다" 만 보여주면 다른 사람은 그 기능 전체가
 * 막혔다고 읽는다. 실제로는 파일 7개 중 3개다 — 나머지 4개는 지금 당장
 * 들어갈 수 있다. 이 도구의 목적이 **중복을 막는 것**이지 사람을 세워두는
 * 것이 아니므로, 비어 있는 몫을 경로까지 함께 낸다. 그래야 읽은 사람이
 * 바로 `claim` 을 칠 수 있다.
 *
 * @param {object[]} claims       claim 레코드 (readClaims() 결과 또는 장부 원본)
 * @param {object[]} modified     [{path, code}] — git 이 본 실제 변경
 * @param {object[]} featureNodes featureGraph().nodes — {id, name, nameSource, paths}
 * @param {object} opts
 *   now       주면 만료 레코드를 걸러낸다. 안 주면 걸러지지 않았다고 말한다.
 *   maxFree   기능마다 보여줄 '비어 있는 경로' 개수
 */
export function whoIsWhere(claims, modified = [], featureNodes = [], { now = null, maxFree = 8 } = {}) {
  const gaps = []
  const { live, expired, unreadable } = partitionClaims(claims, now)
  if (now == null) {
    gaps.push('now 를 주지 않아 만료 판정을 하지 못했다 — 넘어온 claim 이 이미 걸러졌다고 가정한다')
  }
  if (unreadable.length) {
    gaps.push(`읽을 수 없는 장부 레코드 ${unreadable.length}건이 있다 — 그 사람이 무엇을 잡았는지 모른다`)
  }
  if (!featureNodes.length) {
    gaps.push('기능 노드가 없다 — 기능 단위로 올릴 수 없어 경로 그대로 보여준다')
  }

  const touched = new Map((modified ?? []).map((m) => [normalizePath(m.path), m.code ?? null]))
  const inFeature = new Set()
  const claimedSomewhere = new Set()   // 어느 기능에든 들어간 claim 경로

  const features = []
  for (const node of featureNodes) {
    const paths = (node.paths ?? []).map(normalizePath)
    for (const p of paths) inFeature.add(p)
    if (!paths.length) continue

    const holders = []
    const heldFiles = new Set()
    for (const c of live) {
      const mine = [...coveredFiles(c, paths)]
      if (!mine.length) continue
      for (const f of mine) heldFiles.add(f)
      for (const p of (c.paths ?? []).map(normalizePath)) {
        if (paths.some((f) => coversPath([p], f))) claimedSomewhere.add(p)
      }
      holders.push({
        agent: c.agent,
        task: c.task ?? null,
        intent: c.intent ?? null,
        actor: c.actor ?? null,
        files: mine.sort(),
        count: mine.length,
        // 이 기능 중 몇 할을 쥐고 있나. 화면이 노드를 얼마나 물들일지의 기준.
        share: +(mine.length / paths.length).toFixed(3),
        // 🔴 '전체를 잡았나' 는 반드시 따로 낸다. 부분 점유와 전체 점유는
        //    다른 사람이 할 수 있는 일이 다르다.
        whole: mine.length === paths.length,
        touched: mine.filter((f) => touched.has(f)).length,
      })
    }

    const modifiedHere = paths.filter((f) => touched.has(f))
    // D3 — 선언 ⊂ 실제. 선언 없이 바뀐 파일은 여기서도 그대로 드러낸다.
    const undeclared = modifiedHere.filter((f) => !heldFiles.has(f))
    if (!holders.length && !modifiedHere.length) continue   // 아무 일도 없는 기능은 안 낸다

    holders.sort((a, b) => b.count - a.count || (a.agent < b.agent ? -1 : 1))
    const state = holders.length === 0 ? 'free'
      : holders.length > 1 ? 'contested'
        : holders[0].whole ? 'whole' : 'partial'

    const free = paths.filter((f) => !heldFiles.has(f))
    // 🔴 그릇을 기능이라고 부르지 않는다. "app 을 나눠 잡고 있다" 는 문장은
    //    사실이 아니라 `modulesOf` 의 나머지 통을 기능 이름으로 읽은 것이다.
    const container = isContainerNode(node)
    features.push({
      id: node.id,
      name: node.name ?? node.id,
      container,
      // 🔴 이름의 출처를 함께 낸다. featuregraph.mjs 와 같은 이유 —
      //    비전공자에게는 출처가 그 이름이 맞는지 확인할 유일한 수단이다.
      nameSource: node.nameSource ?? null,
      dir: node.dir ?? node.id,
      files: paths.length,
      claimedFiles: heldFiles.size,
      freeFiles: free.length,
      touchedFiles: modifiedHere.length,
      holders,
      undeclared,
      // 다음 사람이 바로 claim 할 수 있는 자리. 잘라서 보여주되 총 수는 위에 있다.
      free: free.slice(0, maxFree),
      freeTruncated: Math.max(0, free.length - maxFree),
      state,
      stateLabel: { free: '비어 있음', partial: '일부 점유', whole: '전체 점유', contested: '나눠 잡음' }[state],
      sentence: featureSentence({
        name: node.name ?? node.id, total: paths.length, holders, state, free: free.length, container,
      }),
    })
  }
  if (features.some((f) => f.container)) {
    gaps.push('기능이 아니라 "나머지" 통인 노드가 섞여 있다 — 그 안에서 둘이 만난 것은 같은 기능을 건드린다는 뜻이 아니다')
  }

  // 기능 지도 밖의 claim — 문서·테스트·설정, 그리고 **아직 커밋 안 된 새 파일**.
  // 숨기면 화면이 절반만 진실이 된다.
  //
  // 🔴 새 파일에는 어느 기능 옆에 있는지를 붙인다.
  //
  //    기능 노드의 `paths` 는 그래프가 아는 파일뿐이라 방금 만든 파일은 어디에도
  //    안 들어간다. 그렇다고 파일 수(`files`)에 더해 버리면 "7개 중 3개" 라는
  //    숫자가 그래프와 어긋난다. 그래서 개수는 건드리지 않고 위치만 알려준다 —
  //    화면이 그 점을 올바른 노드 옆에 그릴 수 있으면 충분하다.
  const featureDirs = featureNodes
    .map((n) => ({ id: n.id, name: n.name ?? n.id, dir: normalizePath(n.dir ?? n.id) }))
    .sort((a, b) => b.dir.length - a.dir.length)
  const outside = []
  for (const c of live) {
    const rest = (c.paths ?? []).map(normalizePath).filter((p) => {
      if (claimedSomewhere.has(p)) return false
      // 디렉터리 claim 이 기능 파일을 하나라도 덮으면 밖이 아니다
      return ![...inFeature].some((f) => coversPath([p], f))
    })
    if (!rest.length) continue
    outside.push({
      agent: c.agent,
      task: c.task ?? null,
      intent: c.intent ?? null,
      paths: rest.sort(),
      near: rest.map((p) => {
        const hit = featureDirs.find((f) => p.startsWith(`${f.dir}/`))
        return hit ? { path: p, feature: hit.id, name: hit.name } : null
      }).filter(Boolean),
    })
  }
  if (outside.length) {
    gaps.push(`기능 지도에 없는 경로를 잡은 사람이 ${outside.length}명 있다 — 문서·테스트·설정은 기능 노드가 되지 않는다`)
  }

  features.sort((a, b) => b.claimedFiles - a.claimedFiles || b.touchedFiles - a.touchedFiles || (a.id < b.id ? -1 : 1))

  return {
    features,
    outside,
    expired: expired.map((c) => ({ agent: c.agent, task: c.task ?? null, paths: (c.paths ?? []).map(normalizePath) })),
    unreadable: unreadable.map((c) => ({ agent: c?.agent ?? '(알 수 없음)' })),
    stats: {
      agents: live.length,
      totalFeatures: featureNodes.length,
      occupiedFeatures: features.filter((f) => f.holders.length && !f.container).length,
      // 🔴 '나머지' 통에서 둘이 만난 것은 중복 작업이 아니다. 세면 요약이 거짓말을 한다.
      contested: features.filter((f) => f.state === 'contested' && !f.container).length,
      wholeHeld: features.filter((f) => f.state === 'whole' && !f.container).length,
      partialHeld: features.filter((f) => f.state === 'partial' && !f.container).length,
      containers: features.filter((f) => f.container).length,
    },
    gaps,
  }
}

/** "민수가 Data Mining 을 잡고 있다 (파일 7개 중 3개)" */
function featureSentence({ name, total, holders, state, free, container = false }) {
  const who = nameList(holders.map((h) => h.agent))
  const held = holders.reduce((a, h) => a + h.count, 0)
  const uniqueHeld = total - free
  // 🔴 그릇이면 문장부터 그렇게 말한다. "app 을 나눠 잡고 있다" 를 그대로 두면
  //    사용자가 없는 기능 하나를 믿게 된다.
  if (container) {
    return `${name}${josa(name, '은/는')} 기능이 아니라 어디에도 안 들어간 파일이 모인 자리다.`
      + (who
        ? ` 지금 ${who}${josa(who, '이/가')} 여기 파일 ${uniqueHeld}개를 잡고 있지만, 같은 기능이라는 뜻은 아니다.`
        : ` 지금 잡고 있는 사람은 없다.`)
  }
  if (state === 'free') return `${name}${josa(name, '은/는')} 지금 아무도 잡고 있지 않다 (파일 ${total}개)`
  if (state === 'whole') {
    return `${who}${josa(who, '이/가')} ${name} 전체를 잡고 있다 (파일 ${total}개 전부)`
  }
  if (state === 'contested') {
    return `${who}${josa(who, '이/가')} ${name}${josa(name, '을/를')} 나눠 잡고 있다`
      + ` (파일 ${total}개 중 ${uniqueHeld}개, 선언 합계 ${held}개) — 같은 기능을 둘 이상이 건드리는 중이다`
  }
  return `${who}${josa(who, '이/가')} ${name}${josa(name, '을/를')} 잡고 있다`
    + ` (파일 ${total}개 중 ${uniqueHeld}개 — 나머지 ${free}개는 아직 비어 있다)`
}

// ---------------------------------------------------------------------------
// ② collisionRisk — 경로는 안 겹치는데 같은 기능을 건드리는 사람들
// ---------------------------------------------------------------------------

/**
 * 이 파일의 핵심. 사용자가 원문에서 말한 것이 이거다 —
 *
 *   > 단순히 file 의 conflict 보다 전체 기능을 앞에서부터 개발하는 사람이 있을 수
 *   > 있고 뒤에서부터 개발하는 사람이 있을 수 있으니 이 개발이 해당 기능과
 *   > 중첩될 여지가 있는지까지 잡아내야 한다.
 *
 * adjacent.mjs 가 씨앗을 이미 심었다(공변경으로 이어진 claim 쌍). 그것을
 * 다시 구현하지 않고 **호출해서** 중간 등급의 근거로 쓴다. 두 벌로 만들면
 * 같은 화면의 두 경고가 서로 다른 답을 하게 된다.
 *
 * ── 등급 ────────────────────────────────────────────────────────────────────
 *
 *   확실 certain   같은 경로다. 프로토콜(checkOverlap)이 이미 막는다.
 *                  그런데도 장부에 보인다면 장부가 갈라진 것이다 — 더 큰 일이다.
 *   높음 high      같은 기능 모듈 안의 다른 파일. 경로는 안 겹친다.
 *                  ← 앞에서 오는 사람과 뒤에서 오는 사람이 여기서 잡힌다.
 *   중간 medium    모듈은 다른데 히스토리가 "늘 같이 바뀐다" 고 말한다.
 *                  근거를 support/lift 로 함께 낸다.
 *   낮음 low       같은 폴더에 있다는 것뿐. 히스토리 근거는 없다.
 *
 * 🔴 등급 순서는 **결과의 심각도가 아니라 근거의 세기**다.
 *
 * 낮음이 안전하다는 뜻이 아니다. 우리가 아는 것이 적다는 뜻이다. 이 축을
 * 섞으면 사용자가 "낮음이니까 괜찮다" 로 읽는데, 근거가 없는 것과 위험이
 * 없는 것은 다른 사실이다. `why` 문자열이 매번 그 차이를 말한다.
 *
 * 🔴 조용한 0 을 안전으로 내지 않는다. 히스토리가 없는 파일은 중간 등급이
 *    구조적으로 뜰 수 없다. 그 사실을 `gaps` 로 낸다.
 *
 * @param {object[]} claims   claim 레코드
 * @param {object[]} coEdges  공변경 엣지 [{source, target, support, lift}]
 * @param {Map|object} freq   파일 → 등장 커밋 수 (cochange.mjs 의 freq)
 * @param {number} now        시각. 만료된 claim 은 경고를 만들지 않는다.
 * @param {object} opts
 *   featureNodes  featureGraph().nodes — 주면 화면과 같은 모듈 경계를 쓴다
 *   paths         그래프에 있는 파일 전체 (freq 로 못 채우는 새 파일 보강)
 */
export function collisionRisk(claims, coEdges = [], freq = null, now = null, {
  featureNodes = null, paths = [], minLift = MIN_LIFT, minSupport = MIN_SUPPORT, maxEvidence = 6,
} = {}) {
  const gaps = []
  const { live, expired, unreadable } = partitionClaims(claims, now)
  if (now == null) gaps.push('now 를 주지 않아 만료된 claim 을 걸러내지 못했다')
  if (expired.length) {
    // 만료된 것은 효력이 없다. 경고를 만들지 않는 것이 옳지만, 그 사실을
    // 말하지 않으면 "경고가 없다 = 아무도 없다" 로 읽힌다.
    gaps.push(`만료된 claim ${expired.length}건은 위험 판정에서 뺐다 — 효력이 없다`)
  }
  if (unreadable.length) {
    gaps.push(`읽을 수 없는 레코드 ${unreadable.length}건은 판정할 수 없었다 — 이 사람들과의 겹침은 여기 안 나온다`)
  }

  // ── 파일 세계 ────────────────────────────────────────────────────────────
  // 히스토리(freq) + 공변경 양끝 + 그래프 파일 + claim 경로 자신.
  //
  // 🔴 claim 경로 자신을 반드시 넣는다. 방금 만든 파일은 히스토리도 없고
  //    그래프에도 없다. 그걸 빼면 새 파일만 잡은 사람은 **어떤 경고에도
  //    등장하지 않는다** — 가장 활발히 일하는 사람이 화면에서 사라진다.
  const universe = new Set()
  for (const f of freqKeys(freq)) universe.add(normalizePath(f))
  for (const e of coEdges ?? []) { universe.add(normalizePath(e.source)); universe.add(normalizePath(e.target)) }
  for (const p of paths ?? []) universe.add(normalizePath(p))
  for (const n of featureNodes ?? []) for (const p of n.paths ?? []) universe.add(normalizePath(p))
  // 🔴 claim 경로는 **아무 파일도 안 덮을 때만** 넣는다.
  //
  //    디렉터리 claim(`src/album`)을 그냥 넣으면 그것이 파일인 척 세계에
  //    들어가고, `modulesOf` 가 `src/album` 을 한 단계 얕게 잘라 `src` 라는
  //    있지도 않은 모듈을 만든다. 그러면 서로 다른 기능의 두 사람이 그
  //    유령 모듈 안에서 '높음' 으로 붙는다.
  const known = [...universe]
  for (const c of live) {
    for (const raw of c.paths ?? []) {
      const p = normalizePath(raw)
      if (!known.some((f) => coversPath([p], f))) universe.add(p)
    }
  }

  if (!freqKeys(freq).length && (coEdges ?? []).length) {
    gaps.push('freq 가 비었다 — Map 이 JSON 을 건너면 빈 객체가 된다. 히스토리 판정을 믿지 말 것')
  }

  if (live.length < 2) {
    return {
      pairs: [], counts: { certain: 0, high: 0, medium: 0, low: 0 }, checked: live.length,
      blocking: false, gaps,
    }
  }

  // ── 모듈 경계 ────────────────────────────────────────────────────────────
  // featureNodes 를 주면 화면(/api/featuregraph)과 같은 경계를 쓴다.
  // 안 주면 modulesOf 로 직접 나눈다 — 같은 함수이므로 결과가 어긋나지 않는다.
  const moduleOf = new Map()
  const moduleName = new Map()
  if (featureNodes?.length) {
    for (const n of featureNodes) {
      // 🔴 그릇은 기능이 아니다. 여기서 거르지 않으면 서로 상관없는 두 사람이
      //    "같은 기능" 으로 붙는다 (isContainerNode 주석의 실측).
      if (isBucket(n.id) || isContainerNode(n)) continue
      for (const p of n.paths ?? []) moduleOf.set(normalizePath(p), n.id)
      moduleName.set(n.id, {
        name: n.name ?? n.id, nameSource: n.nameSource ?? null, dir: normalizePath(n.dir ?? n.id),
      })
    }
  } else {
    const { mods, root } = modulesOf([...universe])
    for (const [dir, files] of mods) {
      // 🔴 뿌리와 '(최상위)' 는 기능이 아니라 **담는 그릇**이다.
      //
      //    featuregraph.mjs 가 뿌리를 이름 붙이기에서 빼는 것과 같은 이유이고,
      //    여기서는 더 나쁘게 물린다. `(최상위)` 는 어디에도 안 들어간 파일이
      //    떨어지는 자리이므로, 그것을 기능으로 치면 `README.md` 를 잡은 사람과
      //    `CLAUDE.md` 를 잡은 사람이 "같은 기능" 으로 붙는다. 실제로 붙었다.
      if (isBucket(dir) || dir === root) continue
      for (const p of files) moduleOf.set(p, dir)
      // 이름을 못 얻었으면 폴더 이름이다. 출처를 'path' 로 정직하게 적는다.
      moduleName.set(dir, { name: dir.split('/').pop(), nameSource: 'path', dir })
    }
  }

  /**
   * 🔴 아직 그래프에 없는 파일도 모듈에 넣는다 (실측으로 찾은 구멍).
   *
   * 이 저장소 자신의 장부로 돌려 봤을 때 이렇게 나왔다 —
   *
   *   agent-pr    app/lib/live.mjs      (기존 파일)
   *   agent-team  app/lib/teamview.mjs  (방금 만든 파일)
   *
   * 같은 모듈 `app/lib` 이므로 '높음' 이어야 하는데 **'낮음' 이 나왔다.**
   * `teamview.mjs` 는 아직 커밋된 적이 없어 `git ls-files` 에도 히스토리에도
   * 없고, 그래서 어떤 모듈에도 안 들어갔기 때문이다.
   *
   * 이것이 이 프로젝트에서 반복해 나온 실패의 모양이다 — **가장 활발한 작업이
   * 정확히 그 이유로 화면에서 사라진다.** 새 파일이야말로 지금 누가 뭘 하는지
   * 그 자체다.
   *
   * 그래서 모듈 디렉터리로 한 번 더 찾는다. `modulesOf` 의 모듈 경계는 원래
   * 디렉터리 경계이므로 새 사실을 지어내는 것이 아니다. 다만 그래프가 확인해
   * 준 것은 아니므로 `inferred` 로 표시해서 문장이 그 사실을 말하게 한다.
   */
  // 긴 디렉터리부터 본다. `app/lib` 이 `app` 보다 먼저 맞아야 한다.
  const moduleDirs = [...moduleName.entries()]
    .map(([id, info]) => ({ id, dir: info.dir ?? id }))
    .sort((a, b) => b.dir.length - a.dir.length)
  const moduleFor = (f) => {
    const known = moduleOf.get(f)
    if (known) return { id: known, inferred: false }
    const hit = moduleDirs.find((m) => f.startsWith(`${m.dir}/`))
    return hit ? { id: hit.id, inferred: true } : null
  }

  const owned = live.map((c) => ({ claim: c, files: coveredFiles(c, universe) }))

  // ── 중간 등급의 근거는 adjacent.mjs 가 만든다 ────────────────────────────
  const adj = featureAdjacency(live, coEdges ?? [], [...universe], { minLift, minSupport, maxEvidence })
  const coPair = new Map()
  for (const p of adj.pairs) coPair.set(agentKey(p.agents[0], p.agents[1]), p)

  const pairs = []
  for (let i = 0; i < owned.length; i++) {
    for (let j = i + 1; j < owned.length; j++) {
      const A = owned[i]
      const B = owned[j]
      /**
       * 🔴 **한 사람의 두 줄은 쌍이 아니다.**
       *
       * 장부의 레코드는 (이름, 세션) 짝마다 하나라, 같은 사람이 창을 둘 띄우면
       * 같은 이름이 두 줄로 선다(protocol.mjs 의 `isSameSubject`). 이 화면이
       * 말하려는 것은 **누구와 누가 부딪히는가**인데, 여기서 자기 자신과의 쌍을
       * 만들면 "같은 경로를 덮는다 — 장부가 갈라졌다" 는 **없는 사고**를 띄운다.
       * 그 경고는 claim 이 이미 그 자리에서 하고 있다.
       */
      if (A.claim.agent === B.claim.agent) continue
      const reasons = []

      // ── 확실 — 같은 경로 ─────────────────────────────────────────────────
      const shared = [...A.files].filter((f) => B.files.has(f))
      const pathClash = (A.claim.paths ?? []).some((a) =>
        (B.claim.paths ?? []).some((b) => pathsOverlap(a, b)))
      if (shared.length || pathClash) {
        reasons.push({
          kind: 'path', level: 'certain',
          files: shared.slice(0, maxEvidence),
          why: '두 claim 이 같은 경로를 덮는다. checkOverlap 이 막았어야 하는 상태다'
            + ' — 장부가 갈라졌거나 두 저장소의 장부를 섞어 본 것이다.',
        })
      }

      // ── 높음 — 같은 기능 모듈 안의 다른 파일 ─────────────────────────────
      const modsA = groupByModule(A.files, moduleFor)
      const modsB = groupByModule(B.files, moduleFor)
      const sharedMods = [...modsA.keys()].filter((m) => modsB.has(m))
      for (const m of sharedMods) {
        const info = moduleName.get(m) ?? { name: m, nameSource: null }
        const a = modsA.get(m)
        const b = modsB.get(m)
        // 한쪽이라도 그래프에 없는 새 파일이면 그 사실을 문장에 남긴다.
        const inferred = [...a.newFiles, ...b.newFiles]
        reasons.push({
          kind: 'module', level: 'high', module: m, name: info.name, nameSource: info.nameSource,
          files: [a.files.slice(0, maxEvidence), b.files.slice(0, maxEvidence)],
          inferredFrom: inferred.length ? inferred.slice(0, maxEvidence) : null,
          // 이름의 출처를 문장 안에 그대로 넣는다. 'docs' 면 사람이 그 묶음을
          // 하나의 기능이라고 문서에 적어 둔 것이고, 'path' 면 폴더가 같을 뿐이다.
          why: `같은 기능 "${info.name}"(${m}) 안에서 서로 다른 파일을 잡았다.`
            + ` 경로는 안 겹치므로 프로토콜은 통과시킨다 — 앞(API)에서 오는 사람과`
            + ` 뒤(저장소)에서 오는 사람이 여기서 만난다.`
            + (info.nameSource === 'docs'
              ? ' 이 이름은 README 가 그 묶음을 부르는 말이다.'
              : ' ⚠️ 이 이름은 폴더 이름에서 나왔다 — 문서가 확인해 준 기능 경계는 아니다.')
            + (inferred.length
              ? ` (${inferred.join(', ')} 은 아직 그래프에 없는 새 파일이라 디렉터리로 맞췄다)`
              : ''),
        })
      }

      // ── 중간 — 히스토리 공변경 ───────────────────────────────────────────
      const co = coPair.get(agentKey(A.claim.agent, B.claim.agent))
      if (co) {
        reasons.push({
          kind: 'cochange', level: 'medium',
          crossings: co.crossings, topLift: co.topLift, evidence: co.evidence,
          why: `히스토리에서 두 영역을 가로지르는 공변경이 ${co.crossings}건 있다`
            + ` (최고 lift ${co.topLift}, 문턱 lift≥${minLift}·n≥${minSupport}).`
            + ' 지금까지 늘 같이 바뀐 파일들이라 이번에도 같이 바뀔 공산이 크다.',
        })
      }

      // ── 낮음 — 같은 폴더뿐 ───────────────────────────────────────────────
      // 🔴 저장소 뿌리는 폴더로 치지 않는다. 최상위 파일 전부를 형제로 만들면
      //    이 경고가 상수처럼 켜져 있고, 그러면 아무 말도 하지 않는 것과 같다.
      const foldersA = new Set([...A.files].map(folderOf).filter(Boolean))
      const foldersB = new Set([...B.files].map(folderOf).filter(Boolean))
      const sharedFolders = [...foldersA].filter((d) => foldersB.has(d))
      if (sharedFolders.length && !sharedMods.length) {
        reasons.push({
          kind: 'folder', level: 'low', folders: sharedFolders.slice(0, maxEvidence),
          why: `같은 폴더(${sharedFolders[0]})에 나란히 있다. 그것 말고 아는 것이 없다`
            + ' — 히스토리도 기능 모듈도 이 둘을 잇지 않는다.'
            + ' 낮음은 "안전하다" 가 아니라 "근거가 적다" 는 뜻이다.',
        })
      }

      if (!reasons.length) continue

      reasons.sort((x, y) => LEVEL_RANK[x.level] - LEVEL_RANK[y.level])
      const level = reasons[0].level
      // 히스토리가 아예 없는 파일이면 중간 등급이 구조적으로 뜰 수 없다.
      const noHistory = [...A.files, ...B.files].filter((f) => freqOf(freq, f) === 0)

      pairs.push({
        level,
        label: LEVEL_LABEL[level],
        agents: [A.claim.agent, B.claim.agent],
        tasks: [A.claim.task ?? null, B.claim.task ?? null],
        intents: [A.claim.intent ?? null, B.claim.intent ?? null],
        actors: [A.claim.actor ?? null, B.claim.actor ?? null],
        paths: [(A.claim.paths ?? []).map(normalizePath), (B.claim.paths ?? []).map(normalizePath)],
        files: [[...A.files].sort().slice(0, maxEvidence), [...B.files].sort().slice(0, maxEvidence)],
        // 등급 하나로 뭉개지 않는다. 근거는 여러 개일 수 있고 각각 다른 것을 말한다.
        reasons,
        why: reasons.map((r) => r.why).join(' '),
        // 히스토리가 없어서 중간 등급이 못 뜬 경우를 쌍마다 밝힌다.
        historyBlind: noHistory.length ? noHistory.slice(0, maxEvidence) : null,
        // 🔴 절대 게이트가 아니다. 소비자가 이 필드를 보고 착각할 여지를 없앤다.
        blocking: false,
      })
    }
  }

  pairs.sort((a, b) =>
    LEVEL_RANK[a.level] - LEVEL_RANK[b.level]
    || (b.reasons.length - a.reasons.length)
    || (a.agents[0] < b.agents[0] ? -1 : 1))

  const counts = { certain: 0, high: 0, medium: 0, low: 0 }
  for (const p of pairs) counts[p.level]++

  const blindPairs = pairs.filter((p) => p.historyBlind).length
  if (blindPairs) {
    gaps.push(`${blindPairs}쌍은 한쪽 파일에 히스토리가 없다 — 공변경(중간 등급)이 구조적으로 뜰 수 없다.`
      + ' 중간 등급이 없다고 히스토리가 안전을 말한 것은 아니다')
  }
  if (!(coEdges ?? []).length) {
    gaps.push('공변경 엣지가 하나도 없다 — 히스토리가 짧거나 아직 계산되지 않았다. 중간 등급은 이번 판정에 없다')
  }

  return { pairs, counts, checked: live.length, blocking: false, gaps }
}

/**
 * 쌍의 키. 에이전트 이름을 쓴다 — 이 화면이 묻는 것은 **누구와 누가** 부딪히는가다.
 *
 * 장부의 레코드는 (이름, 세션) 짝마다 하나라 같은 이름이 두 줄일 수 있지만
 * (protocol.mjs 의 `isSameSubject`), 자기 자신과의 쌍은 위에서 걸러내므로
 * 이 키가 가리키는 것은 언제나 서로 다른 두 사람이다.
 */
const agentKey = (a, b) => (String(a) < String(b) ? `${a}${SEP}${b}` : `${b}${SEP}${a}`)

/**
 * 파일들을 모듈별로 묶는다.
 *
 * 어느 모듈에도 안 속한 파일은 빠진다. 그것이 곧 '낮음' 이 존재할 수 있는
 * 이유다 — `modulesOf` 는 소비자 폴더(테스트·예제·문서·스크립트)를 모듈로
 * 치지 않으므로, 그 안의 파일들은 같은 폴더지만 같은 기능이 아니다.
 */
function groupByModule(files, moduleFor) {
  const out = new Map()
  for (const f of files) {
    const m = moduleFor(f)
    if (!m) continue
    if (!out.has(m.id)) out.set(m.id, { files: [], newFiles: [] })
    out.get(m.id).files.push(f)
    // 그래프가 확인해 준 것이 아니라 디렉터리로 맞춘 것. 문장이 이 차이를 말한다.
    if (m.inferred) out.get(m.id).newFiles.push(f)
  }
  return out
}

/** 사람이 읽을 경고문. adjacent.mjs 의 formatAdjacency 와 같은 재료·같은 모양. */
export function formatRisk(pair) {
  const [a, b] = pair.agents
  const lines = [
    `[${pair.label}] 중복 작업 가능성`,
    ``,
    `  ${a}  (${pair.tasks[0] ?? '작업 미지정'})`,
    `    ${pair.paths[0].join(', ')}`,
    pair.intents[0] ? `    의도: ${pair.intents[0]}` : null,
    ``,
    `  ${b}  (${pair.tasks[1] ?? '작업 미지정'})`,
    `    ${pair.paths[1].join(', ')}`,
    pair.intents[1] ? `    의도: ${pair.intents[1]}` : null,
    ``,
    `  왜 — ${pair.why}`,
    pair.historyBlind
      ? `  ⚠️ 히스토리 없는 파일: ${pair.historyBlind.join(', ')} (공변경 근거가 나올 수 없다)`
      : null,
    ``,
    `  이것은 거부가 아닙니다. 두 사람이 서로의 의도를 아는 것으로 충분할 수 있습니다.`,
  ]
  return lines.filter((l) => l !== null).join('\n')
}

// ---------------------------------------------------------------------------
// ③ staleClaims — "저 사람 아직 하고 있나?"
// ---------------------------------------------------------------------------

/**
 * TTL 이 얼마 안 남았거나 오래 붙잡고 있는 claim.
 *
 * 🔴 만료된 레코드를 효력 있는 것처럼 다루지 않는다 (CLAUDE.md 의 명시적 금지).
 *    만료는 레코드가 사라지는 것이 아니라 효력만 잃는 것이므로, 목록에서
 *    지우지도 않고 `active` 에 섞지도 않는다. 따로 낸다.
 *
 * ⚠️ 한계 — 장부는 "처음 잡은 시각" 을 기억하지 않는다.
 *    `applyRenew` 가 `since` 를 지금으로 되돌린다(protocol.mjs). 그래서
 *    여기서 재는 '잡은 지' 는 **마지막 갱신 이후**다. 두 시간을 붙잡고
 *    10분마다 갱신한 사람은 늘 '10분' 으로 보인다. 이것은 계측 한계이므로
 *    `gaps` 로 말한다 — 추정해서 메우면 없는 사실을 만들어내는 것이다.
 */
export function staleClaims(claims, now, {
  expiringMs = EXPIRING_MS, spentRatio = SPENT_RATIO, longTtlMs = DEFAULT_TTL_MS * 2,
} = {}) {
  const gaps = []
  if (now == null) {
    return {
      active: [], expiring: [], longHeld: [], expired: [], unreadable: [],
      stats: { active: 0, expiring: 0, longHeld: 0, expired: 0, unreadable: 0 },
      gaps: ['now 가 없어 TTL 을 판정할 수 없다 — 아무것도 판정하지 않았다'],
    }
  }
  const { live, expired, unreadable } = partitionClaims(claims, now)

  const rows = live.map((c) => {
    const exp = expiryOf(c)
    const start = heldSince(c)
    const remainingMs = exp - now
    const heldMs = start === null ? null : Math.max(0, now - start)
    // TTL 길이. expiresAt 만 있는 모양에서는 since 로 역산한다.
    const ttlMs = start === null ? null : exp - start
    const flags = []
    if (remainingMs <= expiringMs) flags.push('expiring')
    if (ttlMs && heldMs !== null && heldMs / ttlMs >= spentRatio) flags.push('spent')
    if (ttlMs && ttlMs >= longTtlMs) flags.push('longTtl')
    return {
      agent: c.agent,
      task: c.task ?? null,
      intent: c.intent ?? null,
      actor: c.actor ?? null,
      paths: (c.paths ?? []).map(normalizePath),
      since: c.since ?? null,
      remainingMs,
      remaining: humanDuration(remainingMs),
      heldMs,
      // '잡은 지' 는 마지막 갱신 이후다. 이름을 그대로 두면 오해가 남는다.
      heldSinceRenew: heldMs === null ? null : humanDuration(heldMs),
      ttlMs,
      flags,
      note: flags.includes('expiring')
        ? `${humanDuration(remainingMs)} 뒤에 풀린다 — 계속 하는 중이면 renew 가 필요하다`
        : flags.includes('spent')
          ? `TTL 의 ${Math.round((heldMs / ttlMs) * 100)}% 를 썼다`
          : flags.includes('longTtl')
            ? `기본(30분)보다 긴 ${humanDuration(ttlMs)} 짜리다 — 오래 잡을 작정이다`
            : null,
    }
  }).sort((a, b) => a.remainingMs - b.remainingMs)

  if (rows.some((r) => r.heldMs === null)) {
    gaps.push('since 를 읽을 수 없는 레코드가 있어 잡은 기간을 재지 못했다')
  }
  gaps.push('renew 는 since 를 지금으로 되돌린다 — 여기 나오는 "잡은 지" 는 마지막 갱신 이후이지 처음 잡은 시각이 아니다')
  if (unreadable.length) {
    gaps.push(`읽을 수 없는 레코드 ${unreadable.length}건은 TTL 판정에서 뺐다 — 효력이 있는지 없는지 모른다`)
  }

  const expiredRows = expired.map((c) => {
    const exp = expiryOf(c)
    return {
      agent: c.agent,
      task: c.task ?? null,
      paths: (c.paths ?? []).map(normalizePath),
      expiredAgo: humanDuration(now - exp),
      // 🔴 효력이 없다는 것을 값으로도 못박는다. 화면이 실수로 섞지 못하게.
      inEffect: false,
    }
  }).sort((a, b) => (a.agent < b.agent ? -1 : 1))

  return {
    active: rows,
    expiring: rows.filter((r) => r.flags.includes('expiring')),
    longHeld: rows.filter((r) => r.flags.includes('spent') || r.flags.includes('longTtl')),
    expired: expiredRows,
    unreadable: unreadable.map((c) => ({ agent: c?.agent ?? '(알 수 없음)' })),
    stats: {
      active: rows.length,
      expiring: rows.filter((r) => r.flags.includes('expiring')).length,
      longHeld: rows.filter((r) => r.flags.includes('spent') || r.flags.includes('longTtl')).length,
      expired: expiredRows.length,
      unreadable: unreadable.length,
    },
    gaps,
  }
}

// ---------------------------------------------------------------------------
// ④ summary — 위를 한 문단으로
// ---------------------------------------------------------------------------

/**
 * 화면 맨 위에 놓을 한 문단.
 *
 * 🔴 세 결과를 다 읽는 사용자는 없다. 그래서 한 문단으로 접되,
 *    **접으면서 gaps 를 버리지 않는다.** 접는 과정에서 "못 알아낸 것" 이
 *    사라지면 남는 문장은 실제보다 확신에 찬 문장이 된다.
 */
export function summary({ who = null, risk = null, stale = null, me = null } = {}) {
  const parts = []
  const agents = stale?.stats?.active ?? who?.stats?.agents ?? 0

  if (!agents) {
    parts.push('지금 이 저장소를 잡고 있는 사람은 없다.')
  } else {
    const occupied = who?.stats?.occupiedFeatures ?? 0
    parts.push(`지금 ${agents}명이 일하고 있고, 기능 ${occupied}개가 점유되어 있다.`)
    const contested = who?.stats?.contested ?? 0
    if (contested) parts.push(`그중 ${contested}개는 둘 이상이 나눠 잡고 있다.`)
    const partial = who?.stats?.partialHeld ?? 0
    if (partial) parts.push(`${partial}개는 일부만 잡혀 있어 나머지 파일은 지금도 들어갈 수 있다.`)
  }

  const c = risk?.counts
  if (c && (c.certain || c.high || c.medium || c.low)) {
    const bits = []
    if (c.certain) bits.push(`확실 ${c.certain}쌍`)
    if (c.high) bits.push(`높음 ${c.high}쌍`)
    if (c.medium) bits.push(`중간 ${c.medium}쌍`)
    if (c.low) bits.push(`낮음 ${c.low}쌍`)
    parts.push(`경로가 안 겹치는데 같은 기능을 건드릴 수 있는 조합이 ${bits.join(' · ')} 있다.`)
    if (c.certain) parts.push('확실 등급은 프로토콜이 이미 막는 상태다 — 장부를 확인해야 한다.')
  } else if (risk) {
    parts.push('서로 겹칠 만한 조합은 이번 판정에서 나오지 않았다.')
  }

  if (stale?.stats?.expiring) parts.push(`${stale.stats.expiring}명의 선점이 곧 풀린다.`)
  if (stale?.stats?.expired) parts.push(`만료된 선점 ${stale.stats.expired}건이 장부에 남아 있다 (효력 없음).`)
  if (who?.outside?.length) parts.push(`기능 지도 밖(문서·테스트·설정)을 잡은 사람도 ${who.outside.length}명 있다.`)
  if (me) parts.push(`'나' 는 ${me} 다.`)

  const gaps = [
    ...(who?.gaps ?? []).map((t) => ({ from: 'whoIsWhere', text: t })),
    ...(risk?.gaps ?? []).map((t) => ({ from: 'collisionRisk', text: t })),
    ...(stale?.gaps ?? []).map((t) => ({ from: 'staleClaims', text: t })),
  ]

  return {
    text: parts.join(' '),
    // 🔴 접어도 버리지 않는다. 화면은 이 줄들을 문단 아래에 흐리게 깐다.
    gaps,
    counts: {
      agents,
      features: who?.stats?.occupiedFeatures ?? 0,
      contested: who?.stats?.contested ?? 0,
      risk: risk?.counts ?? { certain: 0, high: 0, medium: 0, low: 0 },
      expiring: stale?.stats?.expiring ?? 0,
      expired: stale?.stats?.expired ?? 0,
    },
    // 게이트가 아니라는 사실을 페이로드에도 남긴다.
    blocking: false,
  }
}
