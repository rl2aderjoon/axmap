/** Explicitly launched persistent CLI sessions. No transcript scraping, global
 * hook edits, per-message process spawning, or inference while the queue is idle. */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { bridgeHome, hostPipe, repoKey, writeJSON } from './bridge.mjs'
import { normalizeUsage, usageDelta } from './session-usage.mjs'
import { errorMessage } from './session-types.mjs'
import { connectCodexProxy } from './codex-connection.mjs'
import type { ProviderProcess } from './codex-connection.mjs'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Provider, SessionRecord, RequestState, LocalMessage, JobRecord, LocalRequest } from './session-types.mjs'
import type { Usage } from './session-types.mjs'

interface ManagedSessionOptions {
  provider: Provider; executable?: string; prefix?: string[]; args?: string[] | null; model?: string; role?: string
  cwd?: string; maxTokens?: number; timeoutMs?: number; onEvent?: (event: Record<string, unknown>) => void
  existingThreadId?: string; socketPath?: string
  observeActive?: boolean
  permissionMode?: string
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
interface ClaudeMessage { type?: string; subtype?: string; session_id?: string; result?: unknown; is_error?: boolean
  usage?: { output_tokens_details?: { thinking_tokens?: number }; [key: string]: unknown } }
const CLAUDE_USAGE_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens', 'thinking_tokens'] as const

// 생존 확인(bridge.sessions)이 같은 이름을 보도록 한 곳에서 만든다.
const pipeFor = hostPipe
const uuid = (value: string | undefined) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '')

export async function startManagedSession({ provider, executable = provider, prefix = [], args = null, model, role = '', existingThreadId, socketPath, observeActive = false,
  permissionMode = 'default', cwd = process.cwd(), maxTokens = 100000, timeoutMs = 120000, onEvent = () => {} }: ManagedSessionOptions) {
  if (!['codex', 'agy', 'claude'].includes(provider)) throw new Error('지원하는 세션은 codex, agy 또는 claude입니다.')
  // 읽기 전용이 기본이다(Codex 의 sandbox read-only 와 같은 자리). 고쳐도 되는 세션은 사람이 serve 할 때 고른다.
  if (!['default', 'plan', 'acceptEdits'].includes(permissionMode)) throw new Error('claude 권한은 default, plan 또는 acceptEdits입니다.')
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('양의 토큰/시간 한도가 필요합니다.')
  if (typeof role !== 'string' || role.length > 1000) throw new Error('역할은 1000자 이하여야 합니다.')
  if (existingThreadId && (provider !== 'codex' || !uuid(existingThreadId) || !socketPath || model || args)) throw new Error('기존 Codex thread와 로컬 socket이 필요하며 모델·실행 인수를 바꾸지 않습니다.')
  const id = randomUUID(), token = randomBytes(32).toString('hex')
  const sessionPath = path.join(bridgeHome(), 'sessions', `${id}.json`)
  const s: SessionRecord = { id, token, provider, transport: 'stdio', role, model: model || null,
    workspaces: [path.resolve(cwd)], repos: [repoKey(cwd)], state: 'starting', fullyIdle: false, hostPid: process.pid,
    registeredAt: new Date().toISOString(), usage: null, usageKnown: true, maxTokens }
  const jobs = new Map<string, JobRecord>()
  const queue: LocalRequest[] = []
  const persistJob = (job: JobRecord) => writeJSON(path.join(bridgeHome(), 'jobs', `${job.id}.json`), job)
  let draining = false
  const drain = () => {
    if (closed || draining || pending || s.state !== 'idle' || !queue.length) return
    draining = true
    const request = queue.shift()!
    jobs.delete(request.id)
    void handle({ action: 'submit', token, request }).catch(e => {
      const job: JobRecord = { id: request.id, to: id, state: 'failed', error: errorMessage(e), completedAt: new Date().toISOString() }
      jobs.set(request.id, job); persistJob(job); emit({ event: 'result', request: job })
    }).finally(() => { draining = false; if (!pending) setImmediate(drain) })
  }
  let attachedUsageOrigin: Usage | null = null
  // Claude Code 는 실행마다 그 실행분만 준다. 다른 provider 처럼 누적값으로 다루려고 여기서 더한다.
  let claudeTotals: Record<string, number> | null = null
  let initialThreadState = 'idle'
  const calls = new Map<string | number, { resolve: (result: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>()
  let child: ProviderProcess | undefined, sequence = 0, pending: JobRecord | null = null, closed = false, buffer = '', stderr = '', turnTimer: NodeJS.Timeout | undefined
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
    if (usage) { s.usage = usage; if (existingThreadId && !attachedUsageOrigin) attachedUsageOrigin = usage }
    s.usageKnown = usage !== null
    persistJob(pending)
    emit({ event: 'result', request: { ...pending } })
    pending = null; s.state = 'idle'; s.fullyIdle = true; delete s.pendingApproval; save(); setImmediate(drain)
  }
  const shutdown = (reason: string) => {
    if (closed) return
    finish('unknown', undefined, reason)
    closed = true; clearTimeout(turnTimer)
    for (const request of queue.splice(0)) {
      const job: JobRecord = { id: request.id, to: id, state: 'failed', error: reason, completedAt: new Date().toISOString() }
      jobs.set(request.id, job); persistJob(job)
    }
    for (const c of calls.values()) { clearTimeout(c.timer); c.reject(new Error(reason)) }
    calls.clear()
    s.state = 'closed'; s.fullyIdle = false; save()
    child?.stdin.destroy(); child?.kill(); server.close()
  }
  let checkingSubmission = false
  const handle = async (message: LocalMessage) => {
    const offered = Buffer.from(typeof message.token === 'string' ? message.token : '')
    const expected = Buffer.from(token)
    if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) throw new Error('로컬 세션 인증 실패')
    if (message.action === 'notice') {
      if (!existingThreadId || provider !== 'codex' || typeof message.text !== 'string' || !message.text.trim() || Buffer.byteLength(message.text) > 8192) throw new Error('기존 Codex 대화에 1~8192바이트 안내만 기록할 수 있습니다.')
      const noticeId = randomUUID()
      await rpc('thread/inject_items', { threadId: existingThreadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `[axMap notice ${noticeId}; context only, no new model turn]\n${message.text}` }] }] })
      writeJSON(path.join(bridgeHome(), 'notices', `${noticeId}.json`), { id: noticeId, to: id, conversationId: existingThreadId, repo: repoKey(cwd), text: message.text, createdAt: new Date().toISOString(), state: 'context_recorded', modelInvoked: false })
      return { noticeId, conversationId: existingThreadId, state: 'context_recorded', modelInvoked: false }
    }
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
    // 🔴 여기부터 접수(pending) 전까지의 거절은 모델을 부르지 않은 확정 거절이다. refused 를 붙여 보낸 쪽이
    //    unknown 이 아니라 failed 로 기록하게 한다 — unknown 으로 남으면 그 세션의 다음 요청이 「이전 요청 미확정」으로
    //    영영 막힌다(토큰 한도에 걸린 Claude 세션에 보낸 요청이 실제로 그렇게 막혔다).
    const refuse = (text: string) => Object.assign(new Error(text), { refused: true })
    if (jobs.has(message.request?.id)) throw refuse('이미 접수한 요청 ID입니다. 다시 전송하지 않았습니다.')
    const queuedRequest = message.request
    if (!uuid(queuedRequest?.id) || queuedRequest.to !== id || typeof queuedRequest.prompt !== 'string' || !queuedRequest.prompt.trim() || Buffer.byteLength(queuedRequest.prompt) > 32768) throw refuse('요청 형식이 올바르지 않습니다.')
    if (message.queueIfBusy && !closed && (pending || draining || queue.length || s.state === 'running' || s.state === 'awaiting_user')) {
      if (queue.length >= 100) throw refuse('명령 큐가 가득 찼습니다.')
      const job: JobRecord = { id: queuedRequest.id, to: id, state: 'queued' }
      persistJob(job); jobs.set(job.id, job); queue.push(queuedRequest)
      emit({ event: 'queued', request: job })
      return { accepted: true, queued: true, session: id, position: queue.length }
    }
    if (closed || s.state !== 'idle' || pending) throw refuse('세션이 대기 중이 아닙니다. 요청을 전달하지 않았습니다.')
    if (existingThreadId) {
      if (checkingSubmission) throw refuse('다른 요청의 상태를 확인 중입니다.')
      checkingSubmission = true
      try {
        const read = await rpc<{ thread: { id: string; status: { type: string } } }>('thread/read', { threadId: existingThreadId })
        if (closed || pending || read.thread.id !== existingThreadId || read.thread.status.type !== 'idle') throw refuse('기존 대화가 다른 작업 중입니다. 새 요청을 전달하지 않았습니다.')
      } finally { checkingSubmission = false }
    }
    if (!s.usageKnown) throw refuse('직전 요청의 사용량을 확인하지 못했습니다. 새 연결에서 예산을 확인하세요.')
    if (s.usage && s.usage.totalTokens - (existingThreadId ? attachedUsageOrigin?.totalTokens ?? s.usage.totalTokens : 0) >= maxTokens) throw refuse('세션 토큰 한도에 도달했습니다.')
    const request = message.request
    if (!uuid(request?.id) || request.to !== id || typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 32768) throw refuse('요청 형식이 올바르지 않습니다.')
    pending = { id: request.id, to: id, state: 'submitted', baseline: s.usage, baselineKnown: s.usageKnown && (!existingThreadId || !!s.usage), result: '' }
    persistJob(pending); jobs.set(request.id, pending); s.state = 'running'; s.fullyIdle = false; save()
    const prompt = `[axMap request ${request.id}]\n요청자: ${request.from || 'axmap'}\n${role ? `역할: ${role}\n` : ''}${request.prompt}`
    turnTimer = setTimeout(() => shutdown('실행 시간 한도 초과. 완료 여부가 불명확하므로 자동 재시도하지 않습니다.'), timeoutMs)
    if (provider === 'agy') write({ event: 'user', message: { content: prompt } })
    else if (provider === 'claude') write({ type: 'user', message: { role: 'user', content: prompt } })
    else rpc<{ turn: { id: string } }>('turn/start', { threadId: s.conversationId, input: [{ type: 'text', text: prompt }], ...(!existingThreadId ? { effort: 'low' } : {}) })
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
      try { void handle(JSON.parse(input.slice(0, end))).then(result => socket.end(JSON.stringify({ result }) + '\n'), e => socket.end(JSON.stringify({ error: errorMessage(e), ...((e as { refused?: boolean })?.refused ? { refused: true } : {}) }) + '\n')) }
      catch (e) { socket.end(JSON.stringify({ error: errorMessage(e) }) + '\n') }
    })
  })
  fs.mkdirSync(bridgeHome(), { recursive: true, mode: 0o700 })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipeFor(id), resolve) })
  if (process.platform !== 'win32') fs.chmodSync(pipeFor(id), 0o600)
  save()
  const cliArgs = args || (provider === 'codex' ? ['app-server', '--stdio']
    : provider === 'claude' ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', permissionMode, ...(model ? ['--model', model] : [])]
    : ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--effort', 'low', ...(model ? ['--model', model] : [])])
  child = existingThreadId ? connectCodexProxy({ executable, prefix, socketPath: socketPath!, cwd }) : spawn(executable, [...prefix, ...cliArgs], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AXMAP_AGENT: `${provider}-${id.slice(0, 8)}`, AXMAP_SESSION: id } })
  child.stdin.on('error', e => shutdown(e.message))
  const exited = new Promise<{ code: number | null; signal?: NodeJS.Signals | null; error?: string }>(resolve => {
    child.once('error', e => { shutdown(e.message); resolve({ code: 1, error: e.message }) })
    child.once('exit', (code, signal) => { shutdown(`CLI가 종료됐습니다 (${code ?? signal}). ${stderr.slice(-1000)}`); resolve({ code, signal }) })
  })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8192) })
  child.stdout.setEncoding('utf8')
  child.stdout.on('error', e => shutdown(e.message))
  child.stdout.on('data', chunk => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) return shutdown('CLI 응답 크기 제한 초과')
    while (buffer.includes('\n') && !closed) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      try {
        const m = JSON.parse(line) as ProviderMessage
        if (provider === 'claude') {
          const c = m as unknown as ClaudeMessage
          // init 은 실행마다 온다. 첫 init 의 대화 ID 를 붙잡고, 바뀌면 다른 대화에 답이 섞인 것이라 닫는다.
          if (c.type === 'system' && c.subtype === 'init') {
            if (!s.conversationId) { s.conversationId = c.session_id; save(); emit({ event: 'conversation', conversationId: s.conversationId }) }
            else if (c.session_id !== s.conversationId) throw new Error('claude 대화 ID가 바뀌었습니다.')
          }
          if (c.type === 'result' && pending) {
            if (c.session_id !== s.conversationId) throw new Error('claude 대화 ID가 바뀌었습니다.')
            const turn: Record<string, unknown> | null = c.usage ? { ...c.usage, thinking_tokens: c.usage.output_tokens_details?.thinking_tokens ?? 0 } : null
            const known = !!turn && CLAUDE_USAGE_KEYS.every(k => Number.isSafeInteger(turn[k]) && (turn[k] as number) >= 0)
            if (known) claudeTotals = Object.fromEntries(CLAUDE_USAGE_KEYS.map(k => [k, (claudeTotals?.[k] || 0) + (turn![k] as number)]))
            const ok = c.subtype === 'success' && !c.is_error
            finish(ok ? 'completed' : 'failed', c.result, ok ? undefined : String(c.result || c.subtype), known ? claudeTotals : null)
          }
          continue
        }
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
        if (m.method === 'thread/status/changed' && !pending) {
          const status = m.params?.status as { type?: string } | undefined
          s.state = status?.type === 'active' ? 'running' : status?.type === 'idle' ? 'idle' : 'unknown'
          s.fullyIdle = s.state === 'idle'; save(); setImmediate(drain)
        }
        if (m.method === 'thread/tokenUsage/updated') {
          if (pending) pending.rawUsage = m.params?.tokenUsage?.total
          else { const usage = normalizeUsage(provider, m.params?.tokenUsage?.total); if (usage) { s.usage = usage; s.usageKnown = true; save() } }
        }
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
      if (existingThreadId) {
        const read = await rpc<{ thread: { id: string; cwd: string; status: { type: string } } }>('thread/read', { threadId: existingThreadId })
        initialThreadState = read.thread.status.type
        if (read.thread.id !== existingThreadId || (initialThreadState !== 'idle' && !(observeActive && initialThreadState === 'active'))) throw new Error('기존 thread가 idle 상태가 아닙니다. 전송하거나 새 대화를 만들지 않았습니다.')
        // Parent workspace sessions can explicitly join a child Git repo. Never attach across unrelated roots.
        const relative = path.relative(path.resolve(read.thread.cwd), path.resolve(cwd))
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('기존 thread와 요청 저장소 경로가 다릅니다.')
      }
      const r = await rpc<{ thread: { id: string }; model?: string }>(existingThreadId ? 'thread/resume' : 'thread/start', existingThreadId
        ? { threadId: existingThreadId, excludeTurns: true }
        : { cwd: path.resolve(cwd), ...(model ? { model } : {}), sandbox: 'read-only', approvalPolicy: 'on-request' })
      if (existingThreadId && r.thread.id !== existingThreadId) throw new Error('기존 thread ID가 바뀌었습니다.')
      s.conversationId = r.thread.id; s.model = r.model || model || null; s.state = initialThreadState === 'active' ? 'running' : 'idle'; s.fullyIdle = s.state === 'idle'; save(); setImmediate(drain)
      emit({ event: 'ready', conversationId: s.conversationId })
    } else if (provider === 'claude') {
      // Claude Code 는 첫 입력이 올 때까지 아무것도 내보내지 않는다. 프로세스가 떴으면 대기로 둔다 —
      // 대화 ID 는 첫 실행의 init 에서 정해진다. 기다리는 동안 모델은 부르지 않는다.
      await new Promise<void>((resolve, reject) => { child!.once('spawn', () => resolve()); child!.once('error', reject) })
      if (closed) throw new Error(`claude 시작 실패: ${stderr.slice(-1000)}`)
      s.state = 'idle'; s.fullyIdle = true; save(); emit({ event: 'ready', conversationId: null })
    } else {
      const deadline = Date.now() + 30000
      while (s.state === 'starting' && !closed && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
      if (s.state !== 'idle') throw new Error(`agy 시작 실패: ${stderr.slice(-1000) || s.state}`)
    }
  } catch (e) { shutdown(errorMessage(e)); throw e }
  return { id, pid: child.pid, conversationId: s.conversationId, exited, close: () => shutdown('사용자가 관리형 연결을 종료했습니다.') }
}
