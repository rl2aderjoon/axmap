/**
 * axmap MCP 가 **어디에 등록돼 있는가** 를 읽기만 하는 자리.
 *
 * 왜 따로 있나 — `tools/mcp-register.mjs` 는 맨 아래에서 `process.exit(main())` 를
 * 부른다. 그래서 그 파일을 import 하면 **등록이 실제로 실행되고 프로세스가 죽는다.**
 * 판정만 필요한 쪽(`doctor`)이 그것을 부를 수 없다. 그렇다고 doctor 안에 같은 판정을
 * 한 벌 더 쓰면 두 곳이 서로 다르게 굴게 된다 — 등록기는 넣었다는데 doctor 는
 * 없다고 하는 상태가 정확히 이 파일이 생긴 이유다.
 *
 * 여기에는 **쓰는 코드를 두지 않는다.** 무엇을 어디에 쓸지는 등록기가 정한다.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * `~/.claude.json` 의 user 범위 axmap 항목.
 *
 * 없으면 `null`, **못 읽으면 `undefined`** 다. 이 둘을 가르는 것이 중요하다 —
 * 파일이 아예 없는 것은 "등록 안 됨" 이고, 있는데 못 읽는 것은 "사고" 다.
 * 사고를 "등록 안 됨" 으로 뭉개면 남의 설정을 덮어쓰자는 판단이 나온다.
 */
export function claudeUserEntry() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'))
    return (cfg && cfg.mcpServers && cfg.mcpServers.axmap) || null
  } catch (e) {
    return e && e.code === 'ENOENT' ? null : undefined
  }
}

/** `~/.gemini/config/mcp_config.json` 의 axmap 항목. 규칙은 위와 같다. */
export function agyUserEntry() {
  try {
    const f = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json')
    const raw = fs.readFileSync(f, 'utf8')
    // agy 는 설치할 때 0바이트 파일을 만들어 둔다. 빈 파일은 사고가 아니라 "아직 없음" 이다.
    if (!raw.trim()) return null
    const cfg = JSON.parse(raw)
    return (cfg && cfg.mcpServers && cfg.mcpServers.axmap) || null
  } catch (e) {
    return e && e.code === 'ENOENT' ? null : undefined
  }
}

/**
 * `~/.codex/config.toml` 안에 axmap 서버가 있는가.
 *
 * 🔴 **이것은 글자 수준의 짐작이다.** 이 저장소에는 codex 로 실제 등록한 결과물이
 * 없어서(`tools/mcp-register.mjs` 의 codex 절 주석 참고) TOML 을 제대로 파싱해서
 * 판정할 근거가 없다. 그래서 `[mcp_servers.axmap]` 머리표만 찾는다.
 *
 * 확실하지 않은 것을 확실한 척 말하지 않으려고 **반환값에 그 사실을 실어 보낸다** —
 * 부르는 쪽이 "짐작" 이라고 사람에게 말할 수 있게. 실물로 확인되면 이 함수만 고친다.
 */
export function codexUserEntry() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8')
    return /^\s*\[mcp_servers\.axmap\]/m.test(raw) ? { guessed: true } : null
  } catch (e) {
    return e && e.code === 'ENOENT' ? null : undefined
  }
}

/**
 * 홈에 등록된 것을 한 번에 모은다.
 *
 * `found` 는 등록이 확인된 도구 이름, `unreadable` 은 설정이 있는데 못 읽은 도구다.
 * 못 읽은 것을 "없음" 쪽에 넣지 않는다 — 그러면 이미 붙어 있는 사람에게
 * "안 붙었습니다" 라고 말하게 되고, 그게 지금 고치는 바로 그 버그다.
 */
export function homeRegistrations() {
  const probes = [
    ['claude', claudeUserEntry],
    ['agy', agyUserEntry],
    ['codex', codexUserEntry],
  ]
  const found = []
  const unreadable = []
  const guessed = []
  for (const [id, probe] of probes) {
    const e = probe()
    if (e === undefined) { unreadable.push(id); continue }
    if (!e) continue
    found.push(id)
    if (e.guessed) guessed.push(id)
  }
  return { found, unreadable, guessed }
}
