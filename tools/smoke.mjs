#!/usr/bin/env node
/**
 * 화면이 실제로 뜨는지 본다.
 *
 * 🔴 `npm test` 는 화면이 죽어도 초록이다.
 *
 * 하룻밤에 두 번 겪었다. 둘 다 문법은 멀쩡했고 테스트는 전부 통과했는데
 * 브라우저에서는 아무것도 안 떴다.
 *
 *   1. 주석에 쓴 `examples/[별]/main.go` 의 `[별]/` 가 블록 주석을 닫아 파일이 깨졌다
 *   2. `let urlReady` 를 첫 사용처보다 아래에 선언해 TDZ 참조 에러가 났고,
 *      그 예외가 부트스트랩 체인을 끊어 흐름·걸음·탭이 통째로 죽었다
 *
 * 2번이 특히 나빴다. 나는 `?step=3` 으로만 확인했는데 그 경로는 크래시 지점을
 * 우회한다. **되는 길만 보면 안 되는 길은 영원히 안 보인다.**
 *
 * 그래서 여기서는 사람이 실제로 처음 여는 주소 — **맨 주소** 를 연다.
 * 자바스크립트가 다 돌고 난 DOM 에 부트스트랩이 남긴 흔적이 있는지만 본다.
 * 픽셀은 안 본다. 스크린샷 비교는 깨지기 쉽고, 우리가 잡으려는 것은
 * "화면이 통째로 안 뜨는 것" 이지 "3px 밀린 것" 이 아니다.
 *
 * 의존성은 늘리지 않는다. 이미 깔린 Chrome 을 `--dump-dom` 으로 부른다.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detect } from '../app/lib/agentcli.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.AXMAP_SMOKE_PORT ?? 7912)
/** 검사 대상은 이 저장소 자신이다. 늘 있고, 크지 않고, 결과가 안정적이다. */
const TARGET = process.argv[2] ?? ROOT

/** 이미 깔린 Chrome 을 찾는다. 없으면 **건너뛰지 않고 실패한다** — 검사는 돌아야 검사다. */
function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME
  const cands = process.platform === 'win32'
    ? [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
       '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch { /* 다음 후보 */ } }
  return null
}

/**
 * 새 껍데기(`/`)가 남겨야 하는 흔적.
 *
 * `data-shell="ready"` 는 `init()` 의 맨 끝에서 붙는다. 그 앞에 API 세 번
 * (`/api/agents` · `/api/graph` · `/api/sessions`)이 있으므로 이 한 줄이
 * **모듈 · 서버 라우트 · 세션 저장소**를 한꺼번에 증명한다.
 */
/**
 * 처음 오는 사람이 보는 화면(`/`).
 *
 * `data-shell="ready"` 는 `init()` 의 맨 끝에서 붙는다. 그 앞에 API 세 번
 * (`/api/agents` · `/api/version` · `/api/sessions`)이 있으므로 이 한 줄이
 * **모듈 · 서버 라우트 · 세션 저장소**를 한꺼번에 증명한다.
 */
const FIRST = [
  { what: '부트스트랩(shell.js)', re: /data-shell="ready"/ },
  { what: '3분할 · 왼쪽 목록', re: /id="chats"/ },
  { what: '3분할 · 가운데', re: /id="stage"/ },
  { what: '3분할 · 오른쪽 입력', re: /id="composer"/ },
  { what: '모드 탭(감시·이해)', re: /data-mode="watch"/ },
  { what: '툴바(아이콘)', re: /data-menu="all"/ },
  /**
   * 🔴 처음 오는 사람에게 보이는 CLI 고르기 카드.
   * 정적 HTML 에 없다 — `/api/agents` 를 받아 `drawPicks()` 가 그린다.
   * 이 표식이 **온보딩이 실제로 떴다**와 **CLI 감지가 돈다**를 함께 증명한다.
   */
  { what: '처음 설정 · CLI 고르기', re: /class="pick/ },
]

/**
 * 고르기를 끝낸 사람이 보는 화면(`/?agent=…`).
 *
 * 🔴 온보딩이 가운데 칸을 가리므로, 주소로 고른 값을 심지 않으면 렌더러가
 * 검사에서 통째로 빠진다. 헤드리스는 클릭을 못 한다.
 *
 * `data-path` 와 `class="wires"` 는 정적 HTML 에 없다 — `/api/ladder` 를 받아
 * `stage.js` 가 만든다. 둘이 **겹 계산 · 라우트 · 카드 · 버스 연결선**을 덮는다.
 */
const OPENED = [
  { what: '부트스트랩(shell.js)', re: /data-shell="ready"/ },
  { what: '가운데 · 번호 카드', re: /data-path="/ },
  { what: '가운데 · 버스 연결선', re: /class="wires"/ },
  { what: '온보딩이 닫혔다', re: /id="onboard" hidden/ },
]

// 검사 PC의 설치된 CLI를 선택한다. 특정 팀의 Claude 설치에 의존하지 않는다.
const agent = detect().find((a) => a.installed)
if (!agent) {
  console.error('온보딩 이후 화면 검증에 필요한 AI CLI가 없습니다. Claude Code, agy 또는 Codex CLI를 설치하세요.')
  process.exit(1)
}

const PAGES = [
  { path: '/', what: '처음 오는 사람', must: FIRST },
  { path: `/?agent=${encodeURIComponent(agent.id)}`, what: '고르기를 끝낸 사람', must: OPENED },
]

async function waitUp(ms = 120_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) })
      return true
    } catch { await new Promise((r) => setTimeout(r, 400)) }
  }
  return false
}

const chrome = findChrome()
if (!chrome) {
  console.error('Chrome 을 찾지 못했습니다. CHROME=<경로> 로 알려주세요.')
  console.error('건너뛰지 않습니다 — 안 도는 검사는 검사가 아닙니다.')
  process.exit(1)
}

// 이미 그 포트를 쓰고 있으면 그것을 재사용하지 않는다. 무엇을 검사했는지가 흐려진다.
const log = path.join(ROOT, '.axmap-smoke.log')
const out = fs.openSync(log, 'w')
const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.mjs'), TARGET, String(PORT)],
  { cwd: ROOT, stdio: ['ignore', out, out], windowsHide: true })

let failed = 0
try {
  if (!await waitUp()) {
    console.error(`서버가 뜨지 않았습니다. 기록: ${log}`)
    try { console.error(fs.readFileSync(log, 'utf8').split('\n').slice(-10).join('\n')) } catch { /* 없으면 그만 */ }
    process.exit(1)
  }

  console.log(`대상 ${TARGET}`)

  for (const page of PAGES) {
    // 🔴 맨 주소로 연다. 사람이 처음 여는 주소가 이것이고, 파라미터를 붙이면
    //    부트스트랩의 다른 갈래를 타서 크래시 지점을 우회할 수 있다.
    const dom = execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      // 자바스크립트가 끝날 시간을 준다. 큰 저장소는 그래프를 만드느라 느리다.
      '--virtual-time-budget=20000',
      '--dump-dom', `http://127.0.0.1:${PORT}${page.path}`,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })

    console.log(`\n${page.path}  ${page.what}  ·  DOM ${dom.length.toLocaleString()} bytes`)
    for (const m of page.must) {
      const ok = m.re.test(dom)
      console.log(`  ${ok ? '통과' : '실패'}  ${m.what}`)
      if (!ok) failed++
    }
  }

  if (failed) {
    console.error('\n화면이 뜨지 않았습니다 — 부트스트랩이 중간에 죽었을 수 있습니다.')
    console.error('브라우저 콘솔을 보세요. 문법은 멀쩡한데 실행이 죽는 경우가 많습니다')
    console.error('(선언 순서·TDZ·없는 id 참조).')
  }
} finally {
  try { server.kill() } catch { /* 이미 죽었으면 그만 */ }
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 그만 */ }
  }
  try { fs.closeSync(out) } catch { /* 그만 */ }
}

if (failed) process.exit(1)
console.log('\n화면 연기 검사 통과')
