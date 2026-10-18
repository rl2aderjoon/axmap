import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dispatchRequest, installHooks, registerHook, requestResult, sessions, uninstallHooks } from '../src/bridge.mjs'

let root, repo, id, log, input, saved
const oldEnv = () => ({ AXMAP_STATE_DIR: process.env.AXMAP_STATE_DIR, AXMAP_AGY_HOME: process.env.AXMAP_AGY_HOME })
const append = e => fs.appendFileSync(log, JSON.stringify(e) + '\n')
const hook = event => registerHook(input, event, { ANTIGRAVITY_LS_ADDRESS: 'localhost:12345', AXMAP_AGY_EXECUTABLE: process.execPath })

beforeEach(() => {
  saved = oldEnv()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-bridge-'))
  repo = path.join(root, 'repo'); fs.mkdirSync(repo)
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0)
  process.env.AXMAP_STATE_DIR = path.join(root, 'state')
  process.env.AXMAP_AGY_HOME = path.join(root, 'agy')
  id = randomUUID()
  log = path.join(process.env.AXMAP_AGY_HOME, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
  fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, '')
  input = { conversationId: id, workspacePaths: [repo], transcriptPath: log, modelName: 'fixture', fullyIdle: true }
  // Real child process fixture: verifies argv preserves quotes, Unicode, newlines,
  // and shell metacharacters without executing them as a command.
  fs.writeFileSync(path.join(repo, 'agentapi'), `
    const fs = require('node:fs');
    fs.writeFileSync('received.json', JSON.stringify(process.argv.slice(2)));
    if (process.argv[2] === 'send-message') console.log(JSON.stringify({accepted:true}));
    else console.log(JSON.stringify({conversationId: process.argv[3]}));
  `)
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  fs.rmSync(root, { recursive: true, force: true })
})

test('hook registration is repo scoped; connection details stay out of session listings', () => {
  hook('Stop')
  const listed = sessions(repo)
  assert.equal(listed[0].id, id)
  assert.equal(listed[0].fullyIdle, true)
  assert.ok(!JSON.stringify(listed).includes('12345'))
  assert.ok(!JSON.stringify(listed).includes(process.execPath))
  const other = path.join(root, 'other'); fs.mkdirSync(other)
  spawnSync('git', ['init', '-q'], { cwd: other })
  assert.deepEqual(sessions(other), [])
  assert.throws(() => dispatchRequest({ to: id, prompt: 'hello', cwd: other }), /현재 작업 저장소/)
})

test('missing provider address, external addresses, malformed IDs and transcript paths fail closed', () => {
  assert.throws(() => registerHook(input, 'Stop', {}), /ANTIGRAVITY_LS_ADDRESS/)
  assert.throws(() => registerHook(input, 'Stop', { ANTIGRAVITY_LS_ADDRESS: 'example.com:443' }), /로컬/)
  assert.throws(() => registerHook({ ...input, conversationId: '../escape' }, 'Stop', {
    ANTIGRAVITY_LS_ADDRESS: 'localhost:12345',
  }), /UUID/)
  assert.throws(() => registerHook({ ...input, transcriptPath: path.join(root, 'secret') }, 'Stop', {
    ANTIGRAVITY_LS_ADDRESS: 'localhost:12345', AXMAP_AGY_EXECUTABLE: process.execPath,
  }), /대화 기록 경로/)
})

test('submission uses the existing conversation and is not reported as completion', () => {
  hook('Stop')
  const prompt = '한글 "quote"\n`literal` $(literal) & | %VALUE%'
  const request = dispatchRequest({ to: id, prompt, cwd: repo })
  assert.equal(request.state, 'submitted')
  const received = JSON.parse(fs.readFileSync(path.join(repo, 'received.json'), 'utf8'))
  assert.equal(received[0], 'send-message')
  assert.equal(received[1], id)
  assert.ok(received[2].endsWith(prompt))
  assert.equal(requestResult(request.id, repo).state, 'submitted')
  assert.throws(() => dispatchRequest({ to: id, prompt: 'duplicate', cwd: repo }), /이전 요청/)
  append({ type: 'USER_INPUT', content: received[2] })
  append({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'finished' })
  assert.equal(requestResult(request.id, repo).state, 'submitted', 'model text alone cannot prove completion')
  hook('Stop')
  const result = requestResult(request.id, repo)
  assert.equal(result.state, 'completed')
  assert.equal(result.result, 'finished')
})

test('a busy session is not interrupted and later user input prevents attribution', () => {
  hook('PreInvocation')
  assert.throws(() => dispatchRequest({ to: id, prompt: 'hello', cwd: repo }), /대기 상태/)
  hook('Stop')
  const request = dispatchRequest({ to: id, prompt: 'hello', cwd: repo })
  append({ type: 'USER_INPUT', content: `[axMap request ${request.id}] hello` })
  append({ type: 'USER_INPUT', content: 'different user request' })
  append({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'unrelated answer' })
  hook('Stop')
  assert.equal(requestResult(request.id, repo).state, 'superseded')
})

test('provider error after a possible send is unknown and never automatically retried', () => {
  hook('Stop')
  fs.writeFileSync(path.join(repo, 'agentapi'), `
    if (process.argv[2] === 'send-message') { console.error('transport failed'); process.exit(1) }
    console.log('{}');
  `)
  const r = dispatchRequest({ to: id, prompt: 'hello', cwd: repo })
  assert.equal(r.state, 'unknown')
  assert.match(r.error, /transport failed/)
  assert.throws(() => dispatchRequest({ to: id, prompt: 'retry', cwd: repo }), /이전 요청/)
})

test('installer preserves other hooks, backs up exact bytes and runs the Windows wrapper', () => {
  const home = path.join(root, 'home')
  const configFile = path.join(home, '.gemini', 'config', 'hooks.json')
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  const original = '{"other":{"Stop":[]}}\n'
  fs.writeFileSync(configFile, original)
  const installed = installHooks({ executable: process.execPath, home })
  assert.equal(fs.readFileSync(installed.backup, 'utf8'), original)
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.deepEqual(config.other, { Stop: [] })
  if (process.platform === 'win32') {
    const command = config['axmap-bridge'].PreInvocation[0].command
    assert.ok(command.endsWith('.cmd'))
    assert.ok(!command.includes('"'))
    const r = spawnSync('cmd.exe', ['/d', '/c', command], {
      input: JSON.stringify(input), encoding: 'utf8', windowsHide: true,
      env: { ...process.env, ANTIGRAVITY_LS_ADDRESS: 'localhost:12345' },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), {})
    assert.equal(sessions(repo)[0].id, id, r.stderr)
  }
  assert.equal(uninstallHooks(home).removed, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { other: { Stop: [] } })
  fs.writeFileSync(configFile, '{broken')
  assert.throws(() => installHooks({ executable: process.execPath, home }))
  assert.equal(fs.readFileSync(configFile, 'utf8'), '{broken')
})
