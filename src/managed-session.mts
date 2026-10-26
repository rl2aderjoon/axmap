/** Explicitly launched persistent CLI sessions. No transcript scraping, global
 * hook edits, per-message process spawning, or inference while the queue is idle. */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { bridgeHome, repoKey, writeJSON } from './bridge.mjs'
import { normalizeUsage, usageDelta } from './session-usage.mjs'
import { errorMessage } from './session-types.mjs'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Provider, SessionRecord, RequestState, LocalMessage, JobRecord } from './session-types.mjs'

interface ManagedSessionOptions {
  provider: Provider; executable?: string; prefix?: string[]; args?: string[] | null; model?: string; role?: string
  cwd?: string; maxTokens?: number; timeoutMs?: number; onEvent?: (event: Record<string, unknown>) => void
}
interface ProviderMessage {
  id?: string | number; method?: string; event?: string; conversation_id?: string
  error?: { message: string }; result?: unknown
  params?: {
    threadId?: string; tokenUsage?: { total: unknown }; item?: { type: string; text?: string }
    turn?: { id: string; status: string; error?: { message: string } }
    [key: string]: unknown
  }
}
interface AgyResult { conversation_id: string; status: string; response?: unknown; error?: string; usage?: unknown }

const pipeFor = (id: string) => process.platform === 'win32' ? `\\\\.\\pipe\\axmap-${id}` : path.join(bridgeHome(), `${id}.sock`)
const uuid = (value: string | undefined) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '')

export async function startManagedSession({ provider, executable = provider, prefix = [], args = null, model, role = '',
  cwd = process.cwd(), maxTokens = 100000, timeoutMs = 120000, onEvent = () => {} }: ManagedSessionOptions) {
  if (!['codex', 'agy'].includes(provider)) throw new Error('지원하는 세션은 codex 또는 agy입니다.')
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('양의 토큰/시간 한도가 필요합니다.')
  if (typeof role !== 'string' || role.length > 1000) throw new Error('역할은 1000자 이하여야 합니다.')
  const id = randomUUID(), token = randomBytes(32).toString('hex')
  const sessionPath = path.join(bridgeHome(), 'sessions', `${id}.json`)
  const s: SessionRecord = { id, token, provider, transport: 'stdio', role, model: model || null,
    workspaces: [path.resolve(cwd)], repos: [repoKey(cwd)], state: 'starting', fullyIdle: false,
    registeredAt: new Date().toISOString(), usage: null, usageKnown: true, maxTokens }
  const jobs = new Map<string, JobRecord>()
  const calls = new Map<string | number, { resolve: (result: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>()
  let child: ChildProcessWithoutNullStreams | undefined, sequence = 0, pending: JobRecord | null = null, closed = false, buffer = '', stderr = '', turnTimer: NodeJS.Timeout | undefined
  const save = () => { s.registeredAt = new Date().toISOString(); writeJSON(sessionPath, s) }
  const emit = (event: Record<string, unknown>) => onEvent({ session: id, ...event })
  const write = (message: unknown) => {
    if (closed || !child?.stdin.writable) throw new Error('세션 입력 연결이 종료됐습니다.')
    child.stdin.write(JSON.stringify(message) + '\n')
  }
  const rpc = <T = unknown,>(method: string, params: unknown): Promise<T> => new Promise((resolve, reject) => {
    const callId = ++sequence
    const timer = setTimeout(() => { calls.delete(callId); reject(new Error(`${method}: 응답 시간 초과`)) }, 15000)
    calls.set(callId, { resolve: value => resolve(value as T), reject, timer })
    try { write({ id: callId, method, params }) } catch (e) { clearTimeout(timer); calls.delete(callId); reject(e) }
  })
  const finish = (state: RequestState, result?: unknown, error?: string, rawUsage?: unknown) => {
    if (!pending) return
    clearTimeout(turnTimer)
    const usage = normalizeUsage(provider, rawUsage)
    Object.assign(pending, { state, result, error, usage: pending.baselineKnown ? usageDelta(usage, pending.baseline) : null,
      completedAt: new Date().toISOString(), conversationId: s.conversationId })
    delete pending.baseline
    delete pending.baselineKnown
    if (usage) s.usage = usage
    s.usageKnown = usage !== null
    emit({ event: 'result', request: { ...pending } })
    pending = null; s.state = 'idle'; s.fullyIdle = true; delete s.pendingApproval; save()
  }
  const shutdown = (reason: string) => {
    if (closed) return
    finish('unknown', undefined, reason)
    closed = true; clearTimeout(turnTimer)
    for (const c of calls.values()) { clearTimeout(c.timer); c.reject(new Error(reason)) }
    calls.clear()
    s.state = 'closed'; s.fullyIdle = false; save()
    child?.stdin.destroy(); child?.kill(); server.close()
  }
  const handle = (message: LocalMessage) => {
    const offered = Buffer.from(typeof message.token === 'string' ? message.token : '')
    const expected = Buffer.from(token)
    if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) throw new Error('로컬 세션 인증 실패')
    if (message.action === 'status') return { id, state: s.state, usage: s.usage, pendingApproval: s.pendingApproval }
    if (message.action === 'result') {
      const result = jobs.get(message.id)
      if (!result) throw new Error('이 세션에 해당 요청이 없습니다.')
      const { baseline, baselineKnown, ...publicResult } = result
      return publicResult
    }
    if (message.action === 'answer') {
      const approval = s.pendingApproval
      if (!approval || String(approval.id) !== String(message.id)) throw new Error('현재 대기 중인 승인 요청이 아닙니다.')
      if (!['accept', 'decline', 'cancel'].includes(message.decision)) throw new Error('이번 실행의 accept, decline 또는 cancel만 지원합니다.')
      write({ id: approval.id, result: { decision: message.decision } })
      delete s.pendingApproval; s.state = 'running'; save(); return { answered: true }
    }
    if (message.action !== 'submit') throw new Error('지원하지 않는 로컬 세션 요청입니다.')
    if (closed || s.state !== 'idle' || pending) throw new Error('세션이 대기 중이 아닙니다. 요청을 전달하지 않았습니다.')
    if (!s.usageKnown) throw new Error('직전 요청의 사용량을 확인하지 못했습니다. 새 연결에서 예산을 확인하세요.')
    if (s.usage && s.usage.totalTokens >= maxTokens) throw new Error('세션 토큰 한도에 도달했습니다.')
    const request = message.request
    if (!uuid(request?.id) || request.to !== id || typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 32768) throw new Error('요청 형식이 올바르지 않습니다.')
    pending = { id: request.id, to: id, state: 'submitted', baseline: s.usage, baselineKnown: s.usageKnown, result: '' }
    jobs.set(request.id, pending); s.state = 'running'; s.fullyIdle = false; save()
    const prompt = `[axMap request ${request.id}]\n요청자: ${request.from || 'axmap'}\n${role ? `역할: ${role}\n` : ''}${request.prompt}`
    turnTimer = setTimeout(() => shutdown('실행 시간 한도 초과. 완료 여부가 불명확하므로 자동 재시도하지 않습니다.'), timeoutMs)
    if (provider === 'agy') write({ event: 'user', message: { content: prompt } })
    else rpc<{ turn: { id: string } }>('turn/start', { threadId: s.conversationId, input: [{ type: 'text', text: prompt }], effort: 'low' })
      .then(r => { if (pending?.id === request.id) pending.turnId = r.turn.id })
      .catch(e => shutdown(e.message))
    return { accepted: true, session: id }
  }
  const server = net.createServer(socket => {
    socket.setEncoding('utf8')
    let input = '', handled = false
    socket.setTimeout(15000, () => socket.destroy()); socket.on('error', () => {})
    socket.on('data', chunk => {
      if (handled) return
      input += chunk
      if (Buffer.byteLength(input) > 65536) return socket.destroy()
      const end = input.indexOf('\n'); if (end < 0) return
      handled = true
      try { socket.end(JSON.stringify({ result: handle(JSON.parse(input.slice(0, end))) }) + '\n') }
      catch (e) { socket.end(JSON.stringify({ error: errorMessage(e) }) + '\n') }
    })
  })
  fs.mkdirSync(bridgeHome(), { recursive: true, mode: 0o700 })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipeFor(id), resolve) })
  if (process.platform !== 'win32') fs.chmodSync(pipeFor(id), 0o600)
  save()
  const cliArgs = args || (provider === 'codex' ? ['app-server', '--stdio']
    : ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--effort', 'low', ...(model ? ['--model', model] : [])])
  child = spawn(executable, [...prefix, ...cliArgs], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AXMAP_AGENT: `${provider}-${id.slice(0, 8)}`, AXMAP_SESSION: id } })
  child.stdin.on('error', e => shutdown(e.message))
  const exited = new Promise<{ code: number | null; signal?: NodeJS.Signals | null; error?: string }>(resolve => {
    child.once('error', e => { shutdown(e.message); resolve({ code: 1, error: e.message }) })
    child.once('exit', (code, signal) => { shutdown(`CLI가 종료됐습니다 (${code ?? signal}). ${stderr.slice(-1000)}`); resolve({ code, signal }) })
  })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8192) })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) return shutdown('CLI 응답 크기 제한 초과')
    while (buffer.includes('\n') && !closed) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      try {
        const m = JSON.parse(line) as ProviderMessage
        if (provider === 'agy') {
          if (m.event === 'init') { s.conversationId = m.conversation_id; s.state = 'idle'; s.fullyIdle = true; save(); emit({ event: 'ready', conversationId: s.conversationId }) }
          if (m.event === 'result' && pending) {
            const r = m.result as AgyResult
            if (r.conversation_id !== s.conversationId) throw new Error('agy 대화 ID가 바뀌었습니다.')
            finish(r.status === 'SUCCESS' ? 'completed' : 'failed', r.response, r.error, r.usage)
          }
          continue
        }
        if (m.id !== undefined && !m.method) {
          const call = calls.get(m.id)
          if (call) { clearTimeout(call.timer); calls.delete(m.id); m.error ? call.reject(new Error(m.error.message)) : call.resolve(m.result) }
          continue
        }
        if (m.id !== undefined && m.method) {
          if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(m.method)) {
            s.pendingApproval = { id: m.id, method: m.method, ...m.params }; s.state = 'awaiting_user'; save()
            emit({ event: 'awaiting_user', request: s.pendingApproval })
          } else { write({ id: m.id, error: { code: -32601, message: '이 연결에서 지원하지 않는 사용자 입력입니다. 대화형 CLI에서 처리하세요.' } }) }
          continue
        }
        if (m.params?.threadId !== s.conversationId) continue
        if (m.method === 'thread/tokenUsage/updated' && pending) pending.rawUsage = m.params?.tokenUsage?.total
        if (m.method === 'item/completed' && pending && m.params?.item?.type === 'agentMessage') pending.result = m.params.item.text
        if (m.method === 'turn/completed' && pending) {
          const r = m.params?.turn
          if (!r) throw new Error('Codex 실행 결과가 없습니다.')
          if (pending.turnId && pending.turnId !== r.id) throw new Error('Codex 실행 ID가 다릅니다.')
          finish(r.status === 'completed' ? 'completed' : 'failed', pending.result, r.error?.message, pending.rawUsage)
        }
      } catch (e) { shutdown(`CLI 프로토콜 오류: ${errorMessage(e)}`) }
    }
  })
  try {
    if (provider === 'codex') {
      await rpc('initialize', { clientInfo: { name: 'axmap', version: '1' } })
      write({ method: 'initialized' })
      const r = await rpc<{ thread: { id: string }; model?: string }>('thread/start', { cwd: path.resolve(cwd), ...(model ? { model } : {}),
        sandbox: 'read-only', approvalPolicy: 'on-request' })
      s.conversationId = r.thread.id; s.model = r.model || model || null; s.state = 'idle'; s.fullyIdle = true; save()
      emit({ event: 'ready', conversationId: s.conversationId })
    } else {
      const deadline = Date.now() + 30000
      while (s.state === 'starting' && !closed && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
      if (s.state !== 'idle') throw new Error(`agy 시작 실패: ${stderr.slice(-1000) || s.state}`)
    }
  } catch (e) { shutdown(errorMessage(e)); throw e }
  return { id, pid: child.pid, conversationId: s.conversationId, exited, close: () => shutdown('사용자가 관리형 연결을 종료했습니다.') }
}
