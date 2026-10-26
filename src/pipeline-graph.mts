/** Terminal topology, rendered from observations rather than fabricated progress. */
import { terminalText, fitTerminal } from './monitor.mjs'
import type { MonitorSnapshot } from './monitor.mjs'
export function renderPipelineGraph(snapshot: MonitorSnapshot, { columns = 110, rows = 42, color = false, frame = 0 } = {}): string {
  const width = Math.max(20, columns), lines: string[] = []
  const put = (text: string) => lines.push(fitTerminal(text, width))
  const cell = (text: string) => [...text].reduce((v, c) => v + (c.codePointAt(0)! >= 0x2e80 ? 2 : 1), 0)
  const card = (title: string, details: string[], inner = 42): string[] => {
    const n = Math.min(inner, width - 4)
    const output = [`┌${'─'.repeat(n)}┐`]
    for (const text of [title, ...details]) {
      const s = fitTerminal(text, n - 2)
      output.push(`│ ${s}${' '.repeat(Math.max(0, n - 1 - cell(s)))}│`)
    }
    output.push(`└${'─'.repeat(n)}┘`)
    return output
  }
  put('axMap /pipeline · LOCAL SESSION MAP')
  put(snapshot.cwd)
  put(`관측 ${snapshot.checkedAt} · 실제 이벤트만 표시`)
  lines.push(...card('axMap · 로컬 메시지 라우터', ['요청 ID · 기존 대화 유지 · Git 왕복 없음']))
  const labels: Record<string, string> = { idle: '대기', running: '실행 중', closed: '종료', awaiting_user: '사용자 승인 대기', unknown: '연결/상태 미확인', starting: '연결 중', settling: '대기 전환 중' }
  const sessions = [...snapshot.sessions].sort((a, b) => Number(b.connection === 'connected') - Number(a.connection === 'connected')).slice(0, 6)
  const count = width >= 105 ? 3 : width >= 70 ? 2 : 1
  const inner = Math.floor((width - (count - 1) * 2) / count) - 2
  const cards: string[][] = []
  for (const s of sessions) {
    const active = snapshot.requests.filter(r => r.to === s.id && ['sending', 'submitted'].includes(r.state))
    const moving = active.length && s.connection === 'connected'
    const link = `${moving ? ['●─────↓', '──●───↓', '────●─↓'][frame % 3] : '──────┤'} ${active.length ? `${active.length}건 응답 대기` : '전달 중인 요청 없음'}`
    const token = s.usage?.totalTokens == null ? '토큰 미측정' : `누적 처리 ${s.usage.totalTokens.toLocaleString()} tokens`
    cards.push([fitTerminal(link, inner + 2), ...card(`${s.provider.toUpperCase()} · ${s.role || s.id.slice(0, 8)}`, [`${labels[s.state] || s.state} · ${s.connection}`, `${s.model || '모델 미확인'} · ${s.transport || '연결 방식 미확인'}`, token], inner)])
  }
  for (let at = 0; at < cards.length; at += count) {
    const row = cards.slice(at, at + count)
    for (let line = 0; line < row[0]!.length; line++) lines.push(row.map(c => { const text = c[line] || ''; return text + ' '.repeat(Math.max(0, inner + 2 - cell(text))) }).join('  ').trimEnd())
  }
  if (!sessions.length) put('등록된 세션 없음 · bridge connect / serve로 연결')
  put('── 요청 · 응답 ──')
  for (const r of snapshot.requests.slice(0, 4)) {
    const elapsed = r.completedAt ? `${((Date.parse(r.completedAt) - Date.parse(r.createdAt)) / 1000).toFixed(2)}s` : '완료 미확정'
    put(`${terminalText(r.from)} → ${r.to.slice(0, 8)} · ${r.state} · ${elapsed}`)
    put(`  ${r.id.slice(0, 8)} · ${terminalText(r.prompt)}`)
  }
  put(`── 선점 ${snapshot.claims.length}건 · 최근 이벤트 ──`)
  for (const e of snapshot.events.slice(0, 3)) put(`${e.at.slice(11, 19)} ${terminalText(e.label)}`)
  for (const issue of snapshot.issues.slice(0, 2)) put(`확인 필요: ${terminalText(issue)}`)
  put('q / Esc 종료 · 화면 종료는 작업 취소가 아님')
  const view = lines.slice(0, Math.max(1, rows)).join('\n')
  return color ? `\x1b[36m${view}\x1b[0m` : view
}
