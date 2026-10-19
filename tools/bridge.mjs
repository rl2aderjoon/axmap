#!/usr/bin/env node
import fs from 'node:fs'
import { resolveBin } from '../src/agentcli.mjs'
import { codexInvocation } from './mcp-register.mjs'
import { dispatchRequest, installHooks, registerHook, requestResult, sessions, uninstallHooks } from '../src/bridge.mjs'
import { startManagedSession } from '../src/managed-session.mjs'
import { runDialogue, startBackgroundDialogue, dialogueResult, stopDialogue } from '../src/session-dialogue.mjs'
import { sendTerminal } from '../src/terminal-bridge.mjs'

const args = process.argv.slice(2)
const [command] = args
const option = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] }
const output = (value) => console.log(JSON.stringify(value, null, 2))
try {
  switch (command) {
    case 'serve': {
      const provider = args[1]
      if (!['codex', 'agy'].includes(provider)) throw new Error('axmap bridge serve codex|agy를 사용하세요.')
      const binary = resolveBin(provider)
      if (!binary) throw new Error(`${provider} 실행 파일을 찾지 못했습니다.`)
      const [executable, ...prefix] = provider === 'codex' ? codexInvocation(binary) : [binary]
      const session = await startManagedSession({ provider, executable, prefix, model: option('model'), role: option('role'),
        maxTokens: Number(option('max-tokens') || 100000), onEvent: output })
      output({ event: 'connected', ...session, exited: undefined, close: undefined })
      process.once('SIGINT', session.close); process.once('SIGTERM', session.close)
      const exit = await session.exited
      process.exitCode = exit.code || 0
      break
    }
    case 'chat': {
      const options = { ...(option('id') ? { id: option('id') } : {}), left: option('left'), right: option('right'), prompt: fs.readFileSync(0, 'utf8'),
        maxTurns: Number(option('max-turns') || 4), maxTokens: Number(option('max-tokens') || 50000),
        maxMessageChars: Number(option('max-message-chars') || 2000),
        onEvent: event => console.error(JSON.stringify(event)) }
      const r = args.includes('--background') ? await startBackgroundDialogue(options) : await runDialogue(options)
      output(r); if (r.state !== 'completed') process.exitCode = 2
      if (r.state === 'queued') process.exitCode = 0
      break
    }
    case 'dialogue': output(dialogueResult(args[1])); break
    case 'stop': output(stopDialogue(args[1])); break
    case 'answer': output(await sendTerminal(option('to'), { action: 'answer', id: option('request'), decision: option('decision') })); break
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
      console.log(`axMap 로컬 세션 연결 — 관리형 Codex/agy와 제한된 자동 대화
axmap bridge serve codex|agy [--model 이름] [--role 역할] [--max-tokens 100000]
    명시적으로 새 관리형 CLI를 시작합니다. 기존 창에 임의로 붙지 않습니다.
axmap bridge chat --left <UUID> --right <UUID> [--max-turns 4] [--max-tokens 50000]
    stdin 작업을 자동 중계합니다. 기본 메시지 한도 2000자, 대기 중 모델 호출 없음.
axmap bridge answer --to <UUID> --request <ID> --decision accept|decline|cancel
    Codex가 요청한 이번 실행의 승인을 사용자가 결정합니다.
axmap bridge chat ... --background                  접수 ID를 반환하고 백그라운드 중계
axmap bridge dialogue <대화 UUID>                    상태·회신·누적 토큰 조회
axmap bridge stop <대화 UUID>                        추가 중계 중단 (이미 보낸 요청은 계속될 수 있음)
axmap bridge install --experimental --executable <agy 절대 경로>   연결 훅 실험
axmap bridge uninstall                             추가한 연결 훅 해제
axmap bridge sessions                              이 repo에 연결된 세션
axmap bridge send --to <세션 UUID>                  본문은 stdin. 기존 세션에 전달
axmap bridge result <요청 UUID>                     제출/완료/불명 상태와 결과
관리형 stdio: Codex App Server / agy stream-json. PTY와 agentapi는 별도 실험 경로입니다.`)
      break
    default: throw new Error(`알 수 없는 bridge 명령: ${command}`)
  }
} catch (e) { console.error(e.message); process.exitCode = 1 }
