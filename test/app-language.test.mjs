import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { userMessageLanguage, nativeRequestText, nativeReplyText, hasRequestMarker, hasReplyMarker } from '../src/app-language.mjs'

test('사용자 언어 변경을 다음 전달에 반영하며 회신 본문과 번역문을 중복하지 않는다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-language-'))
  const saved = { AXMAP_LANGUAGE: process.env.AXMAP_LANGUAGE, AXMAP_STATE_DIR: process.env.AXMAP_STATE_DIR, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
  try {
    delete process.env.AXMAP_LANGUAGE
    process.env.AXMAP_STATE_DIR = path.join(root, 'axmap'); process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR)
    const settings = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')
    fs.writeFileSync(settings, JSON.stringify({ language: 'korean' }))
    const request = { id: randomUUID(), state: 'completed', prompt: '현재 작업을 알려 주세요.', fromSession: randomUUID(), result: '현재 측정 중입니다.' }
    assert.equal(userMessageLanguage(), 'ko')
    assert.match(nativeRequestText(request), /한국어로 한 번만/)
    assert.doesNotMatch(nativeRequestText(request), /Reply once|\[axMap request/)
    const reply = nativeReplyText(request)
    assert.equal(reply.split(request.result).length - 1, 1)
    assert.match(reply, /\[axMap 회신/); assert.doesNotMatch(reply, /completed|Completed|reply|상태:/)
    fs.writeFileSync(settings, JSON.stringify({ language: 'English' }))
    assert.equal(userMessageLanguage(), 'en')
    assert.match(nativeRequestText(request), /Reply once in English/)
    assert.doesNotMatch(nativeRequestText(request), /한국어로|보낸 세션/)
    // 기록과 진행 중인 요청은 표시 언어가 바뀌어도 같은 ID로 대조한다.
    assert.equal(hasRequestMarker(`[axMap 요청 ${request.id}]`, request.id), true)
    assert.equal(hasRequestMarker(`[axMap request ${request.id}]`, request.id), true)
    assert.equal(hasRequestMarker(`[axMap 요청 ${randomUUID()}]`, request.id), false)
    assert.equal(hasReplyMarker(`[axMap 회신 ${request.id}]`), true)
    assert.equal(hasReplyMarker(`[axMap reply ${request.id}]`), true)
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    fs.rmSync(root, { recursive: true, force: true })
  }
})
