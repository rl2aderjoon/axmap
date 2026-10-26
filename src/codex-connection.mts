/** Attach to an existing Codex daemon through its official byte proxy.
 * The proxy carries WebSocket frames, not JSONL. No daemon/model is started. */
import { spawn } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export type ProviderProcess = Pick<ChildProcessWithoutNullStreams, 'pid' | 'once' | 'kill'> & {
  stdin: Writable; stdout: PassThrough | ChildProcessWithoutNullStreams['stdout']; stderr: ChildProcessWithoutNullStreams['stderr']
}
const MAX = 4 * 1024 * 1024
export function websocketFrame(payload: Buffer, opcode = 1): Buffer {
  if (payload.length > MAX) throw new Error('Codex message exceeds 4MiB')
  const mask = randomBytes(4), header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10)
  header[0] = 0x80 | opcode
  if (payload.length < 126) header[1] = 0x80 | payload.length
  else if (payload.length < 65536) { header[1] = 254; header.writeUInt16BE(payload.length, 2) }
  else { header[1] = 255; header.writeBigUInt64BE(BigInt(payload.length), 2) }
  const body = Buffer.from(payload)
  for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ mask[i % 4]!
  return Buffer.concat([header, mask, body])
}

export function connectCodexProxy({ executable, prefix = [], socketPath, cwd, timeoutMs = 10000 }:
  { executable: string; prefix?: string[]; socketPath: string; cwd: string; timeoutMs?: number }): ProviderProcess {
  if (!path.isAbsolute(socketPath) || /[\r\n\0]/.test(socketPath)) throw new Error('An absolute local Codex socket path is required')
  const process = spawn(executable, [...prefix, 'app-server', 'proxy', '--sock', socketPath], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const output = new PassThrough(), key = randomBytes(16).toString('base64')
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  let buffer: Buffer = Buffer.alloc(0), upgraded = false, closed = false, fragment: Buffer[] = [], size = 0, input = ''
  const queued: string[] = []
  const fail = (message: string) => { if (closed) return; closed = true; clearTimeout(timer); output.destroy(new Error(message)); process.kill() }
  const timer = setTimeout(() => fail('Codex local socket handshake timed out'), timeoutMs)
  const send = (text: string) => process.stdin.write(websocketFrame(Buffer.from(text)))
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    input += chunk.toString()
    if (Buffer.byteLength(input) > MAX) { callback(new Error('Codex input exceeds 4MiB')); return }
    while (input.includes('\n')) {
      const at = input.indexOf('\n'), line = input.slice(0, at); input = input.slice(at + 1)
      if (!line.trim()) continue
      if (upgraded) send(line); else queued.push(line)
    }
    callback()
  } })
  process.stdin.on('error', e => fail(e.message))
  process.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > MAX + 16384) { fail('Codex frame buffer exceeds limit'); return }
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) { if (buffer.length > 16384) fail('Invalid Codex upgrade response'); return }
      const lines = buffer.subarray(0, end).toString('ascii').split('\r\n')
      const headers = new Map(lines.slice(1).map(line => { const at = line.indexOf(':'); return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()] }))
      if (!/^HTTP\/1\.1 101\b/.test(lines[0] || '') || headers.get('sec-websocket-accept') !== accept || headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        fail('Codex socket did not confirm the WebSocket handshake'); return
      }
      buffer = buffer.subarray(end + 4); upgraded = true; clearTimeout(timer)
      for (const text of queued.splice(0)) send(text)
    }
    while (buffer.length >= 2 && !closed) {
      const first = buffer[0]!, second = buffer[1]!, opcode = first & 15, fin = !!(first & 128)
      let count = second & 127, offset = 2
      if (first & 112 || second & 128) { fail('Invalid Codex WebSocket flags'); return }
      if (count === 126) { if (buffer.length < 4) return; count = buffer.readUInt16BE(2); offset = 4 }
      if (count === 127) { if (buffer.length < 10) return; const big = buffer.readBigUInt64BE(2); if (big > BigInt(MAX)) { fail('Codex frame exceeds limit'); return }; count = Number(big); offset = 10 }
      if (count > MAX || (opcode >= 8 && (!fin || count > 125))) { fail('Invalid Codex control frame'); return }
      if (buffer.length < offset + count) return
      const body = Buffer.from(buffer.subarray(offset, offset + count)); buffer = buffer.subarray(offset + count)
      if (opcode === 8) { closed = true; output.end(); process.kill(); return }
      if (opcode === 9) { process.stdin.write(websocketFrame(body, 10)); continue }
      if (opcode === 10) continue
      if ((opcode !== 1 && opcode !== 0) || (opcode === 0 && !fragment.length) || (opcode === 1 && fragment.length)) { fail('Invalid Codex text sequence'); return }
      fragment.push(body); size += body.length
      if (size > MAX) { fail('Codex fragmented message exceeds limit'); return }
      if (fin) { output.write(Buffer.concat(fragment).toString('utf8') + '\n'); fragment = []; size = 0 }
    }
  })
  process.once('exit', () => { clearTimeout(timer); output.end() })
  process.stdin.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
  return { pid: process.pid, stdin, stdout: output, stderr: process.stderr,
    once: process.once.bind(process), kill: process.kill.bind(process) }
}
