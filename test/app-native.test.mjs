import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { codexAppRPC, claudePeer, nativeRelayActive, startNativeRelay } from '../src/app-native.mjs'
import { handleAppHook, appSessionId, enqueueAppRequest } from '../src/app-session.mjs'
import { replyAppRequest } from '../src/app-queue.mjs'
import { postMail, collectMail } from '../src/session-mailbox.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-native-'))
process.env.AXMAP_STATE_DIR = path.join(root, 'state')
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
process.env.AXMAP_CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR
const repo = path.join(root, 'repo'); fs.mkdirSync(repo)
execFileSync('git', ['init', '-q'], { cwd: repo })
const { repoKey } = await import('../src/bridge.mjs')
const repoId = repoKey(repo)
const base = path.join(process.env.AXMAP_STATE_DIR, 'bridge')
const file = (kind, id) => path.join(base, kind, `${id}.json`)
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const save = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)) }
const address = () => process.platform === 'win32' ? `\\\\.\\pipe\\ax-native-${randomUUID()}` : path.join(root, `${randomUUID()}.sock`)
const wait = async fn => { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw Error('조건 시간 초과'); await new Promise(r => setTimeout(r, 10)) } }
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('앱 RPC는 분할된 응답 프레임을 읽고 연결 전 실패를 구별한다', async () => {
  const pipe = address()
  const server = net.createServer(s => s.once('data', () => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
    const h = Buffer.alloc(4); h.writeUInt32LE(body.length)
    s.write(h.subarray(0, 2)); setTimeout(() => s.end(Buffer.concat([h.subarray(2), body])), 10)
  }))
  await new Promise(r => server.listen(pipe, r))
  try { assert.deepEqual(await codexAppRPC(pipe, 'tools/list', {}), { ok: true }) }
  finally { await new Promise(r => server.close(r)) }
  await assert.rejects(codexAppRPC(address(), 'tools/list', {}), e => e.notDelivered === true)
})

test('사용자 작업을 우선하고 요청·명시적 회신을 보존하며 idle 앱을 UI 없이 이어 간다', async () => {
  const cc = randomUUID(), cx = randomUUID(), A = appSessionId('claude', cc), B = appSessionId('codex', cx)
  const log = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p', `${cc}.jsonl`)
  save(file('sessions', A), { id: A, provider: 'claude', transport: 'hook', conversationId: cc,
    state: 'running', workspaces: [repo], repos: [repoId], registeredAt: new Date().toISOString(),
    dialogueMode: { until: new Date(Date.now() + 60000).toISOString(), maxTurns: 8, used: 0, waitSeconds: 540 } })
  save(file('sessions', B), { id: B, provider: 'codex', transport: 'hook', conversationId: cx,
    state: 'running', fullyIdle: false, workspaces: [repo], repos: [repoId], registeredAt: new Date().toISOString() })
  const inbox = address(), pipe = address(), inbound = [], calls = []
  const peers = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions'); fs.mkdirSync(peers, { recursive: true })
  const canonical = inbox.startsWith('\\\\.\\pipe\\') ? inbox.toLowerCase() : inbox
  const hash = createHash('sha256').update(canonical).digest('hex')
  save(path.join(peers, `${process.pid}.json`), { pid: process.pid, sessionId: cc, messagingSocketPath: inbox, procStart: 'test', pidDomain: 'test' })
  save(path.join(peers, `${process.pid}.${hash}.key`), { peerToken: 'a'.repeat(32), procStartFt: 'test', pidDomain: 'test' })
  const claude = net.createServer(s => { let b = ''; s.on('data', c => b += c); s.on('end', () => inbound.push(...b.trim().split('\n').map(JSON.parse))) })
  const codex = net.createServer(s => {
    let b = Buffer.alloc(0)
    s.on('data', c => {
      b = Buffer.concat([b, c]); if (b.length < 4 || b.length < b.readUInt32LE(0) + 4) return
      const msg = JSON.parse(b.subarray(4).toString()); calls.push(msg)
      const result = msg.method === 'tools/list' ? { tools: [{ name: 'send_message_to_thread', namespace: 'codex_app' }] } : { success: true }
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result })); const h = Buffer.alloc(4); h.writeUInt32LE(body.length); s.end(Buffer.concat([h, body]))
    })
  })
  await new Promise(r => claude.listen(inbox, r)); await new Promise(r => codex.listen(pipe, r))
  let relay
  try {
    relay = await startNativeRelay({ codex: B, claude: A, repo: repoId, pipe })
    assert.equal(nativeRelayActive(json(file('sessions', A))), true)
    // 중계 연결 전의 오래된 불명/완료 요청은 재전달하지 않는다.
    const old = randomUUID(); save(file('requests', old), { id: old, repo: repoId, to: A, fromSession: B, state: 'completed', result: '옛 회신' })
    const req = enqueueAppRequest(json(file('sessions', A)), { to: A, from: '테스트', fromSession: B, repo: repoId, prompt: '문맥 확인' })
    await new Promise(r => setTimeout(r, 30))
    assert.equal(json(file('requests', req.id)).state, 'queued', '사용자 작업 중에는 파이프에 넣지 않는다')
    assert.equal(inbound.length, 0)
    handleAppHook({ session_id: cc, transcript_path: log, cwd: repo, last_assistant_message: '사용자 작업 완료' }, 'Stop', 'claude')
    await wait(() => json(file('requests', req.id)).state === 'submitted' && inbound.length === 2)
    assert.equal(inbound[0].type, 'auth'); assert.equal(inbound[1].session_id, cc)
    assert.match(inbound[1].message.content, new RegExp(req.id))
    // 원래 사용자의 작업이 끝났다는 이유만으로 아직 읽지 않은 요청을 완료하면 안 된다.
    save(log, { type: 'assistant', message: { content: [{ type: 'text', text: '원래 작업의 답' }] } })
    const boundary = handleAppHook({ session_id: cc, transcript_path: log, cwd: repo, last_assistant_message: '원래 작업의 답' }, 'Stop', 'claude')
    assert.equal(boundary.decision, 'block')
    assert.match(boundary.reason, /ax_reply/)
    assert.equal(json(file('requests', req.id)).state, 'submitted')
    const next = enqueueAppRequest(json(file('sessions', A)), { to: A, from: '테스트', repo: repoId, prompt: '후속 요청' })
    await new Promise(r => setTimeout(r, 30)); assert.equal(json(file('requests', next.id)).state, 'queued')
    fs.writeFileSync(log, JSON.stringify({ type: 'user', message: { content: `[axMap 요청 ${req.id}] 질문` } }) + '\n' + JSON.stringify({ type: 'user', message: { content: `[axMap 회신 ${randomUUID()}] 작업 중 돌아온 회신` } }) + '\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '기존 문맥의 응답' }] } }) + '\n')
    const output = handleAppHook({ session_id: cc, transcript_path: log, cwd: repo, last_assistant_message: '기존 문맥의 응답' }, 'Stop', 'claude', { sleep: () => { throw Error('네이티브 연결에서 훅 대기는 금지') } })
    assert.equal(output.decision, 'block')
    assert.equal(json(file('requests', req.id)).result, undefined, '마지막 답변은 자동 회신하지 않는다')
    // 사람이 끼어들어도 요청을 취소하지 않고, 다음 사용자 답변을 회신으로 오인하지 않는다.
    handleAppHook({ session_id: cc, transcript_path: log, cwd: repo, prompt: '사용자의 새 작업' }, 'UserPromptSubmit', 'claude')
    assert.equal(json(file('requests', req.id)).state, 'submitted')
    replyAppRequest({ id: req.id, session: A, cwd: repo, text: '명시적 협업 회신' })
    await new Promise(r => setTimeout(r, 30))
    assert.equal(json(file('requests', req.id)).returnedAt, undefined, '보낸 쪽 작업 중에는 회신도 큐에 둔다')
    assert.equal(calls.filter(c => c.method === 'tools/call').length, 0)
    save(file('sessions', B), { ...json(file('sessions', B)), state: 'idle', fullyIdle: true })
    await wait(() => json(file('requests', req.id)).returnedAt)
    const sent = calls.filter(c => c.method === 'tools/call')
    assert.equal(sent.length, 1); assert.equal(sent[0].params.arguments.threadId, cx)
    assert.match(sent[0].params.arguments.prompt, /명시적 협업 회신/)
    assert.doesNotMatch(sent[0].params.arguments.prompt, /원래 작업의 답/)
    assert.equal(json(file('requests', old)).returnedAt, undefined)
    handleAppHook({ session_id: cc, transcript_path: log, cwd: repo, last_assistant_message: '사용자 작업 답' }, 'Stop', 'claude')
    await wait(() => json(file('requests', next.id)).state === 'submitted')
    assert.deepEqual(handleAppHook({ session_id: cc, transcript_path: log, cwd: repo, prompt: '사용자의 새 작업' }, 'UserPromptSubmit', 'claude'), {})
    assert.equal(json(file('requests', next.id)).state, 'submitted')
    replyAppRequest({ id: next.id, session: A, cwd: repo, text: '완료' })
    handleAppHook({ session_id: cc, transcript_path: log, cwd: repo }, 'Stop', 'claude')
    // 일반 회신 쪽지도 idle에서 한 번만 편지함 회수 알림으로 전달한다.
    const mail = postMail({ to: A, cwd: repo, from: B, text: '검토 결과 알림' })
    await wait(() => inbound.filter(x => x.type === 'user').length === 3)
    assert.match(inbound.at(-1).message.content, /ax_mailbox/)
    assert.equal(collectMail({ to: A, cwd: repo }).messages[0].id, mail.mail.id)
    collectMail({ to: A, cwd: repo, take: true, at: 'checkpoint' })
    await new Promise(r => setTimeout(r, 30))
    assert.equal(inbound.filter(x => x.type === 'user').length, 3)
    assert.equal(calls.some(c => c.method === 'thread/start'), false)
    assert.equal(fs.readdirSync(path.join(base, 'sessions')).length, 2)
  } finally {
    relay?.close(); await new Promise(r => claude.close(r)); await new Promise(r => codex.close(r))
  }
  assert.equal(nativeRelayActive(json(file('sessions', A))), false)
  // 중계가 종료돼도 과거 540초 훅 대기를 되살리면 안 된다.
  assert.deepEqual(handleAppHook({ session_id: cc, transcript_path: log, cwd: repo, last_assistant_message: '사용자 작업 답' }, 'Stop', 'claude', { sleep: () => { throw Error('중계 종료 뒤에도 훅 대기는 금지') } }), {})
  const offline = enqueueAppRequest(json(file('sessions', A)), { to: A, from: '테스트', repo: repoId, prompt: '연결 복구 후 처리할 요청' })
  assert.equal(offline.state, 'queued', '연결이 끊겨도 접수하고 영속 보관한다')
  handleAppHook({ session_id: cc, transcript_path: log, cwd: repo }, 'SessionEnd', 'claude')
  assert.equal(json(file('requests', offline.id)).state, 'queued', '앱을 닫아도 큐는 남는다')
  // 같은 고정 중계 ID로 복구하면 미전송 요청부터 이어 간다.
  const originalServer = net.createServer(s => { let b = ''; s.on('data', c => b += c); s.on('end', () => inbound.push(...b.trim().split('\n').map(JSON.parse))) })
  const nextCodex = net.createServer(s => {
    s.on('data', () => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'send_message_to_thread', namespace: 'codex_app' }] } }))
      const h = Buffer.alloc(4); h.writeUInt32LE(body.length); s.end(Buffer.concat([h, body]))
    })
  })
  await new Promise(r => originalServer.listen(inbox, r)); await new Promise(r => nextCodex.listen(pipe, r))
  let recovered
  try {
    const fixedId = json(file('sessions', A)).nativeRelay.id
    recovered = await startNativeRelay({ codex: B, claude: A, repo: repoId, pipe, relayId: fixedId, reconnect: true })
    await wait(() => json(file('requests', offline.id)).state === 'submitted')
    recovered.close()
    handleAppHook({ session_id: cc, transcript_path: log, cwd: repo }, 'SessionEnd', 'claude')
    recovered = await startNativeRelay({ codex: B, claude: A, repo: repoId, pipe, relayId: fixedId, reconnect: true })
    await wait(() => inbound.some(x => x.message?.content?.includes('명시적 회신이 없는 요청')))
    assert.equal(inbound.filter(x => x.message?.content?.includes('연결 복구 후 처리할 요청')).length, 1, '전달된 작업을 재실행하지 않고 원문 조회 알림만 보낸다')
    assert.equal(json(file('requests', offline.id)).state, 'submitted')
  } finally {
    recovered?.close(); await new Promise(r => originalServer.close(r)); await new Promise(r => nextCodex.close(r))
  }
  save(path.join(peers, `${process.pid}.${hash}.key`), { peerToken: 'a'.repeat(32), procStartFt: 'other' })
  assert.throws(() => claudePeer(cc), /신원/)
})
