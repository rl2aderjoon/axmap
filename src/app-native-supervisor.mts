/** 로그인과 앱 재실행 뒤 기존 대화의 연결만 복구한다. 모델이나 앱은 시작하지 않는다. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { codexAppRPC, claudePeer, startNativeRelay } from './app-native.mjs'
import type { NativeRelayOptions } from './app-native.mjs'

export interface NativeProfile {
  id: string; codex: string; claude: string; codexConversation: string; claudeConversation: string
  repo: string; cwd: string; pipeHint?: string
  additionalSessions?: string[]
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const PIPE = /^codex-app-tools-[0-9a-f-]{36}$/i
export function validateProfile(p: NativeProfile): void {
  for (const key of ['id', 'codex', 'claude', 'codexConversation', 'claudeConversation'] as const) {
    if (!UUID.test(p[key] || '')) throw new Error(`자동 연결 설정의 ${key}는 UUID여야 합니다.`)
  }
  if (!path.isAbsolute(p.cwd) || !p.repo) throw new Error('자동 연결할 저장소의 절대 경로가 필요합니다.')
  if (p.additionalSessions !== undefined && (!Array.isArray(p.additionalSessions) || p.additionalSessions.some(id => !UUID.test(id)))) throw new Error('추가 연결할 기존 세션 UUID가 필요합니다.')
}
export function discoverCodexPipes(): string[] {
  if (process.platform !== 'win32') return []
  return fs.readdirSync('\\\\.\\pipe\\').filter(n => PIPE.test(n)).map(n => `\\\\.\\pipe\\${n}`)
}
export function chooseCodexPipe(pipes: string[], hint?: string): string | null {
  const candidates = [...new Set(pipes)]
  if (hint && candidates.includes(hint)) return hint
  if (candidates.length === 1) return candidates[0]!
  if (candidates.length > 1) throw new Error('Codex 앱 파이프가 여러 개여서 자동으로 선택하지 않았습니다.')
  return null
}
function statusWrite(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  try { fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, file) }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}
export async function probeCodex(pipe: string, p: NativeProfile, verifyThread: boolean) {
  const catalog = await codexAppRPC(pipe, 'tools/list', { threadStartKind: 'all' }, 3000)
  if (!catalog.tools?.some((t: { name: string }) => t.name === 'send_message_to_thread')) throw new Error('기존 대화 전달 도구가 없습니다.')
  if (!verifyThread) return
  const read = catalog.tools.find((t: { name: string }) => t.name === 'read_thread')
  if (!read) throw new Error('기존 Codex 대화를 확인할 도구가 없습니다.')
  const result = await codexAppRPC(pipe, 'tools/call', { namespace: read.namespace, tool: read.name,
    arguments: { threadId: p.codexConversation, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 },
    callerSource: 'codex', threadId: p.codexConversation, callId: `axmap-probe-${randomUUID()}`, turnId: `axmap-probe-${randomUUID()}` }, 5000)
  if (result.success !== true) throw new Error('저장된 Codex 대화를 확인하지 못했습니다.')
}
interface Relay { id: string; close: () => void }
interface SupervisorDeps {
  pipes?: () => string[]; claude?: (id: string) => unknown
  probe?: (pipe: string, profile: NativeProfile, verifyThread: boolean) => Promise<void>
  start?: (options: NativeRelayOptions) => Promise<Relay>
  intervalMs?: number; singletonPath?: string; statusPath?: string; logPath?: string
}
export async function startNativeSupervisor(profile: NativeProfile, deps: SupervisorDeps = {}) {
  validateProfile(profile)
  const base = path.join(process.env.AXMAP_STATE_DIR || path.join(os.homedir(), '.axmap'), 'bridge', 'native-autostart')
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const singleton = deps.singletonPath || (process.platform === 'win32' ? `\\\\.\\pipe\\axmap-native-supervisor-${profile.id}` : path.join(base, `${profile.id}.sock`))
  const server = net.createServer(s => s.destroy())
  const listening = await new Promise<boolean>((resolve, reject) => {
    server.once('error', e => (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? resolve(false) : reject(e))
    server.listen(singleton, () => resolve(true))
  })
  if (!listening) return { duplicate: true, close: () => {} }
  const status = deps.statusPath || path.join(base, `${profile.id}.status.json`)
  const log = deps.logPath || path.join(base, `${profile.id}.events.jsonl`)
  let relay: Relay | undefined, connectedPipe: string | undefined, lastState = '', busy = false, stopped = false
  const event = (value: unknown) => fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), value }) + '\n', { mode: 0o600 })
  const report = (state: string) => {
    statusWrite(status, { profile: profile.id, pid: process.pid, state, checkedAt: new Date().toISOString(),
      codex: profile.codex, claude: profile.claude, relay: relay?.id })
    if (state !== lastState) { event({ state }); lastState = state }
  }
  const detach = () => { relay?.close(); relay = undefined; connectedPipe = undefined }
  const tick = async () => {
    if (busy || stopped) return
    busy = true
    try {
      let pipe: string | null
      try { pipe = chooseCodexPipe((deps.pipes || discoverCodexPipes)(), connectedPipe || profile.pipeHint) }
      catch { detach(); report('ambiguous-codex'); return }
      if (!pipe) { detach(); report('waiting-codex'); return }
      try { (deps.claude || claudePeer)(profile.claudeConversation) }
      catch { detach(); report('waiting-claude'); return }
      try { await (deps.probe || probeCodex)(pipe, profile, !relay || pipe !== connectedPipe) }
      catch { detach(); report('waiting-codex'); return }
      if (stopped) return
      if (relay && pipe !== connectedPipe) detach()
      if (!relay) {
        try {
          relay = await (deps.start || startNativeRelay)({ codex: profile.codex, claude: profile.claude,
            repo: profile.repo, pipe, relayId: profile.id, additionalSessions: profile.additionalSessions, reconnect: true, onEvent: event })
          connectedPipe = pipe
        } catch { report('waiting-relay'); return }
      }
      report('connected')
    } finally { busy = false }
  }
  const timer = setInterval(() => { void tick().catch(() => report('retrying')) }, deps.intervalMs || 3000)
  await tick()
  return { duplicate: false, close: () => {
    stopped = true; clearInterval(timer); detach(); report('stopped'); server.close()
  } }
}

/** 레지스트리 값과 VBS 본문을 분리해 격리된 환경에서도 설치 결과를 검사한다. */
export function autoStartFiles(node: string, script: string, config: string, launcher: string) {
  for (const file of [node, script, config, launcher]) {
    if (!path.isAbsolute(file) || /["\r\n\0]/.test(file)) throw new Error('자동 시작 파일은 안전한 절대 경로여야 합니다.')
  }
  const command = [node, script, '--config', config].map(s => `"${s}"`).join(' ')
  const vbs = `CreateObject("WScript.Shell").Run "${command.replaceAll('"', '""')}", 0, False\r\n`
  return { vbs, runValue: `"${path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'wscript.exe')}" "${launcher}"` }
}
