import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { installPipelineStatusline, pipelineStatusline } from '../src/pipeline-statusline.mjs'
import { repoKey, writeJSON } from '../src/bridge.mjs'

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-statusline-'))
  const previous = process.env.AXMAP_STATE_DIR
  process.env.AXMAP_STATE_DIR = path.join(root, 'state')
  const cwd = path.join(root, 'repo'); fs.mkdirSync(cwd)
  spawnSync('git', ['init', '-q'], { cwd, windowsHide: true })
  try { await run({ root, cwd, home: path.join(root, 'home'), repo: repoKey(cwd) }) }
  finally {
    if (previous === undefined) delete process.env.AXMAP_STATE_DIR; else process.env.AXMAP_STATE_DIR = previous
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}
test('native status adapters preserve existing settings and previous command output, with reversible install', async () => fixture(async ({ root, cwd, home }) => {
  const legacy = path.join(root, 'legacy.cjs')
  fs.writeFileSync(legacy, "const fs=require('fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write('previous:'+input.marker)")
  for (const provider of ['claude', 'agy']) {
    const target = provider === 'claude' ? path.join(home, '.claude', 'settings.json') : path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
    const original = { model: 'preserved', permissions: { marker: true }, statusLine: { type: 'command',
      command: `"${process.execPath.replaceAll('\\', '/')}" "${legacy.replaceAll('\\', '/')}"`, padding: 2 } }
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(original))
    const installed = installPipelineStatusline(provider, home)
    assert.equal(installed.previousPreserved, true)
    assert.equal(fs.readFileSync(installed.backup, 'utf8'), JSON.stringify(original))
    const current = JSON.parse(fs.readFileSync(target, 'utf8'))
    assert.equal(current.model, 'preserved'); assert.deepEqual(current.permissions, original.permissions)
    assert.equal(current.statusLine.padding, 2)
    if (provider === 'agy') assert.equal(current.statusLine.stack_with_default, true)
    else assert.equal(current.statusLine.refreshInterval, 2)
    installPipelineStatusline(provider, home)
    const text = await pipelineStatusline(provider, JSON.stringify({ cwd, marker: 'KEPT', agent_state: 'working' }), home)
    assert.match(text, /previous:KEPT\naxMap/)
    installPipelineStatusline(provider, home, true)
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), original)
    assert.equal(await pipelineStatusline(provider, JSON.stringify({ cwd, marker: 'ONLY' }), home), 'previous:ONLY')
  }
}))
test('statusline reads provider state and existing request records without probing or submitting work', async () => fixture(async ({ cwd, home, repo }) => {
  const id = randomUUID(), directory = path.join(process.env.AXMAP_STATE_DIR, 'bridge', 'requests')
  const job = { id, to: randomUUID(), repo, from: 'test', prompt: 'work', state: 'submitted', baseline: 0, createdAt: new Date().toISOString() }
  writeJSON(path.join(directory, `${id}.json`), job)
  const pending = await pipelineStatusline('agy', JSON.stringify({ cwd, agent_state: 'tool_use', terminal_width: 100 }), home)
  assert.match(pending, /agy 도구 실행/)
  assert.match(pending, /응답 대기/)
  assert.doesNotMatch(pending, /완료 ✓/)
  writeJSON(path.join(directory, `${id}.json`), { ...job, state: 'completed' })
  const done = await pipelineStatusline('claude', JSON.stringify({ workspace: { current_dir: cwd }, terminal_width: 100 }), home)
  assert.match(done, /완료 ✓/)
  assert.equal(fs.readdirSync(directory).filter(n => n.endsWith('.json')).length, 1)
  assert.equal(fs.existsSync(path.join(cwd, '.axmap')), false)
}))
test('unreadable settings are not replaced', async () => fixture(async ({ home }) => {
  const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{broken')
  assert.throws(() => installPipelineStatusline('agy', home))
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
}))
test('pipeline CLI exposes native statusline setup without opening another window', () => {
  const cli = fileURLToPath(new URL('../bin/axmap.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cli, 'pipeline', '--help'], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /install-statusline --provider claude\|agy/)
  assert.match(result.stdout, /새 창은 열지 않습니다/)
})
