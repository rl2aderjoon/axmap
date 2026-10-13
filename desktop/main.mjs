/**
 * axMap 데스크톱 셸 — Electron 메인 프로세스.
 *
 * 이 파일이 하는 일은 네 가지뿐이다.
 *   ① 빈 포트를 골라 `app/server.mjs` 를 자식 프로세스로 띄운다
 *   ② 창을 그 주소로 가리킨다
 *   ③ 창이 닫히면 자식을 **트리째** 죽인다
 *   ④ 단축키 하나로 창을 띄우고 숨긴다
 *
 * 🔴 화면도 분석도 여기 없다. 전부 `app/` 과 `src/` 에 그대로 있다.
 *
 * 코어를 import 하지 않고 **자식 프로세스로 띄우는** 것이 핵심이다.
 * import 방향은 `desktop/` → 코어 단방향이어야 하고(docs/DECISIONS.md D16),
 * 코어는 Electron 이 있는지 없는지 몰라야 한다. 그래야
 * `node app/server.mjs` 로 브라우저에서 여는 길이 계속 산다.
 */

import { app, BrowserWindow, Menu, Tray, dialog, globalShortcut, ipcMain, nativeImage, shell } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 코어(`app/` · `src/` · `bin/` · `corpus/`)가 어디 있는가.
 *
 * 개발 중에는 저장소 루트이고, 패키징되면 `resources/core` 다.
 * electron-builder 가 `extraResources` 로 거기에 복사한다(package.json 참고).
 * 두 경우의 디렉터리 구조가 아예 달라서 `app.isPackaged` 로 가른다.
 */
const CORE = app.isPackaged
  ? path.join(process.resourcesPath, 'core')
  : path.resolve(HERE, '..')

const flag = (k) => process.argv.includes(k)
const optOf = (k) => {
  const hit = process.argv.find((a) => a.startsWith(`${k}=`))
  return hit ? hit.slice(k.length + 1) : null
}

const SELFTEST = flag('--selftest')
/** 로그인 항목이 붙이는 인자. 부팅하자마자 창이 튀어나오지 않게 한다. */
const HIDDEN = flag('--hidden')

let server = null
let win = null
let tray = null
let target = null
let port = 0
/** 진짜로 끝내는 중인가. 이게 false 면 창을 닫아도 숨기기만 한다. */
let quitting = false

// ── 상태 (마지막으로 연 저장소) ──────────────────────────────────────────────

const statePath = () => path.join(app.getPath('userData'), 'state.json')

const readState = () => {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) } catch { return {} }
}

const writeState = (patch) => {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch }, null, 2))
  } catch { /* 상태 저장 실패로 앱이 죽을 이유는 없다 */ }
  // 대상이 바뀐 것이면 MCP 도 따라올 수 있게 공용 자리에 함께 적는다.
  if (patch.target && writeSharedTarget && !SELFTEST) writeSharedTarget(patch.target)
}

// ── MCP 가 따라오게 하는 한 칸 ───────────────────────────────────────────────
//
// 위 `statePath()` 는 `app.getPath('userData')` 를 쓰는데 그건 **Electron 전용 API** 라
// 순수 node 로 도는 MCP 서버가 같은 경로를 계산할 방법이 없다. 그래서 두 프로세스가
// 둘 다 계산할 수 있는 자리(`~/.axmap/current.json`)에 한 번 더 적는다.
//
// 🔴 뷰어는 대상이 바뀌면 **프로세스를 갈아끼워서** 따라가지만(`pickAndReopen`),
//    MCP 서버에는 그 수법이 안 통한다 — 그것을 띄운 것은 우리가 아니라 AI CLI 다.
//    남의 자식 프로세스는 재시작시킬 수 없으므로 "교체" 대신 "따라가기" 로 푼다.

/** 코어의 `src/repotarget.mjs` 에서 한 번만 들여온다. 못 들여오면 `null` 로 둔다. */
let writeSharedTarget = null

/**
 * 경로를 여기에 다시 적지 않고 코어에서 가져오는 이유: 같은 경로가 두 군데 적히면
 * 반드시 한쪽만 고쳐지고, 그때부터 앱이 적는 자리와 MCP 가 읽는 자리가 갈린다.
 *
 * 정적 `import` 가 아니라 동적 `import` 인 이유: 개발 중에는 `../src` 지만
 * 패키징되면 `resources/core/src` 라 상대 경로가 서로 다르다. `CORE` 가 그 차이를 안다.
 *
 * 실패해도 던지지 않는다 — **이게 안 되는 것과 앱이 안 열리는 것은 다르다.**
 * 뷰어는 그대로 열리고 MCP 만 따라오지 못한다.
 */
async function loadSharedTarget() {
  try {
    const m = await import(pathToFileURL(path.join(CORE, 'src', 'repotarget.mjs')).href)
    writeSharedTarget = m.writeTarget
  } catch {
    writeSharedTarget = null
  }
}

// ── 서버 ────────────────────────────────────────────────────────────────────

/**
 * 빈 포트를 커널에게 물어본다.
 *
 * 받은 뒤 서버가 붙기까지 남이 그 포트를 가로챌 틈이 이론상 있다(TOCTOU).
 * 그대로 둔다 — `app/server.mjs` 가 EADDRINUSE 를 잡아 분명한 메시지를 내고
 * 죽으므로, 조용히 잘못된 화면이 뜨는 경우는 없다. 우리는 그 기록을 보여준다.
 */
const freePort = () => new Promise((res, rej) => {
  const probe = net.createServer()
  probe.on('error', rej)
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address()
    probe.close(() => res(p))
  })
})

const logPath = () => path.join(app.getPath('userData'), 'server.log')

function startServer(t, p) {
  fs.mkdirSync(path.dirname(logPath()), { recursive: true })
  const out = fs.openSync(logPath(), 'w')
  /**
   * 🔴 `ELECTRON_RUN_AS_NODE=1` 이 이 줄의 전부다.
   *
   * 이 변수가 있으면 electron 바이너리가 크롬을 띄우지 않고 **평범한 node** 로 돈다.
   * 덕분에 사용자 PC 에 Node 가 없어도 `app/server.mjs` 가 실행된다 —
   * 설치본에 Node 런타임을 따로 싣지 않아도 되는 이유이고,
   * 코어를 한 줄도 고치지 않고 데스크톱으로 옮길 수 있는 이유다.
   */
  return spawn(process.execPath, [path.join(CORE, 'app', 'server.mjs'), t, String(p)], {
    cwd: CORE,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', out, out],
    windowsHide: true,
  })
}

function stopServer() {
  if (!server) return
  const pid = server.pid
  try { server.kill() } catch { /* 이미 죽었으면 그만 */ }
  /**
   * 🔴 윈도우에서 `kill()` 은 **자식의 자식을 안 죽인다.**
   * 서버는 git 을 계속 spawn 하므로 트리째 죽이지 않으면 포트를 문 채로 남고,
   * 다음 실행이 EADDRINUSE 로 막힌다. `tools/smoke.mjs` 와 같은 처리다.
   */
  if (process.platform === 'win32' && pid) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch { /* 그만 */ }
  }
  server = null
}

async function waitUp(p, ms = 120_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // 서버가 이미 죽었으면 더 기다릴 이유가 없다. 기다림은 실패를 늦출 뿐이다.
    if (server && server.exitCode !== null) return false
    try {
      await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(2000) })
      return true
    } catch { await new Promise((r) => setTimeout(r, 300)) }
  }
  return false
}

const tailLog = (n = 12) => {
  try {
    return fs.readFileSync(logPath(), 'utf8').trim().split('\n').slice(-n).join('\n')
  } catch { return '(기록 없음)' }
}

// ── 창 ──────────────────────────────────────────────────────────────────────

/**
 * 서버가 준비될 때까지 보여줄 화면.
 *
 * 큰 저장소는 그래프를 만드느라 수십 초가 걸린다. 그동안 빈 창을 두면
 * 사람은 앱이 죽은 줄 안다. 배경은 `app/web/shell.css` 의 `--bg`(#faf9f5) 와
 * 같은 값을 써서 화면이 번쩍이지 않게 한다 — 한 값이라도 어긋나면 켤 때마다 보인다.
 */
const loadingPage = (t) => 'data:text/html;charset=utf-8,' + encodeURIComponent(`
<meta charset="utf-8">
<style>
  html,body{height:100%;margin:0;background:#faf9f5;color:#141413;
    font:13px/1.7 "Segoe UI",system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center}
  .b{text-align:center;opacity:.85}
  .t{font-size:15px;letter-spacing:.14em;margin-bottom:10px}
  .p{color:#8e8b82;font-size:12px;max-width:70ch;word-break:break-all}
  .d::after{content:'';animation:d 1.4s steps(4,end) infinite}
  @keyframes d{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}
</style>
<div class="b">
  <div class="t">axMap</div>
  <div class="p">저장소를 읽는 중<span class="d"></span></div>
  <div class="p" style="margin-top:8px">${String(t).replace(/[<&]/g, '')}</div>
</div>`)

function createWindow() {
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    /**
     * 🔴 배경은 새 껍데기(`shell.css` 의 `--bg`)에 맞춘 흰색이다.
     * 예전에는 검정이었다 — 기존 화면이 검은 배경이었기 때문이다. `/` 가
     * 밝은 화면으로 바뀐 지금 검정을 두면 창이 뜰 때 검은 판이 한 번 번쩍인다.
     */
    backgroundColor: '#ffffff',
    title: 'axMap', // 사람이 읽는 자리다 — 표시 이름은 `axMap`, 식별자만 `axmap`
    /**
     * 🔴 제목표시줄을 우리가 그린다.
     *
     * VS Code 처럼 메뉴와 창 단추가 한 막대 안에 있어야 테두리가 하나로 보인다.
     * 윈도우 기본 제목표시줄을 남겨 두면 회색 띠가 우리 툴바 위에 한 겹 더 얹혀
     * 두 개의 앱을 겹쳐 놓은 것처럼 보인다.
     *
     * 대가: 끌어서 옮기기·최소화·최대화·닫기를 전부 우리가 배선해야 한다.
     * `shell.css` 의 `-webkit-app-region` 과 이 파일의 `shell:window` 가 그 몫이다.
     */
    frame: false,
    show: !SELFTEST && !HIDDEN, // 자체 점검은 화면을 띄우지 않는다 — CI 에서도 같은 검사가 돌아야 한다
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  // 바깥 링크는 앱 안에서 열지 않는다. 기본 브라우저로 넘긴다.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  /**
   * 🔴 우리 서버 밖으로는 이동시키지 않는다.
   * 렌더러가 임의의 페이지가 되면 preload 가 노출한 것이 **그 페이지에도** 붙는다.
   * 이 앱은 사용자가 준 경로로 git 을 실행하므로 그 경계를 느슨하게 두지 않는다.
   */
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`) && !url.startsWith('data:')) {
      e.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
  })

  /**
   * 🔴 닫기는 **끝내기가 아니라 숨기기**다.
   *
   * Electron 이 네이티브에 지는 유일하게 체감되는 지점이 콜드 스타트다 —
   * Chromium 초기화에 1~3초가 걸린다. 그런데 그 비용은 **프로세스를 살려두면
   * 앱 수명에 한 번만** 내면 된다. ChatGPT 데스크톱 앱이 상주하는 이유가 이것이고,
   * 여기에 더해 우리는 서버가 이미 저장소를 다 읽어둔 상태를 유지한다 —
   * 다시 띄우면 큰 저장소는 수십 초를 다시 기다려야 한다.
   *
   * 숨기기가 되려면 **나가는 길이 반드시 보여야 한다.** 트레이 메뉴의 종료와
   * `저장소 › 종료` 가 그 길이고, 둘 다 `app.quit()` 를 거쳐 여기를 통과한다.
   */
  w.on('close', (e) => {
    if (quitting || SELFTEST) return
    e.preventDefault()
    w.hide()
  })

  w.on('closed', () => { win = null })
  return w
}

// ── 트레이 ──────────────────────────────────────────────────────────────────

/**
 * 트레이 아이콘을 코드로 그린다.
 *
 * 🔴 왜 `.png` 를 안 싣는가. 저장소에 바이너리를 넣지 않으면 리뷰에서 내용이
 * 그대로 보이고, 크기나 색을 고치는 데 이미지 편집기가 필요 없다.
 * 모양도 이 앱의 은유 그대로다 — 가운데 시작점과 그것을 두르는 궤도.
 *
 * 🔴 `createFromBitmap` 은 **BGRA** 순서를 받는다. RGBA 로 채우면 빨강과
 * 파랑이 바뀐 채로 조용히 뜬다. 에러는 안 난다.
 *
 * 윈도우 작업 표시줄은 밝은 테마와 어두운 테마가 다 있어서 한 색으로 그리면
 * 한쪽에서 사라진다. 밝은 획 바깥에 어두운 테두리를 한 겹 둘러 양쪽에서 보이게 한다.
 */
function trayIcon(size = 16) {
  const buf = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  const put = (i, r, g, b, a) => { buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a }
  /** 반지름 `at` 에 두께 `half` 로 부드러운 획을 놓는다. */
  const band = (d, at, half) => Math.max(0, 1 - Math.abs(d - at) / half)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c)
      const ink = Math.min(1, band(d, size * 0.40, 1.0) + band(d, 0, 1.6))
      const edge = Math.min(1, band(d, size * 0.40, 2.0) + band(d, 0, 2.6))
      const i = (y * size + x) * 4
      if (ink > 0.02) put(i, 232, 232, 232, Math.round(255 * ink))
      else if (edge > 0.02) put(i, 0, 0, 0, Math.round(170 * edge))
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function setupTray(hotkey) {
  try {
    tray = new Tray(trayIcon())
  } catch (e) {
    // 아이콘 하나 때문에 앱이 죽을 이유는 없다. 트레이 없이 계속 간다.
    console.log(`[shell] 트레이를 만들지 못했습니다: ${e.message}`)
    return
  }
  tray.setToolTip('axMap')
  tray.on('click', toggleWindow)
  refreshTray(hotkey)
}

function refreshTray(hotkey) {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `열기${hotkey ? `   ${hotkey}` : ''}`, click: () => { win?.show(); win?.focus() } },
    { label: '다른 저장소 열기…', click: () => pickAndReopen() },
    { type: 'separator' },
    {
      label: '윈도우 시작 시 실행',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => { setLoginItem(item.checked); refreshTray(hotkey) },
    },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]))
}

/**
 * 로그인할 때 조용히 띄운다.
 *
 * `--hidden` 을 함께 등록한다. 상주형 앱의 값은 "이미 떠 있다" 는 것이지
 * "부팅하자마자 앞에 나선다" 는 것이 아니다. 창은 단축키나 트레이로 부른다.
 */
function setLoginItem(on) {
  try { app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] }) } catch { /* 정책으로 막힐 수 있다 */ }
}

// ── 컴패니언 단축키 ─────────────────────────────────────────────────────────

/**
 * 상주해 있다가 단축키로 즉시 뜨고, 다시 누르면 숨는다.
 *
 * ChatGPT 윈도우 앱이 "프로그램을 여는 느낌" 이 아니라 OS 의 일부처럼 느껴지는
 * 이유의 대부분이 이것이다. 렌더러가 아니라 **셸이 만드는 느낌**이라
 * 우리도 같은 값을 아주 싸게 가져올 수 있다.
 *
 * 🔴 `Alt+Space` 는 윈도우 시스템 메뉴의 기본값이고, ChatGPT 앱이 깔려 있으면
 * 그쪽이 먼저 잡는다. 등록은 예외 없이 `false` 로 **조용히** 실패하므로
 * 후보를 순서대로 내려가고 무엇이 잡혔는지 반드시 남긴다.
 * 안 뜨는 단축키를 안내문에 적는 것이 최악이다.
 */
const HOTKEYS = ['Alt+Space', 'Alt+Shift+Space', 'Control+Shift+Space', 'Control+Shift+B']

function bindHotkey() {
  const wanted = readState().hotkey
  for (const key of wanted ? [wanted, ...HOTKEYS] : HOTKEYS) {
    let ok = false
    try { ok = globalShortcut.register(key, toggleWindow) } catch { ok = false }
    if (ok) {
      writeState({ hotkey: key })
      console.log(`[shell] 컴패니언 단축키 ${key}`)
      return key
    }
  }
  console.log('[shell] 컴패니언 단축키를 하나도 잡지 못했습니다 — 다른 앱이 전부 쥐고 있습니다')
  return null
}

function toggleWindow() {
  if (!win) return
  if (win.isVisible() && win.isFocused()) { win.hide(); return }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ── 메뉴 ────────────────────────────────────────────────────────────────────

function buildMenu(hotkey) {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '저장소',
      submenu: [
        { label: '다른 저장소 열기…', accelerator: 'CmdOrCtrl+O', click: () => pickAndReopen() },
        { type: 'separator' },
        { label: '서버 기록 보기', click: () => shell.openPath(logPath()) },
        { type: 'separator' },
        { label: '종료', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '새로고침', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { role: 'toggleDevTools', label: '개발자 도구' },
        { type: 'separator' },
        { role: 'resetZoom', label: '실제 크기' },
        { role: 'zoomIn', label: '확대' },
        { role: 'zoomOut', label: '축소' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
      ],
    },
    {
      label: '도움말',
      submenu: [
        { label: `컴패니언 단축키: ${hotkey ?? '없음'}`, enabled: false },
        { label: `대상: ${target ?? '-'}`, enabled: false },
      ],
    },
  ]))
}

// ── 대상 저장소 ─────────────────────────────────────────────────────────────

async function pickTarget() {
  const fromArg = optOf('--target')
  if (fromArg) return path.resolve(fromArg)
  if (SELFTEST) return CORE // 자기 자신을 분석한다. 사람이 고르는 창을 띄우지 않는다

  const last = readState().target
  if (last && fs.existsSync(last)) return last

  /**
   * 🔴 로그인 자동 실행인데 기억해 둔 저장소가 없으면 **아무것도 묻지 않는다.**
   * 부팅하자마자 폴더 고르는 창이 튀어나오는 것만큼 확실하게 미움받는 동작이 없다.
   * 사람이 한 번 직접 열어 저장소를 고르고 나면 그때부터 자동 실행이 의미를 갖는다.
   */
  if (HIDDEN) return null
  return askForTarget()
}

async function askForTarget() {
  const r = await dialog.showOpenDialog({
    title: '분석할 저장소를 고르세요',
    buttonLabel: '열기',
    properties: ['openDirectory'],
  })
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
}

/**
 * 대상이 바뀌면 서버를 다시 띄운다.
 *
 * `app/server.mjs` 는 시작할 때 인자로 대상을 받고 그 뒤로 바꾸지 않는다.
 * 코어에 "대상 교체" API 를 새로 뚫는 대신 셸이 프로세스를 갈아끼운다 —
 * 코어를 안 건드리는 쪽이 D16 의 경계에 맞고, 실패해도 서버만 죽는다.
 */
async function pickAndReopen(given = null) {
  const next = given ?? await askForTarget()
  if (!next) return
  writeState({ target: next })
  target = next
  stopServer()
  port = await freePort()
  await win?.loadURL(loadingPage(target))
  server = startServer(target, port)
  if (await waitUp(port)) await win?.loadURL(`http://127.0.0.1:${port}/`)
  else showServerFailure()
}

function showServerFailure() {
  dialog.showErrorBox('뷰어를 띄우지 못했습니다',
    `대상: ${target}\n\n서버 기록 마지막 줄:\n\n${tailLog()}\n\n전체 기록: ${logPath()}`)
}

// ── 자체 점검 ───────────────────────────────────────────────────────────────

/**
 * 창이 실제로 그려졌는지 확인하고 종료 코드로 답한다.
 *
 * `tools/smoke.mjs` 와 같은 이유로 있다 — 문법도 단위 테스트도 통과하는데
 * 부트스트랩이 죽어 화면이 통째로 비는 실패를 잡는다. 셸에서는 여기에
 * **preload · 샌드박스 · 포트 연결**까지 함께 검증된다.
 */
async function selftest() {
  /**
   * 화면은 하나다. 옛 화면(`/classic`)은 지웠다.
   *
   * 🔴 "정지 후 초당 그리기" 검사도 함께 뺐다. 그 검사는 `graph.js` 의 캔버스를
   * 재는 것이었는데 그 파일이 사라졌다. 잴 것이 없는데 남겨 두면 늘 0 이 나와서
   * **가짜로 통과한다** — 이 저장소에서 이미 세 번 겪은 실패다.
   * 가운데 칸에 새 그래프가 들어오면 그때 다시 세운다. 그때까지는 없는 검사다.
   */
  const MUST = [
    ['부트스트랩(shell.js)', /data-shell="ready"/],
    ['3분할 · 왼쪽 목록', /id="chats"/],
    ['3분할 · 오른쪽 입력', /id="composer"/],
    ['처음 설정 · CLI 고르기', /class="pick/],
  ]

  const until = Date.now() + 40_000
  let dom = ''
  while (Date.now() < until) {
    try {
      dom = await win.webContents.executeJavaScript('document.documentElement.outerHTML')
    } catch { dom = '' }
    if (MUST.every(([, re]) => re.test(dom))) break
    await new Promise((r) => setTimeout(r, 500))
  }

  console.log(`\nDOM ${dom.length.toLocaleString()} bytes`)
  let failed = 0
  for (const [what, re] of MUST) {
    const ok = re.test(dom)
    console.log(`  ${ok ? '통과' : '실패'}  ${what}`)
    if (!ok) failed++
  }
  if (failed) console.error(`\n창은 떴는데 화면이 비었습니다. 기록: ${logPath()}`)

  stopServer()
  app.exit(failed ? 1 : 0)
}


// ── 기동 ────────────────────────────────────────────────────────────────────

/**
 * 🔴 인스턴스는 하나만 둔다.
 * 전역 단축키로 부르는 상주형 앱이라 두 번째 인스턴스가 뜨면 단축키가
 * 어느 창을 부르는지 알 수 없게 되고, 포트도 두 벌 뜬다.
 */
/**
 * 🔴 자체 점검은 **잠금에 참여하지 않는다.**
 *
 * 이 앱은 상주형이다(닫기는 숨기기). 그래서 한 번 띄워 두면 그 인스턴스가
 * 잠금을 쥔 채 남고, 그다음부터 `--selftest` 는 잠금을 못 얻어 **아무것도
 * 출력하지 않고 종료 코드 0** 으로 끝난다 — 검사가 통과한 것처럼 보인다.
 *
 * 실제로 그렇게 됐다. 앞서 돌린 인스턴스 다섯 개가 살아 있어서 그 뒤의 모든
 * 자체 점검이 조용히 no-op 이었다. 이 저장소에서 세 번째로 잡은 같은 종류의
 * 가짜 통과다 — 검사는 실패할 수 있어야 검사다.
 *
 * 잠금을 못 얻은 평상시 실행은 조용히 끝나도 된다(앞의 창이 앞으로 나온다).
 * 하지만 그때도 **왜 끝났는지는 남긴다.**
 */
if (!SELFTEST && !app.requestSingleInstanceLock()) {
  console.error('[shell] 이미 실행 중입니다 — 그 창을 앞으로 가져옵니다.')
  app.quit()
} else {
  if (!SELFTEST) app.on('second-instance', () => { if (win) { win.show(); win.focus() } })
  app.whenReady().then(main).catch((e) => {
    // 자체 점검은 창을 띄울 사람이 없다. 대화상자로 막히면 그대로 멈춘다.
    if (SELFTEST) { console.error(String(e?.stack ?? e)); app.exit(1); return }
    dialog.showErrorBox('시작하지 못했습니다', String(e?.stack ?? e))
    app.exit(1)
  })
}

async function main() {
  await loadSharedTarget()
  target = await pickTarget()
  if (!target) { app.quit(); return }
  writeState({ target })

  port = await freePort()
  win = createWindow()
  /**
   * 자체 점검은 창을 띄우지 않는다.
   *
   * 한동안 띄웠다 — 그리기 횟수를 재려면 크로미움이 실제로 합성을 해야 했기
   * 때문이다. 그 검사가 사라졌으므로(캔버스가 없다) 다시 조용해진다.
   * 검사가 사람의 화면을 가리지 않는 편이 낫다.
   */
  await win.loadURL(loadingPage(target))

  server = startServer(target, port)
  if (!await waitUp(port)) {
    if (SELFTEST) {
      console.error(`서버가 뜨지 않았습니다.\n${tailLog()}`)
      stopServer()
      app.exit(1)
      return
    }
    showServerFailure()
    return
  }

  await win.loadURL(`http://127.0.0.1:${port}/`)

  const hotkey = SELFTEST ? null : bindHotkey()
  buildMenu(hotkey)
  if (!SELFTEST) setupTray(hotkey)

  if (SELFTEST) await selftest()
}

ipcMain.handle('shell:target', () => target)
ipcMain.handle('shell:open-repo', async () => { await pickAndReopen(); return target })

/**
 * 화면이 이미 받아 둔 경로로 갈아끼운다.
 *
 * `/api/open` 이 클론까지 끝내고 로컬 경로를 돌려주므로, 여기서는 그 경로로
 * 서버를 다시 띄우기만 하면 된다. 대상을 프로세스 안에서 바꾸지 않는 이유는
 * `app/server.mjs` 의 `/api/open` 주석에 있다.
 */
ipcMain.handle('shell:open-path', async (_e, p) => {
  if (typeof p !== 'string' || !p) return null
  await pickAndReopen(p)
  return target
})

ipcMain.handle('shell:pick-folder', async () => askForTarget())

/**
 * 창 단추. 제목표시줄을 우리가 그리기로 했으므로(`frame: false`) 이것도 우리 몫이다.
 * 🔴 여기 없는 동작은 화면에서 아무 일도 안 일어난다 — 조용히. 이름을 바꾸면 짝을 맞춘다.
 */
ipcMain.handle('shell:window', (_e, action) => {
  if (!win) return null
  if (action === 'min') win.minimize()
  else if (action === 'max') win.isMaximized() ? win.unmaximize() : win.maximize()
  else if (action === 'close') win.close()   // 닫기는 숨기기다 — 위의 `close` 처리 참고
  return win.isMaximized()
})

/**
 * 정상 경로에서는 여기로 오지 않는다 — 닫기는 숨기기이기 때문이다(`close` 처리).
 * 창이 정말로 파괴됐는데 트레이마저 없으면 되살릴 방법이 없으므로 그때는 끝낸다.
 */
app.on('window-all-closed', () => { if (quitting || !tray) { stopServer(); app.quit() } })
app.on('before-quit', () => { quitting = true; stopServer() })
app.on('will-quit', () => { globalShortcut.unregisterAll(); tray?.destroy() })
