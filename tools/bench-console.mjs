#!/usr/bin/env node
/** Explicitly invoked real-console benchmark. Sends only the listed test prompts. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { consoleCall, attachConsole } from '../src/external-console.mjs'
import { dispatchRequest, waitForRequest } from '../src/bridge.mjs'
import { nativeConsoleHelper } from '../src/windows-console.mjs'

const args = process.argv.slice(2)
const option = n => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args[i + 1] }
const pid = Number(option('pid'))
if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Usage: node tools/bench-console.mjs --pid <agy PID> [--output file]')
if (!nativeConsoleHelper()) throw new Error('Native helper is unavailable; refusing to label fallback timings as native.')
const originalMode = process.env.AXMAP_CONSOLE_HELPER
const report = { measuredAt: new Date().toISOString(), platform: process.platform, node: process.version,
  pid, cwd: process.cwd(), snapshots: {}, requests: [], safetyChecks: {} }
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
try {
  for (const mode of ['powershell', 'native']) {
    if (mode === 'powershell') process.env.AXMAP_CONSOLE_HELPER = mode
    else delete process.env.AXMAP_CONSOLE_HELPER
    const samples = []
    for (let i = 0; i < 7; i++) {
      const start = performance.now()
      consoleCall(pid)
      samples.push(Number((performance.now() - start).toFixed(2)))
    }
    report.snapshots[mode] = { samplesMs: samples, medianMs: median(samples) }
    console.log(JSON.stringify({ event: 'snapshots', mode, ...report.snapshots[mode] }))
  }
  const live = consoleCall(pid)
  report.startedAt = live.startedAt
  for (const [name, payload] of Object.entries({ changedIdentity: { startedAt: 'invalid' }, changedScreen: { startedAt: live.startedAt, expectedScreen: 'invalid', text: 'MUST_NOT_BE_SENT' } })) {
    try { consoleCall(pid, name === 'changedScreen' ? 'send' : 'snapshot', payload); throw new Error('Safety rejection missing') }
    catch (e) {
      const expected = name === 'changedScreen' ? /Console changed/ : /identity changed/
      if (!expected.test(e.message)) throw e
      report.safetyChecks[name] = e.message
    }
  }
  const session = attachConsole({ pid, cwd: process.cwd() })
  report.sessionId = session.id
  const memory = randomUUID().slice(0, 8)
  const prompts = [
    { prompt: `Transport latency test 1. Remember the code ${memory} for the next message. Do not use tools, MCP, commands or files. Reply in this chat with exactly: AXMAP_LATENCY_READY`, expected: 'AXMAP_LATENCY_READY' },
    { prompt: 'Transport latency test 2. Do not use tools, MCP, commands or files. Reply in this chat with only the code I asked you to remember in the previous message.', expected: memory },
    { prompt: 'Transport latency test 3 (Unicode). Do not use tools, MCP, commands or files. Reply in this chat with exactly: 한글_왕복_OK', expected: '한글_왕복_OK' },
  ]
  for (const { prompt, expected } of prompts) {
    const start = performance.now()
    const request = dispatchRequest({ to: session.id, cwd: process.cwd(), from: 'codex-latency-benchmark', prompt })
    const dispatchMs = performance.now() - start
    const result = await waitForRequest(request.id, process.cwd(), 30000)
    const entry = { id: request.id, dispatchMs: Number(dispatchMs.toFixed(2)), roundTripMs: Number((performance.now() - start).toFixed(2)),
      state: result.state, expected, result: result.result, passed: result.state === 'completed' && String(result.result).includes(expected) }
    report.requests.push(entry)
    console.log(JSON.stringify({ event: 'reply', ...entry }))
    if (!entry.passed) { process.exitCode = 1; break }
  }
  report.snapshotSpeedup = Number((report.snapshots.powershell.medianMs / report.snapshots.native.medianMs).toFixed(2))
  if (option('output')) {
    const output = path.resolve(option('output'))
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  }
} finally {
  if (originalMode === undefined) delete process.env.AXMAP_CONSOLE_HELPER
  else process.env.AXMAP_CONSOLE_HELPER = originalMode
}
