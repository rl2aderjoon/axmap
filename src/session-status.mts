import { sessions } from './bridge.mjs'
import { sendTerminal } from './terminal-bridge.mjs'
import { externalStatus } from './external-console.mjs'
import type { PublicSession, SessionSnapshot, SessionState, ConnectionState } from './session-types.mjs'

/** Probe only the authenticated local control pipe. A saved idle/running record
 * cannot establish that its host still exists; no model request is submitted. */
export async function sessionStatus(cwd = process.cwd()): Promise<SessionSnapshot[]> {
  const listed = sessions(cwd)
  return Promise.all(listed.map(async session => {
    const base = { ...session, lastKnownState: session.state ?? null }
    const snapshot = (state: SessionState, connection: ConnectionState, extra: Partial<PublicSession> = {}): SessionSnapshot => ({ ...base, ...extra, state, connection,
      fullyIdle: connection === 'connected' && state === 'idle', checkedAt: new Date().toISOString() })
    if (session.state === 'closed') return snapshot('closed', 'closed')
    if (session.transport === 'console') {
      try {
        const live = externalStatus(session)
        return snapshot(live.state, 'connected')
      } catch { return snapshot('unknown', 'unreachable') }
    }
    if (!['pty', 'stdio'].includes(session.transport || '')) return snapshot('unknown', 'unverified')
    try {
      const raw: unknown = await sendTerminal(session.id, { action: 'status' }, null, { timeoutMs: 1000 })
      const live = raw as Partial<PublicSession> | null
      if (live?.id !== session.id || !live.state || !['starting', 'running', 'idle', 'awaiting_user', 'settling', 'closed'].includes(live.state)) {
        return snapshot('unknown', 'unreachable')
      }
      return snapshot(live.state, 'connected', {
        usage: live.usage === undefined ? session.usage : live.usage,
        pendingApproval: live.pendingApproval,
      })
    } catch {
      // A disconnected host or a timeout is not proof of a completed task.
      return snapshot('unknown', 'unreachable')
    }
  }))
}

const labels = { starting: '시작 중', running: '작업 중', idle: '대기', awaiting_user: '승인 대기',
  settling: '대기 전환 중', closed: '종료', unknown: '상태 미확인' }
const connections = { connected: '연결됨', closed: '종료됨', unreachable: '연결 확인 불가', unverified: '확인 미지원' }
const safe = (value: unknown) => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')

export function formatSessionStatus(listed: readonly SessionSnapshot[]): string {
  if (!listed.length) return '이 저장소에 등록된 로컬 세션이 없습니다.'
  return ['axMap 세션 상태', ...listed.map(s => {
    const usage = s.usage?.totalTokens == null ? '미확인' : `${s.usage.totalTokens}${s.maxTokens ? ` / ${s.maxTokens}` : ''}`
    return `${safe(s.provider)}  ${safe(s.id)}\n  ${connections[s.connection] || '상태 미확인'} · ${labels[s.state] || '상태 미확인'}${s.role ? ` · ${safe(s.role)}` : ''}\n  확인된 누적 처리 토큰: ${usage}`
  })].join('\n')
}
