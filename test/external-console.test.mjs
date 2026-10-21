import { test } from 'node:test'
import assert from 'node:assert/strict'
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
