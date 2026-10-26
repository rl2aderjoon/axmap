/** Attach to an existing Windows console; never launch or resume a model. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bridgeHome, repoKey, readJSON, writeJSON } from './bridge.mjs'
import { nativeConsoleHelper } from './windows-console.mjs'
import type { SessionRecord, RequestRecord, ConsoleSnapshot, HookInput, TranscriptEntry } from './session-types.mjs'

const helper = fileURLToPath(new URL('../tools/windows-console.ps1', import.meta.url))
export function consoleCall(pid: number, action?: 'snapshot' | 'send', payload?: Record<string, unknown>): ConsoleSnapshot
export function consoleCall(pid: number, action: 'ancestor', payload?: Record<string, unknown>): ConsoleSnapshot | { ignored: true }
export function consoleCall(pid: number, action = 'snapshot', payload: Record<string, unknown> = {}): ConsoleSnapshot | { ignored: true } {
  if (process.platform !== 'win32') throw new Error('독립 agy 콘솔 연결은 현재 Windows에서 지원합니다.')
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('양의 정수 PID가 필요합니다.')
  const native = nativeConsoleHelper()
  const r = spawnSync(native || 'powershell.exe', native ? [String(pid), action] : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', helper, '-TargetPid', String(pid), '-Action', action], {
    input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024,
  })
  let data: (Omit<Partial<ConsoleSnapshot>, 'ignored'> & { error?: string; ignored?: boolean }) | undefined
  try { data = JSON.parse(r.stdout) } catch { /* report the underlying failure */ }
  if (r.error || r.status !== 0 || data?.error || !data) throw new Error(data?.error || r.error?.message || r.stderr?.trim() || '기존 콘솔 연결 실패')
  if (action === 'ancestor' && data.ignored) return { ignored: true }
  if (typeof data.pid !== 'number' || typeof data.startedAt !== 'string' || (action !== 'ancestor' && typeof data.screen !== 'string')) throw new Error('기존 콘솔 응답 형식이 올바르지 않습니다.')
  return data as ConsoleSnapshot
}
function identityID({ pid, startedAt }: Pick<ConsoleSnapshot, 'pid' | 'startedAt'>): string {
  const hex = createHash('sha256').update(`agy-console:${pid}:${startedAt}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
const target = (id: string) => path.join(bridgeHome(), 'sessions', `${id}.json`)
export function consoleIdle(screen: string): boolean {
  // Use the last input box only. Old answers may contain quoted prompt boxes.
  const borders = [...screen.matchAll(/^[─━]{10,}\r?$/gm)]
  if (borders.length < 2) return false
  const top = borders.at(-2), bottom = borders.at(-1)
  if (!top || !bottom) return false
  const input = screen.slice(top.index + top[0].length, bottom.index).trim()
  const footer = screen.slice(bottom.index + bottom[0].length)
  return input === '>' && /\? for shortcuts/.test(footer) && !/esc to cancel/i.test(footer)
}
export function attachConsole({ pid, cwd }: { pid: number; cwd: string }) {
  const live = consoleCall(pid)
  const id = identityID(live)
  const previous = fs.existsSync(target(id)) ? readJSON<Partial<SessionRecord>>(target(id)) : {}
  const repo = repoKey(cwd)
  if (previous.repos && !previous.repos.includes(repo)) throw new Error('이 프로세스는 다른 저장소에 등록되어 있습니다.')
  const idle = consoleIdle(live.screen)
  const s: SessionRecord = { ...previous, id, provider: 'agy', transport: 'console', pid, startedAt: live.startedAt,
    workspaces: previous.workspaces || [path.resolve(cwd)], repos: previous.repos || [repo],
    state: idle ? 'idle' : 'unknown', fullyIdle: idle, registeredAt: new Date().toISOString(), event: previous.event || 'attach' }
  writeJSON(target(id), s)
  return { id, provider: s.provider, transport: s.transport, pid, state: s.state, workspaces: s.workspaces }
}
export function registerExternalHook(input: HookInput, event: string) {
  if (!['SessionStart', 'PreInvocation', 'Stop'].includes(event)) throw new Error('지원하지 않는 훅 이벤트입니다.')
  const identity = consoleCall(process.pid, 'ancestor')
  if (identity.ignored) return {}
  const id = identityID(identity)
  const previous = fs.existsSync(target(id)) ? readJSON<Partial<SessionRecord>>(target(id)) : {}
  const workspaces = input.workspacePaths || previous.workspaces
  if (!Array.isArray(workspaces) || !workspaces.length || workspaces.some(p => !path.isAbsolute(p))) throw new Error('훅의 작업 저장소 경로가 없습니다.')
  const conversationId = input.conversationId
  if (typeof conversationId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(conversationId)) throw new Error('훅의 대화 UUID가 없습니다.')
  const transcript = path.join(process.env.AXMAP_AGY_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli'),
    'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl')
  if (path.resolve(input.transcriptPath || '') !== transcript) throw new Error('훅의 대화 기록 경로가 다릅니다.')
  const idle = event === 'Stop' && input.fullyIdle === true
  writeJSON(target(id), { ...previous, ...identity, id, provider: 'agy', transport: 'console', conversationId,
    transcript, workspaces, repos: [...new Set(workspaces.map(repoKey))], model: input.modelName || previous.model,
    event, state: idle ? 'idle' : 'running', fullyIdle: idle, registeredAt: new Date().toISOString() })
  return { id }
}
export function externalStatus(session: Pick<SessionRecord, 'id'>) {
  const s = readJSON<SessionRecord>(target(session.id))
  const live = consoleCall(consolePID(s), 'snapshot', { startedAt: s.startedAt })
  const state: 'idle' | 'unknown' = consoleIdle(live.screen) ? 'idle' : 'unknown'
  writeJSON(target(s.id), { ...readJSON<SessionRecord>(target(s.id)), state, fullyIdle: state === 'idle' })
  return { id: s.id, state }
}
function consolePID(s: SessionRecord): number {
  if (!s.pid || !s.startedAt) throw new Error('등록된 콘솔 프로세스 신원이 없습니다.')
  return s.pid
}
export function checkConsole(s: SessionRecord): ConsoleSnapshot {
  const live = consoleCall(consolePID(s), 'snapshot', { startedAt: s.startedAt })
  if (!consoleIdle(live.screen)) throw new Error('상대 콘솔이 빈 입력창에서 대기 중이지 않습니다. 입력을 보내지 않았습니다.')
  return live
}
export function validateConsolePrompt(prompt: string, from: string): void {
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(prompt.replace(/\r\n/g, '\n')) || /[\x00-\x1f\x7f]/.test(from)) throw new Error('콘솔 요청에는 제어 문자를 포함할 수 없습니다.')
}
export function findConsoleTranscript(s: SessionRecord, request: RequestRecord): SessionRecord {
  if (s.transcript) return s
  const brain = path.join(process.env.AXMAP_AGY_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli'), 'brain')
  if (!fs.existsSync(brain)) return s
  const marker = `[axMap request ${request.id}]`
  const matches = []
  for (const entry of fs.readdirSync(brain, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue
    const log = path.join(brain, entry.name, '.system_generated', 'logs', 'transcript.jsonl')
    let stat
    try { stat = fs.statSync(log) } catch { continue }
    if (stat.mtimeMs < Date.parse(request.createdAt) || stat.size > 32 * 1024 * 1024) continue
    const records = fs.readFileSync(log, 'utf8').split('\n').slice(0, -1)
    if (records.some(line => {
      try { const e = JSON.parse(line) as TranscriptEntry; return e.type === 'USER_INPUT' && String(e.content).includes(marker) }
      catch { return false }
    })) matches.push({ conversationId: entry.name, transcript: log })
  }
  if (matches.length !== 1) return s
  const updated = { ...readJSON<SessionRecord>(target(s.id)), ...matches[0] }
  writeJSON(target(s.id), updated)
  return updated
}
export function submitConsole(s: SessionRecord, request: RequestRecord, preflight?: ConsoleSnapshot) {
  validateConsolePrompt(request.prompt, request.from)
  const live = preflight || checkConsole(s)
  // Bracketed paste preserves multiline prompts and prevents embedded Enter keys
  // from becoming separate submissions. Only the final CR submits the message.
  const text = `\x1b[200~[axMap request ${request.id}]\n요청자: ${request.from}\n${request.prompt.replace(/\r\n/g, '\n')}\x1b[201~\r`
  consoleCall(consolePID(s), 'send', { startedAt: s.startedAt, expectedScreen: live.screen, text })
  writeJSON(target(s.id), { ...readJSON<SessionRecord>(target(s.id)), state: 'running', fullyIdle: false })
  return { accepted: true, pid: s.pid }
}
