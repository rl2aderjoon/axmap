#!/usr/bin/env node
import fs from 'node:fs'
import { runPipelineOperation } from '../src/pipeline-mcp.mjs'
import { errorMessage } from '../src/session-types.mjs'
import { installPipelineStatusline, pipelineStatusline } from '../src/pipeline-statusline.mjs'
const output = value => process.stdout.write(JSON.stringify(value) + '\n')
let cancelled = false
process.on('message', message => { if (message?.type === 'cancel-observation') cancelled = true })
try {
  const action = process.argv[2]
  const option = name => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? undefined : process.argv[at + 1] }
  if (!action || action === '--help' || action === '-h') {
    console.log('axmap pipeline install-statusline --provider claude|agy\naxmap pipeline uninstall-statusline --provider claude|agy\n현재 CLI의 상태줄에 axMap 진행을 표시합니다. 기존 명령은 보존하며 새 창은 열지 않습니다.\n대화 안 패널은 MCP ax_pipeline, 진행 알림은 ax_pipeline_watch를 사용하세요.')
  } else if (action === 'install-statusline' || action === 'uninstall-statusline') {
    console.log(JSON.stringify(installPipelineStatusline(option('provider'), option('home'), action === 'uninstall-statusline'), null, 2))
  } else if (action === 'statusline') {
    process.stdout.write(await pipelineStatusline(option('provider'), fs.readFileSync(0, 'utf8'), option('home')))
  } else {
    const args = JSON.parse(fs.readFileSync(0, 'utf8'))
    const result = await runPipelineOperation(action, args, message => output({ type: 'progress', message }), () => cancelled)
    output({ type: 'result', result })
  }
} catch (e) {
  if (process.argv[2] === 'statusline') console.log('axMap · 상태 확인 필요')
  else output({ type: 'result', result: { content: [{ type: 'text', text: errorMessage(e) }], isError: true } })
} finally { if (process.connected) process.disconnect() }
