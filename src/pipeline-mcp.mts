/** Portable MCP observation: structured snapshots, plain text and progress share one source. */
import { createMonitor, terminalText, fitTerminal } from './monitor.mjs'
import { dispatchRequest, requestResult } from './bridge.mjs'
import type { MonitorSnapshot } from './monitor.mjs'
import type { RequestRecord } from './session-types.mjs'

export interface PipelineOutput {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError: boolean
}
export type PipelineEmit = (message: string) => void
const labels: Record<string, string> = { sending: '전달 중', submitted: '응답 대기', completed: '완료 확인', unknown: '전송 확인 필요', failed: '실패', superseded: '다른 입력으로 대체됨' }
const pending = new Set(['sending', 'submitted', 'unknown'])

export function pipelineView(snapshot: MonitorSnapshot) {
  return {
    schemaVersion: 1, type: 'pipeline', cwd: snapshot.cwd, checkedAt: snapshot.checkedAt,
    sessions: snapshot.sessions.map(s => ({ id: s.id, provider: s.provider, state: s.state, connection: s.connection,
      model: s.model ?? null, transport: s.transport ?? null, conversationId: s.conversationId ?? null,
      role: fitTerminal(s.role, 120), usage: s.usage ?? null, pendingApproval: !!s.pendingApproval })),
    requests: snapshot.requests.map(r => ({ id: r.id, to: r.to, from: terminalText(r.from), state: r.state,
      task: fitTerminal(r.prompt, 200), createdAt: r.createdAt, completedAt: r.completedAt, usage: r.usage ?? null,
      latencyMs: r.completedAt ? Math.max(0, Date.parse(r.completedAt) - Date.parse(r.createdAt)) : null, error: fitTerminal(r.error, 240) })),
    dialogues: snapshot.dialogues.map(d => ({ id: d.id, state: d.state, turns: d.turns.length,
      maxTurns: d.limits?.maxTurns, usage: d.usage ?? null, usagePending: d.usagePending })),
    claims: snapshot.claims.slice(0, 10).map(c => ({ agent: terminalText(c.agent), task: fitTerminal(c.intent || c.task, 160),
      paths: c.paths.slice(0, 6).map(terminalText), pathCount: c.paths.length })),
    events: snapshot.events.slice(0, 15).map(e => ({ ...e, label: terminalText(e.label) })),
    issues: snapshot.issues.map(terminalText),
  }
}
export type PipelineView = ReturnType<typeof pipelineView>
export function pipelineText(view: PipelineView): string {
  const active = view.requests.filter(r => pending.has(r.state))
  const lines = [`axMap · 진행 확인 ${active.length}개 · ${view.sessions.length}개 세션`, `저장소: ${terminalText(view.cwd)}`]
  for (const session of view.sessions.slice(0, 5)) lines.push(`${session.provider} ${session.id.slice(0, 8)} · ${session.pendingApproval ? '사용자 승인 필요' : session.state} · ${session.connection}`)
  const selected = [...active, ...view.requests.filter(r => !pending.has(r.state))].slice(0, 3)
  for (const request of selected) {
    lines.push(`${request.from} → ${request.to.slice(0, 8)} · ${labels[request.state] || request.state}`)
    lines.push(request.state === 'completed' ? '접수 ✓ → 전달 ✓ → 응답 ✓ → 완료 확인 ✓' :
      request.state === 'submitted' ? '접수 ✓ → 전달 ✓ → 응답 대기 → 완료 미확정' :
      request.state === 'unknown' ? '접수 ✓ → 전달 여부 확인 필요 → 완료 미확정' : `접수 → ${labels[request.state] || request.state} → 완료 미확정`)
    lines.push(`작업: ${request.task}`)
    if (request.error) lines.push(`사유: ${request.error}`)
  }
  if (!selected.length) lines.push('새 요청을 기다리는 중')
  for (const issue of view.issues.slice(0, 2)) lines.push(`확인 필요: ${issue}`)
  return lines.join('\n')
}
function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  const result = value === undefined ? fallback : value
  if (typeof result !== 'number' || !Number.isInteger(result) || result < min || result > max) throw new Error(`${name}: ${min}~${max} 정수여야 합니다.`)
  return result
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const textResult = (text: string, structuredContent?: Record<string, unknown>, isError = false): PipelineOutput => ({ content: [{ type: 'text', text }], structuredContent, isError })

export async function runPipelineOperation(action: string, args: Record<string, unknown>, emit: PipelineEmit = () => {}, cancelled: () => boolean = () => false): Promise<PipelineOutput> {
  const cwd = process.cwd(), progress = args.__progress === true
  if (action === 'snapshot' || action === 'watch') {
    const duration = integer(args.duration_ms, action === 'watch' ? 5000 : 0, 0, 25000, 'duration_ms')
    const interval = integer(args.interval_ms, 1000, 500, 5000, 'interval_ms')
    const collect = createMonitor(cwd), deadline = Date.now() + (progress ? duration : 0)
    let view: PipelineView
    do {
      view = pipelineView(await collect())
      if (progress) {
        const active = view.requests.filter(r => pending.has(r.state))
        emit(active.length ? active.slice(0, 3).map(r => `${r.id.slice(0, 8)} ${labels[r.state]}`).join(' · ') : 'axMap · 진행 중인 요청 없음')
      }
      if (cancelled() || Date.now() >= deadline) break
      await delay(Math.min(interval, Math.max(0, deadline - Date.now())))
      if (cancelled()) break
    } while (true)
    const note = action === 'watch' && !progress ? '\n클라이언트가 progressToken을 제공하지 않아 현재 상태를 한 번 반환했습니다.' : ''
    return textResult(pipelineText(view) + note + (cancelled() ? '\n관측 대기를 중단했습니다. 이미 전달한 작업은 계속 실행될 수 있습니다.' : ''), view, cancelled())
  }
  if (action === 'dispatch' || action === 'result') {
    // Validate the wait budget before any irreversible submission.
    const waitMs = integer(args.wait_ms, 0, 0, 30000, 'wait-ms')
    let request: RequestRecord
    if (action === 'dispatch') {
      if (typeof args.to !== 'string' || typeof args.prompt !== 'string') throw new Error('to와 prompt 문자열이 필요합니다.')
      if (progress) emit('axMap · 대상 세션과 입력 상태 확인')
      request = dispatchRequest({ to: args.to, prompt: args.prompt, cwd, from: process.env.AXMAP_AGENT || 'axmap' })
    } else {
      if (typeof args.id !== 'string') throw new Error('요청 UUID가 필요합니다.')
      request = requestResult(args.id, cwd)
    }
    const deadline = Date.now() + waitMs
    let lastMessage = '', lastAt = 0
    do {
      const message = `axMap · ${request.id.slice(0, 8)} · ${labels[request.state] || request.state}`
      if (progress && (message !== lastMessage || Date.now() - lastAt >= 1000)) { emit(message); lastMessage = message; lastAt = Date.now() }
      if (cancelled() || request.state !== 'submitted' || Date.now() >= deadline) break
      await delay(Math.min(200, Math.max(0, deadline - Date.now())))
      if (cancelled()) break
      request = requestResult(request.id, cwd)
    } while (true)
    return textResult(JSON.stringify(request, null, 2), { schemaVersion: 1, type: 'request', request,
      observationCancelled: cancelled() }, action === 'dispatch' && request.state === 'unknown')
  }
  throw new Error(`지원하지 않는 파이프라인 동작: ${action}`)
}
