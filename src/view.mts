/** Read-only terminal view of observed sessions, claims, mail and events. */
import fs from 'node:fs'
import path from 'node:path'
import { bridgeHome } from './bridge.mjs'
import { createMonitor, fitTerminal, terminalText } from './monitor.mjs'
import type { MonitorSnapshot } from './monitor.mjs'

interface ViewMail { to: string; from: string; topic: string; text: string }
export interface ViewSnapshot extends MonitorSnapshot { mail: ViewMail[]; mailIssues: string[] }
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export function createView(cwd: string, options: Parameters<typeof createMonitor>[1] = {}): () => Promise<ViewSnapshot> {
  const collect = createMonitor(cwd, options)
  return async () => {
    const snapshot = await collect(), mail: ViewMail[] = [], mailIssues: string[] = []
    if (snapshot.issues.some(issue => issue.startsWith('세션 확인:'))) mailIssues.push('받은 편지함: 세션 목록을 확인하지 못함')
    // Reading does not create mailboxes, expire records, collect messages or wake a model.
    for (const session of snapshot.sessions.slice(0, 100)) {
      if (!uuid.test(session.id)) { mailIssues.push('받은 편지함: 세션 ID 확인 필요'); continue }
      const file = path.join(bridgeHome(), 'mailboxes', `${session.id}.json`)
      try {
        if (fs.statSync(file).size > 1024 * 1024) throw new Error('파일 크기 초과')
        const box: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!box || typeof box !== 'object' || (box as { version?: unknown }).version !== 1 || !Array.isArray((box as { messages?: unknown }).messages)) throw new Error('형식 오류')
        for (const m of (box as { messages: unknown[] }).messages) {
          if (!m || typeof m !== 'object') throw new Error('메시지 형식 오류')
          const entry = m as Record<string, unknown>
          if (entry.repo !== snapshot.repo || entry.state !== 'queued') continue
          if (entry.to !== session.id || typeof entry.from !== 'string' || typeof entry.text !== 'string' || typeof entry.expiresAt !== 'string' || !Number.isFinite(Date.parse(entry.expiresAt))) throw new Error('메시지 형식 오류')
          if (Date.parse(entry.expiresAt) <= Date.now()) continue
          mail.push({ to: session.id, from: entry.from, topic: typeof entry.topic === 'string' ? entry.topic : '', text: entry.text })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') mailIssues.push(`받은 편지함 ${session.id.slice(0, 8)}: 읽기 실패`)
      }
    }
    if (snapshot.sessions.length > 100) mailIssues.push('받은 편지함: 앞의 세션 100개만 확인')
    return { ...snapshot, mail, mailIssues }
  }
}

const labels: Record<string, string> = { idle: '대기', running: '작업 중', closed: '종료', awaiting_user: '승인 대기', unknown: '상태 미확인', starting: '시작 중', settling: '대기 전환 중' }
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
function cells(value: string): number {
  return [...segmenter.segment(value)].reduce((n, { segment }) => {
    const cp = segment.codePointAt(0) || 0
    return n + (/\p{Extended_Pictographic}/u.test(segment) || cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe10 && cp <= 0xfe6f || cp >= 0xff01 && cp <= 0xff60 || cp >= 0x20000) ? 2 : /^\p{Mark}+$/u.test(segment) ? 0 : 1)
  }, 0)
}
function pad(value: unknown, width: number): string {
  const text = fitTerminal(value, Math.max(0, width))
  return text + ' '.repeat(Math.max(0, width - cells(text)))
}

export function renderView(snapshot: MonitorSnapshot, { columns = 100, rows = 36, color = false, frame = 0 } = {}): string {
  const width = Math.max(1, Math.floor(columns)), height = Math.max(1, Math.floor(rows)), lines: string[] = []
  if (width < 20) return [fitTerminal('axMap · 화면이 좁습니다', width), fitTerminal('q 종료', width)].slice(0, height).join('\n')
  const view = snapshot as Partial<ViewSnapshot>
  const palette = {
    text: '194;197;205', muted: '137;140;150', border: '78;82;94', accent: '172;158;199',
    claude: '207;157;134', codex: '143;174;214', agy: '139;187;165', warning: '212;171;125',
  }
  type Tone = keyof typeof palette
  const paint = (text: string, tone: Tone) => color ? `\x1b[38;2;${palette[tone]}m${text}\x1b[0m` : text
  const line = (text: string, tone: Tone = 'text') => lines.push(paint(fitTerminal(text, width), tone))
  const paintBoxLine = (text: string, index: number, last: number, tone: Tone, colorStatus = false) => {
    if (index === 0 || index === last) return paint(text, 'border')
    return paint(text.slice(0, 1), 'border') + paint(text.slice(1, -1), index === 1 || colorStatus && index === 3 ? tone : 'text') + paint(text.slice(-1), 'border')
  }
  const box = (title: string, content: string[], w: number): string[] => {
    const n = Math.max(1, w - 2)
    return [`┌${'─'.repeat(n)}┐`, ...[title, ...content].map(s => `│${pad(' ' + terminalText(s), n)}│`), `└${'─'.repeat(n)}┘`]
  }
  line('axMap VIEW · 실제 로컬 관측', 'accent')
  line(`${snapshot.cwd} · ${snapshot.checkedAt}`, 'muted')
  const sessions = [...snapshot.sessions].sort((a, b) => Number(b.connection === 'connected') - Number(a.connection === 'connected')).slice(0, 3)
  const cols = width >= 90 ? 3 : width >= 58 ? 2 : 1
  const cardWidth = Math.max(3, Math.floor((width - (cols - 1) * 2) / cols))
  const cards = sessions.map(s => {
    const active = snapshot.requests.some(r => r.to === s.id && ['sending', 'submitted'].includes(r.state))
    const connection: Record<string, string> = { closed: '연결 종료', unreachable: '연결 불가', unverified: '연결 미확인' }
    const state = s.connection === 'connected' ? labels[s.state] || '상태 미확인' : connection[s.connection] || '연결 미확인'
    return box(`${s.provider.toUpperCase()} · ${s.id.slice(0, 8)}`, [s.role || '역할 미확인', `${active ? ['◐', '◓', '◑', '◒'][frame % 4] : '○'} ${state}`, s.model || '모델 미확인'], cardWidth)
  })
  for (let start = 0; start < cards.length; start += cols) {
    const group = cards.slice(start, start + cols)
    for (let i = 0; i < group[0]!.length; i++) lines.push(group.map((card, k) => {
      const provider = sessions[start + k]!.provider.toLowerCase()
      const tone: Tone = provider === 'codex' ? 'codex' : provider === 'agy' ? 'agy' : provider === 'claude' ? 'claude' : 'accent'
      return paintBoxLine(card[i]!, i, card.length - 1, tone, true)
    }).join('  '))
  }
  if (!sessions.length) line('등록된 세션 없음 · bridge 연결 후 표시', 'muted')
  const claims = snapshot.claims.flatMap(c => c.paths.map(p => `${terminalText(c.agent)} · ${terminalText(p)}`))
  const mails = view.mail?.map(m => `${terminalText(m.from)} → ${m.to.slice(0, 8)} · ${terminalText(m.topic || m.text)}`) || []
  const left = [`LEDGER · 현재 선점 ${snapshot.claims.length}건`, ...(claims.slice(0, 4).length ? claims.slice(0, 4) : ['현재 선점 없음'])]
  const right = [`MAILBOX · ${view.mailIssues?.length ? '일부 확인 실패' : `대기 ${view.mail?.length ?? 0}건`}`, ...(mails.slice(0, 4).length ? mails.slice(0, 4) : [view.mailIssues?.length ? '대기 건수 미확인' : '대기 메시지 없음'])]
  if (width >= 58) {
    const lw = Math.floor((width - 2) / 2), rw = width - lw - 2, count = Math.max(left.length, right.length)
    const a = box(left[0]!, Array.from({ length: count - 1 }, (_, i) => left[i + 1] || ''), lw)
    const b = box(right[0]!, Array.from({ length: count - 1 }, (_, i) => right[i + 1] || ''), rw)
    a.forEach((v, i) => lines.push(paintBoxLine(v, i, a.length - 1, 'accent') + '  ' + paintBoxLine(b[i]!, i, b.length - 1, 'accent')))
  } else {
    const a = box(left[0]!, left.slice(1), Math.max(3, width))
    const b = box(right[0]!, right.slice(1), Math.max(3, width))
    lines.push(...a.map((x, i) => paintBoxLine(x, i, a.length - 1, 'accent')))
    lines.push(...b.map((x, i) => paintBoxLine(x, i, b.length - 1, 'accent')))
  }
  line('── 최근 관측 이벤트 ──', 'muted')
  for (const e of snapshot.events.slice(0, 4)) line(`${terminalText(e.at.slice(11, 19))}  ${terminalText(e.label)}`)
  if (!snapshot.events.length) line('기록된 이벤트 없음', 'muted')
  for (const issue of [...snapshot.issues, ...(view.mailIssues || [])].slice(0, 2)) line(`확인 필요: ${issue}`, 'warning')
  const footer = paint(fitTerminal('q / Esc 종료 · 작업은 계속됨 · 모델 호출 없음', width), 'muted')
  return [...lines.slice(0, Math.max(0, height - 1)), footer].join('\n')
}
