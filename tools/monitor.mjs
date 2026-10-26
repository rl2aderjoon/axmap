#!/usr/bin/env node
import { runMonitor } from '../src/monitor-cli.mjs'
import { errorMessage } from '../src/session-types.mjs'
try { await runMonitor(process.argv.slice(2)) }
catch (e) { console.error(`axMap monitor: ${errorMessage(e)}`); process.exitCode = 1 }
