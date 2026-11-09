import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { replyAppRequest, pendingAppRequests } from '../src/app-queue.mjs'
import { repoKey } from '../src/bridge.mjs'

test('명시적 회신은 요청·수신자·저장소를 검증하고 재시작·중복 호출에도 보존된다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-queue-'))
  const previous = process.env.AXMAP_STATE_DIR
  try {
    process.env.AXMAP_STATE_DIR = path.join(root, 'state')
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo)
    execFileSync('git', ['init', '-q'], { cwd: repo })
    const base = path.join(process.env.AXMAP_STATE_DIR, 'bridge')
    const session = randomUUID(), other = randomUUID(), id = randomUUID()
    const file = (kind, key) => path.join(base, kind, `${key}.json`)
    const save = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)) }
    const recipient = { transport: 'hook', repos: [repoKey(repo)] }
    save(file('sessions', session), { ...recipient, id: session })
    save(file('sessions', other), { ...recipient, id: other })
    const request = { id, to: session, from: other, repo: repoKey(repo), nativeRelayId: randomUUID(), state: 'submitted', createdAt: new Date().toISOString(), prompt: '검토 요청' }
    save(file('requests', id), request)
    assert.equal(pendingAppRequests(session).length, 1)
    assert.throws(() => replyAppRequest({ id, session: other, cwd: repo, text: '잘못된 수신자' }), /이 세션이 받은/)
    save(file('requests', id), { ...request, state: 'unknown' })
    assert.throws(() => replyAppRequest({ id, session, cwd: repo, text: '불명 전송 답' }), /전달이 확인/)
    save(file('requests', id), request)
    const first = replyAppRequest({ id, session, cwd: repo, text: '검토 결과' })
    assert.equal(first.state, 'completed'); assert.equal(first.replayed, false)
    assert.equal(replyAppRequest({ id, session, cwd: repo, text: '검토 결과' }).replayed, true)
    assert.throws(() => replyAppRequest({ id, session, cwd: repo, text: '다른 결과' }), /이미 다른 회신/)
    assert.equal(pendingAppRequests(session).length, 0)
    const child = execFileSync(process.execPath, ['--input-type=module', '-e', `import {replyAppRequest} from './src/app-queue.mjs'; const r=replyAppRequest(JSON.parse(process.argv[1])); console.log(JSON.stringify(r))`, JSON.stringify({ id, session, cwd: repo, text: '검토 결과' })], { encoding: 'utf8', env: process.env })
    assert.equal(JSON.parse(child).replayed, true)
    assert.equal(JSON.parse(fs.readFileSync(file('requests', id))).result, '검토 결과')
  } finally {
    if (previous === undefined) delete process.env.AXMAP_STATE_DIR; else process.env.AXMAP_STATE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
