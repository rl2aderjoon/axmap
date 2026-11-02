#!/usr/bin/env node
import { runConsoleQueue } from '../src/bridge.mjs'
try { runConsoleQueue(process.argv[2], process.argv[3]) } catch (e) { console.error(e.message); process.exitCode = 1 }
