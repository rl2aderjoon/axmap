#!/usr/bin/env node
import { startNativeRelay } from '../src/app-native.mjs'
import { repoKey } from '../src/bridge.mjs'
const args = process.argv.slice(2)
const option = name => args[args.indexOf(`--${name}`) + 1]
try {
  if (!args.includes('--codex') || !args.includes('--claude') || !args.includes('--cwd')) throw new Error('node tools/app-native.mjs --codex <axMap UUID> --claude <axMap UUID> --cwd <저장소>')
  const relay = await startNativeRelay({ codex: option('codex'), claude: option('claude'), repo: repoKey(option('cwd')),
    pipe: process.env.CODEX_APP_TOOLS_PIPE_PATH, onEvent: e => console.log(JSON.stringify(e)) })
  console.log(JSON.stringify({ event: 'ready', id: relay.id, pid: process.pid }))
  const close = () => { relay.close(); process.exit(0) }
  process.once('SIGTERM', close); process.once('SIGINT', close)
} catch (e) { console.error(e.message); process.exitCode = 1 }
