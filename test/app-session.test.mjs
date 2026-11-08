import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import cp from 'node:child_process'
import { randomUUID } from 'node:crypto'

// 상태 폴더와 Claude 홈을 격리한다. 실제 ~/.axmap 과 ~/.claude 는 건드리지 않는다.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-app-session-'))
process.env.AXMAP_STATE_DIR = path.join(root, 'state')
process.env.AXMAP_CLAUDE_HOME = path.join(root, 'claude')
const repo = path.join(root, 'repo')
fs.mkdirSync(repo)
const git = (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')

const { handleAppHook, appSessionId, setDialogueMode, codexTurn, pumpCodexSessions, listenAppSession, watchAppSession } = await import('../src/app-session.mjs')
const { dispatchRequest, requestResult, sessions } = await import('../src/bridge.mjs')
const runner = path.resolve('tools/run.mjs')

const claudeId = randomUUID(), codexId = randomUUID()
const claudeLog = path.join(process.env.AXMAP_CLAUDE_HOME, 'projects', 'repo', `${claudeId}.jsonl`)
fs.mkdirSync(path.dirname(claudeLog), { recursive: true })
const claudeIn = extra => ({ session_id: claudeId, transcript_path: claudeLog, cwd: repo, ...extra })
const codexLog = path.join(root, 'codex', 'sessions', `rollout-2026-11-05T00-00-00-${codexId}.jsonl`)
fs.mkdirSync(path.dirname(codexLog), { recursive: true })
fs.writeFileSync(codexLog, '')
const codexIn = extra => ({ session_id: codexId, transcript_path: codexLog, cwd: repo, ...extra })
const A = appSessionId('claude', claudeId), B = appSessionId('codex', codexId)
// 가짜 시계: 기다림이 실제 시간을 쓰지 않는다.
let t = Date.now()
const clock = { now: () => t, sleep: ms => { t += ms } }
const hook = (input, event, provider) => handleAppHook(input, event, provider, clock)
const runHook = (input, event, provider) => {
  const r = cp.spawnSync(process.execPath, [runner, 'hook', event, '--provider', provider],
    { input: JSON.stringify(input), encoding: 'utf8', env: process.env, timeout: 20000 })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
const read = id => JSON.parse(fs.readFileSync(path.join(process.env.AXMAP_STATE_DIR, 'bridge', 'requests', `${id}.json`), 'utf8'))

test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('app sessions register from their own hooks and announce the ID once only in axMap repos', () => {
  assert.deepEqual(hook(claudeIn(), 'SessionStart', 'claude'), {})
  git('branch', 'axmap/claims')
  const first = hook(claudeIn({ prompt: 'hi' }), 'UserPromptSubmit', 'claude')
  assert.match(first.hookSpecificOutput.additionalContext, new RegExp(A))
  assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.deepEqual(hook(claudeIn({ prompt: 'again' }), 'UserPromptSubmit', 'claude'), {})
  // codex 는 콘솔 경로를 건너뛰고 실제 훅 실행기(run.mjs)를 거쳐 등록된다.
  const codex = runHook(codexIn(), 'SessionStart', 'codex')
  assert.match(codex.hookSpecificOutput.additionalContext, new RegExp(B))
  const listed = sessions(repo)
  assert.deepEqual(listed.map(s => [s.id, s.transport]).sort(), [[A, 'hook'], [B, 'hook']].sort())
})

test('a Claude transcript outside the projects folder is rejected', () => {
  assert.throws(() => hook({ ...claudeIn(), transcript_path: path.join(root, 'elsewhere', `${claudeId}.jsonl`) }, 'Stop', 'claude'), /대화 기록/)
})

test('Codex helper conversations without a rollout file are not registered; a foreign rollout is rejected', () => {
  const helper = randomUUID()
  assert.deepEqual(hook({ session_id: helper, transcript_path: null, cwd: repo, prompt: '제목' }, 'UserPromptSubmit', 'codex'), {})
  assert.equal(fs.existsSync(path.join(process.env.AXMAP_STATE_DIR, 'bridge', 'sessions', `${appSessionId('codex', helper)}.json`)), false)
  assert.throws(() => hook({ ...codexIn(), transcript_path: path.join(root, 'codex', 'sessions', `rollout-x-${helper}.jsonl`) }, 'Stop', 'codex'), /대화 기록/)
})

test('requests to an app session need its dialogue mode and are never typed anywhere', () => {
  assert.throws(() => dispatchRequest({ to: B, prompt: 'x', cwd: repo, fromSession: A }), /대화 모드가 꺼져/)
  assert.throws(() => setDialogueMode({ session: A, cwd: repo, on: true, maxTurns: 0 }), /maxTurns/)
})

test('dialogue mode: request waits for the receiver Stop, the answer returns to the sender Stop', () => {
  setDialogueMode({ session: B, cwd: repo, on: true, waitSeconds: 5 })
  const r = dispatchRequest({ to: B, prompt: '계산: 2+3', cwd: repo, from: 'agent', fromSession: A })
  assert.equal(r.state, 'queued')
  assert.equal(requestResult(r.id, repo).state, 'queued')

  // B 의 응답이 끝나면 같은 대화를 이어 가게 한다.
  const start = t
  const out = hook(codexIn({ last_assistant_message: '이전 답' }), 'Stop', 'codex')
  assert.equal(out.decision, 'block')
  assert.match(out.reason, new RegExp(`\\[axMap request ${r.id}\\]`))
  assert.match(out.reason, /계산: 2\+3/)
  assert.equal(t, start, '이미 와 있는 요청은 기다리지 않고 바로 꺼낸다')
  assert.equal(read(r.id).state, 'submitted')
  // Codex 의 이어 가기 문구는 새 프롬프트로 보일 수 있다. 우리 표식이 있으면 끼어들기가 아니다.
  hook(codexIn({ prompt: out.reason }), 'UserPromptSubmit', 'codex')
  assert.equal(read(r.id).state, 'submitted')

  // 다음 Stop 의 마지막 답이 그 요청의 결과다. 더 온 것이 없으면 정해진 시간만 기다리고 끝낸다.
  const before = t
  assert.deepEqual(hook(codexIn({ last_assistant_message: '5' }), 'Stop', 'codex'), {})
  assert.equal(t - before, 5000)
  assert.deepEqual([read(r.id).state, read(r.id).result], ['completed', '5'])

  // 보낸 쪽(A)은 대화 모드일 때만 회신을 받는다.
  assert.deepEqual(hook(claudeIn({ last_assistant_message: 'x' }), 'Stop', 'claude'), {})
  setDialogueMode({ session: A, cwd: repo, on: true, waitSeconds: 1 })
  const back = hook(claudeIn({ last_assistant_message: 'x' }), 'Stop', 'claude')
  assert.equal(back.decision, 'block')
  assert.match(back.reason, new RegExp(`\\[axMap reply ${r.id}\\][\\s\\S]*\\n5\\n`))
  assert.match(back.reason, new RegExp(`from_session="${A}"`))
  assert.ok(read(r.id).returnedAt)
  // 한 번 돌려준 회신은 다시 오지 않고, 이 차례는 axMap 요청이 아니므로 아무 요청도 완료로 바꾸지 않는다.
  assert.deepEqual(hook(claudeIn({ last_assistant_message: 'y' }), 'Stop', 'claude'), {})
})

test('a human prompt during a delivered request supersedes it; the turn limit stops delivery', () => {
  const r = dispatchRequest({ to: B, prompt: '두 번째', cwd: repo, fromSession: A })
  assert.equal(hook(codexIn({}), 'Stop', 'codex').decision, 'block')
  hook(codexIn({ prompt: '사람이 직접 입력' }), 'UserPromptSubmit', 'codex')
  assert.equal(read(r.id).state, 'superseded')

  setDialogueMode({ session: B, cwd: repo, on: true, waitSeconds: 1, maxTurns: 1 })
  dispatchRequest({ to: B, prompt: '셋', cwd: repo })
  assert.equal(hook(codexIn({}), 'Stop', 'codex').decision, 'block')
  // 한도를 다 쓰면 모드가 꺼진 것과 같다. 새 요청은 접수조차 하지 않는다.
  assert.throws(() => dispatchRequest({ to: B, prompt: '넷', cwd: repo }), /대화 모드가 꺼져/)
  assert.deepEqual(hook(codexIn({ last_assistant_message: 'ok' }), 'Stop', 'codex'), {})
})

test('a conversation whose cwd moves between repos stays reachable from both', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-app-move-'))
  try {
    cp.execFileSync('git', ['init', '-q'], { cwd: other })
    hook(codexIn({ cwd: other, prompt: 'p' }), 'UserPromptSubmit', 'codex')
    hook(codexIn({ cwd: repo, last_assistant_message: 'a' }), 'Stop', 'codex')
    hook(codexIn({ cwd: other, last_assistant_message: 'b' }), 'Stop', 'codex')
    assert.ok(sessions(repo).some(s => s.id === B), '앞서 있던 저장소에서도 보인다')
    assert.ok(sessions(other).some(s => s.id === B), '새 저장소에서도 보인다')
  } finally { fs.rmSync(other, { recursive: true, force: true }) }
})

test('status shows an interrupted Codex turn as idle using the rollout turn_aborted event', async () => {
  const { sessionStatus } = await import('../src/session-status.mjs')
  const state = async () => (await sessionStatus(repo)).find(s => s.id === B).state
  hook(codexIn({ prompt: '긴 작업' }), 'UserPromptSubmit', 'codex')
  const event = type => JSON.stringify({ type: 'event_msg', payload: { type } }) + '\n'
  fs.writeFileSync(codexLog, event('task_started'))
  assert.equal(await state(), 'running')
  fs.appendFileSync(codexLog, event('turn_aborted'))
  assert.equal(await state(), 'idle')
  fs.appendFileSync(codexLog, event('task_started'))
  assert.equal(await state(), 'running', '다음 차례가 시작되면 다시 작업 중이다')
  hook(codexIn({ last_assistant_message: 'x' }), 'Stop', 'codex')
})

test('bridge send strips the PowerShell BOM and CRLF from the piped prompt', () => {
  setDialogueMode({ session: B, cwd: repo, on: true })
  const r = cp.spawnSync(process.execPath, [path.resolve('tools/bridge.mjs'), 'send', '--to', B],
    { cwd: repo, input: '\uFEFF첫 줄\r\n둘째 줄\r\n', encoding: 'utf8', env: process.env, timeout: 20000 })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).prompt, '첫 줄\n둘째 줄\n')
  setDialogueMode({ session: B, cwd: repo, on: false })
})

test('turning dialogue mode off fails undelivered requests instead of leaving them queued', () => {
  setDialogueMode({ session: B, cwd: repo, on: true })
  const r = dispatchRequest({ to: B, prompt: '대기', cwd: repo })
  setDialogueMode({ session: B, cwd: repo, on: false })
  assert.equal(read(r.id).state, 'failed')
  // 다른 저장소에서는 이 세션을 바꿀 수 없다.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-app-other-'))
  try {
    cp.execFileSync('git', ['init', '-q'], { cwd: other })
    assert.throws(() => setDialogueMode({ session: B, cwd: other, on: true }), /현재 작업 저장소/)
  } finally { fs.rmSync(other, { recursive: true, force: true }) }
})

test('SessionEnd closes the app session and fails its queue', () => {
  setDialogueMode({ session: A, cwd: repo, on: true })
  const r = dispatchRequest({ to: A, prompt: '끝', cwd: repo, fromSession: B })
  hook(claudeIn({}), 'SessionEnd', 'claude')
  assert.equal(read(r.id).state, 'failed')
  assert.equal(sessions(repo).find(s => s.id === A).state, 'closed')
})

test('hook install gives Stop the provider default 600 seconds and keeps other events short', async () => {
  const { installTerminalHooks } = await import('../src/terminal-bridge.mjs')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-app-hooks-'))
  try {
    for (const provider of ['claude', 'codex']) {
      const saved = JSON.parse(fs.readFileSync(installTerminalHooks(home, provider), 'utf8'))
      assert.equal(saved.hooks.Stop.at(-1).hooks[0].timeout, 600)
      assert.equal(saved.hooks.SessionStart.at(-1).hooks[0].timeout, 10)
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

const rollout = (file, ...events) => fs.appendFileSync(file, events.map(([type, timestamp, extra]) =>
  JSON.stringify({ timestamp, type: 'event_msg', payload: { type, ...extra } })).join('\n') + '\n')
function notifyPair() {
  const cid = randomUUID(), xid = randomUUID()
  const clog = path.join(process.env.AXMAP_CLAUDE_HOME, 'projects', 'repo', `${cid}.jsonl`)
  const xlog = path.join(root, 'codex', 'sessions', `rollout-2026-11-08T00-00-00-${xid}.jsonl`)
  fs.writeFileSync(clog, ''); fs.writeFileSync(xlog, '')
  const cin = { session_id: cid, transcript_path: clog, cwd: repo }, xin = { session_id: xid, transcript_path: xlog, cwd: repo }
  handleAppHook(cin, 'SessionStart', 'claude'); handleAppHook(xin, 'SessionStart', 'codex')
  const c = appSessionId('claude', cid), x = appSessionId('codex', xid)
  for (const session of [c, x]) setDialogueMode({ session, cwd: repo, on: true, notify: true })
  return { c, x, xid, xlog, cin }
}

test('codexTurn 은 마지막 차례의 시작·끝을 읽고 못 읽으면 null 이다', () => {
  const { xlog } = notifyPair()
  assert.equal(codexTurn(path.join(root, 'missing.jsonl')), null)
  rollout(xlog, ['task_started', '2026-11-08T00:00:01.000Z'])
  assert.equal(codexTurn(xlog).idle, false)
  rollout(xlog, ['task_complete', '2026-11-08T00:00:02.000Z', { last_agent_message: 'hi' }])
  assert.deepEqual(codexTurn(xlog), { idle: true, aborted: false, lastMessage: 'hi', startedAt: '2026-11-08T00:00:01.000Z' })
})

test('알림 모드: 쉬는 Codex 에 넣고, 넣은 뒤 시작한 차례의 끝만 답으로 적는다', () => {
  const { c, x, xid, xlog } = notifyPair()
  rollout(xlog, ['task_started', '2026-11-08T00:00:01.000Z'], ['task_complete', '2026-11-08T00:00:02.000Z', { last_agent_message: 'old' }])
  const sent = [], queue = (thread, message) => { sent.push({ thread, message }); return { ok: true } }
  const first = dispatchRequest({ to: x, from: 'test', fromSession: c, prompt: 'one', cwd: repo })
  const second = dispatchRequest({ to: x, from: 'test', fromSession: c, prompt: 'two', cwd: repo })
  pumpCodexSessions(repo, { queue })
  assert.equal(sent.length, 1); assert.equal(sent[0].thread, xid); assert.match(sent[0].message, /one/)
  assert.equal(requestResult(first.id, repo).state, 'submitted')
  pumpCodexSessions(repo, { queue })
  assert.equal(sent.length, 1, '이전 차례의 끝으로 다음 것을 넣지 않는다')
  assert.equal(requestResult(first.id, repo).state, 'submitted')
  const start = new Date(Date.now() + 1000).toISOString(), end = new Date(Date.now() + 2000).toISOString()
  rollout(xlog, ['task_started', start], ['task_complete', end, { last_agent_message: 'answer' }])
  pumpCodexSessions(repo, { queue })
  assert.equal(requestResult(first.id, repo).result, 'answer')
  assert.equal(sent.length, 2); assert.match(sent[1].message, /two/)
  assert.equal(requestResult(second.id, repo).state, 'submitted')
})

test('알림 모드: codex queue 가 실패하면 unknown 으로 두고 다시 보내지 않는다', () => {
  const { c, x, xlog } = notifyPair()
  rollout(xlog, ['task_started', '2026-11-08T00:00:01.000Z'], ['task_complete', '2026-11-08T00:00:02.000Z', {}])
  let calls = 0
  const r = dispatchRequest({ to: x, from: 'test', fromSession: c, prompt: 'x', cwd: repo })
  const queue = () => { calls++; return { ok: false, error: 'boom' } }
  pumpCodexSessions(repo, { queue }); pumpCodexSessions(repo, { queue })
  assert.equal(calls, 1); assert.equal(requestResult(r.id, repo).state, 'unknown')
})

test('listen: 쉬는 Claude 세션에 온 요청을 한 번만 내보내고 작업 중에는 내보내지 않는다', async () => {
  const { c, x, cin } = notifyPair()
  handleAppHook(cin, 'UserPromptSubmit', 'claude')
  const r = dispatchRequest({ to: c, from: 'test', fromSession: x, prompt: 'ping', cwd: repo })
  const out = []
  let polls = 0
  await listenAppSession({ session: c, cwd: repo, intervalMs: 1, queue: () => ({ ok: true }), onDelivery: t => out.push(t), shouldStop: () => ++polls > 3 })
  assert.equal(out.length, 0)
  assert.equal(handleAppHook(cin, 'Stop', 'claude').decision, 'block', '응답 끝에 이미 와 있으면 바로 이어 간다')
  assert.equal(requestResult(r.id, repo).state, 'submitted')
  const again = dispatchRequest({ to: c, from: 'test', fromSession: x, prompt: 'pong', cwd: repo })
  handleAppHook({ ...cin, last_assistant_message: 'done' }, 'Stop', 'claude')
  polls = 0
  await listenAppSession({ session: c, cwd: repo, intervalMs: 1, queue: () => ({ ok: true }), onDelivery: t => out.push(t), shouldStop: () => ++polls > 3 })
  assert.equal(out.length, 0, 'Stop 이 이미 꺼냈으면 listen 은 두 번 내보내지 않는다')
  assert.equal(requestResult(again.id, repo).state, 'submitted')
})

test('응답 끝 감시: 쉬는 Claude 에 온 요청을 돌려주고, 알림 모드가 아니면 바로 끝난다', async () => {
  const { c, x, cin } = notifyPair()
  handleAppHook(cin, 'Stop', 'claude')
  const waiting = watchAppSession(cin, 'claude', { intervalMs: 5, queue: () => ({ ok: true }) })
  const r = dispatchRequest({ to: c, from: 'test', fromSession: x, prompt: 'wake me', cwd: repo })
  assert.match(await waiting, /wake me/)
  assert.equal(requestResult(r.id, repo).state, 'submitted')
  setDialogueMode({ session: c, cwd: repo, on: false })
  assert.equal(await watchAppSession(cin, 'claude', { intervalMs: 5 }), null)
})

test('응답 끝 감시: 새 감시가 자리를 넘겨받거나 사용자가 입력하면 조용히 끝난다', async () => {
  const { cin } = notifyPair()
  handleAppHook(cin, 'Stop', 'claude')
  const options = { intervalMs: 5, queue: () => ({ ok: true }) }
  const old = watchAppSession(cin, 'claude', options)
  await new Promise(resolve => setTimeout(resolve, 30))
  const latest = watchAppSession(cin, 'claude', options)
  assert.equal(await old, null)
  handleAppHook(cin, 'UserPromptSubmit', 'claude')
  assert.equal(await latest, null)
})

test('훅 설치: Claude 의 Stop 에만 깨우기 감시가 들어가고 다시 설치해도 하나다', async () => {
  const { installTerminalHooks } = await import('../src/terminal-bridge.mjs')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-app-hooks-'))
  try {
    const watches = provider => JSON.parse(fs.readFileSync(installTerminalHooks(home, provider), 'utf8')).hooks.Stop.flatMap(g => g.hooks).filter(h => h.asyncRewake)
    assert.equal(watches('claude').length, 1)
    assert.match(watches('claude')[0].command, /hook-watch --provider claude/)
    assert.equal(watches('codex').length, 0)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
