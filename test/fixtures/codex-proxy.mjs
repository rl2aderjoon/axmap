// Minimal independent daemon byte-proxy fixture. No real model or Git calls.
import { createHash } from 'node:crypto'
let buffer = Buffer.alloc(0), upgraded = false, thread, calls = 0
const mode = process.env.AXMAP_PROXY_TEST_MODE || 'idle'
function frame(value, first = 129) {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
  const h = Buffer.alloc(body.length < 126 ? 2 : 4); h[0] = first; h[1] = body.length < 126 ? body.length : 126
  if (body.length >= 126) h.writeUInt16BE(body.length, 2)
  process.stdout.write(Buffer.concat([h, body]))
}
function reply(m) {
  if (m.method === 'thread/start') throw new Error('Must not create a new thread')
  if (m.method === 'initialize') { frame({ id: m.id, result: {} }); return }
  if (m.method === 'initialized') return
  if (m.method === 'thread/inject_items') {
    if (m.params.threadId !== thread || m.params.items[0].role !== 'user') throw new Error('Notice target/authority changed')
    frame({ id: m.id, result: {} }); return
  }
  if (m.method === 'thread/read') { thread = m.params.threadId; frame({ id: m.id, result: { thread: { id: thread, cwd: process.cwd(), status: { type: mode === 'busy' ? 'active' : 'idle' } } } }); return }
  if (m.method === 'thread/resume') { frame({ id: m.id, result: { thread: { id: mode === 'wrong-thread' ? 'wrong' : thread }, model: 'fixture' } }); return }
  if (m.method === 'turn/start') {
    calls++
    if (m.params.threadId !== thread || 'effort' in m.params) throw new Error('Original thread/config changed')
    const id = `turn-${calls}`; frame({ id: m.id, result: { turn: { id } } })
    frame({ method: 'thread/tokenUsage/updated', params: { threadId: thread, tokenUsage: { total: { inputTokens: 100000 + calls * 100, cachedInputTokens: 90000, outputTokens: 1000 + calls * 10, reasoningOutputTokens: 100, totalTokens: 101000 + calls * 110 } } } })
    const text = JSON.stringify({ method: 'item/completed', params: { threadId: thread, item: { type: 'agentMessage', text: 'same-thread reply' } } })
    frame(text.slice(0, 50), 1); frame(text.slice(50), 128)
    frame({ method: 'turn/completed', params: { threadId: thread, turn: { id, status: 'completed' } } })
  }
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  if (!upgraded) {
    const at = buffer.indexOf('\r\n\r\n'); if (at < 0) return
    const key = buffer.subarray(0, at).toString().match(/Sec-WebSocket-Key: (.+)\r\n/)?.[1]
    const accept = mode === 'bad-handshake' ? 'wrong' : createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    process.stdout.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    buffer = buffer.subarray(at + 4); upgraded = true
  }
  while (buffer.length >= 2) {
    let n = buffer[1] & 127, at = 2
    if (!(buffer[1] & 128)) throw new Error('Client frames must be masked')
    if (n === 126) { if (buffer.length < 4) return; n = buffer.readUInt16BE(2); at = 4 }
    if (n === 127) { if (buffer.length < 10) return; n = Number(buffer.readBigUInt64BE(2)); at = 10 }
    if (buffer.length < at + 4 + n) return
    const mask = buffer.subarray(at, at + 4), body = Buffer.from(buffer.subarray(at + 4, at + 4 + n))
    buffer = buffer.subarray(at + 4 + n)
    for (let i = 0; i < n; i++) body[i] ^= mask[i % 4]
    reply(JSON.parse(body.toString()))
  }
})
