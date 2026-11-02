import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installTerminalHooks } from '../src/terminal-bridge.mjs'
import { consoleIdle, validateConsolePrompt, consoleCall } from '../src/external-console.mjs'

const rule = '─'.repeat(40)
const box = (input = '>', footer = '? for shortcuts') => `${rule}\r\n${input}\r\n${rule}\r\n${footer}\r\n`
test('only the final empty input box establishes console idle', () => {
  assert.equal(consoleIdle(box()), true)
  assert.equal(consoleIdle(box('> draft')), false)
  assert.equal(consoleIdle(box('>', 'esc to cancel')), false)
  assert.equal(consoleIdle(box() + box('> draft')), false)
  assert.equal(consoleIdle(`${rule}\n> previous request\nanswer\n` + box()), true)
  assert.equal(consoleIdle('answer text only'), false)
})
test('console messages preserve CRLF and Unicode but reject terminal commands', () => {
  assert.doesNotThrow(() => validateConsolePrompt('한글 "quotes"\r\nnew line\tvalue', 'agent'))
  for (const prompt of ['\x1b[201~danger', 'a\rb', '\x03', '\x00']) {
    assert.throws(() => validateConsolePrompt(prompt, 'agent'), /제어 문자/)
  }
  assert.throws(() => validateConsolePrompt('hello', 'agent\nforged'), /제어 문자/)
  assert.throws(() => consoleCall(-1), /PID|Windows/)
})

test('Claude placeholder requires cursor at the empty editor and rejects drafts or busy footers', () => {
  const screen = `${rule}\n> Try "fix tests"\n${rule}\nshift+tab to cycle\n`
  const live = { provider: 'claude', cursorX: 2, cursorRow: 1 }
  assert.equal(consoleIdle(screen, live), true)
  assert.equal(consoleIdle(screen, { ...live, cursorX: 8 }), false)
  assert.equal(consoleIdle(screen, { ...live, cursorRow: 0 }), false)
  assert.equal(consoleIdle(screen.replace('Try "fix tests"', 'my unfinished draft'), live), false)
  assert.equal(consoleIdle(screen.replace('shift+tab to cycle', 'esc to interrupt'), live), false)
})

test('Claude hook install preserves settings and unrelated hooks, is idempotent, and uses bash-safe Windows paths', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-claude-hooks-'))
  try {
    const target = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const original = { model: 'keep-model', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } }
    fs.writeFileSync(target, JSON.stringify(original))
    installTerminalHooks(home, 'claude'); installTerminalHooks(home, 'claude')
    const saved = JSON.parse(fs.readFileSync(target, 'utf8'))
    assert.equal(saved.model, original.model)
    assert.equal(saved.hooks.Stop.length, 2)
    assert.equal(saved.hooks.Stop[0].hooks[0].command, 'echo keep')
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
      const h = saved.hooks[event].at(-1).hooks[0]
      assert.ok(h.command.includes('--provider claude'))
      assert.ok(!h.command.includes('\\'))
    }
    assert.ok(fs.readdirSync(path.dirname(target)).some(n => n.includes('.bak')))
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
