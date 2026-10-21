/** The user launches an interactive CLI. axMap owns its PTY and a local,
 * authenticated pipe; remote requests never launch/resume another model. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { bridgeHome, repoKey, readJSON, writeJSON } from './bridge.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const validID = id => /^[0-9a-f-]{36}$/i.test(id || '')
const sessionFile = id => {
  if (!validID(id)) throw new Error('잘못된 터미널 세션 ID입니다.')
  return path.join(bridgeHome(), 'sessions', `${id}.json`)
}
const pipeFor = id => process.platform === 'win32'
  ? `\\\\.\\pipe\\axmap-${id}` : path.join(bridgeHome(), `${id}.sock`)

export function sendTerminal(id, message, token = null, { timeoutMs = 10000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('양의 응답 시간 한도가 필요합니다.')
  const s = readJSON(sessionFile(id))
  if (!['pty', 'stdio'].includes(s.transport)) throw new Error('로컬 관리형 세션이 아닙니다.')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeFor(id))
    socket.setEncoding('utf8')
    let buffer = ''
    const fail = e => { socket.destroy(); reject(e) }
    socket.setTimeout(timeoutMs, () => fail(new Error('로컬 세션 응답 시간 초과. 자동 재전송하지 마세요.')))
    socket.on('error', fail)
    socket.on('connect', () => socket.write(JSON.stringify({ ...message, token: token || s.token }) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 1024 * 1024) return fail(new Error('로컬 응답 크기 제한 초과'))
      const end = buffer.indexOf('\n')
      if (end < 0) return
      socket.end()
      try {
        const response = JSON.parse(buffer.slice(0, end))
        if (response.error) reject(new Error(response.error)); else resolve(response.result)
      } catch (e) { reject(e) }
    })
    socket.on('end', () => { if (!buffer.includes('\n')) reject(new Error('세션 연결이 응답 없이 종료됐습니다.')) })
  })
}

export async function startTerminal({ executable, args = [], provider, cwd = process.cwd(), onData = () => {}, cols = 100, rows = 30 }) {
  const { spawn } = await import('node-pty')
  const id = randomUUID(), token = randomBytes(32).toString('hex')
  const s = { id, provider, transport: 'pty', token, workspaces: [cwd], repos: [repoKey(cwd)],
    state: 'starting', fullyIdle: false, registeredAt: new Date().toISOString(), event: 'launch' }
  const jobs = new Map()
  let pending = null, draft = false, term, closed = false, stopTimer
  const save = () => { s.registeredAt = new Date().toISOString(); writeJSON(sessionFile(id), s) }
  const finish = (state, result, error) => {
    if (!pending) return
    Object.assign(pending, { state, result, error, completedAt: new Date().toISOString() })
    jobs.set(pending.id, { ...pending }); pending = null
  }
  const handle = message => {
    const offered = Buffer.from(typeof message.token === 'string' ? message.token : '')
    const expected = Buffer.from(token)
    if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) throw new Error('로컬 세션 인증 실패')
    if (message.action === 'status') return { state: s.state, id, provider }
    if (message.action === 'result') {
      const job = jobs.get(message.id)
      if (!job) throw new Error('이 터미널에 해당 요청이 없습니다.')
      return job
    }
    if (message.action === 'hook') {
      clearTimeout(stopTimer)
      const { input, event } = message
      s.event = event; s.model = input.modelName || input.model || s.model
      s.conversationId = input.conversationId || input.session_id || s.conversationId
      if (event !== 'Stop') {
        s.state = 'running'; s.fullyIdle = false
        if (pending && event === 'UserPromptSubmit' && typeof input.prompt === 'string') {
          pending.observed = input.prompt.includes(`[axMap request ${pending.id}]`)
        }
        save(); return {}
      }
      if (provider === 'agy' && input.fullyIdle !== true) { save(); return {} }
      let answer = input.last_assistant_message
      if (provider === 'agy') {
        const log = path.join(process.env.AXMAP_AGY_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli'),
          'brain', s.conversationId || '', '.system_generated', 'logs', 'transcript.jsonl')
        if (path.resolve(input.transcriptPath || '') !== log) throw new Error('종료 훅의 대화 기록 경로가 다릅니다.')
        const lines = fs.readFileSync(log, 'utf8').trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line))
        const lastUser = lines.findLast(e => e.type === 'USER_INPUT')
        if (pending) pending.observed = String(lastUser?.content).includes(`[axMap request ${pending.id}]`)
        answer = lines.findLast(e => e.type === 'PLANNER_RESPONSE' && e.source === 'MODEL' && e.status === 'DONE')?.content
      }
      if (pending) finish(pending.observed && !pending.interrupted && typeof answer === 'string' ? 'completed' : 'superseded',
        pending.observed && !pending.interrupted ? answer : undefined,
        pending.observed && !pending.interrupted ? undefined : '다른 입력이 섞였거나 이 요청의 응답을 확인하지 못했습니다.')
      // Stop runs before the provider restores its input UI. Allow that handoff
      // to finish before accepting another injected prompt.
      s.state = 'settling'; s.fullyIdle = false; save()
      stopTimer = setTimeout(() => { if (!closed && s.state === 'settling') { s.state = 'idle'; s.fullyIdle = true; draft = false; save() } }, 500)
      return {}
    }
    if (message.action === 'submit') {
      const request = message.request
      if (closed || s.state !== 'idle' || draft || pending) throw new Error('상대가 대기 중이 아니거나 입력 중입니다. 작업을 전달하지 않았습니다.')
      if (!validID(request?.id) || request.to !== id || typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 32768) throw new Error('요청 형식이 올바르지 않습니다.')
      const prompt = `[axMap request ${request.id}]\n요청자: ${String(request.from || 'axmap')}\n${request.prompt}`
      if (/[\x00-\x08\x0b-\x1f\x7f]/.test(prompt)) throw new Error('터미널 제어 문자가 포함된 요청은 보낼 수 없습니다.')
      pending = { id: request.id, to: id, state: 'submitted' }; jobs.set(request.id, pending)
      s.state = 'running'; s.fullyIdle = false; save()
      term.write(`\x1b[200~${prompt}\x1b[201~`)
      setTimeout(() => { if (!closed) term.write('\r') }, 100)
      return { accepted: true, session: id }
    }
    throw new Error('지원하지 않는 로컬 세션 요청입니다.')
  }
  fs.mkdirSync(bridgeHome(), { recursive: true, mode: 0o700 })
  const server = net.createServer(socket => {
    socket.setEncoding('utf8')
    let buffer = '', handled = false
    socket.setTimeout(15000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('data', chunk => {
      if (handled) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > 65536) return socket.destroy()
      const end = buffer.indexOf('\n'); if (end < 0) return
      handled = true
      try { socket.end(JSON.stringify({ result: handle(JSON.parse(buffer.slice(0, end))) }) + '\n') }
      catch (e) { socket.end(JSON.stringify({ error: e.message }) + '\n') }
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipeFor(id), resolve) })
  if (process.platform !== 'win32') fs.chmodSync(pipeFor(id), 0o600)
  save()
  try {
    term = spawn(executable, args, { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env,
      AXMAP_TERMINAL_SESSION: id, AXMAP_TERMINAL_TOKEN: token,
      AXMAP_AGENT: `${provider}-${id.slice(0, 8)}`, AXMAP_SESSION: id,
    }, useConpty: true, useConptyDll: process.platform === 'win32' })
  } catch (e) { server.close(); s.state = 'closed'; save(); throw e }
  term.onData(onData)
  const exited = new Promise(resolve => term.onExit(ev => {
    if (closed) return
    closed = true; clearTimeout(stopTimer)
    // ConPTY may keep its input handle alive after a normal child exit.
    if (process.platform === 'win32') { try { term.kill() } catch { /* already closed */ } }
    finish('unknown', undefined, '요청의 완료를 확인하기 전에 세션이 종료됐습니다.')
    s.state = 'closed'; s.fullyIdle = false; save(); server.close(); resolve(ev)
  }))
  return { id, pid: term.pid, exited,
    input(data) {
      const terminalReply = /^\x1b\[(?:\d+;\d+R|\?[^a-zA-Z]*[a-zA-Z])$/.test(String(data))
      if (terminalReply) { term.write(data); return }
      if (pending) pending.interrupted = true
      draft = !String(data).includes('\r')
      if (!draft) { s.state = 'running'; s.fullyIdle = false; save() }
      term.write(data)
    },
    resize: (c, r) => term.resize(c, r),
    close: () => term.kill(),
  }
}

/** Copy only production dependencies from the npm package, not a developer's
 * entire node_modules. This also keeps the setup copy independent of npm cache. */
export function installTerminalRuntime(sourceRoot, destRoot = ROOT) {
  const source = path.resolve(sourceRoot), dest = path.resolve(destRoot)
  const require = createRequire(path.join(source, 'package.json'))
  const copied = new Set()
  function copy(name) {
    if (copied.has(name)) return
    const descriptor = require.resolve(`${name}/package.json`)
    const pkg = readJSON(descriptor)
    const target = path.join(dest, 'node_modules', ...name.split('/'))
    if (path.resolve(path.dirname(descriptor)) !== path.resolve(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.cpSync(path.dirname(descriptor), target, { recursive: true, force: true })
    }
    copied.add(name)
    for (const dependency of Object.keys(pkg.dependencies || {})) copy(dependency)
    for (const dependency of Object.keys(pkg.optionalDependencies || {})) {
      try { require.resolve(`${dependency}/package.json`) }
      catch (e) { if (e.code === 'MODULE_NOT_FOUND') continue; throw e }
      copy(dependency)
    }
  }
  copy('node-pty')
  const installed = createRequire(path.join(dest, 'package.json'))('node-pty')
  if (typeof installed.spawn !== 'function') throw new Error('설치된 터미널 라이브러리를 불러오지 못했습니다.')
  return { packages: [...copied], destination: dest }
}

export function installTerminalHooks(home = os.homedir(), provider = 'agy') {
  if (!['agy', 'codex'].includes(provider)) throw new Error('지원하지 않는 CLI 훅입니다.')
  const target = provider === 'agy' ? path.join(home, '.gemini', 'config', 'hooks.json')
    : path.join(home, '.codex', 'hooks.json')
  const config = fs.existsSync(target) ? readJSON(target) : {}
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('기존 hooks.json을 읽지 못했습니다.')
  if (provider === 'codex' && config.hooks !== undefined && (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))) throw new Error('기존 Codex hooks 설정이 객체가 아닙니다.')
  const definition = {}
  const script = path.join(ROOT, 'tools', 'run.mjs')
  if ([process.execPath, script].some(p => /["\r\n%&|<>^]/.test(p))) throw new Error('훅 경로에 지원하지 않는 셸 문자가 있습니다.')
  for (const event of provider === 'agy' ? ['SessionStart', 'PreInvocation', 'Stop'] : ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    let command = `"${process.execPath}" "${script}" hook ${event}`
    if (process.platform === 'win32') {
      const wrapper = path.join(home, '.axmap', 'bridge', `terminal-${provider}-${event}.cmd`)
      if (/[\s"%&|<>^]/.test(wrapper)) throw new Error('이 Windows 훅 경로에는 공백/셸 문자를 사용할 수 없습니다.')
      fs.mkdirSync(path.dirname(wrapper), { recursive: true })
      fs.writeFileSync(wrapper, `@echo off\r\n${command}\r\n`)
      command = wrapper
    }
    if (provider === 'agy') definition[event] = [{ type: 'command', command, timeout: 10 }]
    else {
      config.hooks ||= {}
      const existing = config.hooks[event] || []
      if (!Array.isArray(existing)) throw new Error(`기존 Codex ${event} 설정이 배열이 아닙니다.`)
      config.hooks[event] = existing.filter(group => !(Array.isArray(group.hooks) && group.hooks.some(h => h.statusMessage === 'axMap terminal bridge')))
      config.hooks[event].push({ hooks: [{ type: 'command', command, timeout: 10, statusMessage: 'axMap terminal bridge' }] })
    }
  }
  if (provider === 'agy') config['axmap-terminal'] = definition
  writeJSON(target, config)
  return target
}
