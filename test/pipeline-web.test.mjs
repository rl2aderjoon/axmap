import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { startPipelineWeb } from '../src/pipeline-web.mjs'
test('local graph serves scoped observations, denies foreign origins and has no mutation endpoint', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-pipeline-web-')); spawnSync('git', ['init', '-q'], { cwd, windowsHide: true })
  const web = await startPipelineWeb(cwd)
  try {
    const html = await fetch(web.url); assert.equal(html.status, 200); assert.match(await html.text(), /data-axmap-local="true"/)
    const base = new URL(web.url).origin
    const snapshot = await fetch(base + '/api/snapshot'); assert.equal(snapshot.status, 200)
    const value = await snapshot.json(); assert.equal(value.structuredContent.cwd, cwd); assert.equal(value.structuredContent.sessions.length, 0)
    assert.equal((await fetch(base + '/api/snapshot', { headers: { Origin: 'https://foreign.example' } })).status, 403)
    assert.equal((await fetch(base + '/api/snapshot', { method: 'POST' })).status, 405)
    assert.equal((await fetch(base + '/private-file')).status, 404)
    assert.equal(fs.existsSync(path.join(cwd, '.axmap')), false)
  } finally { await web.close(); await fs.promises.rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
})
