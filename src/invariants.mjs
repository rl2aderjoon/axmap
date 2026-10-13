/**
 * 불변식 검사기.
 *
 * docs/INVARIANTS.md 의 I1~I8 을 코드로 옮긴 것이다.
 * 모델 검증기(test/model.test.mjs), 카오스 테스트(demo/chaos.sh),
 * 사후 감사(axmap audit)가 **같은 검사기**를 쓴다.
 * 도구마다 다른 판정을 하면 무엇이 맞는지 알 수 없게 된다.
 *
 * 여기도 순수하다. git 도 파일시스템도 없다.
 */

import {
  DEFAULT_MERGE_POLICY,
  activeClaims,
  claimExpiresAt,
  normalizePath,
  pathsOverlap,
} from './protocol.mjs'

// ---------------------------------------------------------------------------
// I1 · 상호배제 (상태 불변식)
// 어느 시점에도, 서로 겹치는 경로를 유효하게 소유한 에이전트는 최대 1명이다.
// ---------------------------------------------------------------------------

export function mutualExclusionViolations(claims, now) {
  const live = activeClaims(claims, now)
  const out = []
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]
      const b = live[j]
      if (a.agent === b.agent) continue
      for (const pa of a.paths.map(normalizePath)) {
        for (const pb of b.paths.map(normalizePath)) {
          if (pathsOverlap(pa, pb)) {
            out.push({
              invariant: 'I1',
              message: `${pa} 와 ${pb} 를 ${a.agent} 와 ${b.agent} 가 동시에 소유`,
              agents: [a.agent, b.agent],
              paths: [pa, pb],
              windows: [
                { agent: a.agent, since: a.since, until: new Date(claimExpiresAt(a)).toISOString() },
                { agent: b.agent, since: b.since, until: new Date(claimExpiresAt(b)).toISOString() },
              ],
            })
          }
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// I2 · 무손실 (전이 불변식)
// claim 이 성공을 반환했으면, 요청한 경로는 반드시 내 레코드에 있다.
// ---------------------------------------------------------------------------

export function lossViolations({ requested, record }) {
  const have = new Set(record.paths.map(normalizePath))
  return requested
    .map(normalizePath)
    .filter((p) => !have.has(p))
    .map((p) => ({
      invariant: 'I2',
      message: `claim 이 성공했는데 ${p} 가 레코드에 없다`,
      agents: [record.agent],
      paths: [p],
    }))
}

// ---------------------------------------------------------------------------
// I6 · 비부활 (전이 불변식)
// 성공한 claim 의 경로는 (요청한 경로 ∪ 직전 "유효" claim 의 경로) 안에 있어야 한다.
// 만료된 내 레코드에서 넘어온 경로는 관문 2 를 거치지 않았으므로 부활이다.
// ---------------------------------------------------------------------------

export function resurrectionViolations({ before, after, requested, me, now }) {
  const prev = activeClaims(before, now).find((c) => c.agent === me)
  const allowed = new Set([
    ...requested.map(normalizePath),
    ...(prev?.paths ?? []).map(normalizePath),
  ])
  const mine = after.find((c) => c.agent === me)
  if (!mine) return []
  return mine.paths
    .map(normalizePath)
    .filter((p) => !allowed.has(p))
    .map((p) => ({
      invariant: 'I6',
      message: `${p} 가 만료된 레코드에서 검사 없이 부활했다`,
      agents: [me],
      paths: [p],
    }))
}

// ---------------------------------------------------------------------------
// I7 · 세션 이름 유일성 (상태 불변식)
// 한 슬롯 레지스트리 안에서 동시에 살아있는 두 세션은 서로 다른 AXMAP_AGENT 를 갖는다.
//
// 🔴 "모든 에이전트의 이름이 다르다" 는 여기에 적을 수 없다. 사람이 두 셸에
//    같은 AXMAP_AGENT 를 넣으면 시스템이 막을 방법이 없고, 검사할 수 없는 문장을
//    불변식이라고 적어두면 그 목록 전체의 신뢰가 떨어진다.
//    시스템이 **실제로 보장할 수 있는 것**은 자기가 띄운 세션들의 이름뿐이다.
// ---------------------------------------------------------------------------

export function sessionIdentityViolations(sessions) {
  const out = []
  const seen = new Map()
  for (const s of sessions ?? []) {
    const id = s?.id ?? null
    const name = typeof s?.agent === 'string' ? s.agent.trim() : ''
    /**
     * 이름이 없는 것을 건너뛰지 않는다. 이름이 없는 세션은 자식이 서버의 환경을
     * 그대로 물려받는다는 뜻이고, 그것이 이 불변식을 만든 버그 그 자체다.
     * 여기서 조용히 넘기면 "위반 0" 이 "아무 문제 없음" 으로 읽힌다.
     */
    if (!name) {
      out.push({
        invariant: 'I7',
        message: `세션 ${id} 에 이름이 없다 — 자식이 서버의 AXMAP_AGENT 를 그대로 물려받는다`,
        agents: [],
        sessions: [id],
      })
      continue
    }
    const prev = seen.get(name)
    if (prev !== undefined && prev !== id) {
      out.push({
        invariant: 'I7',
        message: `세션 ${prev} 와 ${id} 가 같은 이름 "${name}" 을 쓴다 — 서로를 겹침으로 보지 못한다`,
        agents: [name],
        sessions: [prev, id],
      })
      continue
    }
    seen.set(name, id)
  }
  return out
}

// ---------------------------------------------------------------------------
// I8 · 게이트 우선 (전이 불변식)
// 게이트가 하나라도 빨갛거나 빠진 제안은 어떤 표 조합으로도 병합되지 않는다.
//
// I5(강제)와 같은 자리에 있다. I5 가 없으면 claim 이 권고 사항이 되듯,
// I8 이 없으면 게이트가 권고 사항이 된다. 그리고 "작업 노드가 없어도 도는
// 시스템" 의 실패 모드는 멈춤이 아니라 조용한 부패다 - 아무도 안 볼 때
// 자동 워커가 빨간 것을 밀어 넣고, 그것을 아무도 모른다.
//
// checkMerge 를 부르지 않고 게이트만 다시 본다. 판정을 만든 함수로 그 판정을
// 검사하면 검사 대상이 제품이 아니라 검사기가 된다 (모델 검증기의 oracle 원칙).
// ---------------------------------------------------------------------------

export function gatePrecedenceViolations({ merge, policy = DEFAULT_MERGE_POLICY }) {
  const gates = merge.gates ?? {}
  const out = []
  for (const name of policy.requiredGates) {
    const g = gates[name]
    if (g && g.ok) continue
    out.push({
      invariant: 'I8',
      message: g
        ? `게이트 ${name} 가 빨간 채로 ${merge.id} 가 병합됐다`
        : `게이트 ${name} 를 돌리지 않은 채 ${merge.id} 가 병합됐다`,
      agents: merge.agent ? [merge.agent] : [],
      paths: merge.paths ?? [],
      gate: name,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 사후 감사
//
// 장부 브랜치는 모든 claim 변화를 커밋으로 기록한 완전한 감사 로그다.
// 스냅샷을 순서대로 재생하면 상호배제가 깨진 적이 있는지 사후에 증명할 수 있다.
// 구현을 믿을 필요가 없어진다는 것이 이 검사의 핵심이다.
// ---------------------------------------------------------------------------

/**
 * 스냅샷의 논리 시각.
 *
 * 커밋 시각을 그대로 쓰지 않는 이유: 테스트가 AXMAP_NOW 로 시계를 옮기면
 * 커밋 시각(실제 벽시계)과 레코드의 since(논리 시각)가 어긋난다.
 * since 는 논리적으로 미래일 수 없으므로, 둘 중 늦은 쪽이 그 스냅샷의 시각이다.
 * 실제 사용에서는 항상 since <= 커밋 시각이므로 커밋 시각과 같다.
 */
export function snapshotTime(snapshot) {
  const sinces = snapshot.claims.map((c) => Date.parse(c.since)).filter((n) => !Number.isNaN(n))
  return Math.max(snapshot.time, ...(sinces.length ? sinces : [snapshot.time]))
}

// ---------------------------------------------------------------------------
// I5 · 강제 (전이 불변식)
// 커밋이 파일을 고쳤다면, 그 시각에 **누군가는** 그 파일을 잡고 있어야 한다.
//
// 🔴 이 검사가 없으면 claim 은 권고 사항이다. 지금까지 강제하는 것은 각자 PC 의
//    커밋 훅뿐이었고, 훅은 "설치했는가" 에 달려 있으며 `--no-verify` 로 넘어가고
//    웹 IDE 에는 아예 없다. 서버에서 도는 검사만이 설치 여부와 무관하다.
//
// 🔴 **"고친 사람이 곧 잡은 사람인가" 는 묻지 않는다.** 장부의 `agent` 는 세션
//    이름(`claude-code-mcpjson` 같은)이고 커밋의 author 는 git 이름(`janghyojoon`)
//    이라 서로 다른 이름 공간이다. 둘을 이름으로 맞추면 **정상 작업이 전부 위반으로
//    나온다.** 그래서 여기서는 "아무도 안 잡은 파일이 고쳐졌나" 하나만 본다 —
//    이것이 이 검사가 실제로 증명할 수 있는 문장이다. 소유자까지 맞추려면 claim
//    레코드에 git 신원을 함께 적어야 하고, 그건 별개의 변경이다.
//
// 🔴 장부보다 앞선 커밋은 **건너뛰되 세어서 보고한다.** 조용히 빼면 "위반 0" 이
//    "검사했고 깨끗함" 으로 읽힌다. 검사하지 않은 것을 통과로 내지 않는다.
// ---------------------------------------------------------------------------

export function enforcementViolations(snapshots, commits) {
  const snaps = [...(snapshots ?? [])].sort((a, b) => snapshotTime(a) - snapshotTime(b))
  const violations = []
  const skipped = []

  for (const c of commits ?? []) {
    // 그 커밋 시각에 유효했던 마지막 장부 스냅샷을 찾는다.
    let snap = null
    for (const s of snaps) {
      if (snapshotTime(s) <= c.time) snap = s
      else break
    }
    if (!snap) {
      skipped.push({ commit: c.sha, subject: c.subject, reason: '장부보다 앞선 커밋' })
      continue
    }
    const held = activeClaims(snap.claims, c.time).flatMap((cl) => cl.paths.map(normalizePath))
    for (const f of (c.files ?? []).map(normalizePath)) {
      if (held.some((p) => pathsOverlap(p, f))) continue
      violations.push({
        invariant: 'I5',
        message: `${f} 를 아무도 잡지 않은 채 고쳤다`,
        agents: c.author ? [c.author] : [],
        paths: [f],
        commit: c.sha,
        subject: c.subject,
        at: new Date(c.time).toISOString(),
      })
    }
  }
  return { violations, skipped }
}

// ---------------------------------------------------------------------------
// 체크포인트 — "여기까지는 이미 재생해서 깨끗함을 봤다"
//
// 🔴 왜 필요한가. 감사는 장부 이력을 **처음부터 전부** 다시 재생했다. 장부는
//    하루 100건씩 늘기만 하므로 이 검사는 쓸수록 느려진다 — 팀 저장소에서
//    파이프라인 평균이 42초에서 332초로 갔고, 같은 파이프라인의 다른 잡은
//    5~10초 그대로였다 (실측 2026-09-04, 표본 각 15건).
//
// 🔴 그런데 **이력을 버리면 안 된다.** 감사가 보장하는 문장은 "어느 시점에도 두
//    사람이 같은 파일을 동시에 잡은 적이 없다" 이고, 최근 N개만 보면 사흘 전
//    겹침이 영원히 안 보인다. TTL 로 오래된 것을 지우는 것도 같은 이유로 안 된다.
//
//    그래서 버리는 대신 **이미 본 것을 다시 안 본다.** 체크포인트 하나는 이런
//    문장이다 — *"장부를 뿌리부터 이 커밋까지 재생했고, 그 구간의 모든 스냅샷에서
//    상호배제(I1)가 성립했다."* 장부는 append-only(**뒤에 붙기만 하고 지난 것이
//    바뀌지 않는**) git 이력이므로 한 번 증명한 앞구간은 계속 참이다.
//    체크포인트부터 재생한 결과를 거기에 이어 붙이면 **전체를 본 것과 같다.**
//
// 🔴 체크포인트는 장부 상태의 **사본이 아니라 주소**다 (커밋 sha 하나).
//    상태를 복사해 두면 장부와 두 벌이 되고, 두 벌은 반드시 어긋난다.
//    주소는 어긋날 수가 없다 — 그 커밋의 트리가 곧 그 시점의 장부다.
// ---------------------------------------------------------------------------

/**
 * `atMs` 시점에 이미 성립해 있던 체크포인트 중 **가장 늦은 것**.
 * 하나도 없으면 null (= 장부 뿌리부터 재생해야 한다).
 */
export function pickCheckpoint(checkpoints, atMs) {
  let best = null
  for (const cp of checkpoints ?? []) {
    if (!Number.isFinite(cp?.time) || cp.time > atMs) continue
    if (!best || cp.time > best.time) best = cp
  }
  return best
}

/**
 * 이번 감사를 **어디서부터** 재생할지, 그리고 어떤 코드 커밋을 판정할지 정한다.
 *
 * 🔴 시작 지점은 "가장 최근 체크포인트" 가 **아니다.** "이번 코드 구간에서 가장
 *    오래된 커밋보다 앞선 체크포인트" 다. 이것이 이 설계의 전부다.
 *
 *    I5(강제)는 커밋 하나하나에 대해 *"그 시각에 누가 그 파일을 잡고 있었나"* 를
 *    묻는다. 최근 체크포인트부터 재생하면 그보다 오래된 커밋은 참고할 장부
 *    스냅샷이 아예 없어서 **조용히 통과**한다 — 락에서 최악인 fail-open 이다.
 *
 *    - 기능 브랜치는 오늘 만든 커밋 몇 개뿐이라 오늘치만 읽고 끝난다
 *    - 승격 MR(`common/dev -> main` 같은 것)은 9일치 91커밋을 한 번에 나른다.
 *      그때는 9일 전 체크포인트부터 재생해야 판정이 성립한다
 *
 *    **드물게 무거운 것이 자주 무거운 것보다 낫다.** 고치기 전은 반대였다.
 *
 * 🔴 첫 체크포인트보다 앞선 코드 커밋은 **면제**한다 (amnesty). 이미 만들어진
 *    커밋이라 지금 와서 다시 만들 수 없다. 장부가 생기기 전 커밋을 봐주는 자리가
 *    이미 있고(enforcementViolations 의 skipped), 그 자리를 한 번 더 쓰는 것이다.
 *    면제는 **조용하면 안 된다** — 몇 건을 왜 면제했는지 부르는 쪽이 찍는다.
 *
 * @returns {{from: object|null, judged: Array, amnestied: Array}}
 */
export function planAudit({ checkpoints = [], codeCommits = null }) {
  const cps = [...checkpoints].filter((c) => Number.isFinite(c?.time)).sort((a, b) => a.time - b.time)
  const first = cps[0] ?? null

  // 코드 대조를 안 하면 I1 만 본다. 그때는 마지막 체크포인트부터면 충분하다.
  if (!codeCommits) return { from: cps[cps.length - 1] ?? null, judged: null, amnestied: [] }

  const amnestied = first ? codeCommits.filter((c) => c.time < first.time) : []
  const judged = first ? codeCommits.filter((c) => c.time >= first.time) : [...codeCommits]

  if (!judged.length) return { from: first, judged, amnestied }
  const oldest = Math.min(...judged.map((c) => c.time))
  return { from: pickCheckpoint(cps, oldest), judged, amnestied }
}

/**
 * 시간이 흐르는 것만으로는 겹침이 생기지 않는다 (만료는 claim 을 없앨 뿐이다).
 * 겹침은 오직 claim 이 추가될 때 생기고, claim 은 커밋으로만 추가된다.
 * 따라서 각 커밋 시점만 검사하면 전체 구간을 덮는다.
 *
 * @param replay  체크포인트로 앞구간을 건너뛰었다면 그 사실 — 어느 체크포인트가
 *                앞선 몇 개를 보증하는가. null 이면 장부 뿌리부터 전부 재생했다는 뜻이다.
 * @param amnesty 첫 체크포인트보다 앞서서 **판정에서 면제한** 코드 커밋들.
 */
export function auditLedger(snapshots, commits = null, { replay = null, amnesty = [] } = {}) {
  const violations = []
  for (const snap of snapshots) {
    const t = snapshotTime(snap)
    for (const v of mutualExclusionViolations(snap.claims, t)) {
      violations.push({ ...v, commit: snap.commit, subject: snap.subject, at: new Date(t).toISOString() })
    }
  }
  const code = commits ? enforcementViolations(snapshots, commits) : null
  if (code) violations.push(...code.violations)
  return {
    ok: violations.length === 0,
    checked: snapshots.length,
    codeChecked: commits ? commits.length : null,
    codeSkipped: code ? code.skipped : null,
    replay,
    amnesty,
    violations,
  }
}

export function formatAudit(report) {
  // 코드 검사를 돌렸는지, 그중 몇 개를 못 봤는지는 통과·실패 어느 쪽에서도 적는다.
  const codeLine =
    report.codeChecked === null || report.codeChecked === undefined
      ? '코드 커밋 대조: 안 함 (--code <범위> 를 주면 봅니다)'
      : `코드 커밋 대조: ${report.codeChecked}개` +
        (report.codeSkipped?.length ? ` (장부보다 앞서 건너뛴 것 ${report.codeSkipped.length}개)` : '')

  // 어디서부터 재생했는지. 체크포인트가 없으면 뿌리부터 본 것이라 적을 것이 없다.
  const replayLine = report.replay
    ? `재생 구간: 체크포인트 ${report.replay.from.slice(0, 7)} (${report.replay.at}) 이후` +
      ` - 그 앞 스냅샷 ${report.replay.covered}개는 이 체크포인트가 보증합니다`
    : null

  // 🔴 면제는 조용하면 안 된다. 몇 건을 왜 봐줬는지 통과·실패 어느 쪽에서도 적는다.
  const amnestyLines = []
  if (report.amnesty?.length) {
    amnestyLines.push(
      `면제 ${report.amnesty.length}개 - 첫 체크포인트보다 앞선 코드 커밋이라 판정하지 않았습니다.`,
    )
    for (const c of report.amnesty) {
      amnestyLines.push(`    - ${c.sha.slice(0, 7)}  ${c.at}  ${c.subject}`)
    }
  }

  if (report.ok) {
    return [
      `감사 통과 - 스냅샷 ${report.checked}개 재생`,
      '장부 이력 전체에서 상호배제(I1)가 깨진 시점이 없습니다.',
      ...(replayLine ? [replayLine] : []),
      codeLine,
      ...amnestyLines,
    ].join('\n')
  }
  const lines = [
    `감사 실패 - 스냅샷 ${report.checked}개 중 위반 ${report.violations.length}건`,
    ...(replayLine ? [replayLine] : []),
    codeLine,
    ...amnestyLines,
    '',
  ]
  for (const v of report.violations) {
    lines.push(`  x [${v.invariant}] ${v.at}  commit ${v.commit.slice(0, 7)}  ${v.subject}`)
    lines.push(`      ${v.message}`)
    for (const w of v.windows ?? []) lines.push(`      ${w.agent}: ${w.since} ~ ${w.until}`)
    lines.push('')
  }
  return lines.join('\n')
}
