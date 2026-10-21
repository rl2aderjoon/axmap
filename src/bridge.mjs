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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bridgeHome = () => path.join(process.env.AXMAP_STATE_DIR || path.join(os.homedir(), '.axmap'), 'bridge')
const agyHome = () => process.env.AXMAP_AGY_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli')
const file = (kind, id) => {
  if (!UUID.test(id || '')) throw new Error('세션/요청 ID는 UUID여야 합니다.')
  return path.join(bridgeHome(), kind, `${id}.json`)
}
function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }
function writeJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  const tmp = `${p}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, p)
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
}
function repoKey(cwd) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd, encoding: 'utf8', windowsHide: true,
  })
  if (r.status !== 0) throw new Error(`Git 작업 저장소를 확인하지 못했습니다: ${cwd}`)
  const key = fs.realpathSync(r.stdout.trim())
  return process.platform === 'win32' ? key.toLowerCase() : key
}
function addressError(address) {
  // Only a loopback address exported by a local provider hook is accepted.
  if (typeof address !== 'string' || !/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/.test(address)) {
    throw new Error('공식 훅에서 받은 로컬 ANTIGRAVITY_LS_ADDRESS가 필요합니다.')
  }
  const port = Number(address.slice(address.lastIndexOf(':') + 1))
  if (port < 1 || port > 65535) throw new Error('연결 포트가 잘못되었습니다.')
}
function runAPI(session, args) {
  addressError(session.address)
  const r = spawnSync(session.executable, ['agentapi', ...args], {
    cwd: session.workspaces[0],
    env: { ...process.env, ANTIGRAVITY_LS_ADDRESS: session.address },
    encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
  })
  if (r.error || r.status !== 0) throw new Error(`열린 세션 연결 실패: ${r.error?.message || r.stderr?.trim() || r.stdout?.trim() || r.status}`)
  const text = r.stdout.trim()
  if (text) {
    let data
    try { data = JSON.parse(text) } catch { return text }
    if (data?.error) throw new Error(`열린 세션 연결 실패: ${JSON.stringify(data.error)}`)
    return data
  }
  return null
}
function transcript(session) {
  const expected = path.join(agyHome(), 'brain', session.conversationId || session.id, '.system_generated', 'logs', 'transcript.jsonl')
  if (session.transcript !== expected) throw new Error('등록된 대화 기록 경로가 올바르지 않습니다.')
  const lines = fs.readFileSync(expected, 'utf8').split('\n')
  // A trailing incomplete record may be in flight; malformed complete records fail.
  lines.pop()
  return lines.filter(s => s.trim()).map(s => JSON.parse(s))
}
function publicSession(s) {
  return { id: s.id, provider: s.provider, workspaces: s.workspaces, model: s.model,
    transport: s.transport || 'agentapi', state: s.state, pid: s.pid,
    registeredAt: s.registeredAt, event: s.event, fullyIdle: s.fullyIdle,
    role: s.role, usage: s.usage, usageKnown: s.usageKnown, maxTokens: s.maxTokens, pendingApproval: s.pendingApproval }
}
export function sessions(cwd) {
  const dir = path.join(bridgeHome(), 'sessions')
  if (!fs.existsSync(dir)) return []
  const repo = repoKey(cwd)
  return fs.readdirSync(dir).filter(n => UUID.test(n.replace(/\.json$/, '')) && n.endsWith('.json'))
    .map(n => readJSON(path.join(dir, n))).filter(s => s.repos.includes(repo)).map(publicSession)
}
function sessionFor(id, cwd) {
  const s = readJSON(file('sessions', id))
  if (!s.repos.includes(repoKey(cwd))) throw new Error('이 세션은 현재 작업 저장소에 등록되지 않았습니다.')
  if (s.provider !== 'agy' && !['pty', 'stdio'].includes(s.transport)) throw new Error('아직 지원하지 않는 수신 세션입니다.')
  return s
}

/** Hook input and env come from Antigravity, not a remote message or repo file. */
export function registerHook(input, event, env = process.env) {
  if (!['SessionStart', 'PreInvocation', 'Stop'].includes(event)) throw new Error('지원하지 않는 훅 이벤트입니다.')
  addressError(env.ANTIGRAVITY_LS_ADDRESS)
  const id = input.conversationId
  const target = file('sessions', id)
  const workspaces = input.workspacePaths
  if (!Array.isArray(workspaces) || !workspaces.length || workspaces.some(p => !path.isAbsolute(p))) {
    throw new Error('훅의 작업 저장소 경로가 없습니다.')
  }
  const executable = env.AXMAP_AGY_EXECUTABLE
  if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) throw new Error('등록된 agy 실행 파일이 없습니다.')
  const expected = path.join(agyHome(), 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
  if (path.resolve(input.transcriptPath || '') !== expected) throw new Error('Antigravity CLI 대화 기록 경로가 아닙니다.')
  const s = { id, provider: 'agy', executable, address: env.ANTIGRAVITY_LS_ADDRESS,
    transcript: expected, workspaces, repos: [...new Set(workspaces.map(repoKey))], model: input.modelName || null,
    registeredAt: new Date().toISOString(), event, fullyIdle: event === 'Stop' && input.fullyIdle === true }
  writeJSON(target, s)
  return publicSession(s)
}

export function requestResult(id, cwd) {
  const target = file('requests', id)
  const request = readJSON(target)
  if (request.repo !== repoKey(cwd)) throw new Error('이 요청은 현재 작업 저장소의 요청이 아닙니다.')
  if (!['submitted', 'unknown'].includes(request.state)) return request
  let s = sessionFor(request.to, cwd)
  if (['pty', 'stdio'].includes(s.transport)) {
    try { Object.assign(request, terminalRPC(s.id, { action: 'result', id })) }
    catch (e) { request.state = 'unknown'; request.error = e.message }
    writeJSON(target, request)
    return request
  }
  if (s.transport === 'console') {
    try { s.fullyIdle = externalStatus(s).state === 'idle' }
    catch (e) {
      request.state = 'unknown'; request.error = e.message
      writeJSON(target, request)
      return request
    }
    s = findConsoleTranscript(s, request)
    if (!s.transcript) return request
  }
  const entries = transcript(s)
  const marker = `[axMap request ${id}]`
  const start = entries.findIndex((e, i) => i >= request.baseline && e.type === 'USER_INPUT' && String(e.content).includes(marker))
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

export function sessionLeasePath(id) {
  if (!UUID.test(id || '')) throw new Error('세션 ID는 UUID여야 합니다.')
  return path.join(bridgeHome(), 'dialogues', `session-${id}.lock`)
}

export function dispatchRequest({ to, prompt, cwd, from = 'axmap', dialogueId = null }) {
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 32768) throw new Error('요청 본문은 1~32768바이트여야 합니다.')
  const s = sessionFor(to, cwd)
  const lease = sessionLeasePath(to)
  if (fs.existsSync(lease) && readJSON(lease).dialogueId !== dialogueId) throw new Error('이 세션은 자동 대화가 사용 중입니다. 해당 대화가 끝난 뒤 요청하세요.')
  const dir = path.join(bridgeHome(), 'requests')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return withRepoLock(path.join(dir, `${to}.lock`), () => {
    if (fs.existsSync(lease) && readJSON(lease).dialogueId !== dialogueId) throw new Error('이 세션은 자동 대화가 사용 중입니다.')
    for (const n of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
      const previous = readJSON(path.join(dir, n))
      if (previous.to !== to || !['sending', 'submitted', 'unknown'].includes(previous.state)) continue
      const latest = previous.state === 'sending' ? previous : requestResult(previous.id, cwd)
      if (['sending', 'submitted', 'unknown'].includes(latest.state)) throw new Error(`이 세션의 이전 요청이 아직 확정되지 않았습니다: ${latest.id}`)
    }
    // No fallback to `agy -p` or --conversation: both would start a separate process.
    if (s.transport === 'console') { validateConsolePrompt(prompt, from); checkConsole(s) }
    if (!['pty', 'stdio', 'console'].includes(s.transport)) {
      runAPI(s, ['get-conversation-metadata', to])
      if (!s.fullyIdle || s.event !== 'Stop') throw new Error('상대 세션의 대기 상태를 아직 확인하지 못했습니다. 작업 종료 훅을 기다리세요.')
    }
    const request = { id: randomUUID(), to, from, repo: repoKey(cwd), prompt,
      createdAt: new Date().toISOString(), baseline: ['pty', 'stdio'].includes(s.transport) ? null : s.transcript ? transcript(s).length : 0, state: 'sending' }
    const target = file('requests', request.id)
    writeJSON(target, request)
    try {
      request.receipt = s.transport === 'console' ? submitConsole(s, request) : ['pty', 'stdio'].includes(s.transport)
        ? terminalRPC(to, { action: 'submit', request })
        : runAPI(s, ['send-message', to, `[axMap request ${request.id}]\n요청자: ${from}\n${prompt}`])
      request.state = 'submitted'
    } catch (e) {
      // A timeout may occur after delivery. Never retry automatically.
      request.state = 'unknown'
      request.error = e.message
    }
    writeJSON(target, request)
    return request
  })
}

function terminalRPC(id, message) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'run.mjs'), 'rpc', id], {
    input: JSON.stringify(message), encoding: 'utf8', windowsHide: true, timeout: 15000,
  })
  if (r.error || r.status !== 0) throw new Error(r.error?.message || r.stderr?.trim() || '터미널 세션에 연결하지 못했습니다.')
  return JSON.parse(r.stdout)
}

export { bridgeHome, repoKey, readJSON, writeJSON }

export function uninstallHooks(home = os.homedir()) {
  const target = path.join(home, '.gemini', 'config', 'hooks.json')
  if (!fs.existsSync(target)) return { removed: false }
  const config = readJSON(target)
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

export function installHooks({ executable, home = os.homedir() }) {
  if (!path.isAbsolute(executable || '') || !fs.existsSync(executable)) throw new Error('agy 실행 파일의 절대 경로가 필요합니다.')
  const target = path.join(home, '.gemini', 'config', 'hooks.json')
  const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
  const config = original === null ? {} : JSON.parse(original)
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('기존 hooks.json이 객체가 아닙니다. 변경하지 않았습니다.')
  const script = path.join(ROOT, 'tools', 'bridge.mjs')
  if ([process.execPath, script, executable].some(s => /["\r\n%&|<>^]/.test(s))) throw new Error('훅 명령 경로에 지원하지 않는 셸 문자가 있습니다.')
  const definition = {}
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
