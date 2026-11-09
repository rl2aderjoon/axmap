import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startNativeSupervisor, chooseCodexPipe, autoStartFiles, validateProfile } from '../src/app-native-supervisor.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-autostart-'))
process.env.AXMAP_STATE_DIR = path.join(root, 'state')
const profile = { id: randomUUID(), codex: randomUUID(), claude: randomUUID(), codexConversation: randomUUID(),
  claudeConversation: randomUUID(), repo: '지정된 저장소', cwd: root }
const wait = async fn => { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw Error('자동 재연결 조건 시간 초과'); await new Promise(r => setTimeout(r, 10)) } }
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('로그인 실행 파일은 공백 경로를 보존하고 숨김 실행하며 외부 명령 삽입을 거절한다', () => {
  const files = autoStartFiles(path.join(root, 'Node 폴더', 'node.exe'), path.join(root, '실행 도구.mjs'), path.join(root, '설정.json'), path.join(root, '시작.vbs'))
  assert.match(files.vbs, /, 0, False/)
  assert.match(files.vbs, /Node 폴더/)
  assert.match(files.runValue, /wscript.exe/)
  assert.throws(() => autoStartFiles(path.join(root, 'bad"node'), root, root, root), /안전한 절대 경로/)
  assert.throws(() => validateProfile({ ...profile, codex: '다른 대화' }), /UUID/)
  assert.equal(chooseCodexPipe([], undefined), null)
  assert.throws(() => chooseCodexPipe(['첫째', '둘째']), /여러 개/)
  assert.equal(chooseCodexPipe(['첫째', '둘째'], '첫째'), '첫째')
})

test('앱을 기다리다가 같은 대화에 재연결하고 파이프 교체와 중복 실행을 처리한다', async () => {
  const singletonPath = process.platform === 'win32' ? `\\\\.\\pipe\\ax-auto-test-${randomUUID()}` : path.join(root, 'singleton.sock')
  const statusPath = path.join(root, 'status.json'), logPath = path.join(root, 'events.jsonl')
  let pipes = [], claude = false, healthy = true, closes = 0
  const starts = [], probes = []
  const deps = { singletonPath, statusPath, logPath, intervalMs: 20,
    pipes: () => pipes, claude: () => { if (!claude) throw Error('앱이 꺼짐') },
    probe: async (pipe, p, verifyThread) => { probes.push({ pipe, verifyThread }); if (!healthy) throw Error('파이프 종료') },
    start: async opts => { starts.push(opts); return { id: opts.relayId, close: () => closes++ } } }
  const state = () => JSON.parse(fs.readFileSync(statusPath, 'utf8')).state
  const supervisor = await startNativeSupervisor(profile, deps)
  try {
    assert.equal(state(), 'waiting-codex'); assert.equal(starts.length, 0)
    const duplicate = await startNativeSupervisor(profile, deps)
    assert.equal(duplicate.duplicate, true); duplicate.close()
    pipes = ['처음 파이프']; await wait(() => state() === 'waiting-claude')
    assert.equal(starts.length, 0)
    claude = true; await wait(() => state() === 'connected')
    assert.equal(starts.length, 1)
    assert.deepEqual([starts[0].codex, starts[0].claude, starts[0].relayId], [profile.codex, profile.claude, profile.id])
    assert.equal(starts[0].reconnect, true)
    pipes = []; await wait(() => state() === 'waiting-codex')
    assert.equal(closes, 1)
    pipes = ['재실행 파이프']; await wait(() => state() === 'connected')
    assert.equal(starts.length, 2); assert.equal(starts[1].pipe, '재실행 파이프')
    healthy = false; await wait(() => state() === 'waiting-codex')
    healthy = true; await wait(() => state() === 'connected')
    assert.equal(starts.length, 3)
    assert.ok(probes.some(p => p.verifyThread))
    // 사용자 모델 실행·새 대화 생성 기능은 supervisor 의존성에 존재하지 않는다.
    assert.equal(Object.hasOwn(starts[0], 'model'), false)
  } finally { supervisor.close() }
  assert.equal(state(), 'stopped')
})
