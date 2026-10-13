/**
 * 로컬 LLM (Ollama) — 선택적이다.
 *
 * docs/DECISIONS.md D4·D5 의 원칙을 지킨다.
 *   · LLM 은 판정하지 않는다. 설명하고 후보를 제안할 뿐이다.
 *   · LLM 이 말한 것은 기계적으로 검증한다. 검증 못 하면 그렇게 표시한다.
 *
 * Ollama 가 없으면 조용히 비활성화된다. 결정론적 기능은 전부 그대로 동작한다.
 * 폐쇄망에서 LLM 을 못 쓰는 상황이 곧 이 도구를 못 쓰는 상황이 되면 안 된다.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { outline } from './analyze.mjs'

const HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
const MODEL = process.env.AXMAP_MODEL ?? 'qwen2.5-coder:7b'
const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache')

let statusCache = null

export async function status() {
  if (statusCache && Date.now() - statusCache.at < 10_000) return statusCache
  try {
    const res = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(1500) })
    const body = await res.json()
    const models = (body.models ?? []).map((m) => m.name)
    const modelReady = models.some((m) => m === MODEL || m.startsWith(MODEL.split(':')[0]))
    statusCache = {
      at: Date.now(),
      available: true,
      host: HOST,
      model: MODEL,
      models,
      modelReady,
      thinking: modelReady ? await thinkingCapability() : false,
    }
  } catch {
    statusCache = { at: Date.now(), available: false, host: HOST, model: MODEL, models: [] }
  }
  return statusCache
}

/**
 * 이 모델이 사고 과정을 뱉는 종류인지 Ollama 에 물어본다.
 *
 * 이름으로 짐작하면 새 모델이 나올 때마다 틀린다. /api/show 의 capabilities 가
 * 답을 갖고 있다. 실패하면 false — 없는 기능을 있다고 보는 쪽이 더 위험하다.
 */
async function thinkingCapability() {
  try {
    const res = await fetch(`${HOST}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL }),
      signal: AbortSignal.timeout(3000),
    })
    return ((await res.json()).capabilities ?? []).includes('thinking')
  } catch {
    return false
  }
}

/**
 * 사고 과정을 끈다.
 *
 * 여기서 하는 일은 추출이지 추론이 아니다. 그리고 이 파이프라인에서는 사고를
 * 켤 방법이 아예 없다 — qwen3.5:9b 로 실측한 결과다.
 *   · 출력 문법을 걸면 첫 토큰부터 JSON 만 허용되어 사고할 자리가 없고,
 *     모델의 답이 통째로 thinking 필드로 가서 response 는 빈 문자열이 된다.
 *   · 문법을 풀면 사고가 끝나지 않는다. 컨텍스트 16384 · 예산 8192 로도
 *     사고에만 31,540자를 쓰고 287초 뒤 답 없이 잘렸다.
 * 둘 사이에 안전지대가 없으므로 끄는 것이 유일하게 답이 나오는 설정이다.
 *
 * 지원하지 않는 모델에 이 필드를 보내면 Ollama 가 요청을 거부하므로
 * capabilities 로 확인된 경우에만 붙인다.
 */
const thinkOpt = (s) => (s.thinking ? { think: false } : {})

/**
 * 모델별 샘플링.
 *
 * temperature 0.1 은 qwen2.5-coder:7b 에 맞춰 실측으로 굳은 값이다. 다른 모델에
 * 그대로 씌우면 배관 문제를 모델 성능으로 오해하게 된다 (thinking 계열은 기본
 * temperature 가 1 이고 낮은 값에서 반복에 빠지는 것으로 알려져 있다).
 * 그래서 아는 모델만 덮어쓰고 나머지는 모델 자신의 기본값에 맡긴다.
 *
 * presence_penalty 만은 모델과 무관하게 0 으로 못박는다. JSON 은 `{"channel":`
 * 같은 키를 반복해야 하는 형식인데 qwen3.5 의 기본값은 1.5 로 그 반복을 억제하는
 * 방향으로 작용한다. 이건 취향이 아니라 형식 요구다.
 */
const TUNED = { 'qwen2.5-coder': { temperature: 0.1 } }

/**
 * JSON 출력의 길이 한도.
 *
 * 512 였는데 실측에서 20개 중 2개가 잘렸다 (채널 8개짜리 파일들, 41 tok/s 로
 * 10~11초 = 500토큰 부근). 잘린 JSON 은 파싱에 실패하고 그 파일의 엣지가 통째로
 * 사라진다. 하필 채널이 가장 많은 파일에서 터지므로 손실이 가장 큰 곳에서 조용히 진다.
 * format:'json' 이 문법은 강제해도 길이는 강제하지 못한다.
 */
const JSON_PREDICT = 1536

function sampling(json) {
  return {
    ...(TUNED[MODEL.split(':')[0]] ?? {}),
    ...(json ? { presence_penalty: 0 } : {}),
    num_predict: json ? JSON_PREDICT : 256,
  }
}

/**
 * 모델을 미리 메모리에 올린다.
 *
 * 서버가 뜰 때 한 번 부른다. 사용자가 첫 노드를 클릭할 즈음이면 이미 올라가 있어
 * 44초짜리 콜드 스타트를 만나지 않는다. 실패해도 무시한다 — 없어도 되는 기능이다.
 */
export async function warmup() {
  const s = await status()
  if (!s.available || !s.modelReady) return s
  try {
    await fetch(`${HOST}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: 'ok', stream: false, keep_alive: KEEP_ALIVE, options: { num_predict: 1 } }),
      signal: AbortSignal.timeout(180_000),
    })
  } catch {
    /* 미리 올리기 실패는 치명적이지 않다 */
  }
  return s
}

// ---------------------------------------------------------------------------
// 캐시 — content hash 기준. 파일이 안 바뀌었으면 다시 돌리지 않는다.
// 로컬 추론은 느리므로 캐시가 성능의 대부분이다.
// ---------------------------------------------------------------------------

/**
 * 엣지 독해의 출력 문법.
 *
 * format:'json' 은 문법만 강제하고 길이는 강제하지 못한다. 실측에서 채널 10개짜리
 * 파일에 같은 채널을 방향만 바꿔가며 97줄 반복하다 num_predict 에 잘려 죽는 일이
 * 40파일 중 1~2건씩 났다 (temperature 를 0.4 까지 올려도 재현됨 — 확률로는 못 막는다).
 *
 * maxItems 를 주면 문법이 배열을 닫도록 강제하므로 그 실패가 원천적으로 사라진다.
 * 24 는 관측된 파일당 최대 채널 수(14)의 두 배 가까운 여유다. 실제 채널이 이보다
 * 많은 파일이 생기면 잘리는데, 그때는 잘림이 아니라 파일을 쪼갤 신호로 읽는 게 맞다.
 */
const EDGE_SCHEMA = {
  type: 'object',
  properties: {
    edges: {
      type: 'array',
      maxItems: 24,
      items: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          direction: { type: 'string', enum: ['pub', 'sub'] },
        },
        required: ['channel', 'direction'],
      },
    },
  },
  required: ['edges'],
}

/**
 * 핵심 줄 고르기의 출력 문법.
 *
 * EDGE_SCHEMA 와 같은 이유다. 프롬프트가 "최대 3군데"라고 말해도 그건 부탁이고,
 * maxItems 는 강제다. 엣지 독해에서 실제로 터진 반복 루프가 여기라고 안 터질
 * 이유가 없다 — 여기는 사용자가 노드를 클릭한 화면 경로라 30초 멈춤으로 나타난다.
 *
 * 줄 범위가 파일 길이 안에 드는지는 문법으로 표현할 수 없으므로 아래에서 잘라낸다.
 */
const KEY_SCHEMA = {
  type: 'object',
  properties: {
    key: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          from: { type: 'integer' },
          to: { type: 'integer' },
          why: { type: 'string' },
        },
        required: ['from', 'to', 'why'],
      },
    },
  },
  required: ['key'],
}

/** 종류별 출력 형식. 답을 바꾸는 입력이므로 캐시 키에도 들어간다. */
// `cls` 의 문법은 대분류 목록에 따라 런타임에 만들어지므로 여기 둘 수 없다.
// 하지만 키 계산은 "JSON 문법을 썼는가"를 알아야 하고(디코딩 설정이 달라진다),
// 목록 자체는 classify() 가 키 텍스트에 넣는다.
const FORMAT = { sum: undefined, keys: KEY_SCHEMA, edge: EDGE_SCHEMA, cls: 'dynamic-enum' }

/**
 * 캐시 키 = 모델 + 디코딩 설정 + 내용.
 *
 * 네 함수 모두 readCache 가 status() 보다 먼저 돈다. 키가 파일 내용만 해싱하면
 * AXMAP_MODEL 을 바꿔도 이미 캐시된 파일은 옛 모델의 답을 그대로 돌려주고,
 * 화면에는 새 모델 이름이 붙는다. 모델을 비교하는 순간 이것이 결과를 조용히 오염시킨다.
 *
 * 디코딩 설정까지 넣는 이유도 같다. num_predict 를 512 에서 올려도 캐시가 남아 있으면
 * 잘린 옛 답이 그대로 나온다. 답을 바꾸는 입력은 전부 키에 들어가야 한다.
 */
function key(kind, text) {
  const cfg = JSON.stringify({ format: FORMAT[kind], options: sampling(FORMAT[kind] != null) })
  return `${kind}-${crypto.createHash('sha1').update(`${MODEL}\n${cfg}\n${text}`).digest('hex').slice(0, 16)}`
}

function readCache(k) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${k}.json`), 'utf8'))
  } catch {
    return null
  }
}

function writeCache(k, value) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(path.join(CACHE_DIR, `${k}.json`), JSON.stringify(value))
  } catch {
    /* 캐시 실패는 치명적이지 않다 */
  }
}

async function generate(prompt, { format, timeoutMs = 120_000 } = {}) {
  const s = await status() // 10초 캐시라 사실상 공짜다. think 지원 여부가 여기서 온다
  const res = await fetch(`${HOST}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      keep_alive: KEEP_ALIVE,
      format,
      ...thinkOpt(s),
      options: sampling(format != null),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`ollama ${res.status}`)
  return (await res.json()).response ?? ''
}

// ---------------------------------------------------------------------------
// 요약 — 노드를 클릭했을 때
// ---------------------------------------------------------------------------

/**
 * 모델에 넘길 내용의 크기 조절.
 *
 * 실측: 생성은 41 tok/s 로 일정한데(3~4초) 프롬프트 평가가 파일 크기에 비례해
 * 최대 9초까지 간다. 병목은 "얼마나 쓰느냐"가 아니라 "얼마나 읽히느냐"다.
 *
 * 그렇다고 고정된 줄 수로 자르면 정확도를 잃는다. 실측에서 222줄짜리 파일을
 * 160줄로 자르자 뒤쪽 62줄에 있던 채널 두 개를 통째로 놓쳤다.
 *
 * 그래서 파일 크기에 따라 다르게 넣는다 (D6 적응형 노드와 같은 원리).
 *   작은 파일 → 전체. 어차피 프롬프트가 짧아 빠르다
 *   큰 파일   → 앞부분 + 함수 목록. 본문 대신 구조를 준다
 */
const WHOLE_UNDER = 260
const HEAD_LINES = 130

/**
 * 모델을 메모리에 붙잡아 두는 시간.
 *
 * 기본값은 5분이다. 잠깐 다른 일을 하고 돌아와 노드를 누르면 4.7GB 를 다시 올리느라
 * 44초를 기다리게 된다(실측). 사용 중에는 도구가 "가끔 엄청 느린" 물건이 되면 안 된다.
 */
const KEEP_ALIVE = process.env.AXMAP_KEEP_ALIVE ?? '30m'

/** 파일 크기에 맞춰 모델에 보여줄 내용을 고른다. */
function context(relPath, text) {
  const lines = text.split('\n')
  if (lines.length <= WHOLE_UNDER) {
    return { body: text, note: `파일 ${relPath} 전체 (${lines.length}줄)` }
  }
  const lang = /\.py$/.test(relPath) ? 'python' : 'js'
  const list = outline(text, lang)
    .map((o) => `  ${o.kind} ${o.name}  (${o.line}-${o.endLine})`)
    .join('\n')
  return {
    body: `${lines.slice(0, HEAD_LINES).join('\n')}\n\n# ... 생략 ...\n\n# 이 파일의 전체 구성:\n${list}`,
    note: `파일 ${relPath} 의 앞 ${HEAD_LINES}줄과 전체 구성 (총 ${lines.length}줄)`,
  }
}

function summaryPrompt(relPath, text) {
  const { body, note } = context(relPath, text)
  // 작은 모델은 지시가 앞에 멀리 있으면 흘린다. 코드를 먼저 주고 지시를 뒤에 붙인다.
  return `\`\`\`
${body}
\`\`\`

위는 ${note} 이다. 한국어로 두 문장만 써라.
1번 문장: 이 파일이 맡은 책임.
2번 문장: 다른 코드와 어떻게 이어지는지 (입출력, 채널 이름, 호출 관계).
코드에 없는 것은 쓰지 마라. 인사말·머리말·목록 없이 두 문장만 출력하라.`
}

export async function summarize(relPath, text) {
  const k = key('sum', relPath + text)
  const hit = readCache(k)
  if (hit) return { ...hit, cached: true }

  const s = await status()
  if (!s.available) return { available: false }

  const out = { available: true, summary: (await generate(summaryPrompt(relPath, text))).trim(), model: s.model }
  writeCache(k, out)
  return out
}

/**
 * 토큰이 나오는 대로 흘려보낸다.
 *
 * 로컬 추론은 한 파일에 수 초가 걸린다. 다 끝날 때까지 빈 화면을 보여주면
 * 실제 속도와 무관하게 도구가 느리게 느껴진다. 첫 글자가 빨리 나오는 것이
 * 전체가 빨리 끝나는 것보다 체감에 크게 작용한다.
 *
 * @param onChunk (text) => void
 * @returns {{available, cached, model}} 본문은 onChunk 로 나갔다
 */
export async function summarizeStream(relPath, text, onChunk) {
  const k = key('sum', relPath + text)

  const hit = readCache(k)
  if (hit) {
    onChunk(hit.summary)
    return { available: true, cached: true, model: hit.model }
  }

  const s = await status()
  if (!s.available) return { available: false }

  const res = await fetch(`${HOST}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: summaryPrompt(relPath, text),
      stream: true,
      keep_alive: KEEP_ALIVE,
      ...thinkOpt(s),
      options: sampling(false),
    }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) throw new Error(`ollama ${res.status}`)

  // Ollama 스트림은 줄 단위 JSON 이다. 청크 경계가 줄 중간일 수 있으므로 버퍼링한다.
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line)
        if (j.response) {
          full += j.response
          onChunk(j.response)
        }
      } catch {
        /* 부분 줄은 다음 청크에서 이어진다 */
      }
    }
  }

  writeCache(k, { available: true, summary: full.trim(), model: s.model })
  return { available: true, cached: false, model: s.model }
}

// ---------------------------------------------------------------------------
// 핵심 코드 — 전체를 보여주는 것은 "핵심만 읽게 한다"는 목적에 반한다.
//
// 파일이 짧아도 그 안에서 정말 봐야 할 곳은 몇 줄뿐인 경우가 많다.
// 어느 줄이 핵심인지는 기계적으로 정하기 어려우므로 LLM 이 고르되,
// 돌려준 줄 범위는 파일 길이로 잘라내 검증한다 (없는 줄을 가리키면 버린다).
// ---------------------------------------------------------------------------

export async function keyLines(relPath, text) {
  const k = key('keys', relPath + text)
  const hit = readCache(k)
  if (hit) return { ...hit, cached: true }

  const s = await status()
  if (!s.available) return { available: false, key: [] }

  const lines = text.split('\n')
  const numbered = lines
    .slice(0, 400)
    .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
    .join('\n')

  const prompt = `\`\`\`
${numbered}
\`\`\`

위는 ${relPath} 이고 각 줄 앞에 줄 번호가 붙어 있다.

이 파일을 이해하려면 **반드시 읽어야 할 곳**을 최대 3군데 골라라.
- 핵심 규칙·분기·상태 전이가 있는 곳을 고르고, import 나 상용구는 고르지 마라.
- 한 군데는 20줄을 넘기지 마라.
- why 는 한국어 한 문장으로, 왜 그 부분이 핵심인지 적어라.

JSON 으로만 답하라:
{"key":[{"from":10,"to":24,"why":"..."}]}`

  let parsed = { key: [] }
  try {
    parsed = JSON.parse(await generate(prompt, { format: FORMAT.keys }))
  } catch {
    /* 형식을 어기면 빈 결과 */
  }

  const out = {
    available: true,
    model: s.model,
    key: (parsed.key ?? [])
      .map((r) => ({
        from: Math.max(1, Math.min(lines.length, Number(r.from) | 0)),
        to: Math.max(1, Math.min(lines.length, Number(r.to) | 0)),
        why: typeof r.why === 'string' ? r.why.trim() : '',
      }))
      .filter((r) => r.to >= r.from && r.to - r.from <= 60)
      .slice(0, 3),
  }
  writeCache(k, out)
  return out
}

// ---------------------------------------------------------------------------
// 파일 분류 — 자연어 단위로 노드를 다시 세우기 위한 색인
//
// 🔴 역할 분담이 이 설계의 전부다.
//
//   큰 모델 (Claude)   저장소를 한 번 보고 **대분류를 만든다** — 열린 생성
//   작은 모델 (로컬)   파일마다 그 목록에서 **고르기만 한다** — 좁은 선택
//
// 이번 프로젝트에서 작은 모델에게 열린 생성을 시켜 실패한 적이 세 번 있다
// (기능 이름 짓기, 제목 검증, 이름 참조 정밀도). 반대로 후보를 주고 고르게
// 하면 잘한다. 실측: 40개 파일에서 **형식위반 0 · 클러스터 내부 일치도 99%**,
// 파일당 1.7초.
//
// enum 을 문법(format)으로 강제하므로 목록 밖의 답이 **원천적으로** 나올 수
// 없다. `verified` 로 환각을 문자열 대조하던 것보다 강한 보장이다.
// ---------------------------------------------------------------------------

/** 모델에 넣을 분량. 분류는 요약보다 짧게 봐도 된다 — 무엇인지만 알면 된다. */
const CLASSIFY_HEAD = 120
const CLASSIFY_WHOLE_UNDER = 160

export async function classify(relPath, text, categories) {
  if (!categories?.length) return { available: false }

  const lines = text.split('\n')
  const body = lines.length <= CLASSIFY_WHOLE_UNDER
    ? text
    : `${lines.slice(0, CLASSIFY_HEAD).join('\n')}\n\n# ... 생략 ...`

  // 분류 목록이 바뀌면 답이 바뀐다. 캐시 키에 반드시 들어가야 한다 —
  // 안 넣으면 대분류를 고친 뒤에도 옛 답이 그대로 나온다.
  const k = key('cls', `${categories.join('')}\n${relPath}${text}`)
  const hit = readCache(k)
  if (hit) return { ...hit, cached: true }

  const s = await status()
  if (!s.available) return { available: false }

  const schema = {
    type: 'object',
    properties: {
      category: { type: 'string', enum: categories },
      role: { type: 'string' },
    },
    required: ['category', 'role'],
  }

  const prompt = `\`\`\`
${body}
\`\`\`

위는 파일 ${relPath} 이다.

이 파일이 속하는 분류를 아래에서 **하나만** 고르라:
${categories.map((c) => `- ${c}`).join('\n')}

그리고 이 파일이 맡은 역할을 한국어 한 문장으로 적으라 (30자 이내).

JSON 으로만 답하라: {"category":"...","role":"..."}`

  let out = { available: true, category: null, role: '', model: s.model }
  try {
    const j = JSON.parse(await generate(prompt, { format: schema, timeoutMs: 60_000 }))
    // 문법이 보장하지만 한 번 더 본다. 모델을 바꾸면 이 가정이 깨질 수 있다.
    out = {
      available: true,
      category: categories.includes(j.category) ? j.category : null,
      role: typeof j.role === 'string' ? j.role.trim().slice(0, 60) : '',
      model: s.model,
    }
  } catch {
    out.parseFailed = true
  }
  writeCache(k, out)
  return out
}

// ---------------------------------------------------------------------------
// 엣지 독해 — D5
//
// 정적 파싱은 파라미터를 통한 간접 배선을 놓친다 (실측으로 확인됨).
// LLM 은 그것을 읽지만 환각할 수 있다.
// 그래서 LLM 이 말한 채널이 파일에 문자열로 실제 존재하는지 확인한다.
// 없으면 버리지 않고 verified:false 로 남겨 화면에서 구분되게 한다.
// ---------------------------------------------------------------------------

export async function readEdges(relPath, text) {
  const k = key('edge', relPath + text)
  const hit = readCache(k)
  if (hit) return { ...hit, cached: true }

  const s = await status()
  if (!s.available) return { available: false, edges: [] }

  const { body, note } = context(relPath, text)
  const prompt = `\`\`\`
${body}
\`\`\`

위는 ${note} 이다.
이 파일이 발행(publish)하거나 구독(subscribe)하는 채널/토픽 이름을 모두 찾아라.
파라미터 기본값, docstring 의 흐름도, 주석에 적힌 것도 포함하라.
반드시 코드에 실제로 등장하는 문자열만 쓰라.

JSON 으로만 답하라:
{"edges":[{"channel":"/이름","direction":"pub"|"sub"}]}`

  let parsed = { edges: [] }
  let parseFailed = false
  try {
    parsed = JSON.parse(await generate(prompt, { format: FORMAT.edge }))
  } catch {
    // "형식을 어겼다" 와 "채널이 하나도 없다" 는 결과가 똑같이 빈 배열이라 구분이 안 된다.
    // 모델을 바꿨을 때 조용히 망가지는 지점이 정확히 여기다 (사고 토큰이 num_predict 를
    // 먹어 JSON 이 잘리는 경우 등). 화면에는 그냥 "엣지 없음"으로 보인다. 플래그로 드러낸다.
    parseFailed = true
  }

  // 문법은 배열 길이를 묶어주지만 같은 채널을 두 번 쓰는 것은 막지 못한다.
  // 한 파일이 같은 채널을 같은 방향으로 두 번 배선하는 일은 없으므로 중복은 곧 잡음이고,
  // 그대로 두면 화면에 같은 선을 겹쳐 그리고 세는 쪽에서는 개수를 부풀린다.
  const seen = new Set()
  const edges = (parsed.edges ?? [])
    .filter((e) => e && typeof e.channel === 'string')
    .map((e) => ({
      channel: e.channel,
      direction: e.direction === 'pub' ? 'pub' : 'sub',
      // ★ 여기가 작은 모델을 쓸 수 있게 해주는 지점 — 환각을 문자열 대조로 거른다
      verified: text.includes(e.channel),
      source: 'llm',
    }))
    .filter((e) => {
      const k = `${e.channel}\u0000${e.direction}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

  const out = { available: true, edges, model: s.model, parseFailed }
  writeCache(k, out)
  return out
}
