import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { nativeConsoleHelper } from '../src/windows-console.mjs'

test('native console helper builds once, reuses its cache, and rejects a non-agy target', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-native-console-'))
  const previous = process.env.AXMAP_STATE_DIR
  const mode = process.env.AXMAP_CONSOLE_HELPER
  process.env.AXMAP_STATE_DIR = root
  delete process.env.AXMAP_CONSOLE_HELPER
  try {
    const helper = nativeConsoleHelper()
    const compilerAvailable = ['Framework64', 'Framework'].some(p => fs.existsSync(path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', p, 'v4.0.30319', 'csc.exe')))
    if (!compilerAvailable) { assert.equal(helper, null); return }
    assert.ok(helper, 'The available framework compiler must build the helper')
    const stat = fs.statSync(helper)
    assert.equal(nativeConsoleHelper(), helper)
    assert.equal(fs.statSync(helper).mtimeMs, stat.mtimeMs)
    const r = spawnSync(helper, [String(process.pid), 'snapshot'], { input: '{}', encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 1)
    assert.match(JSON.parse(r.stdout).error, /not agy/)
    const badAction = spawnSync(helper, [String(process.pid), 'invalid'], { input: '{}', encoding: 'utf8', windowsHide: true })
    assert.equal(badAction.status, 1)
    assert.match(JSON.parse(badAction.stdout).error, /Unsupported/)
    process.env.AXMAP_CONSOLE_HELPER = 'powershell'
    assert.equal(nativeConsoleHelper(), null)
  } finally {
    if (previous === undefined) delete process.env.AXMAP_STATE_DIR; else process.env.AXMAP_STATE_DIR = previous
    if (mode === undefined) delete process.env.AXMAP_CONSOLE_HELPER; else process.env.AXMAP_CONSOLE_HELPER = mode
    fs.rmSync(root, { recursive: true, force: true })
  }
})
