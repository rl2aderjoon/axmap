/**
 * 대화 세션 — 겉은 채팅, 속은 CLI 프로세스.
 *
 * 🔴 세션을 **화면이 아니라 여기(서버)가** 들고 있다.
 *
 * 요구는 하나였다: "앱이 느려져도 터미널에서의 작업은 정상이었으면 좋겠다."
 * 그러려면 진행 중인 작업이 렌더러와 **아무 관계가 없어야** 한다.
 * 그래서 이렇게 갈랐다.
 *
 *   프로세스를 띄우고 출력을 모으는 일   서버 (이 파일)
 *   모인 것을 말풍선으로 그리는 일       화면
 *
 * 창을 닫아도, 그래프가 버벅여도, 렌더러가 죽어도 자식 프로세스는 계속 돈다.
 * 화면은 나중에 붙어서 `?since=` 로 밀린 것을 받아 가면 된다.
 *
 * 🔴 그리고 **감추는 것은 터미널이지 결과가 아니다.**
 *
 * 사용자에게 "지금 CLI 를 쓰고 있다" 는 사실은 숨겨도 되지만, AI 가 어떤 파일을
 * 고쳤는지는 숨기면 안 된다. 그것을 숨기는 순간 이 제품이 없애려던 공포
 * (D1 의 F2 — "AI 가 뭘 망가뜨렸는지 모른다")를 이 제품이 직접 만들어내는 셈이 된다.
 * 그래서 `touched` 를 따로 모아 화면이 반드시 띄우게 한다.
 *
 * 🔴 그리고 **세션마다 다른 사람이어야 한다.**
 *
 * 이 앱의 목적이 "여러 AI CLI 세션을 동시에 굴리는 것" 인데, 오랫동안 `spawn` 에
 * `env` 옵션이 없어서 자식이 서버의 환경을 통째로 물려받았다. 그러면 세션이
 * 몇 개든 전부 같은 `AXMAP_AGENT` 이고, `checkOverlap` 은 자기 claim 을 겹침으로
 * 보지 않으므로 **서로를 하나도 못 막는다.** 이름을 정하는 규칙과 그 근거는
 * `app/lib/slots.mjs` 머리말에 있다.
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { agentById, argvFor, pickId, resolveBin } from './agentcli.mjs'
import * as slots from './slots.mjs'

/**
 * 한 세션이 들고 있을 최대 메시지 수.
 * 넘으면 오래된 것부터 버리되 **버렸다고 말한다** — 조용히 사라지면
 * 사용자는 대화가 원래 그랬던 줄 안다.
 */
const MAX_MESSAGES = 2000

/** 파일을 실제로 바꾸는 도구들. 이 이름이 보이면 `touched` 에 올린다. */
const EDITORS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'edit_file'])

/**
 * 대화가 아닌 이벤트들. 화면은 접어 두지만 기록은 남긴다.
 * 실측에서 나온 것부터 넣었다 — 모르는 것은 여기 넣지 말고 `raw` 로 흘려보낸다.
 */
const NOT_CONVERSATION = new Set([
  'system', 'rate_limit_event', 'stream_event', 'control_response', 'control_request',
])

const sessions = new Map()

// ── 만들기 · 조회 ───────────────────────────────────────────────────────────

export function create({ agent = 'claude', cwd = process.cwd(), title = '' } = {}) {
  const spec = agentById(agent)
  if (!spec) throw new Error(`모르는 에이전트: ${agent}`)
  if (!resolveBin(spec.bin)) throw new Error(`${spec.name} 이(가) 이 PC 에 없습니다`)

  const id = randomUUID()
  /**
   * 🔴 이름을 못 정하면 세션을 만들지 않는다.
   *
   * 이름 없이 띄우면 자식이 서버의 `AXMAP_AGENT` 를 그대로 물려받아 세션들이
   * 다시 한 사람이 된다 — 이 파일 머리말의 그 버그다. 못 막는 것보다 못 띄우는
   * 것이 낫다(fail-closed). 이유는 메시지에 그대로 실어 보낸다.
   */
  let seat
  try {
    seat = slots.acquire(cwd, { sessionId: id })
  } catch (e) {
    throw new Error(`세션 이름을 정하지 못해 시작하지 않았습니다: ${e.message}`)
  }

  const s = {
    id,
    agent,
    agentName: spec.name,
    /** 이 세션이 장부에서 누구인가. 자식에게 `AXMAP_AGENT` 로 넘어간다 */
    axmapAgent: seat.agent,
    slot: seat.slot,
    cwd,
    title: title || '새 대화',
    /** CLI 쪽 대화 id. 이게 있어야 다음 턴이 앞 대화에 이어붙는다. */
    cid: null,
    state: 'idle',
    error: null,
    seq: 0,
    messages: [],
    /** path -> {tool, n} — AI 가 건드린 파일. 반드시 화면에 보인다 */
    touched: new Map(),
    dropped: 0,
    startedAt: Date.now(),
    proc: null,
  }
  sessions.set(s.id, s)
  return view(s)
}

/**
 * 자식에게 줄 환경.
 *
 * 🔴 `env` 를 주지 않으면 자식은 서버의 환경을 **통째로** 물려받는다. 그래서
 * 여기가 이 파일에서 가장 중요한 세 줄이다 — 이 한 줄이 빠져 있는 동안 앱에서
 * 띄운 세션은 몇 개든 장부에서 한 사람이었다.
 *
 * `process.env` 를 먼저 펼치는 이유: CLI 는 PATH·HOME·자격증명 경로·프록시
 * 설정을 전부 환경에서 읽는다. 필요한 것만 골라 넘기면 어느 CLI 가 무엇을 읽는지
 * 우리가 다 아는 척하는 것이고, 빠뜨리면 "왜 로그인이 안 되지" 로 돌아온다.
 */
export function childEnv(s, base = process.env) {
  return { ...base, AXMAP_AGENT: s.axmapAgent }
}

export const get = (id) => sessions.get(id) ?? null

/** 목록. 사이드바가 이걸 그린다 — 이 목록이 곧 "지금 살아 있는 터미널들" 이다. */
export function list() {
  return [...sessions.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((s) => ({
      id: s.id,
      title: s.title,
      agent: s.agent,
      agentName: s.agentName,
      // 사이드바가 "이 대화는 장부에서 누구인가" 를 그릴 수 있어야 한다.
      // 이름을 사람이 읽는 것이 이 제품의 목적이라 UUID 대신 슬롯 번호를 쓴다.
      axmapAgent: s.axmapAgent,
      cwd: s.cwd,
      state: s.state,
      messages: s.messages.length,
      touched: s.touched.size,
      startedAt: s.startedAt,
    }))
}

/** 화면에 주는 모양. `since` 뒤의 메시지만 준다 — 매번 전부 보내면 앱이 느려진다. */
export function view(s, since = -1) {
  return {
    id: s.id,
    title: s.title,
    agent: s.agent,
    agentName: s.agentName,
    axmapAgent: s.axmapAgent,
    cwd: s.cwd,
    state: s.state,
    error: s.error,
    seq: s.seq,
    dropped: s.dropped,
    messages: s.messages.filter((m) => m.seq > since),
    touched: [...s.touched.entries()].map(([file, v]) => ({ file, ...v })),
  }
}

export function remove(id) {
  const s = sessions.get(id)
  if (!s) return false
  stop(id)
  sessions.delete(id)
  // 슬롯을 즉시 돌려준다. 안 돌려주면 다음 세션이 `s3`, `s4` 로 번호만 커지고,
  // 그러면 앱을 껐다 켤 때 이름이 달라져 두고 간 claim 을 반납할 수 없다.
  releaseSeat(s)
  return true
}

/** 슬롯 반납은 실패해도 세션 정리를 막지 않는다 — 죽은 pid 는 다음 acquire 가 걷어낸다. */
function releaseSeat(s) {
  try { slots.release(s.cwd, s.slot) } catch { /* 편의 기록이다. 여기서 죽을 이유가 없다 */ }
}

/** 진행 중인 턴을 끊는다. 세션 자체는 남는다 — 이어서 다시 물을 수 있다. */
export function stop(id) {
  const s = sessions.get(id)
  if (!s?.proc) return false
  try { s.proc.kill() } catch { /* 이미 죽었으면 그만 */ }
  s.proc = null
  s.state = 'idle'
  push(s, { role: 'note', text: '중단했습니다.' })
  return true
}

// ── 메시지 ──────────────────────────────────────────────────────────────────

function push(s, m) {
  s.messages.push({ seq: ++s.seq, at: Date.now(), ...m })
  if (s.messages.length > MAX_MESSAGES) {
    const cut = s.messages.length - MAX_MESSAGES
    s.messages.splice(0, cut)
    s.dropped += cut
  }
}

// ── 한 턴 보내기 ────────────────────────────────────────────────────────────

/**
 * 프롬프트 하나를 보내고, 응답을 말풍선으로 쌓는다.
 *
 * 🔴 프롬프트를 **stdin 으로** 준다. 인자로 넘기면 따옴표·개행·백틱이 셸이나
 * 인자 파서에 먹혀 **조용히 잘린다.** 사용자가 쓴 말이 반쯤 사라진 채 AI 에게
 * 가는 것이라 최악의 실패다. stdin 은 그런 해석을 아예 안 거친다.
 *
 * 반환은 즉시 한다. 기다리지 않는다 — 화면이 뒤에서 `?since=` 로 받아 간다.
 */
export function send(id, prompt) {
  const s = sessions.get(id)
  if (!s) throw new Error('없는 세션입니다')
  if (s.state === 'running') throw new Error('아직 앞의 답을 기다리는 중입니다')

  const spec = agentById(s.agent)
  const bin = resolveBin(spec.bin)
  if (!bin) throw new Error(`${spec.name} 이(가) 이 PC 에 없습니다`)

  push(s, { role: 'user', text: prompt })
  if (s.title === '새 대화') s.title = prompt.slice(0, 40).replace(/\s+/g, ' ').trim()

  // 이 CLI 가 세션 id 를 받는 쪽이면 우리가 만들어 박는다 (agentcli.mjs 참고).
  const newId = spec.takesId ? randomUUID() : null
  const argv = argvFor(spec, { cid: s.cid, newId })

  s.state = 'running'
  s.error = null

  const proc = spawn(bin, argv, {
    cwd: s.cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    // 🔴 이 줄이 없으면 세션이 몇 개든 전부 같은 사람이 된다. childEnv 머리말 참고.
    env: childEnv(s),
  })
  s.proc = proc
  if (spec.takesId && !s.cid) s.cid = newId

  let out = ''
  let err = ''

  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk) => {
    out += chunk
    // JSONL 이다. 마지막 조각은 아직 안 끝났을 수 있으니 남겨 둔다.
    const lines = out.split('\n')
    out = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) feed(s, line.trim())
  })

  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk) => { err += chunk })

  proc.on('error', (e) => {
    s.state = 'error'
    s.error = e.message
    s.proc = null
    push(s, { role: 'error', text: `실행하지 못했습니다: ${e.message}` })
  })

  proc.on('close', (code) => {
    if (out.trim()) feed(s, out.trim())
    s.proc = null
    if (code === 0) {
      s.state = 'idle'
      return
    }
    s.state = 'error'
    /**
     * 🔴 여기가 로그인 안 된 경우가 튀어나오는 자리다.
     * 터미널을 감춰 놨으므로 그냥 두면 사용자에게는 **아무 일도 안 일어난 것**으로
     * 보인다. stderr 를 그대로 올려서 최소한 무엇 때문인지는 보이게 한다.
     */
    s.error = err.trim() || `종료 코드 ${code}`
    push(s, { role: 'error', text: s.error })
  })

  try {
    proc.stdin.end(prompt, 'utf8')
  } catch (e) {
    s.state = 'error'
    push(s, { role: 'error', text: `프롬프트를 넘기지 못했습니다: ${e.message}` })
  }

  return view(s, s.seq - 1)
}

// ── stream-json 읽기 ────────────────────────────────────────────────────────

/**
 * CLI 가 흘려주는 JSONL 한 줄을 말풍선으로 바꾼다.
 *
 * 🔴 못 읽은 줄을 **버리지 않는다.** 버리면 화면은 조용히 불완전한 대화를
 * 보여주고 사용자는 그게 전부인 줄 안다. 모양이 낯설면 낯선 채로 올린다.
 * (`애매하면 거부한다` 와 같은 이유 — CLAUDE.md)
 */
function feed(s, line) {
  let ev
  try { ev = JSON.parse(line) } catch {
    push(s, { role: 'raw', text: line })
    return
  }

  const cid = pickId(ev)
  if (cid) s.cid = cid

  /**
   * 계측·제어 이벤트는 대화가 아니다.
   *
   * 🔴 그래도 **버리지는 않는다.** `meta` 로 올려서 화면이 접어 두게 한다.
   * 실측에서 `rate_limit_event` 와 MCP 경고가 말풍선 사이에 그대로 끼어들었다 —
   * 사용자에게는 AI 가 헛소리를 한 것처럼 보인다. 그렇다고 조용히 지우면
   * 사용량 한도에 걸려 멈춘 것인지 알 방법이 없어진다. 접어 두는 것이 답이다.
   */
  if (NOT_CONVERSATION.has(ev.type)) { push(s, { role: 'meta', text: line }); return }

  const content = ev.message?.content ?? ev.content
  if (Array.isArray(content)) {
    for (const b of content) block(s, b)
    return
  }

  if (ev.type === 'result') {
    // 최종 답. 앞서 assistant 블록으로 이미 올라온 것과 같은 내용이면 중복이므로 건너뛴다.
    const last = s.messages[s.messages.length - 1]
    const text = typeof ev.result === 'string' ? ev.result : null
    if (text && last?.role === 'assistant' && last.text.trim() === text.trim()) return
    if (text) push(s, { role: 'assistant', text })
    if (ev.is_error) push(s, { role: 'error', text: '에이전트가 오류로 끝났습니다.' })
    return
  }

  if (typeof ev.text === 'string') { push(s, { role: 'assistant', text: ev.text }); return }

  push(s, { role: 'raw', text: line })
}

function block(s, b) {
  if (!b || typeof b !== 'object') return

  if (b.type === 'text' && b.text) { push(s, { role: 'assistant', text: b.text }); return }

  if (b.type === 'tool_use') {
    const file = b.input?.file_path ?? b.input?.path ?? null
    const edits = EDITORS.has(b.name)

    if (edits && file) {
      const prev = s.touched.get(file)
      s.touched.set(file, { tool: b.name, n: (prev?.n ?? 0) + 1 })
    }

    push(s, {
      role: 'tool',
      tool: b.name,
      file,
      /** 파일을 실제로 바꾼 도구인가. 화면이 이걸로 강조 여부를 정한다 */
      edits,
      text: summarize(b),
    })
    return
  }

  // tool_result 는 대개 길고 사람이 읽을 것이 아니다. 오류일 때만 올린다.
  if (b.type === 'tool_result' && b.is_error) {
    push(s, { role: 'error', text: String(b.content ?? '도구가 실패했습니다').slice(0, 500) })
  }
}

/** 도구 한 번을 한 줄로. 사람이 읽을 수 있는 만큼만. */
function summarize(b) {
  const i = b.input ?? {}
  if (i.file_path || i.path) return String(i.file_path ?? i.path)
  if (i.command) return String(i.command).slice(0, 200)
  if (i.pattern) return String(i.pattern).slice(0, 200)
  if (i.query) return String(i.query).slice(0, 200)
  if (i.prompt) return String(i.prompt).slice(0, 200)
  return ''
}

/** 서버가 내려갈 때 자식들을 남기지 않는다. */
export function shutdown() {
  for (const s of sessions.values()) {
    try { s.proc?.kill() } catch { /* 그만 */ }
    /**
     * 슬롯도 함께 비운다. 여기서 못 비워도(강제 종료·정전) 다음 실행이 죽은
     * pid 를 보고 회수하므로 영구히 새지는 않는다 — 그것이 pid 를 적어둔 이유다.
     * 그래도 정상 종료에서는 비워둔다. 그래야 다음에 켰을 때 s1 부터 다시 준다.
     */
    releaseSeat(s)
  }
}
