/** Local sessions are attached by the provider's own hooks. Sending a message
 * must never silently create/resume a second model process. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { withRepoLock } from './repolock.mjs'
import { submitConsole, checkConsole, validateConsolePrompt, findConsoleTranscript, externalStatus } from './external-console.mjs'
import { errorCode, errorMessage, RPC_NOT_DELIVERED_EXIT } from './session-types.mjs'
import { commonKey, resolveTarget } from './workspace.mjs'
import type { HostLiveness } from './session-types.mjs'
import type { SessionRecord, PublicSession, RequestRecord, DispatchOptions, HookInput, TranscriptEntry } from './session-types.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bridgeHome = () => path.join(process.env.AXMAP_STATE_DIR || path.join(os.homedir(), '.axmap'), 'bridge')
const agyHome = () => process.env.AXMAP_AGY_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli')
const file = (kind: string, id: string) => {
  if (!UUID.test(id || '')) throw new Error('세션/요청 ID는 UUID여야 합니다.')
  return path.join(bridgeHome(), kind, `${id}.json`)
}
// Disk schemas are supplied by callers; invalid JSON still fails closed.
function readJSON<T = unknown>(p: string): T { return JSON.parse(fs.readFileSync(p, 'utf8')) as T }
function writeJSON(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  const tmp = `${p}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    // Windows readers/AV can briefly deny replacement. Keep atomic rename and
    // a bounded retry; never unlink the old record or retry a model submission.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, p); break }
      catch (e) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(errorCode(e) || '') || attempt >= 10) throw e
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
    }
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
}
function commonDirKey(cwd: string): string | null {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd, encoding: 'utf8', windowsHide: true,
  })
  return r.status === 0 ? commonKey(fs.realpathSync(r.stdout.trim())) : null
}
function repoKey(cwd: string): string {
  // Git 안이면 지금까지와 같은 한 번의 git 호출로 끝낸다. 실패했을 때만 작업 폴더
  // 규칙(수동 설정 → 자식 저장소 자동 탐색 → 모호하면 오류)으로 대상 저장소를 정한다.
  const direct = commonDirKey(cwd)
  if (direct) return direct
  const repo = resolveTarget(cwd)
  const key = repo && commonDirKey(repo)
  if (!key) throw new Error(`Git 작업 저장소를 확인하지 못했습니다: ${cwd}`)
  return key
}
function addressError(address: unknown): asserts address is string {
  // Only a loopback address exported by a local provider hook is accepted.
  if (typeof address !== 'string' || !/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/.test(address)) {
    throw new Error('공식 훅에서 받은 로컬 ANTIGRAVITY_LS_ADDRESS가 필요합니다.')
  }
  const port = Number(address.slice(address.lastIndexOf(':') + 1))
  if (port < 1 || port > 65535) throw new Error('연결 포트가 잘못되었습니다.')
}
function runAPI(session: SessionRecord, args: string[]): unknown {
  addressError(session.address)
  if (!session.executable) throw new Error('등록된 agy 실행 파일이 없습니다.')
  const r = spawnSync(session.executable, ['agentapi', ...args], {
    cwd: session.workspaces[0],
    env: { ...process.env, ANTIGRAVITY_LS_ADDRESS: session.address },
    encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
  })
  if (r.error || r.status !== 0) throw new Error(`열린 세션 연결 실패: ${r.error?.message || r.stderr?.trim() || r.stdout?.trim() || r.status}`)
  const text = r.stdout.trim()
  if (text) {
    let data: { error?: unknown }
    try { data = JSON.parse(text) } catch { return text }
    if (data?.error) throw new Error(`열린 세션 연결 실패: ${JSON.stringify(data.error)}`)
    return data
  }
  return null
}
function transcript(session: SessionRecord): TranscriptEntry[] {
  const expected = path.join(agyHome(), 'brain', session.conversationId || session.id, '.system_generated', 'logs', 'transcript.jsonl')
  if (session.transcript !== expected) throw new Error('등록된 대화 기록 경로가 올바르지 않습니다.')
  const lines = fs.readFileSync(expected, 'utf8').split('\n')
  // A trailing incomplete record may be in flight; malformed complete records fail.
  lines.pop()
  return lines.filter(s => s.trim()).map(s => JSON.parse(s) as TranscriptEntry)
}
function publicSession(s: SessionRecord, liveness?: HostLiveness): PublicSession {
  return { id: s.id, provider: s.provider, workspaces: s.workspaces, model: s.model,
    conversationId: s.conversationId,
    transport: s.transport || 'agentapi', state: s.state, pid: s.pid,
    registeredAt: s.registeredAt, event: s.event,
    // 호스트가 살아 있는지 확인하지 못했으면 저장된 "대기"를 대기로 보고하지 않는다.
    fullyIdle: liveness === 'unverified' ? false : s.fullyIdle,
    role: s.role, usage: s.usage, usageKnown: s.usageKnown, maxTokens: s.maxTokens, pendingApproval: s.pendingApproval,
    ...(liveness ? { liveness } : {}) }
}

/** 관리형 세션(pty·stdio)의 로컬 제어 파이프. 세션 호스트가 살아 있는 동안만 존재한다. */
export const hostPipe = (id: string) => process.platform === 'win32' ? `\\\\.\\pipe\\axmap-${id}` : path.join(bridgeHome(), `${id}.sock`)

/** Windows 의 열린 파이프 이름 목록. 읽지 못하면 오류 자체를 돌려준다 —
 * "목록에 없음"과 "목록을 못 읽음"을 같은 것으로 보면 산 세션을 닫힘으로 적는다. */
function openPipes(): Set<string> | Error {
  try { return new Set(fs.readdirSync('\\\\.\\pipe\\').map(n => n.toLowerCase())) }
  catch (e) { return e instanceof Error ? e : new Error(String(e)) }
}

/**
 * 저장된 상태가 아니라 호스트가 실제로 살아 있는지. 연결 요청은 보내지 않는다.
 *
 * `bridge serve` 가 강제 종료되면 종료 처리(state: closed)를 쓰지 못해 기록이
 * 영원히 `idle` 로 남는다 (실측: 세션 d3cde187, 파이프 없음). 파이프는 호스트가
 * listen 한 뒤에만 기록을 쓰므로, 파이프가 없다는 것은 호스트가 끝났다는 뜻이다.
 *   Windows : 파이프 이름 목록에 없으면 dead, 목록을 못 읽으면 unverified
 *   그 밖   : 소켓 파일이 없으면 dead. 있으면 기록된 호스트 pid 로 판단하고,
 *             pid 가 없으면(이전 버전 기록) unverified — 남은 소켓 파일만으로는 모른다.
 */
function hostLiveness(s: SessionRecord, pipes: () => Set<string> | Error): HostLiveness {
  if (process.platform === 'win32') {
    const listed = pipes()
    if (listed instanceof Error) return 'unverified'
    return listed.has(`axmap-${s.id}`.toLowerCase()) ? 'alive' : 'dead'
  }
  try { fs.statSync(hostPipe(s.id)) } catch (e) { return errorCode(e) === 'ENOENT' ? 'dead' : 'unverified' }
  if (!Number.isSafeInteger(s.hostPid) || (s.hostPid as number) <= 0) return 'unverified'
  try { process.kill(s.hostPid as number, 0); return 'alive' } catch (e) {
    return errorCode(e) === 'ESRCH' ? 'dead' : errorCode(e) === 'EPERM' ? 'alive' : 'unverified'
  }
}

function markClosed(target: string, s: SessionRecord): SessionRecord {
  // 호스트가 끝난 뒤 기록을 바꾸는 쪽은 여기뿐이지만, 막 종료 처리 중인 호스트가 더
  // 최신 기록(사용량 등)을 썼을 수 있어 다시 읽고 바꾼다.
  let latest = s
  try { latest = readJSON<SessionRecord>(target) } catch { /* 아래에서 읽은 기록으로 표시만 한다 */ }
  if (latest.state === 'closed') return latest
  const closed: SessionRecord = { ...latest, state: 'closed', fullyIdle: false,
    closedReason: '세션 호스트의 로컬 연결 파이프가 없습니다. 정상 종료 처리 없이 끝난 것으로 보입니다.' }
  // 저장에 실패해도 이번 조회에는 닫힘으로 보고한다. 다음 조회가 다시 시도한다.
  try { writeJSON(target, closed) } catch { /* 위와 같다 */ }
  return closed
}

export function sessions(cwd: string): PublicSession[] {
  const dir = path.join(bridgeHome(), 'sessions')
  if (!fs.existsSync(dir)) return []
  const repo = repoKey(cwd)
  let pipes: Set<string> | Error | undefined
  const listPipes = () => (pipes ??= openPipes())
  return fs.readdirSync(dir).filter(n => UUID.test(n.replace(/\.json$/, '')) && n.endsWith('.json'))
    .map(n => [path.join(dir, n), readJSON<SessionRecord>(path.join(dir, n))] as const)
    .filter(([, s]) => s.repos.includes(repo))
    .map(([target, s]) => {
      if (!['pty', 'stdio'].includes(s.transport || '') || s.state === 'closed') return publicSession(s)
      const liveness = hostLiveness(s, listPipes)
      return liveness === 'dead' ? publicSession(markClosed(target, s), 'dead') : publicSession(s, liveness)
    })
}
function sessionFor(id: string, cwd: string): SessionRecord {
  const s = readJSON<SessionRecord>(file('sessions', id))
  if (!s.repos.includes(repoKey(cwd))) throw new Error('이 세션은 현재 작업 저장소에 등록되지 않았습니다.')
  if (s.provider !== 'agy' && !['pty', 'stdio'].includes(s.transport || '')) throw new Error('아직 지원하지 않는 수신 세션입니다.')
  return s
}

/** Hook input and env come from Antigravity, not a remote message or repo file. */
export function registerHook(input: HookInput, event: string, env: NodeJS.ProcessEnv = process.env): PublicSession {
  if (!['SessionStart', 'PreInvocation', 'Stop'].includes(event)) throw new Error('지원하지 않는 훅 이벤트입니다.')
  addressError(env.ANTIGRAVITY_LS_ADDRESS)
  const id = input.conversationId || ''
  const target = file('sessions', id)
  const workspaces = input.workspacePaths
  if (!Array.isArray(workspaces) || !workspaces.length || workspaces.some(p => !path.isAbsolute(p))) {
    throw new Error('훅의 작업 저장소 경로가 없습니다.')
  }
  const executable = env.AXMAP_AGY_EXECUTABLE
  if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) throw new Error('등록된 agy 실행 파일이 없습니다.')
  const expected = path.join(agyHome(), 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
  if (path.resolve(input.transcriptPath || '') !== expected) throw new Error('Antigravity CLI 대화 기록 경로가 아닙니다.')
  const s: SessionRecord = { id, provider: 'agy', executable, address: env.ANTIGRAVITY_LS_ADDRESS,
    transcript: expected, workspaces, repos: [...new Set(workspaces.map(repoKey))], model: input.modelName || null,
    registeredAt: new Date().toISOString(), event, fullyIdle: event === 'Stop' && input.fullyIdle === true }
  writeJSON(target, s)
  return publicSession(s)
}

export function requestResult(id: string, cwd: string): RequestRecord {
  const target = file('requests', id)
  const request = readJSON<RequestRecord>(target)
  if (request.repo !== repoKey(cwd)) throw new Error('이 요청은 현재 작업 저장소의 요청이 아닙니다.')
  if (!['submitted', 'unknown'].includes(request.state)) return request
  let s = sessionFor(request.to, cwd)
  if (['pty', 'stdio'].includes(s.transport || '')) {
    try { Object.assign(request, terminalRPC(s.id, { action: 'result', id })) }
    catch (e) { request.state = 'unknown'; request.error = errorMessage(e) }
    writeJSON(target, request)
    return request
  }
  if (s.transport === 'console') {
    try { s.fullyIdle = externalStatus(s).state === 'idle' }
    catch (e) {
      request.state = 'unknown'; request.error = errorMessage(e)
      writeJSON(target, request)
      return request
    }
    s = findConsoleTranscript(s, request)
    if (!s.transcript) return request
  }
  const entries = transcript(s)
  const marker = `[axMap request ${id}]`
  const start = entries.findIndex((e, i) => i >= (request.baseline ?? 0) && e.type === 'USER_INPUT' && String(e.content).includes(marker))
  if (start < 0) return request
  const tail = entries.slice(start + 1)
  if (tail.some(e => e.type === 'USER_INPUT')) {
    request.state = 'superseded'
    request.error = '다른 사용자 입력이 이어져 이 요청의 완료를 확정할 수 없습니다.'
  } else if (s.transport === 'console' ? s.fullyIdle : s.event === 'Stop' && s.fullyIdle && s.registeredAt > request.createdAt) {
    const answer = tail.filter(e => e.source === 'MODEL' && e.type === 'PLANNER_RESPONSE' && e.status === 'DONE').at(-1)
    if (answer) {
      request.state = 'completed'
      request.result = answer.content
      request.completedAt = s.transport === 'console' ? new Date().toISOString() : s.registeredAt
    }
  }
  if (['completed', 'superseded'].includes(request.state)) writeJSON(target, request)
  return request
}

/** Wait locally, without spending model turns on repeated status tool calls. */
export async function waitForRequest(id: string, cwd: string, timeoutMs = 30000): Promise<RequestRecord> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) throw new Error('wait-ms는 0~30000 정수여야 합니다.')
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const result = requestResult(id, cwd)
    if (result.state !== 'submitted' || performance.now() >= deadline) return result
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - performance.now()))))
  }
}

export function sessionLeasePath(id: string): string {
  if (!UUID.test(id || '')) throw new Error('세션 ID는 UUID여야 합니다.')
  return path.join(bridgeHome(), 'dialogues', `session-${id}.lock`)
}

export function dispatchRequest({ to, prompt, cwd, from = 'axmap', dialogueId = null }: DispatchOptions): RequestRecord {
  // 보내기 시작 전에 난 오류(이전 요청 미확정, 대기 미확인 등)는 확실히 전달되지 않은 것이다.
  // 받은 편지함이 이를 "전달 불명"과 구별해야 쪽지를 다시 대기열로 돌릴 수 있다.
  let sending = false
  try {
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 32768) throw new Error('요청 본문은 1~32768바이트여야 합니다.')
  const s = sessionFor(to, cwd)
  const lease = sessionLeasePath(to)
  if (fs.existsSync(lease) && readJSON<{ dialogueId: string }>(lease).dialogueId !== dialogueId) throw new Error('이 세션은 자동 대화가 사용 중입니다. 해당 대화가 끝난 뒤 요청하세요.')
  const dir = path.join(bridgeHome(), 'requests')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return withRepoLock(path.join(dir, `${to}.lock`), () => {
    if (fs.existsSync(lease) && readJSON<{ dialogueId: string }>(lease).dialogueId !== dialogueId) throw new Error('이 세션은 자동 대화가 사용 중입니다.')
    for (const n of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
      const previous = readJSON<RequestRecord>(path.join(dir, n))
      if (previous.to !== to || !['sending', 'submitted', 'unknown'].includes(previous.state)) continue
      const latest = previous.state === 'sending' ? previous : requestResult(previous.id, cwd)
      if (['sending', 'submitted', 'unknown'].includes(latest.state)) throw new Error(`이 세션의 이전 요청이 아직 확정되지 않았습니다: ${latest.id}`)
    }
    // No fallback to `agy -p` or --conversation: both would start a separate process.
    let consolePreflight
    if (s.transport === 'console') { validateConsolePrompt(prompt, from); consolePreflight = checkConsole(s) }
    if (!['pty', 'stdio', 'console'].includes(s.transport || '')) {
      runAPI(s, ['get-conversation-metadata', to])
      if (!s.fullyIdle || s.event !== 'Stop') throw new Error('상대 세션의 대기 상태를 아직 확인하지 못했습니다. 작업 종료 훅을 기다리세요.')
    }
    const request: RequestRecord = { id: randomUUID(), to, from, repo: repoKey(cwd), prompt,
      createdAt: new Date().toISOString(), baseline: ['pty', 'stdio'].includes(s.transport || '') ? null : s.transcript ? transcript(s).length : 0, state: 'sending' }
    const target = file('requests', request.id)
    writeJSON(target, request)
    sending = true
    try {
      request.receipt = s.transport === 'console' ? submitConsole(s, request, consolePreflight) : ['pty', 'stdio'].includes(s.transport || '')
        ? terminalRPC(to, { action: 'submit', request })
        : runAPI(s, ['send-message', to, `[axMap request ${request.id}]\n요청자: ${from}\n${prompt}`])
      request.state = 'submitted'
    } catch (e) {
      if (notDelivered(e)) {
        // 로컬 파이프에 연결조차 못 했다(ENOENT·ECONNREFUSED). 한 바이트도 보내지
        // 않았으므로 확실히 전달되지 않았다. unknown 으로 두면 이 세션의 다음 요청이
        // 전부 막힌다. 자동 재전송은 여전히 하지 않는다.
        request.state = 'failed'
        request.error = `전달되지 않았습니다: ${errorMessage(e)}`
      } else {
        // A timeout may occur after delivery. Never retry automatically.
        request.state = 'unknown'
        request.error = errorMessage(e)
      }
    }
    writeJSON(target, request)
    return request
  })
  } catch (e) {
    if (!sending && e instanceof Error) Object.assign(e, { notDelivered: true })
    throw e
  }
}

/** 연결 전에 실패해 아무것도 보내지 않은 오류만 true. 문구가 아니라 종료 코드나 보내기 전 단계로 가른다. */
export const notDelivered =(e: unknown) => e instanceof Error && (e as Error & { notDelivered?: boolean }).notDelivered === true

function terminalRPC(id: string, message: unknown): unknown {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'run.mjs'), 'rpc', id], {
    input: JSON.stringify(message), encoding: 'utf8', windowsHide: true, timeout: 15000,
  })
  // 시간 초과(r.error)나 그 밖의 실패는 연결 뒤에 났을 수 있어 전달 여부를 모른다.
  if (!r.error && r.status === RPC_NOT_DELIVERED_EXIT) {
    throw Object.assign(new Error(r.stderr?.trim() || '로컬 세션 파이프에 연결하지 못했습니다.'), { notDelivered: true })
  }
  if (r.error || r.status !== 0) throw new Error(r.error?.message || r.stderr?.trim() || '터미널 세션에 연결하지 못했습니다.')
  return JSON.parse(r.stdout)
}

export { bridgeHome, repoKey, readJSON, writeJSON }

export function uninstallHooks(home = os.homedir()) {
  const target = path.join(home, '.gemini', 'config', 'hooks.json')
  if (!fs.existsSync(target)) return { removed: false }
  const config = readJSON<Record<string, unknown>>(target)
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('기존 hooks.json이 객체가 아닙니다. 변경하지 않았습니다.')
  if (!Object.hasOwn(config, 'axmap-bridge')) return { removed: false }
  delete config['axmap-bridge']
  writeJSON(target, config)
  // A running provider can retain the old hook command until exit. Make its
  // wrapper harmless immediately, without requiring another session restart.
  if (process.platform === 'win32') {
    for (const event of ['SessionStart', 'PreInvocation', 'Stop']) {
      const wrapper = path.join(home, '.axmap', 'bridge', `agy-${event}.cmd`)
      if (fs.existsSync(wrapper)) fs.writeFileSync(wrapper, '@echo off\r\necho {}\r\n')
    }
  }
  return { removed: true, hooks: target, note: '다른 훅은 유지합니다. 기존 CLI에 캐시된 훅은 정상 종료 시 해제됩니다.' }
}

export function installHooks({ executable, home = os.homedir() }: { executable: string; home?: string }) {
  if (!path.isAbsolute(executable || '') || !fs.existsSync(executable)) throw new Error('agy 실행 파일의 절대 경로가 필요합니다.')
  const target = path.join(home, '.gemini', 'config', 'hooks.json')
  const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
  const config = original === null ? {} : JSON.parse(original)
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('기존 hooks.json이 객체가 아닙니다. 변경하지 않았습니다.')
  const script = path.join(ROOT, 'tools', 'bridge.mjs')
  if ([process.execPath, script, executable].some(s => /["\r\n%&|<>^]/.test(s))) throw new Error('훅 명령 경로에 지원하지 않는 셸 문자가 있습니다.')
  const definition: Record<string, Array<{ type: string; command: string; timeout: number }>> = {}
  for (const event of ['SessionStart', 'PreInvocation', 'Stop']) {
    let command = `"${process.execPath}" "${script}" hook --event ${event} --executable "${executable}"`
    if (process.platform === 'win32') {
      // Antigravity's command runner escapes a quoted executable incorrectly on
      // Windows. A bare .cmd entry point matches its documented hook examples;
      // quotes inside the wrapper are interpreted by cmd, not its command parser.
      const wrapper = path.join(home, '.axmap', 'bridge', `agy-${event}.cmd`)
      if (/[\s"%&|<>^]/.test(wrapper)) throw new Error('Windows 훅 실행 경로에는 공백이나 셸 특수 문자가 없어야 합니다. 설정을 변경하지 않았습니다.')
      fs.mkdirSync(path.dirname(wrapper), { recursive: true })
      fs.writeFileSync(wrapper, `@echo off\r\n${command}\r\n`, { mode: 0o600 })
      command = wrapper
    }
    definition[event] = [{ type: 'command', command, timeout: 10 }]
  }
  config['axmap-bridge'] = definition
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const backup = `${target}.axmap-${randomUUID()}.bak`
  if (original !== null) fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 })
  writeJSON(target, config)
  return { hooks: target, backup: original === null ? null : backup,
    note: '기존 실행 중인 CLI가 새 훅을 읽지 않으면 같은 대화를 재개해 한 번 다시 열어야 합니다. Remote Control은 필요 없습니다.' }
}
