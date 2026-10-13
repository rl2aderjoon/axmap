/**
 * 자식 프로세스가 **정말로** 다른 AXMAP_AGENT 를 받는가.
 *
 * 🔴 슬롯을 잘 나눠주는 것과 그 이름이 자식에게 도달하는 것은 다른 층이다.
 *    실제 사고는 뒤쪽에서 났다 — `spawn` 에 `env` 옵션이 아예 없어서 자식이
 *    서버의 환경을 통째로 물려받았고, 이름을 아무리 잘 지어도 아무 소용이 없었다.
 *    (`test/cli.test.mjs` 가 순수 로직 대신 진짜 프로세스를 돌리는 이유와 같다.)
 *
 * 그래서 여기서는 **진짜로 자식을 띄운다.** 다만 진짜 AI CLI 를 쓰면 이 PC 에
 * 무엇이 설치돼 있느냐에 따라 결과가 달라지므로, 같은 규약(JSONL 을 stdout 으로)
 * 을 지키는 가짜 CLI 를 하나 만들어 `AGENTS` 에 끼운다. 그 가짜 CLI 가 하는 일은
 * 자기가 물려받은 `AXMAP_AGENT` 를 그대로 되돌려주는 것뿐이다.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENTS } from '../app/lib/agentcli.mjs'
import * as sess from '../app/lib/session.mjs'

/** 이 값이 그대로 새어나가면(= env 를 안 주면) 두 세션이 같은 사람이 된다. */
const SERVER_NAME = 'server-inherited'

let repo = null
let script = null
const made = []

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-sessid-'))
  process.env.AXMAP_AGENT = SERVER_NAME

  script = path.join(repo, 'fake-cli.mjs')
  fs.writeFileSync(
    script,
    // 프롬프트는 stdin 으로 온다(session.mjs 머리말). 다 읽은 뒤 한 줄만 돌려준다.
    'let buf = "";\n' +
      'process.stdin.setEncoding("utf8");\n' +
      'process.stdin.on("data", (c) => { buf += c });\n' +
      'process.stdin.on("end", () => {\n' +
      '  process.stdout.write(JSON.stringify({ type: "result", result: process.env.AXMAP_AGENT ?? "(없음)" }) + "\\n");\n' +
      '});\n',
  )

  // `bin: "node"` 라야 resolveBin 이 which/where 로 실제 경로를 찾는다.
  AGENTS.push({
    id: 'fake-identity',
    name: '가짜 CLI',
    bin: 'node',
    creds: [],
    takesId: false,
    start: () => [script],
    resume: () => [script],
  })
})

after(() => {
  for (const id of made) { try { sess.remove(id) } catch { /* 이미 지워졌으면 그만 */ } }
  const i = AGENTS.findIndex((a) => a.id === 'fake-identity')
  if (i >= 0) AGENTS.splice(i, 1)
  try { fs.rmSync(repo, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ }
})

function open(title) {
  const v = sess.create({ agent: 'fake-identity', cwd: repo, title })
  made.push(v.id)
  return v
}

/** 턴이 끝날 때까지 기다린다. `send` 는 기다리지 않고 즉시 돌아오는 설계다. */
async function settle(id, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const s = sess.get(id)
    if (s && s.state !== 'running') return s
    if (Date.now() > until) throw new Error(`세션이 끝나지 않았습니다: ${id} (${s?.state})`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const saidBy = (s) => s.messages.filter((m) => m.role === 'assistant').map((m) => m.text)

describe('한 앱 안의 두 세션', () => {
  it('🔴 자식이 서로 다른 AXMAP_AGENT 를 받는다 (env 를 안 주던 시절의 버그)', async () => {
    const a = open('A')
    const b = open('B')

    assert.ok(a.axmapAgent, '세션에 이름이 없다')
    assert.notEqual(a.axmapAgent, b.axmapAgent)

    sess.send(a.id, '너는 누구냐')
    sess.send(b.id, '너는 누구냐')
    const sa = await settle(a.id)
    const sb = await settle(b.id)

    assert.equal(sa.state, 'idle', sa.error ?? '')
    assert.equal(saidBy(sa)[0], a.axmapAgent, '자식이 이 세션의 이름을 못 받았다')
    assert.equal(saidBy(sb)[0], b.axmapAgent)
    assert.notEqual(saidBy(sa)[0], saidBy(sb)[0], '두 자식이 같은 사람이 되었다')
    // 서버의 이름이 그대로 새어나가면 안 된다. 그것이 정확히 그 버그였다.
    assert.notEqual(saidBy(sa)[0], SERVER_NAME)
  })

  it('이름은 base 위에 슬롯 번호를 붙인 것이다 — 사람이 읽는다', () => {
    const c = open('C')
    assert.match(c.axmapAgent, new RegExp(`^${SERVER_NAME}-s\\d+$`))
  })

  it('세션을 닫으면 슬롯이 돌아온다', () => {
    const d = open('D')
    const name = d.axmapAgent
    sess.remove(d.id)
    const e = open('E')
    assert.equal(e.axmapAgent, name, '비어 있는 번호를 다시 준다')
  })

  it('목록과 상세 모두 이름을 내보낸다 (화면이 누구인지 그릴 수 있어야 한다)', () => {
    const f = open('F')
    const row = sess.list().find((s) => s.id === f.id)
    assert.equal(row.axmapAgent, f.axmapAgent)
    assert.equal(sess.view(sess.get(f.id)).axmapAgent, f.axmapAgent)
  })
})
