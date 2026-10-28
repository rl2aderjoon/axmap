#!/usr/bin/env node
import { runMonitor } from '../src/monitor-cli.mjs'
import { errorMessage } from '../src/session-types.mjs'

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('axmap view [--cwd <repo>] [--interval 1000] [--once | --json] [--no-color]\n실제 세션·선점·대기 메시지·최근 이벤트를 터미널에서 표시합니다. q / Esc / Ctrl+C 종료.')
} else {
  try { await runMonitor(['--view', ...process.argv.slice(2)]) }
  catch (e) { console.error(`axMap view: ${errorMessage(e)}`); process.exitCode = 1 }
}
