#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { startNativeSupervisor } from '../src/app-native-supervisor.mjs'
const args = process.argv.slice(2), at = args.indexOf('--config')
try {
  if (at < 0 || !args[at + 1] || !path.isAbsolute(args[at + 1])) throw new Error('--config <자동 연결 설정의 절대 경로>가 필요합니다.')
  const profile = JSON.parse(fs.readFileSync(args[at + 1], 'utf8').replace(/^\uFEFF/, ''))
  const supervisor = await startNativeSupervisor(profile)
  if (supervisor.duplicate) process.exit(0)
  const close = () => { supervisor.close(); process.exit(0) }
  process.once('SIGINT', close); process.once('SIGTERM', close)
} catch (e) { console.error(e.message); process.exitCode = 1 }
