#!/usr/bin/env node
import fs from 'node:fs'
import { dispatchRequest, installHooks, registerHook, requestResult, sessions, uninstallHooks } from '../src/bridge.mjs'

const args = process.argv.slice(2)
const [command] = args
const option = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] }
const output = (value) => console.log(JSON.stringify(value, null, 2))
try {
  switch (command) {
    case 'install':
      if (!args.includes('--experimental')) throw new Error('실험용 연결입니다. 현재 검증한 CLI는 필요한 연결 정보를 훅에 제공하지 않습니다. 확인 후 --experimental로 명시하세요.')
      output(installHooks({ executable: option('executable') })); break
    case 'uninstall': output(uninstallHooks()); break
    case 'hook': {
      const input = JSON.parse(fs.readFileSync(0, 'utf8'))
      try {
        registerHook(input, option('event'), { ...process.env, AXMAP_AGY_EXECUTABLE: option('executable') })
      } catch (e) { console.error(`axMap bridge: ${e.message}`) }
      // Observe only. Never alter a provider's permission or continuation decision.
      output({})
      break
    }
    case 'sessions': output(sessions(process.cwd())); break
    case 'send': {
      const r = dispatchRequest({ to: option('to'), prompt: fs.readFileSync(0, 'utf8'), cwd: process.cwd(), from: process.env.AXMAP_AGENT || 'axmap' })
      output(r)
      if (r.state === 'unknown') process.exitCode = 2
      break
    }
    case 'result': output(requestResult(args[1], process.cwd())); break
    case undefined:
    case '--help':
      console.log(`실험용 프로토타입: 현재 CLI 실측에서는 수신 연결 정보를 받지 못했습니다.
axmap bridge install --experimental --executable <agy 절대 경로>   연결 훅 실험
axmap bridge uninstall                             추가한 연결 훅 해제
axmap bridge sessions                              이 repo에 연결된 세션
axmap bridge send --to <세션 UUID>                  본문은 stdin. 기존 세션에 전달
axmap bridge result <요청 UUID>                     제출/완료/불명 상태와 결과
현재 수신 어댑터: Antigravity CLI agentapi (실측 검증 전에는 사용 가능으로 단정하지 않음)`)
      break
    default: throw new Error(`알 수 없는 bridge 명령: ${command}`)
  }
} catch (e) { console.error(e.message); process.exitCode = 1 }
