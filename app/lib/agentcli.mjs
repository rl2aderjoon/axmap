/**
 * 어떤 AI CLI 가 이 PC 에 있고, 로그인돼 있는가.
 *
 * 🔴 왜 필요한가.
 *
 * 화면에서는 "새 대화" 지만 실제로는 **CLI 프로세스를 하나 띄우는 것**이다.
 * 그 CLI 에 로그인이 안 돼 있으면 프롬프트를 보낸 뒤에야 로그인 화면이 뜨는데,
 * 우리는 터미널을 감춰 놨으므로 사용자에게는 그냥 **아무 일도 안 일어난 것**으로
 * 보인다. 그래서 대화를 시작하기 전에 먼저 물어본다.
 *
 * 세 CLI 모두 같은 모양의 비대화형 모드를 갖고 있어서 한 겹으로 덮을 수 있다.
 *
 *   -p / --print                     한 번 묻고 끝낸다
 *   --output-format stream-json      JSONL 로 흘려준다 → 채팅 말풍선으로 다시 그린다
 *   --resume / --conversation <id>   앞 대화에 이어붙인다
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()
const hasHome = (rel) => { try { return fs.existsSync(path.join(HOME, rel)) } catch { return false } }

/**
 * 🔴 `claude` 는 세션 id 를 **받고**, `agy` 는 **주기만 한다.**
 *
 * 그래서 이어붙이는 방법이 둘로 갈린다.
 *   받는 쪽 — 우리가 uuid 를 만들어 첫 턴에 박고, 그 값으로 resume 한다
 *   주는 쪽 — 첫 턴 응답에서 id 를 주워 두었다가 다음 턴에 쓴다
 * 둘 다 `pickId()` 로 응답에서 id 를 줍는다. 받는 쪽도 주워 두면 우리가 만든
 * 값과 CLI 가 실제로 쓴 값이 어긋났을 때 CLI 쪽을 따라갈 수 있다.
 */
export const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    creds: ['.claude/.credentials.json', '.claude.json'],
    takesId: true,
    start: (id) => ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', id],
    resume: (cid) => ['-p', '--output-format', 'stream-json', '--verbose', '--resume', cid],
  },
  {
    id: 'agy',
    name: 'agy',
    bin: 'agy',
    /**
     * 🔴 여기에 `AppData/Local/agy` 를 넣었다가 뺐다.
     *
     * 그건 **실행 파일이 있는 자리**이지 자격증명이 아니다. 넣어 두면 설치만
     * 해도 "로그인됨" 으로 뜬다 — 확신 있게 틀린 답이고, 이 저장소가 가장
     * 싫어하는 종류의 실패다(D5). 모르면 `unknown` 이 맞는 답이다.
     */
    creds: ['.agy/auth.json', '.agy/credentials.json', '.config/agy/auth.json'],
    takesId: false,
    start: () => ['-p', '--output-format', 'stream-json'],
    resume: (cid) => ['-p', '--output-format', 'stream-json', '--conversation', cid],
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    creds: ['.codex/auth.json'],
    takesId: false,
    start: () => ['exec', '--json', '-'],
    resume: (cid) => ['exec', 'resume', cid, '--json', '-'],
    /**
     * 🔴 이 PC 에 codex 가 없어서 **실물로 확인하지 못했다.**
     * 확인 안 된 것을 확인된 것처럼 화면에 내보내지 않는다 — 화면이 이 표시를
     * 그대로 띄운다. 실제 codex 가 있는 PC 에서 한 번 돌려보고 이 줄을 지운다.
     */
    unverified: true,
  },
]

export const agentById = (id) => AGENTS.find((a) => a.id === id) ?? null

/**
 * 실행 파일의 실제 경로.
 *
 * 🔴 윈도우의 `spawn('claude', …)` 은 확장자 없는 이름을 못 찾는다.
 * `shell: true` 로 우회하면 프롬프트 안의 따옴표가 셸에 먹혀 **조용히 잘린다** —
 * 사용자가 쓴 말이 반쯤 사라진 채로 AI 에게 간다는 뜻이라 최악이다.
 * 그래서 경로를 먼저 풀어서 그 경로로 직접 띄운다. 프롬프트는 stdin 으로 준다.
 */
export function resolveBin(bin) {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const r = spawnSync(cmd, [bin], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) return null
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? null
  } catch { return null }
}

/**
 * 로그인 여부는 **모르면 모른다고 한다.**
 *
 * 자격증명이 있는 자리는 CLI 버전마다 바뀌고, macOS 는 키체인에 넣어서 파일이
 * 아예 없다. 없다고 단정하면 멀쩡한 CLI 를 못 쓰게 막고, 있다고 단정하면 첫
 * 프롬프트에서 로그인 화면이 떠 대화가 그냥 멈춘다. 둘 다 조용한 실패다.
 * 그래서 `yes` · `no` · `unknown` 셋으로 답하고, 화면이 그 셋을 다르게 그린다.
 *
 * 🔴 그러므로 `unknown` 을 "아마 되겠지" 로 접지 마라. 그 값이 화면에
 * "로그인 상태를 확인하지 못했습니다" 로 그대로 나가는 것이 설계다 —
 * 터미널을 감춰 놨기 때문에 침묵이 곧 미궁이 된다.
 */
function signedIn(a, installed) {
  if (!installed) return 'no'
  return a.creds.some(hasHome) ? 'yes' : 'unknown'
}

/** 이 PC 에서 쓸 수 있는 CLI 목록. 화면이 시작할 때 한 번 묻는다. */
export function detect() {
  return AGENTS.map((a) => {
    const bin = resolveBin(a.bin)
    return {
      id: a.id,
      name: a.name,
      installed: !!bin,
      path: bin,
      signedIn: signedIn(a, !!bin),
      unverified: !!a.unverified,
    }
  })
}

/** 설치돼 있는 것 중 첫 번째. 화면이 기본값으로 쓴다. */
export function preferred(found = detect()) {
  return found.find((a) => a.installed && a.signedIn !== 'no') ?? found.find((a) => a.installed) ?? null
}

/**
 * 이번 턴에 띄울 인자.
 * `cid` 가 있으면 이어붙이고, 없으면 새로 시작한다.
 */
export function argvFor(agent, { cid, newId }) {
  return cid ? agent.resume(cid) : agent.start(newId)
}

/**
 * 응답 이벤트에서 대화 id 를 줍는다.
 * CLI 마다 이름이 달라서 아는 이름을 전부 본다. 못 찾으면 null 이고,
 * 그러면 다음 턴은 **이어붙지 않고 새 대화가 된다** — 조용히 섞이는 것보다 낫다.
 */
export function pickId(ev) {
  if (!ev || typeof ev !== 'object') return null
  for (const k of ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id']) {
    if (typeof ev[k] === 'string' && ev[k]) return ev[k]
  }
  return null
}
