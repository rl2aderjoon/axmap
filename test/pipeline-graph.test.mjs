import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderPipelineGraph } from '../src/pipeline-graph.mjs'
const snapshot = { cwd: '/repo', checkedAt: '2026-10-26T06:00:00Z', sessions: [{ id: '11111111', provider: 'codex', role: 'review', state: 'idle', connection: 'connected', model: null, transport: 'stdio', usage: null }], requests: [{ id: '22222222', to: '11111111', from: 'author', state: 'submitted', prompt: 'look\x1b[2J', createdAt: '2026-10-26T06:00:00Z' }], claims: [], events: [], issues: [] }
test('topology is driven by pending work, escapes controls and never invents completion/usage', () => {
  const waiting = renderPipelineGraph(snapshot, { columns: 100, rows: 50, frame: 1 })
  assert.match(waiting, /CODEX.*review/); assert.match(waiting, /──●───↓/); assert.match(waiting, /토큰 미측정/); assert.doesNotMatch(waiting, /\x1b|\d+%/)
  const completed = renderPipelineGraph({ ...snapshot, requests: [{ ...snapshot.requests[0], state: 'completed', completedAt: '2026-10-26T06:00:03Z' }] }, { rows: 50 })
  assert.match(completed, /3.00s/); assert.doesNotMatch(completed, /──●───↓/)
  const small = renderPipelineGraph(snapshot, { columns: 25, rows: 12 }); assert.ok(small.split('\n').length <= 12)
})
