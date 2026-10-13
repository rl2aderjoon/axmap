/**
 * 분할을 채점한다 — 압축적인가 · 흔들리지 않는가 · 앞일을 맞히는가.
 *
 * 🔴 정답 분할이 없다. 이 파일이 존재하는 이유 전체가 그것이다.
 *
 * "이 저장소의 올바른 모듈 목록" 을 아무도 갖고 있지 않으므로, 정답과 맞춰
 * 점수를 매기는 흔한 방법을 쓸 수 없다. 그래서 **정답 없이도 잴 수 있는 것**
 * 넷만 잰다. 넷 다 D17 이 알고리즘에 요구한 성질에서 그대로 나온다.
 *
 *   압축성    블록이 사람이 들고 있을 수 있는 개수인가. 하나가 다 삼키지 않았나
 *   안정성    씨앗을 바꾸거나 커밋 하나가 더 들어와도 같은 그림인가
 *   예측력    **떼어놓은 미래**의 공변경을 블록이 맞히는가
 *   독립성    폴더 구조를 그냥 다시 발견한 것은 아닌가
 *
 * 이 중 셋째가 핵심이고 나머지와 성격이 다르다. 앞의 둘은 "말이 되는가" 를
 * 보지만 셋째는 **틀릴 수 있는 예측**이다. 커밋 이력을 앞뒤로 자르고,
 * 앞쪽만으로 블록을 만든 뒤, 뒤쪽에서 실제로 같이 바뀐 쌍을 그 블록이
 * 품고 있었는지 센다. 품고 있었으면 그 분할은 우연이 아니었다는 뜻이다.
 *
 * docs/SSOT.md 가 "떼어놓고 검증(held-out)하지 않았다" 를 못 한 일로 적어
 * 두었다. 여기가 그 고리다.
 *
 * ⚠️ 넷째는 **높으면 나쁘다.** D17: "이름으로 군집을 만들면 디렉터리 구조를
 *    다시 발견할 뿐이고, 우리가 알고 싶은 것은 그 반대 — 폴더가 다른데 실제로
 *    얽혀 있는 것" 이다. 폴더와 일치할수록 이 도구는 쓸모가 없어진다.
 */

// ---------------------------------------------------------------------------
// 두 분할이 얼마나 같은가 — 조정 랜드 지수(ARI)
// ---------------------------------------------------------------------------

const choose2 = (x) => (x * (x - 1)) / 2

/**
 * ARI. 1 이면 같은 분할, 0 이면 무작위로 나눈 것과 다를 바 없음, 음수도 나온다.
 *
 * 🔴 그냥 "몇 %가 같은 블록인가" 를 쓰지 않는 이유: 블록을 아주 잘게 쪼개면
 *    아무 두 파일도 같은 블록이 아니게 되어 **자동으로 높은 일치**가 나온다.
 *    ARI 는 우연히 일치할 몫을 빼기 때문에 그 속임수가 안 통한다.
 *    안정성을 재는 자가 속을 수 있으면 안정성 숫자 전체가 무의미하다.
 */
export function ari(a, b) {
  const n = a.length
  if (!n || b.length !== n) return null

  const table = new Map()
  const rowN = new Map()
  const colN = new Map()
  for (let i = 0; i < n; i++) {
    const key = `${a[i]},${b[i]}`
    table.set(key, (table.get(key) ?? 0) + 1)
    rowN.set(a[i], (rowN.get(a[i]) ?? 0) + 1)
    colN.set(b[i], (colN.get(b[i]) ?? 0) + 1)
  }

  let index = 0
  for (const v of table.values()) index += choose2(v)
  let rowSum = 0
  for (const v of rowN.values()) rowSum += choose2(v)
  let colSum = 0
  for (const v of colN.values()) colSum += choose2(v)

  const total = choose2(n)
  if (!total) return 1
  const expected = (rowSum * colSum) / total
  const max = (rowSum + colSum) / 2
  // 두 분할이 다 자명할 때(전부 하나 / 전부 혼자) 분모가 0 이 된다.
  // 그때는 실제로 같은지만 보고 답한다 — 0 으로 나누어 NaN 을 흘리지 않는다.
  if (max === expected) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if ((a[i] === a[j]) !== (b[i] === b[j])) return 0
    }
    return 1
  }
  return (index - expected) / (max - expected)
}

// ---------------------------------------------------------------------------
// 압축성 — 사람이 들고 있을 수 있는 그림인가
// ---------------------------------------------------------------------------

/**
 * 분할의 모양. 좋고 나쁨을 판정하지 않고 사실만 낸다.
 *
 * `maxShare` 가 이 중 제일 중요하다. 블록이 12개라도 그중 하나가 파일의 70%를
 * 갖고 있으면 그 그림은 **블록이 하나인 그림**이고, 나머지 11개는 부스러기다.
 * 개수만 세면 그 사실이 안 보인다.
 */
export function shape(membership) {
  const n = membership.length
  if (!n) return { blocks: 0, maxShare: 1, singletonShare: 1, entropy: 0, medSize: 0, usableBlocks: 0 }

  const size = new Map()
  for (const c of membership) size.set(c, (size.get(c) ?? 0) + 1)
  const sizes = [...size.values()].sort((x, y) => y - x)

  let h = 0
  for (const s of sizes) { const p = s / n; h -= p * Math.log(p) }
  const singles = sizes.filter((s) => s === 1).length

  return {
    blocks: sizes.length,
    // 혼자인 파일은 블록이 아니다. 그림에 실제로 그려지는 덩어리 수를 따로 센다.
    usableBlocks: sizes.filter((s) => s >= 2).length,
    maxShare: sizes[0] / n,
    singletonShare: singles / n,
    // 정규화 엔트로피. 1 에 가까우면 고르게, 0 에 가까우면 한쪽에 쏠렸다.
    entropy: sizes.length > 1 ? h / Math.log(sizes.length) : 0,
    medSize: sizes[sizes.length >> 1],
  }
}

// ---------------------------------------------------------------------------
// 예측력 — 떼어놓은 미래를 맞히는가
// ---------------------------------------------------------------------------

/**
 * 주어진 엣지 무게 중 몇 %가 블록 **안**에 떨어지는가.
 *
 * 만든 데 쓴 엣지로 재면 동어반복이다. 그래서 이 함수는 **만들 때 안 쓴
 * 엣지**를 받도록 설계했다 — 뒤쪽 커밋에서 나온 공변경을 넣는다.
 *
 * ⚠️ 블록이 하나면 이 값은 자동으로 1 이 된다. 그래서 이 숫자는 **혼자
 *    쓰면 안 되고** `shape` 의 제약을 통과한 분할끼리만 비교해야 한다.
 *    `rank()` 가 그 순서를 강제한다.
 */
export function containment(ids, edges, membership, { minSupport = 1 } = {}) {
  const index = new Map()
  ids.forEach((id, i) => index.set(id, i))

  let inside = 0
  let total = 0
  let pairs = 0
  let hit = 0
  for (const e of edges) {
    const a = index.get(e.source)
    const b = index.get(e.target)
    if (a === undefined || b === undefined || a === b) continue
    const w = e.support ?? 1
    if (w < minSupport) continue
    total += w
    pairs++
    if (membership[a] === membership[b]) { inside += w; hit++ }
  }
  return {
    weighted: total ? inside / total : null,
    // 무게를 빼고 쌍 개수로도 낸다. 큰 support 하나가 값을 끌고 가는지 보려면 둘이 필요하다.
    unweighted: pairs ? hit / pairs : null,
    pairs,
  }
}

// ---------------------------------------------------------------------------
// 독립성 — 폴더를 다시 발견한 것은 아닌가
// ---------------------------------------------------------------------------

/**
 * 파일 경로의 디렉터리로 만든 분할. 비교 대상이지 입력이 아니다.
 *
 * @param depth 몇 번째 마디까지를 한 덩어리로 볼 것인가. 1 이면 최상위 폴더
 */
export function directoryPartition(ids, { depth = 1 } = {}) {
  const map = new Map()
  const out = new Int32Array(ids.length)
  ids.forEach((id, i) => {
    const parts = id.split(/[/\\]/).slice(0, depth).join('/')
    if (!map.has(parts)) map.set(parts, map.size)
    out[i] = map.get(parts)
  })
  return out
}

// ---------------------------------------------------------------------------
// 안정성
// ---------------------------------------------------------------------------

/**
 * 여러 번 나눈 결과가 서로 얼마나 같은가. 쌍마다 ARI 를 내고 평균한다.
 *
 * 이 숫자가 낮으면 **씨앗 하나 바꿨을 뿐인데 화면 색이 전부 바뀐다**는 뜻이다.
 * D17 이 spectral 을 버린 세 번째 이유가 정확히 이것이고, 그러니 우리가 고른
 * 알고리즘이 같은 병을 앓고 있지 않은지 매번 확인해야 한다.
 */
export function agreement(runs) {
  if (runs.length < 2) return { mean: null, min: null, n: 0 }
  const vals = []
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const v = ari(runs[i], runs[j])
      if (v != null) vals.push(v)
    }
  }
  if (!vals.length) return { mean: null, min: null, n: 0 }
  return {
    mean: vals.reduce((a, v) => a + v, 0) / vals.length,
    // 평균만 보면 한 번의 붕괴가 묻힌다. 최악을 함께 낸다.
    min: Math.min(...vals),
    n: vals.length,
  }
}

// ---------------------------------------------------------------------------
// 고르기
// ---------------------------------------------------------------------------

/**
 * 후보 중 하나를 고른다.
 *
 * 🔴 가중합으로 점수 하나를 만들지 않는다.
 *
 * "안정성 0.3 × 압축성 0.2 × 예측력 0.5" 같은 식을 쓰면 그 가중치가 어디서
 * 왔냐는 질문에 답할 수 없고, 결국 **눈으로 고른 상수를 없애려고 만든 도구
 * 안에 눈으로 고른 상수를 넣는 꼴**이 된다. 그리고 가중합은 한 축의 붕괴를
 * 다른 축의 초과 달성으로 가려준다 — 안정성 0.1 짜리 분할이 예측력이 높다는
 * 이유로 뽑힐 수 있다. 그건 매일 색이 바뀌는 지도다.
 *
 * 그래서 **제약을 먼저 통과시키고, 통과한 것들 중에서 하나의 목적만** 본다.
 * 이 저장소가 "표본이 모자라면 답하지 않는다" 로 하는 것과 같은 모양이다.
 *
 * 제약을 아무도 통과하지 못하면 **후보를 지어내지 않고 그 사실을 돌려준다.**
 */
export const LIMITS = {
  maxBlobShare: 0.4,     // 한 블록이 이보다 크면 그건 지도가 아니라 얼룩이다
  minStability: 0.6,     // 씨앗을 바꿨을 때 이만큼은 같아야 한다
  minBlocks: 3,
  maxBlocks: 40,         // 화면에 색으로 구별해 그릴 수 있는 상한 (Q1 과 이어짐)
  maxSingletonShare: 0.5,
  maxDirAgreement: 0.9,  // 폴더와 이 이상 같으면 새로 알려주는 것이 없다
}

export function rank(candidates, limits = LIMITS) {
  const judged = candidates.map((c) => {
    const fail = []
    if (c.shape.usableBlocks < limits.minBlocks) fail.push(`블록 ${c.shape.usableBlocks}개 — 너무 적다`)
    if (c.shape.usableBlocks > limits.maxBlocks) fail.push(`블록 ${c.shape.usableBlocks}개 — 화면에 못 그린다`)
    if (c.shape.maxShare > limits.maxBlobShare) fail.push(`한 블록이 ${(c.shape.maxShare * 100).toFixed(0)}% 를 차지한다`)
    if (c.shape.singletonShare > limits.maxSingletonShare) fail.push(`혼자인 파일이 ${(c.shape.singletonShare * 100).toFixed(0)}%`)
    if (c.stability?.mean != null && c.stability.mean < limits.minStability) {
      fail.push(`씨앗을 바꾸면 달라진다 (ARI ${c.stability.mean.toFixed(2)})`)
    }
    if (c.dirAgreement != null && c.dirAgreement > limits.maxDirAgreement) {
      fail.push(`폴더 구조와 거의 같다 (ARI ${c.dirAgreement.toFixed(2)})`)
    }
    return { ...c, ok: fail.length === 0, fail }
  })

  const passed = judged.filter((c) => c.ok && c.heldOut?.weighted != null)
  passed.sort((a, b) => b.heldOut.weighted - a.heldOut.weighted)

  return {
    best: passed[0] ?? null,
    // 왜 못 골랐는지 말할 수 있어야 한다. 빈 답과 "후보가 전부 탈락" 은 다르다.
    why: passed.length ? null : (judged.length ? '모든 후보가 제약에 걸렸다' : '후보가 없다'),
    passed,
    judged,
  }
}
