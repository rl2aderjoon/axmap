/**
 * 기능 인접 경고 — 파일은 안 겹치는데 **기능이 겹칠 때**.
 *
 * v0 프로토콜은 경로가 겹치는지만 본다. 그것으로 못 잡는 상황이 있다.
 *
 *   에이전트 A 가 `album.controller.ts` 를 잡는다   (API 쪽, 앞에서부터)
 *   에이전트 B 가 `album.repository.ts` 를 잡는다   (DB 쪽, 뒤에서부터)
 *
 * 경로가 안 겹치므로 **둘 다 통과한다.** 그런데 같은 기능이다.
 * A 가 응답 형태를 바꾸고 B 가 스키마를 바꾸면, 머지 시점에 텍스트 충돌은
 * 하나도 없는데 기능이 깨진다. 이것이 파일 단위 락의 한계다.
 *
 * 🔴 이것은 **경고이지 거부가 아니다.** 프로토콜을 건드리지 않는다.
 *
 * checkOverlap 은 그대로 두고, 뷰어가 옆에서 알려주기만 한다. 이유가 있다 —
 *
 *   1. 거부로 만들면 통과가 **줄어드는** 게 아니라 판정 기준이 달라진다.
 *      "경로가 겹치면 거부" 는 결정론이고 증명 가능하지만(I1), "기능이 겹치면
 *      거부" 는 lift 문턱이라는 조절 가능한 숫자에 기댄다. 그 숫자를 정당화할
 *      근거가 아직 없다 (DECISIONS.md 열린 질문 Q5).
 *   2. 히스토리가 없는 새 저장소에서는 이 신호가 아예 없다. 락이 그런 것에
 *      의존하면 "어떤 저장소에서는 락이 약해진다" 는 상태가 된다.
 *
 * 그래서 게이트는 그대로, 사람에게 정보만 준다 — D4 가 LLM 을 게이트 밖에
 * 둔 것과 같은 배치다.
 */

/** 경로 접두사 포함. protocol.mjs 의 겹침 판정과 같은 '/' 경계 규칙을 쓴다. */
const covers = (claimPath, file) => file === claimPath || file.startsWith(`${claimPath}/`)

/** 이 claim 이 덮는 실제 파일들 */
function filesOf(claim, allPaths) {
  const out = new Set()
  for (const c of claim.paths ?? []) {
    for (const f of allPaths) if (covers(c, f)) out.add(f)
  }
  return out
}

/**
 * 활성 claim 들 사이에서 "경로는 안 겹치는데 공변경으로 이어진" 쌍을 찾는다.
 *
 * @param {object[]} claims    활성 claim (agent, paths, task, intent…)
 * @param {object[]} coEdges   공변경 엣지 (source, target, support, lift)
 * @param {string[]} allPaths  그래프에 있는 파일 전체
 * @param {object} opts
 * @returns {{pairs: object[], byAgent: object}}
 */
export function featureAdjacency(claims, coEdges, allPaths, {
  minLift = 3, minSupport = 4, maxEvidence = 8,
} = {}) {
  const live = (claims ?? []).filter((c) => !c.broken && (c.paths?.length ?? 0) > 0)
  if (live.length < 2) return { pairs: [], checked: live.length }

  const owned = live.map((c) => ({ claim: c, files: filesOf(c, allPaths) }))

  // 파일 → 그 파일을 덮는 claim 들. 같은 파일을 둘이 덮고 있으면 그건
  // 프로토콜이 이미 막았어야 하는 상황이므로 여기서 다루지 않는다.
  const ownerOf = new Map()
  owned.forEach((o, i) => { for (const f of o.files) ownerOf.set(f, i) })

  const pairKey = (i, j) => (i < j ? `${i}\0${j}` : `${j}\0${i}`)
  const acc = new Map()

  for (const e of coEdges) {
    if ((e.lift ?? 0) < minLift || (e.support ?? 0) < minSupport) continue
    const a = ownerOf.get(e.source)
    const b = ownerOf.get(e.target)
    if (a === undefined || b === undefined || a === b) continue

    const k = pairKey(a, b)
    if (!acc.has(k)) acc.set(k, { a: Math.min(a, b), b: Math.max(a, b), evidence: [] })
    acc.get(k).evidence.push({
      from: e.source, to: e.target, lift: e.lift, support: e.support,
    })
  }

  const pairs = [...acc.values()].map((p) => {
    const A = owned[p.a].claim
    const B = owned[p.b].claim
    const ev = p.evidence.sort((x, y) => y.lift - x.lift).slice(0, maxEvidence)
    return {
      agents: [A.agent, B.agent],
      tasks: [A.task ?? null, B.task ?? null],
      intents: [A.intent ?? null, B.intent ?? null],
      paths: [A.paths, B.paths],
      // 세기는 "몇 개의 공변경 엣지가 두 영역을 가로지르나" + 가장 강한 lift.
      // 하나의 점수로 합치지 않는다 — 둘은 다른 것을 뜻한다.
      // (엣지 수 = 얼마나 넓게 얽혔나 / 최고 lift = 얼마나 강하게 얽혔나)
      crossings: p.evidence.length,
      topLift: ev[0]?.lift ?? 0,
      evidence: ev,
    }
  }).sort((x, y) => y.crossings - x.crossings || y.topLift - x.topLift)

  return { pairs, checked: live.length }
}

/**
 * 사람이 읽을 경고문.
 *
 * 거부 메시지와 **같은 모양**으로 만든다. 이 저장소의 거부 메시지는
 * "누가·무엇을·언제까지" 를 말해서 에이전트가 스스로 방향을 틀 수 있게 한다.
 * 경고도 같은 재료를 줘야 같은 판단을 할 수 있다.
 */
export function formatAdjacency(pair) {
  const [a, b] = pair.agents
  const lines = [
    `⚠ 경로는 안 겹치지만 같은 기능일 수 있습니다`,
    ``,
    `  ${a}  (${pair.tasks[0] ?? '작업 미지정'})`,
    `    ${pair.paths[0].join(', ')}`,
    pair.intents[0] ? `    의도: ${pair.intents[0]}` : null,
    ``,
    `  ${b}  (${pair.tasks[1] ?? '작업 미지정'})`,
    `    ${pair.paths[1].join(', ')}`,
    pair.intents[1] ? `    의도: ${pair.intents[1]}` : null,
    ``,
    `  근거 — 두 영역을 가로지르는 공변경 ${pair.crossings}건 (최고 lift ${pair.topLift})`,
    ...pair.evidence.slice(0, 4).map((e) => `    ${e.from}  ↔  ${e.to}   lift ${e.lift} · n=${e.support}`),
    ``,
    `  이것은 거부가 아닙니다. 두 사람이 서로의 의도를 아는 것으로 충분할 수 있습니다.`,
  ]
  return lines.filter((l) => l !== null).join('\n')
}
