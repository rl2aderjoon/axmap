import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('MCP exposes local session tools; missing sessions are errors with no ledger bootstrap', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-mcp-bridge-'))
  try {
    spawnSync('git', ['init', '-q'], { cwd: repo })
    const server = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))
    const requests = [
      { id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bridge-test', version: '1' } } },
      { id: 1, method: 'tools/list' },
      { id: 2, method: 'tools/call', params: { name: 'ax_sessions', arguments: {} } },
      { id: 3, method: 'tools/call', params: { name: 'ax_dispatch', arguments: { to: '00000000-0000-0000-0000-000000000000', prompt: 'hello' } } },
    ]
    const r = spawnSync(process.execPath, [server], { cwd: repo, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, AXMAP_REPO: repo, AXMAP_AGENT: 'bridge-test', AXMAP_STATE_DIR: path.join(repo, 'state') },
      input: requests.map(x => JSON.stringify({ jsonrpc: '2.0', ...x })).join('\n') + '\n', timeout: 30000,
    })
    assert.equal(r.status, 0, r.stderr)
    const responses = new Map(r.stdout.trim().split('\n').map(s => { const m = JSON.parse(s); return [m.id, m] }))
    const names = responses.get(1).result.tools.map(t => t.name)
    for (const name of ['ax_sessions', 'ax_dispatch', 'ax_result']) assert.ok(names.includes(name))
    assert.equal(responses.get(2).result.isError, false)
    assert.deepEqual(JSON.parse(responses.get(2).result.content[0].text), [])
    assert.equal(responses.get(3).result.isError, true)
    assert.equal(fs.existsSync(path.join(repo, '.axmap')), false)
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
})
