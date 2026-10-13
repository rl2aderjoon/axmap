#!/usr/bin/env node
/**
 * 3인 페르소나 벤치마크 — 시각화가 이해 속도를 **실제로** 올리는가.
 *
 *   node tools/persona-bench.mjs --repo <경로|git주소> [--port 7850]
 *   node tools/persona-bench.mjs --report            지금까지의 결과
 *
 * ── 왜 이걸 만드나 ────────────────────────────────────────────────────────
 *
 * 관찰 여섯 회차가 모두 "그래프를 꺼도 이 도구는 거의 그대로 쓸모 있었을
 * 것" 이라고 했다. 그런데 그건 **인상**이지 측정이 아니다. 그리고 관찰자는
 * 전부 AI 였다 — AI 는 텍스트를 잘 읽는다. 사람에게도 같은 말인지는 모른다.
 *
 * 그러니 재야 한다. 같은 저장소, 같은 질문지, **보는 것만 다른** 셋을 붙인다.
 *
 *   A  시각화만    화면 스크린샷만 본다. API 도 소스도 못 본다.
 *   B  텍스트만    API 응답만 본다. 화면을 못 본다.
 *   C  둘 다       화면과 API 를 다 본다.
 *
 * 🔴 이 셋의 차이가 곧 시각화의 값이다.
 *
 *   A ≥ B 이면 시각화가 혼자서도 일한다.
 *   A < B 인데 C > B 이면 시각화는 보조로만 값이 있다.
 *   C ≈ B 이면 **시각화가 보태는 것이 없다.** 그때는 형식을 바꾼다 —
 *   힘-지향 그래프가 아니어도 된다. 2차원 트리든 mermaid 든.
 *
 * ── 무엇을 재나 ──────────────────────────────────────────────────────────
 *
 *   호출 수   같은 답에 도달하는 데 든 도구 호출. 적을수록 빠르다.
 *   정답      docs/BENCH.md 의 질문지. 채점은 사람이 아니라 **검증 가능한 것**만.
 *   막힌 곳   답을 못 낸 질문. 이게 다음에 고칠 자리다.
 *
 * ⚠️ 이 하네스는 **에이전트를 띄우지 않는다.** 페르소나별 프롬프트와 접근
 *    제한을 만들어 파일로 내놓고, 결과를 받아 표로 만든다. 에이전트를 띄우는
 *    것은 부르는 쪽(사람 또는 상위 세션)이 한다 — 그래야 어떤 모델로 돌렸는지가
 *    기록에 남고, 하네스가 모델에 묶이지 않는다.
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'docs', 'bench-runs')

const args = process.argv.slice(2)
const flag = (n, d = null) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1] }

/**
 * 페르소나.
 *
 * 🔴 제한이 곧 실험 조건이다. "보지 마라" 로는 안 된다 — 에이전트는 본다.
 *    그래서 **줄 것만 준다.** A 에게는 스크린샷 파일만, B 에게는 API 주소만.
 */
export const PERSONAS = {
  viz: {
    key: 'viz',
    label: 'A · 시각화만',
    sees: '화면 스크린샷 (PNG)',
    forbids: ['API 응답', '저장소 소스', '파일 목록'],
    why: '시각화가 혼자서 얼마나 말하는가',
  },
  text: {
    key: 'text',
    label: 'B · 텍스트만',
    sees: 'API 응답 (JSON)',
    forbids: ['화면 스크린샷'],
    why: '텍스트만으로 어디까지 되는가 — 이것이 기준선이다',
  },
  both: {
    key: 'both',
    label: 'C · 둘 다',
    sees: '화면 스크린샷 + API 응답',
    forbids: [],
    why: '시각화가 텍스트 위에 무엇을 보태는가',
  },
}

/** 질문지. docs/BENCH.md 가 규격이고 여기는 그 기계 표현이다. */
export const QUESTIONS = [
  { id: 'M1', q: '이 저장소는 무엇을 하는 물건인가', check: 'README·매니페스트의 설명과 맞는가' },
  { id: 'M2', q: '실행은 어디서 시작하나 — 파일 하나를 짚어라', check: '매니페스트가 선언한 진입점과 맞는가' },
  { id: 'M3', q: '이 저장소의 큰 덩어리 셋을 이름으로 대라', check: '모듈 경계와 맞는가' },
  { id: 'M4', q: '<기능 X> 를 고치려면 어느 파일을 열어야 하나', check: '그 기능의 파일 집합에 들어 있는가' },
  { id: 'M5', q: '건드리면 파급이 큰 파일 하나와 그 근거', check: '근거가 화면·API 에 실제로 있는 수인가' },
  { id: 'M6', q: '지금 다른 사람이 잡고 있는 곳이 있나 — 있으면 누가 무엇을', check: '장부와 맞는가' },
  { id: 'M7', q: '내가 지금 <파일 Y> 를 고치면 누구와 부딪히나', check: '경고와 맞는가' },
]

const now = () => new Date().toISOString()
const stamp = () => now().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

/** 화면 스크린샷을 찍는다 — A·C 페르소나가 볼 것. */
function shoot(url, file, { width = 1440, height = 900, budget = 30000 } = {}) {
  const chrome = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find((p) => { try { return fs.existsSync(p) } catch { return false } })
  if (!chrome) throw new Error('크롬을 못 찾았습니다 — 시각화 페르소나를 돌릴 수 없습니다')
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--window-size=${width},${height}`, `--virtual-time-budget=${budget}`,
    `--screenshot=${file}`, url,
  ], { stdio: 'ignore', timeout: budget + 30000, windowsHide: true })
  if (!fs.existsSync(file)) throw new Error(`스크린샷이 안 나왔습니다: ${url}`)
  return file
}

/**
 * 한 판을 준비한다.
 *
 * 서버를 띄우고, 시각화 페르소나가 볼 스크린샷을 미리 찍어두고,
 * 페르소나별 지시문을 파일로 낸다.
 */
/**
 * 🔴 성공한 저장소는 두 번 쓰지 않는다.
 *
 * 도구가 그 저장소를 이해시키는 데 성공했다면, 같은 것으로 또 재는 것은
 * 아무것도 재지 않는 것이다 — 우리가 이미 그 저장소에 맞춰 고쳤기 때문이다.
 * 과적합은 조용히 온다. 실제로 겪었다: 파이썬에서 합격한 뒤 Go 로 옮기자마자
 * 과적합 둘이 드러났다 (밤샘 로그).
 *
 * 기록은 온보딩 평가와 **같은 파일**을 쓴다. 두 목록을 두면 한쪽에서 본 것을
 * 다른 쪽이 또 뽑는다.
 */
const SEEN = path.join(ROOT, 'docs', 'evaluated-repos.txt')

function alreadySeen(name) {
  try {
    return fs.readFileSync(SEEN, 'utf8').split('\n')
      .map((l) => l.split('#')[0].trim()).filter(Boolean)
      .some((l) => l === name || l.endsWith(`/${name}`) || name.endsWith(`/${l}`))
  } catch { return false }
}

function markSeen(name, note) {
  try { fs.appendFileSync(SEEN, `${name}  # 페르소나 벤치 · ${note}\n`) } catch { /* 못 적어도 계속 */ }
}

/** 새 저장소를 뽑는다 — 추첨기가 이미 본 것을 빼고 고른다. */
function drawRepo() {
  console.log('새 저장소를 뽑습니다 (본 적 없는 인기 저장소)...')
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'pick-repo.mjs'), '--no-serve'], {
    encoding: 'utf8', timeout: 900_000, windowsHide: true,
  })
  console.log(out.split('\n').filter((l) => l.trim() && !/Updating files/.test(l)).slice(-5).join('\n'))
  // 추첨기가 찍는 두 형태 중 하나에서 경로를 집는다. 형태가 바뀌면 여기서 던진다 —
  // 조용히 빈 경로로 진행하면 "저장소가 비었다" 는 틀린 결론이 벤치에 들어간다.
  const m = out.match(/클론 중\.\.\.\s*(.+?)\s*$/m) ?? out.match(/serve-public\.mjs\s+"([^"]+)"/)
  if (!m) throw new Error('추첨기가 클론 경로를 안 알려줬습니다 (출력 형식이 바뀐 듯)')
  return m[1].trim()
}

async function prepare({ repo, port, drawn = false }) {
  const name = path.basename(repo)
  // 🔴 방금 뽑은 것은 검사하지 않는다.
  //
  // 추첨기(pick-repo)가 뽑는 순간 같은 목록에 기록한다. 그래서 --draw 로 막
  // 받아온 저장소를 그대로 검사하면 **자기가 방금 적은 줄에 자기가 걸린다.**
  // 목록 하나를 두 도구가 쓰기로 한 대가다 — 그 편이 "두 곳에서 본 것을
  // 또 뽑는" 것보다 낫다.
  if (!drawn && alreadySeen(name) && !args.includes('--again')) {
    throw new Error(`이미 평가한 저장소입니다: ${name}\n`
      + '  성공한 저장소로 또 재면 과적합이 안 보입니다. 새로 뽑으세요:\n'
      + '    node tools/persona-bench.mjs --draw\n'
      + '  그래도 다시 재려면 --again')
  }
  const runId = `${stamp()}-${path.basename(repo).replace(/[^\w.-]/g, '_')}`
  const dir = path.join(OUT, runId)
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true })

  console.log(`판 ${runId}`)
  console.log(`  대상 ${repo}`)

  const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.mjs'), repo, String(port), '--readonly'], {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let log = ''
  server.stdout.on('data', (d) => { log += d })
  server.stderr.on('data', (d) => { log += d })

  const base = `http://127.0.0.1:${port}`
  const up = await (async () => {
    for (let i = 0; i < 90; i++) {
      try { await fetch(base, { signal: AbortSignal.timeout(1500) }); return true } catch { /* 아직 */ }
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  })()
  if (!up) { server.kill(); throw new Error(`서버가 안 떴습니다:\n${log.slice(-600)}`) }
  console.log(`  서버 ${base}`)

  /**
   * 🔴 시각화 페르소나가 볼 화면은 **흐름의 각 걸음**이다.
   *
   * 첫 화면 하나만 주면 "시각화가 못 한다" 가 아니라 "우리가 안 보여줬다" 가
   * 된다. 걸음마다 찍어서 사람이 실제로 눌러 볼 만한 것을 다 준다.
   */
  const views = [
    { name: '01-첫화면', url: `${base}/` },
    { name: '02-흐름1-무엇을하는물건', url: `${base}/?step=1` },
    { name: '03-흐름2-진입점', url: `${base}/?step=2` },
    { name: '04-흐름3-계층', url: `${base}/?step=3` },
    { name: '05-흐름4-활발하고위험한곳', url: `${base}/?step=4` },
    { name: '06-기능축', url: `${base}/?unit=feature` },
    { name: '07-감시-누가무엇을', url: `${base}/?watch=1` },

    /**
     * 🔴 그림만 — 왼쪽 패널을 잘라낸 것. A′ 페르소나가 볼 것.
     *
     * 1회차의 설계 결함을 고치는 자리다. "시각화만 보는 신입" 에게 준
     * 스크린샷에 **사이드바의 문장이 통째로 들어 있었다.** 그래서 그 신입은
     * 픽셀에서 글자를 읽었고, 우리가 잰 것은 "그림 대 글" 이 아니라
     * "화면 대 API" 였다.
     *
     * `view=graph` 를 함께 준다 — 안 주면 오른쪽이 사다리 뷰(텍스트)라
     * 패널만 없앤 또 다른 글 화면이 된다. 실제로 한 번 그렇게 찍혔다.
     */
    { name: 'g1-그림만-계층', url: `${base}/?panel=off&view=graph&step=3`, viz: true },
    { name: 'g2-그림만-기능축', url: `${base}/?panel=off&view=graph&unit=feature`, viz: true },
    { name: 'g3-그림만-감시', url: `${base}/?panel=off&view=graph&watch=1`, viz: true },
  ]
  const shots = []
  for (const v of views) {
    const f = path.join(dir, 'shots', `${v.name}.png`)
    try { shoot(v.url, f); shots.push({ ...v, file: path.relative(dir, f) }); process.stdout.write('.') } catch (e) {
      shots.push({ ...v, error: e.message.slice(0, 120) }); process.stdout.write('x')
    }
  }
  console.log(`\n  스크린샷 ${shots.filter((s) => !s.error).length}/${views.length}`)

  for (const p of Object.values(PERSONAS)) {
    fs.writeFileSync(path.join(dir, `persona-${p.key}.md`), personaPrompt(p, { base, shots, repo }))
  }
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
    runId, repo, port, at: now(), views: shots, personas: Object.keys(PERSONAS),
  }, null, 1))

  markSeen(name, runId)
  console.log(`\n  지시문 ${dir}`)
  console.log(`  서버는 계속 돕니다 (PID ${server.pid}). 끝나면: taskkill /PID ${server.pid} /F`)
  server.unref()
  return dir
}

/**
 * 페르소나에게 줄 프롬프트를 만든다.
 *
 * 🔴 내보내는 이유는 재사용이 아니라 **검사**다. 이 프롬프트는 실제로 판을 열어야만
 * 찍히고, 판을 열려면 크롬과 저장소가 필요하다. 그래서 여기가 깨져도 아무 테스트도
 * 빨개지지 않는다 — app/web 이 죽어도 npm test 가 초록이던 것과 같은 사각지대다.
 * 내보내 두면 렌더링해서 눈으로 볼 수 있다.
 */
export function personaPrompt(p, { base, shots, repo }) {
  const shotList = shots.filter((s) => !s.error)
    .map((s) => `  · ${s.name}  →  shots/${path.basename(s.file)}`).join('\n')
  const seeVis = p.key !== 'text'
  const seeApi = p.key !== 'viz'

  return `# ${p.label}

너는 이 저장소를 **처음 본다.** 아무 사전 지식도 없다.
아래 질문에 답하고, 답할 때마다 **무엇을 보고 그렇게 판단했는지** 적어라.

## 🔴 볼 수 있는 것 — 이것만 본다

${seeVis ? `**화면 스크린샷** (Read 도구로 PNG 를 읽어라)\n${shotList}\n` : ''}
${seeApi ? `**API** (curl 또는 fetch)\n  ${base}/api/flow · /api/overlay · /api/entry · /api/featuregraph · /api/watch · /api/graph\n` : ''}
## 🔴 보면 안 되는 것

${p.forbids.length ? p.forbids.map((f) => `  · ${f}`).join('\n') : '  (제한 없음)'}
  · 저장소 소스 코드를 직접 열지 마라 (${repo})
  · axMap 자신의 코드를 읽지 마라 — 도구를 쓰는 사람이지 만든 사람이 아니다

이 제한이 곧 실험 조건이다. 어기면 이 판이 무의미해진다.
**볼 수 없는 것 때문에 답을 못 하겠으면 "못 함" 이라고 적어라.** 그게 데이터다.

## 🔴 낱말 기록 — 답과 나란히, 답을 바꾸지 않고

질문에는 **평소대로 답해라.** 이 기록은 답에 영향을 주지 않는다. 따로 적는 것이다.

화면과 API 에 나오는 낱말 중 **화면이 그 뜻을 알려주지 않은 것**을 전부 적어라.

  · 낱말 · 어디서 봤나 · 화면이 준 설명(없으면 "없음") · 그 뜻을 몰라도 답할 수 있었나

🔴 **네가 이미 뜻을 아는 낱말도 적는다.** 재는 것은 네 지식이 아니라 **화면이 자기
낱말을 스스로 가르치는가**이다. "당연히 아는 말이라 뺐다" 는 판단이 정확히 우리가
재려는 그것이므로, 그 판단을 하지 마라.

이 도구를 쓸 사람 중에는 프로그래밍을 배운 적 없는 사람이 있다. 그 사람에게는
네가 당연하다고 여긴 낱말이 벽이다. 네가 그 벽을 대신 볼 수는 없지만, **벽이
있었을 자리**는 적어줄 수 있다.

## 질문

${QUESTIONS.map((q) => `### ${q.id}. ${q.q}\n\n- 답:\n- 무엇을 보고:\n- 도구 호출 수:\n`).join('\n')}

## 마지막에 적을 것

1. **호출 수 합계**
2. **못 한 질문**과 그 이유
3. 🔴 **막혔던 자리** — 무엇을 보고 싶었는데 없었나. 이게 우리가 고칠 자리다.
4. ${seeVis ? '화면이 도움이 된 순간과 방해가 된 순간을 각각 하나씩' : '화면이 있었다면 어디서 도움이 됐을 것 같나'}
5. 🔴 **낱말 기록** — 위 규칙대로 표로. 화면의 말을 고칠 유일한 근거다.
   하나도 없으면 "없음" 이라고 적어라. 빈 것과 안 적은 것은 다른 말이다.

답은 \`answers-${p.key}.md\` 로 저장해라.
`
}

function report() {
  let runs = []
  try { runs = fs.readdirSync(OUT).filter((d) => fs.existsSync(path.join(OUT, d, 'run.json'))) } catch { /* 없음 */ }
  if (!runs.length) return console.log('아직 판이 없습니다.')
  console.log(`판 ${runs.length}개\n`)
  for (const r of runs.sort()) {
    const meta = JSON.parse(fs.readFileSync(path.join(OUT, r, 'run.json'), 'utf8'))
    const answers = Object.keys(PERSONAS).map((k) => {
      const f = path.join(OUT, r, `answers-${k}.md`)
      if (!fs.existsSync(f)) return { k, done: false }
      const t = fs.readFileSync(f, 'utf8')
      // 🔴 채점을 지어내지 않는다. 파일에 적힌 것만 읽는다.
      const calls = [...t.matchAll(/도구\s*호출\s*수\s*[:：]\s*(\d+)/g)].map((m) => Number(m[1]))
      const cant = (t.match(/못\s*함/g) ?? []).length
      return { k, done: true, calls: calls.reduce((a, b) => a + b, 0), answered: calls.length, cant }
    })
    console.log(`── ${r}   ${path.basename(meta.repo)}`)
    for (const a of answers) {
      const p = PERSONAS[a.k]
      console.log(a.done
        ? `   ${p.label.padEnd(14)} 호출 ${String(a.calls).padStart(3)} · 답한 질문 ${a.answered}/${QUESTIONS.length} · "못 함" ${a.cant}`
        : `   ${p.label.padEnd(14)} (아직 안 돌림)`)
    }
    console.log('')
  }
  console.log(`🔴 읽는 법
   A(시각화만) ≥ B(텍스트만)   → 시각화가 혼자서도 일한다
   A < B 인데 C > B            → 시각화는 보조로만 값이 있다
   C ≈ B                       → 시각화가 보태는 것이 없다. 형식을 바꿔라.`)
}

if (args.includes('--report')) report()
else {
  let repo = flag('--repo')
  let drawn = false
  if (!repo && args.includes('--draw')) {
    try { repo = drawRepo(); drawn = true } catch (e) { console.error(e.message); process.exit(1) }
  }
  if (!repo) {
    console.error(`사용법:
  node tools/persona-bench.mjs --draw                 새 저장소를 뽑아서 준비 (권장)
  node tools/persona-bench.mjs --repo <경로> [--again]
  node tools/persona-bench.mjs --report

🔴 성공한 저장소는 두 번 쓰지 않습니다. 같은 것으로 또 재면 아무것도 재지 않는 것입니다.`)
    process.exit(1)
  }
  prepare({ repo, port: Number(flag('--port') ?? 7850), drawn })
    .then((d) => console.log(`\n준비 끝. 페르소나 셋에게 각각 persona-*.md 를 주고 돌려라.\n  ${d}`))
    .catch((e) => { console.error(e.message); process.exit(1) })
}
