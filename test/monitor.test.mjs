import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createMonitor, renderMonitor, terminalText, fitTerminal } from '../src/monitor.mjs'
import { repoKey, writeJSON } from '../src/bridge.mjs'

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-monitor-'))
  const saved = { AXMAP_STATE_DIR: process.env.AXMAP_STATE_DIR, AXMAP_AGY_HOME: process.env.AXMAP_AGY_HOME }
  const cwd = path.join(root, 'repo'); fs.mkdirSync(cwd)
  assert.equal(spawnSync('git', ['init', '-q'], { cwd, windowsHide: true }).status, 0)
  process.env.AXMAP_STATE_DIR = path.join(root, 'state'); process.env.AXMAP_AGY_HOME = path.join(root, 'agy')
  try { await run({ root, cwd, repo: repoKey(cwd), bridge: path.join(root, 'state', 'bridge') }) }
  finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}
const request = (repo, overrides = {}) => ({ id: randomUUID(), to: randomUUID(), from: 'codex', repo,
  prompt: '변경 사항 검토', createdAt: '2026-10-26T00:00:00Z', baseline: 0, state: 'submitted', ...overrides })

test('monitor observes real transcript completion without submitting a model job or bootstrapping a ledger', async () => fixture(async ({ cwd, repo, bridge }) => {
  const id = randomUUID(), conversationId = randomUUID()
  const transcript = path.join(process.env.AXMAP_AGY_HOME, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl')
  fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.writeFileSync(transcript, '')
  const session = { id, conversationId, provider: 'agy', transport: 'agentapi', repos: [repo], workspaces: [cwd],
    transcript, fullyIdle: false, event: 'PreInvocation', registeredAt: '2026-10-26T00:00:00Z' }
  writeJSON(path.join(bridge, 'sessions', `${id}.json`), session)
  const job = request(repo, { to: id })
  writeJSON(path.join(bridge, 'requests', `${job.id}.json`), job)
  const collect = createMonitor(cwd)
  let snapshot = await collect()
  assert.equal(snapshot.requests[0].state, 'submitted')
  assert.equal(snapshot.sessions[0].connection, 'unverified')
  assert.match(renderMonitor(snapshot), /응답 대기/)
  assert.doesNotMatch(renderMonitor(snapshot), /● 완료 확인/)
  fs.appendFileSync(transcript, JSON.stringify({ type: 'USER_INPUT', content: `[axMap request ${job.id}]` }) + '\n' +
    JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '검토 완료' }) + '\n')
  writeJSON(path.join(bridge, 'sessions', `${id}.json`), { ...session, fullyIdle: true, event: 'Stop', registeredAt: '2026-10-26T00:00:01Z' })
  snapshot = await collect()
  assert.equal(snapshot.requests[0].state, 'completed')
  assert.equal(snapshot.requests[0].result, '검토 완료')
  assert.match(renderMonitor(snapshot), /● 완료 확인/)
  assert.ok(snapshot.events.some(e => /완료 확인/.test(e.label)))
  assert.equal(fs.readdirSync(path.join(bridge, 'requests')).filter(n => n.endsWith('.json')).length, 1)
  assert.equal(fs.existsSync(path.join(cwd, '.axmap')), false)
}))

test('repo isolation, active claims and damaged-record warnings survive observation failures', async () => fixture(async ({ cwd, repo, bridge }) => {
  const own = request(repo, { state: 'unknown' }), other = request('another-repo')
  writeJSON(path.join(bridge, 'requests', `${own.id}.json`), own)
  writeJSON(path.join(bridge, 'requests', `${other.id}.json`), other)
  fs.writeFileSync(path.join(bridge, 'requests', `${randomUUID()}.json`), '{broken')
  const claims = path.join(cwd, '.axmap', 'ledger', 'claims')
  writeJSON(path.join(claims, 'active.json'), { agent: 'worker', intent: '테스트', paths: ['src'], since: '2026-10-26T00:00:00Z', ttlMs: 60000 })
  writeJSON(path.join(claims, 'expired.json'), { agent: 'old', paths: ['docs'], since: '2026-10-25T00:00:00Z', ttlMs: 1 })
  let resolutions = 0
  const collect = createMonitor(cwd, { now: () => Date.parse('2026-10-26T00:00:20Z'),
    probe: async () => { throw new Error('offline') }, resolve: () => { resolutions++; throw new Error('unreachable') } })
  const snapshot = await collect()
  assert.deepEqual(snapshot.requests.map(r => r.id), [own.id])
  assert.equal(snapshot.requests[0].state, 'unknown')
  assert.deepEqual(snapshot.claims.map(c => c.agent), ['worker'])
  assert.equal(resolutions, 1)
  assert.ok(snapshot.issues.some(i => i.includes('offline')))
  assert.ok(snapshot.issues.some(i => i.includes('읽을 수 없는 기록')))
  const text = renderMonitor(snapshot)
  assert.match(text, /전달 확인 필요/)
  assert.doesNotMatch(text, /● 완료 확인/)
  assert.ok(!JSON.stringify(snapshot).includes(other.id))
}))

test('pending checks are bounded and deduplicated per recipient', async () => fixture(async ({ cwd, repo, bridge }) => {
  const jobs = Array.from({ length: 8 }, () => request(repo))
  jobs.push(request(repo, { to: jobs[0].to }))
  for (const job of jobs) writeJSON(path.join(bridge, 'requests', `${job.id}.json`), job)
  const calls = []
  await createMonitor(cwd, { probe: async () => [], resolve: id => { calls.push(id); return jobs.find(j => j.id === id) } })()
  assert.equal(calls.length, 4)
  assert.equal(new Set(calls.map(id => jobs.find(j => j.id === id).to)).size, 4)
}))

test('terminal rendering escapes controls, fits Korean text and handles small terminals', () => {
  assert.equal(terminalText('abc\x1b[2J\x1b]0;bad\x07\n\u202E한글'), 'abc 한글')
  assert.equal(fitTerminal('한글 ABC', 6), '한글 …')
  const snapshot = { cwd: 'C:/work', checkedAt: '2026-10-26T00:00:00Z', repo: 'repo', sessions: [], requests: [], dialogues: [], claims: [], events: [], issues: [] }
  for (const [columns, rows] of [[100, 36], [30, 12], [10, 4], [1, 1]]) {
    const text = renderMonitor(snapshot, { columns, rows })
    assert.ok(text.split('\n').length <= rows)
    assert.ok(text.split('\n').every(line => Array.from(line).length <= columns))
    assert.ok(!text.includes('\x1b'))
  }
  assert.match(renderMonitor(snapshot, { color: true }), /\x1b\[/)
  assert.match(renderMonitor(snapshot), /새 요청을 기다리는 중/)
  assert.match(renderMonitor({ ...snapshot, issues: ['읽기 실패'] }, { rows: 8 }), /읽기 실패/)
})
