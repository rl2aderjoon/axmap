import readline from 'node:readline'
const provider = process.argv[2], mode = process.argv[3]
const cid = '11111111-2222-4333-8444-555555555555'
let turns = 0, remembered = '', active
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const complete = () => {
  const text = active.prompt
  if (text.includes('remember 731')) remembered = '731'
  const answer = mode?.includes('dialogue') ? JSON.stringify({ message: provider === 'codex' ? 'Review this.' : 'Reviewed.', done: provider === 'agy' })
    : text.includes('recall') ? remembered : 'ok'
  const usage = provider === 'agy' ? { input_tokens: 100 * turns, output_tokens: 10 * turns,
    cache_read_tokens: 50 * turns, thinking_tokens: 2 * turns, total_tokens: 110 * turns }
    : { inputTokens: 150 * turns, cachedInputTokens: 50 * turns, outputTokens: 10 * turns,
      reasoningOutputTokens: 2 * turns, totalTokens: 160 * turns }
  if (provider === 'agy') send({ event: 'result', result: { conversation_id: mode === 'wrong-id' ? 'wrong' : cid,
    status: 'SUCCESS', response: answer, usage: mode === 'no-usage' ? null : usage } })
  else {
    if (mode !== 'no-usage') send({ method: 'thread/tokenUsage/updated', params: { threadId: cid, turnId: active.id, tokenUsage: { total: usage } } })
    send({ method: 'item/completed', params: { threadId: cid, turnId: active.id, item: { type: 'agentMessage', text: answer } } })
    send({ method: 'turn/completed', params: { threadId: cid, turn: { id: active.id, status: 'completed' } } })
  }
}
if (provider === 'agy') send({ event: 'init', conversation_id: cid })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') return send({ id: m.id, result: {} })
  if (m.method === 'thread/start') return send({ id: m.id, result: { thread: { id: cid }, model: 'fixture' } })
  if (m.id === 'approval-1' && m.result) return complete()
  if (m.method === 'turn/start' || m.event === 'user') {
    turns++
    active = { id: `turn-${turns}`, prompt: provider === 'agy' ? m.message.content : m.params.input[0].text }
    if (provider === 'codex') send({ id: m.id, result: { turn: { id: active.id } } })
    if (mode === 'approval') send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: cid, turnId: active.id, command: 'example' } })
    else setTimeout(complete, mode === 'slow-dialogue' ? 1000 : 50)
  }
})
