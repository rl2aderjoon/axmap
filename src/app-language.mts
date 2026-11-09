/** 전달 문구는 사용자 언어 하나로 만든다. 원문을 번역해 병기하는 모델 호출은 하지 않는다. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RequestRecord } from './session-types.mjs'
export type MessageLanguage = 'ko' | 'en'
function normalize(value: unknown): MessageLanguage | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (/^(ko(?:[-_].*)?|korean|한국어)$/.test(v)) return 'ko'
  if (/^(en(?:[-_].*)?|english|영어)$/.test(v)) return 'en'
  return undefined
}
export function userMessageLanguage(): MessageLanguage {
  const configured = normalize(process.env.AXMAP_LANGUAGE)
  if (configured) return configured
  const files = [path.join(process.env.AXMAP_STATE_DIR || path.join(os.homedir(), '.axmap'), 'settings.json'),
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json')]
  for (const file of files) {
    try {
      const settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      const selected = normalize(settings.language || settings.locale)
      if (selected) return selected
    } catch { /* 표시 설정이 없으면 다음 사용자 설정을 확인한다. */ }
  }
  return 'ko'
}
export function requestMarker(id: string, language = userMessageLanguage()): string {
  return `[axMap ${language === 'ko' ? '요청' : 'request'} ${id}]`
}
export function replyMarker(id: string, language = userMessageLanguage()): string {
  return `[axMap ${language === 'ko' ? '회신' : 'reply'} ${id}]`
}
export function hasRequestMarker(text: string, id: string): boolean {
  return text.includes(requestMarker(id, 'ko')) || text.includes(requestMarker(id, 'en'))
}
export function hasReplyMarker(text: string): boolean { return /\[axMap (?:회신|reply) [0-9a-f-]{36}\]/i.test(text) }
export function nativeRequestText(r: RequestRecord, language = userMessageLanguage()): string {
  return language === 'ko'
    ? `${requestMarker(r.id, language)}\n보낸 세션: ${r.fromSession || r.from}\n${r.prompt}\n\n에이전트 협업 큐입니다. 최신 사용자 작업이 우선이며 작업 경계에서 처리하세요. 한국어로 한 번만 회신하세요. 마지막 답변은 자동 전송되지 않습니다. ax_reply(id="${r.id}", session="${r.to}", text=회신 본문)로 저장하세요. 도구가 없으면 axmap bridge reply --request ${r.id} --session ${r.to} --cwd <대상 저장소> 명령에 본문을 stdin으로 전달하세요. 단순 알림은 회신 대신 빈 ACK 없이 처리 완료 사실만 같은 명령으로 기록하세요.`
    : `${requestMarker(r.id, language)}\nFrom session: ${r.fromSession || r.from}\n${r.prompt}\n\nAgent collaboration queue. Respect current human work and process at a safe boundary. Reply once in English. Your final answer is not forwarded automatically. Save your response with ax_reply(id="${r.id}", session="${r.to}", text=response), or pipe it to axmap bridge reply --request ${r.id} --session ${r.to} --cwd <repository>.`
}
export function nativeReplyText(r: RequestRecord, language = userMessageLanguage()): string {
  const labels: Record<string, string> = language === 'ko'
    ? { completed: '완료', failed: '실패', unknown: '전달 여부 미확인', superseded: '사용자 입력으로 기존 요청의 응답 귀속 취소' }
    : { completed: 'Completed', failed: 'Failed', unknown: 'Delivery unconfirmed', superseded: 'Superseded by user input' }
  const body = typeof r.result === 'string' ? r.result : r.error || ''
  const state = r.state === 'completed' ? '' : `${labels[r.state] || r.state}\n`
  // 완료 본문은 한 번만 전달한다. 번역문·동일 내용의 요약·상시 안내를 덧붙이지 않는다.
  return `${replyMarker(r.id, language)}\n${state}${body}`
}
