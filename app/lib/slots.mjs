/**
 * 세션마다 안정적인 고유 이름 — `<base>-s<N>`.
 *
 * 🔴 이 파일이 없던 동안 **앱에서 띄운 세션은 몇 개든 전부 같은 사람이었다.**
 *
 * `app/lib/session.mjs` 의 `spawn` 에 `env` 옵션이 없어서 자식이 `app/server.mjs`
 * 의 환경을 그대로 물려받았다. 그러면 세 세션이 전부 같은 `AXMAP_AGENT` 로
 * claim 하고, `checkOverlap` 은 **자기 claim 을 겹침으로 보지 않으므로**
 * 서로를 하나도 못 막는다. 이 저장소가 `.mcp.json` 에서 뿌리뽑은 바로 그 실패가
 * (SPEC §3 "에이전트 이름을 정하는 순서") 앱 안에서 되살아나 있었다.
 * "혼자서 에이전트 여러 개" 가 실제로 일어나는 곳이 여기다.
 *
 * ── 이름을 왜 이렇게 짓는가 ────────────────────────────────────────────────
 *
 * `base` 는 `live.mjs` 의 `whoAmI()` 가 정한다. **여기서 다시 구현하지 않는다.**
 * 두 곳이 갈리면 CLI 는 `A` 로 claim 했는데 화면이 그것을 남의 것으로 칠한다.
 *
 * 랜덤 UUID 를 쓰지 않는다. 이 제품의 목적이 "누가 무엇을 잡았는지 **사람이 보는
 * 것**" 이므로 화면에 `f47ac10b-…-s?` 가 뜨면 목적에 정면으로 반한다.
 * `janghyojoon-s2` 는 읽는 순간 누구인지 안다.
 *
 * ── 슬롯 레지스트리(`<repo>/.axmap/sessions.json`)가 왜 필요한가 ───────────
 *
 * 세션 id(UUID)를 이름으로 쓰면 앱을 껐다 켤 때마다 이름이 바뀐다. 그러면
 * **앱이 죽으며 두고 간 claim 을 아무도 반납할 수 없다** — `release` 는 이름이
 * 다르므로 종료 코드 5 를 내고, 그동안 TTL 이 다 갈 때까지 남의 영역이 막힌다.
 *
 * 슬롯 번호는 pid 로 회수되므로 앱을 껐다 켜면 옛 pid 가 죽어 슬롯이 전부 비고
 * 첫 세션이 다시 `s1` 을 받는다. **이름이 재시작을 넘어 안정적**이라는 뜻이고,
 * 그래서 다시 켠 세션이 자기가 두고 간 claim 을 그대로 반납할 수 있다.
 *
 * pid 를 기록하는 이유는 **앱을 두 개 띄웠을 때**다. 그때 둘 다 `s1` 을 잡으면
 * 이름 충돌이 그대로 돌아온다. 살아있는 pid 의 슬롯은 절대 뺏지 않는다.
 *
 * ── 이 파일은 fail-closed 의 예외다 ────────────────────────────────────────
 *
 * 레지스트리가 없거나 깨져 있으면 **빈 것으로 시작한다.** 장부 레코드였다면
 * 전체를 중단해야 하지만(SPEC §6) 이것은 락이 아니라 **편의 기록**이다.
 * 여기서 중단하면 얻는 것 없이 앱이 세션을 하나도 못 띄운다. 반대로 빈 것으로
 * 시작해서 생기는 최악은 "살아있는 앱의 슬롯을 잊고 같은 번호를 준다" 인데,
 * 그것은 아래 `alive()` 가 죽은 pid 만 버리는 것과 acquire 직후의 I7 검사가 막는다.
 * 판정을 바꾸지 않는 기록에까지 fail-closed 를 적용하면 원칙이 아니라 미신이 된다.
 *
 * 다만 **이름을 정하지 못하는 것은 다르다.** 이름 없이 세션을 띄우면 그 순간
 * 위의 버그가 그대로 돌아오므로, `acquire` 가 실패하면 세션을 만들지 않는다.
 */

import fs from 'node:fs'
import path from 'node:path'
import { whoAmI } from './live.mjs'
import { sessionIdentityViolations } from '../../src/invariants.mjs'

/** `.axmap/` 는 이미 gitignore 다. 새 항목을 만들지 않는다. */
const REGISTRY_REL = path.join('.axmap', 'sessions.json')

/**
 * `whoAmI()` 가 아무것도 못 찾았을 때의 이름.
 *
 * CLI 는 이름을 모르면 die 하지만(치환이 곧 소유권 충돌이므로) 여기서는 다르다.
 * 슬롯 번호가 붙어 **세션끼리는 어차피 서로 다른 이름**이 되므로, 같은 이름이
 * 되어 서로를 못 막는 그 실패는 일어나지 않는다. 사람 이름을 못 찾은 것은
 * 화면에서 `agent-s1` 로 보이는 불편이지 상호배제의 구멍이 아니다.
 */
const FALLBACK_BASE = 'agent'

export function registryPath(repoRoot) {
  return path.join(repoRoot, REGISTRY_REL)
}

/** 이 저장소에서 '나'. 순서는 CLI·MCP·화면과 같아야 하므로 live.mjs 것을 그대로 쓴다. */
export function baseName(repoRoot) {
  return whoAmI(repoRoot) || FALLBACK_BASE
}

export function sessionAgentName(base, slot) {
  return `${base}-s${slot}`
}

/**
 * 이 pid 가 아직 살아 있는가. `process.kill(pid, 0)` 은 신호를 보내지 않고
 * 존재만 확인하며, 윈도우에서도 동작한다.
 *
 * 🔴 `EPERM` 은 **살아 있는 것**이다. 다른 사용자의 프로세스라 신호를 못 보낼
 * 뿐 존재는 한다. 여기서 죽었다고 보면 남이 쓰는 슬롯을 뺏어 같은 이름이 둘
 * 생긴다 — 애매하면 뺏지 않는 쪽이 맞다.
 */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/** 레지스트리를 읽는다. 없거나 깨졌으면 빈 것 (머리말의 "fail-closed 의 예외"). */
export function readRegistry(repoRoot) {
  let raw
  try {
    raw = fs.readFileSync(registryPath(repoRoot), 'utf8')
  } catch {
    return {}
  }
  try {
    const j = JSON.parse(raw)
    const slots = j?.slots
    return slots && typeof slots === 'object' && !Array.isArray(slots) ? slots : {}
  } catch {
    return {}
  }
}

/**
 * 파일 하나를 원자적으로 쓴다 — 임시 파일에 다 쓴 뒤 같은 디렉터리에서 rename.
 *
 * 방식과 이유는 `bin/axmap.mjs` 의 `writeFileAtomic` 머리말에 적혀 있다. 요약하면
 * `writeFileSync` 는 호출 하나로 보여도 커널이 여러 번에 나눠 쓸 수 있고, 그 사이에
 * 다른 앱 인스턴스가 이 파일을 읽으면 **반쯤 쓰인 JSON** 을 본다. 그러면 위 규칙에
 * 따라 빈 것으로 시작하고, 살아있는 슬롯을 잊어 같은 번호를 두 번 준다.
 * 같은 디렉터리 안의 rename 은 같은 파일시스템이라 원자적이다.
 */
function writeFileAtomic(target, data) {
  const tmp = `${target}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, target)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 원래 원인을 가리지 않는다 */ }
    throw e
  }
}

function writeRegistry(repoRoot, slots) {
  const file = registryPath(repoRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeFileAtomic(file, JSON.stringify({ slots }, null, 2) + '\n')
}

/**
 * 죽은 항목을 버리고 **가장 작은 빈 번호**를 준다. 순수 함수다 —
 * `isAlive` 를 인자로 받으므로 진짜 프로세스 없이도 회수 규칙을 검증할 수 있다.
 * (시각도 인자로 받는다. CLAUDE.md "시각은 항상 인자로 받는다")
 *
 * 가장 작은 빈 번호인 이유: 앱을 껐다 켜면 슬롯이 전부 비므로 첫 세션이 다시
 * `s1` 을 받는다. 번호를 계속 키우면 재시작마다 이름이 달라져 두고 간 claim 을
 * 반납할 수 없게 되고, 그것이 이 레지스트리를 만든 이유 자체를 무너뜨린다.
 */
export function allocate(slots, { sessionId, agentFor, pid, now, isAlive = alive }) {
  const live = {}
  for (const [k, v] of Object.entries(slots ?? {})) {
    const n = Number(k)
    // 번호가 아닌 키는 이 파일을 손으로 고친 흔적이다. 편의 기록이므로 버린다.
    if (!Number.isInteger(n) || n < 1) continue
    if (!v || typeof v !== 'object') continue
    if (!isAlive(v.pid)) continue
    live[String(n)] = v
  }
  let slot = 1
  while (live[String(slot)]) slot++
  live[String(slot)] = {
    pid,
    sessionId,
    since: new Date(now).toISOString(),
    /**
     * 확정된 이름을 함께 적는다. 번호만 적으면 이름을 읽는 쪽이 `base` 를 다시
     * 계산해야 하는데, 그 `base` 는 **그 프로세스의 환경**에서 나온다 —
     * 앱을 두 개 띄우면 두 인스턴스가 같은 슬롯에 대해 서로 다른 이름을 말하게
     * 되고, 그러면 I7 을 검사할 방법 자체가 없어진다.
     */
    agent: agentFor(slot),
  }
  return { slot, slots: live }
}

/** 레지스트리 한 장을 I7 검사기가 읽을 모양으로. */
function sessionsOf(slots) {
  return Object.entries(slots).map(([n, v]) => ({
    id: v?.sessionId ?? `slot-${n}`,
    agent: v?.agent ?? null,
    pid: v?.pid ?? null,
  }))
}

/**
 * 슬롯 하나를 잡고 이 세션의 `AXMAP_AGENT` 를 확정한다.
 *
 * 실패하면 던진다. 이름 없이 세션을 띄우면 자식이 서버의 이름을 그대로 물려받아
 * 세션들이 다시 한 사람이 되므로, **이름을 못 정하는 것은 세션을 못 만드는 것**이다.
 */
export function acquire(repoRoot, { sessionId, pid = process.pid, now = Date.now(), isAlive = alive } = {}) {
  const base = baseName(repoRoot)
  const { slot, slots } = allocate(readRegistry(repoRoot), {
    sessionId,
    agentFor: (n) => sessionAgentName(base, n),
    pid,
    now,
    isAlive,
  })

  /**
   * I7 을 잡은 자리에서 바로 확인한다 (docs/INVARIANTS.md).
   * 검사기는 모델 검증기·감사와 같은 `src/invariants.mjs` 를 쓴다 — 도구마다
   * 판정이 다르면 무엇이 맞는지 알 수 없게 된다.
   */
  const bad = sessionIdentityViolations(sessionsOf(slots))
  if (bad.length) {
    throw new Error(
      '세션 이름이 겹쳤습니다 (I7 위반). 이 상태로 띄우면 두 세션이 서로를 막지 못합니다.\n' +
        bad.map((v) => `  ${v.message}`).join('\n'),
    )
  }

  writeRegistry(repoRoot, slots)
  return { slot, agent: sessionAgentName(base, slot), base }
}

/**
 * 슬롯을 반납한다.
 *
 * 🔴 **내 pid 의 것만 지운다.** 앱이 두 개일 때, 내가 들고 있다고 믿는 번호를
 * 그 사이 다른 인스턴스가 (내 pid 가 죽은 줄 알고) 가져갔을 수 있다. 그것을
 * 지우면 살아있는 남의 슬롯을 비우는 것이고, 다음 세션이 같은 이름을 받는다.
 */
export function release(repoRoot, slot, { pid = process.pid } = {}) {
  const slots = readRegistry(repoRoot)
  const key = String(slot)
  const cur = slots[key]
  if (!cur || cur.pid !== pid) return false
  delete slots[key]
  writeRegistry(repoRoot, slots)
  return true
}
