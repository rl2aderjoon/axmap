#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { startTerminal, sendTerminal, installTerminalHooks, installTerminalRuntime } from '../src/terminal-bridge.mjs'
import { registerExternalHook } from '../src/external-console.mjs'
import { RPC_NOT_DELIVERED_EXIT } from '../src/session-types.mjs'

const [command, ...args] = process.argv.slice(2)
try {
  if (command === 'install-runtime') {
    console.log(JSON.stringify(installTerminalRuntime(args[0])))
  } else if (command === 'install-hooks') {
    console.log(JSON.stringify({ hooks: [installTerminalHooks(), installTerminalHooks(undefined, 'codex')] }))
  } else if (command === 'rpc') {
    try { console.log(JSON.stringify(await sendTerminal(args[0], JSON.parse(fs.readFileSync(0, 'utf8'))))) }
    catch (e) {
      if (e?.notDelivered !== true) throw e
      // 연결 전에 실패해 아무것도 보내지 않았다. 호출한 쪽(bridge.terminalRPC)이
      // 문구가 아니라 종료 코드로 "확실히 미전달"을 알아보게 한다.
      console.error(e.message); process.exitCode = RPC_NOT_DELIVERED_EXIT
    }
  } else if (command === 'hook') {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'))
    if (process.env.AXMAP_TERMINAL_SESSION && process.env.AXMAP_TERMINAL_TOKEN) {
      await sendTerminal(process.env.AXMAP_TERMINAL_SESSION, { action: 'hook', event: args[0], input }, process.env.AXMAP_TERMINAL_TOKEN)
    } else if (process.platform === 'win32' && input.conversationId) {
      try { registerExternalHook(input, args[0]) }
      catch (e) { console.error(`axMap 독립 콘솔: ${e.message}`) }
    }
    console.log('{}')
  } else if (command === '--help' || !command) {
    console.log('axmap run agy|codex [기존 CLI 인수...] [--cwd 작업폴더]\n사용자가 여는 실제 CLI 터미널을 유지합니다. 별도 연결 URL은 필요 없습니다.')
  } else {
    if (!['agy', 'codex'].includes(command)) throw new Error('현재 실행 도구는 agy 또는 codex입니다.')
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('사용자가 연 대화형 터미널에서 실행하세요. 새 백그라운드 AI 세션은 만들지 않습니다.')
    const cwdAt = args.indexOf('--cwd')
    let cwd = process.cwd()
    if (cwdAt >= 0) {
      if (!args[cwdAt + 1]) throw new Error('--cwd 뒤에 작업 폴더를 지정하세요.')
      cwd = path.resolve(args[cwdAt + 1]); args.splice(cwdAt, 2)
    }
    const found = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true })
    const executable = found.stdout?.split(/\r?\n/).map(s => s.trim()).find(s => s && (process.platform !== 'win32' || path.extname(s).toLowerCase() === '.exe'))
    if (!executable) throw new Error(`${command} 실행 파일을 찾지 못했습니다.`)
    installTerminalHooks(undefined, command)
    if (command === 'codex') console.error('Codex가 새 훅의 신뢰 확인을 요청하면 /hooks에서 axMap 훅을 검토하세요. 승인을 자동으로 우회하지 않습니다.')
    let terminal
    const oldRaw = process.stdin.isRaw
    try {
      terminal = await startTerminal({ executable, args, provider: command, cwd, cols: process.stdout.columns || 100, rows: process.stdout.rows || 30, onData: data => process.stdout.write(data) })
      console.error(`axMap 연결 세션: ${terminal.id}`)
      process.stdin.setRawMode(true); process.stdin.resume()
      const input = data => terminal.input(data.toString('utf8'))
      const resize = () => terminal.resize(process.stdout.columns || 100, process.stdout.rows || 30)
      process.stdin.on('data', input); process.stdout.on('resize', resize)
      const stop = () => terminal.close()
      process.once('SIGTERM', stop)
      const ev = await terminal.exited
      process.removeListener('SIGTERM', stop)
      process.stdin.off('data', input); process.stdout.off('resize', resize)
      process.exitCode = ev.exitCode
    } finally {
      process.stdin.setRawMode(oldRaw); process.stdin.pause()
      process.stdout.write('\x1b[?2004l\x1b[?25h')
    }
    // node-pty's Windows output worker can outlive the exited console. This
    // standalone terminal host has finished; release its remaining native handles.
    process.exit(process.exitCode || 0)
  }
} catch (e) { console.error(e.message); process.exitCode = 1 }
