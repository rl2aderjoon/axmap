/**
 * 새 껍데기 — 3분할과 대화만 있다.
 *
 * 🔴 여기는 **아무것도 실행하지 않는다.**
 *
 * 프로세스를 띄우고 출력을 모으는 일은 전부 서버(`app/lib/session.mjs`)가 한다.
 * 이 파일은 모인 것을 받아 그릴 뿐이다. 그래야 창이 느려지거나 닫혀도 진행
 * 중인 작업이 계속 돈다 — 그것이 이 구조의 유일한 목적이다.
 *
 * 🔴 그리고 이 파일은 **일부러 작다.**
 *
 * 옛 화면이 3,527줄까지 자란 것은 기능을 하나씩 덧댄 결과다(지금은 지웠다).
 * 여기에 무언가를 올릴 때는 `docs/BENCH.md` 의 M3(핵심까지 가는 데 몇 번
 * 눌렀나)를 앞당기는지 먼저 묻는다. 앞당기지 않으면 올리지 않는다.
 */

/**
 * 가운데 칸은 별도 모듈이 그린다.
 *
 * 🔴 이 파일에 밀어 넣지 않는 이유: 옛 화면이 3,527줄까지 자란 것이 정확히
 * "한 파일에 하나씩 덧대기" 의 결과였다. 칸이 하나 늘면 파일도 하나 는다.
 */
import { drawStage, watchStage } from './stage.js'

const $ = (s) => document.querySelector(s)

const S = {
  /** 지금 열어 둔 세션 id */
  cur: null,
  /** 이 세션에서 어디까지 받아 갔나. 매번 전부 받으면 화면이 느려진다. */
  since: -1,
  state: 'idle',
  agent: null,
  agentName: null,
  agents: [],
  /** 지금 보고 있는 저장소의 절대 경로 */
  root: null,
  /** 지금 도는 코드가 어느 빌드인가. 낡은 설치본을 알아차리게 한다 */
  version: null,
  sending: false,
}

const api = async (path, opt) => {
  const r = await fetch(path, opt)
  const body = await r.json().catch(() => ({ error: '응답을 읽지 못했습니다' }))
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
  return body
}
const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
})

/**
 * 대화가 비었는가. 인사말과 입력창을 칸 가운데로 띄울지 정한다.
 * 상태를 CSS 클래스 하나로 두어 배치 규칙이 전부 `shell.css` 에 남게 한다 —
 * 자바스크립트가 좌표를 계산하기 시작하면 반응형이 곧바로 깨진다.
 */
const blank = (on) => $('#chat').classList.toggle('blank', on)

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

// ── 왼쪽 ────────────────────────────────────────────────────────────────────

function tabs() {
  for (const t of document.querySelectorAll('.tab')) {
    t.onclick = () => {
      for (const o of document.querySelectorAll('.tab')) o.classList.toggle('on', o === t)
      /**
       * 🔴 아직 아무 일도 하지 않는다. 일부러 그렇다.
       * 감시 · 이해가 각각 가운데 칸에 무엇을 그릴지는 아직 안 정했다.
       * 안 정한 것을 정한 것처럼 배선해 두면 나중에 그 배선을 먼저 풀어야 한다.
       */
    }
  }
}

async function refreshChats() {
  let list
  try { ({ sessions: list } = await api('/api/sessions')) } catch { return }

  const box = $('#chats')
  box.replaceChildren()
  if (!list.length) { box.append(el('div', 'empty', '아직 없습니다')); return }

  for (const s of list) {
    const cls = ['chat', s.id === S.cur && 'on', s.state === 'running' && 'run', s.state === 'error' && 'err']
    const row = el('div', cls.filter(Boolean).join(' '))
    row.append(el('span', 'dot'))
    row.append(el('span', 'name', s.title))
    // 고친 파일 수. 세어서 보이는 것 자체가 이 제품의 요점이다 (D1 의 F2).
    if (s.touched) row.append(el('span', 'n', String(s.touched)))
    row.title = `${s.agentName} · ${s.cwd}`
    row.onclick = () => open(s.id)
    box.append(row)
  }
}

// ── 대화 ────────────────────────────────────────────────────────────────────

async function open(id) {
  if (S.cur === id) return
  S.cur = id
  S.since = -1
  $('#thread').replaceChildren()
  await pump()
  await refreshChats()
}

async function create() {
  if (!S.agent) return null
  try {
    const s = await post('/api/sessions', { agent: S.agent })
    S.cur = s.id
    S.since = -1
    $('#thread').replaceChildren()
    await refreshChats()
    return s.id
  } catch (e) { fail(e.message); return null }
}

/** 서버에 밀린 메시지를 받아 온다. */
async function pump() {
  if (!S.cur) return
  let v
  try { v = await api(`/api/session/${S.cur}?since=${S.since}`) } catch { return }

  S.state = v.state
  $('#title').textContent = v.title ?? ''
  $('#stop').hidden = v.state !== 'running'

  if (v.messages.length) {
    for (const m of v.messages) { S.since = m.seq; draw(m) }
    const t = $('#thread')
    t.scrollTop = t.scrollHeight
  }
  touched(v.touched)
  think(v.state === 'running')
  $('#send').disabled = v.state === 'running' || !S.agent
  $('#hello').hidden = true
  blank(false)
}

function draw(m) {
  const t = $('#thread')

  if (m.role === 'tool') {
    const n = el('div', `msg tool${m.edits ? ' edits' : ''}`)
    n.append(el('span', 't', m.edits ? '고침' : m.tool))
    n.append(el('span', 'a', m.text || m.tool))
    n.title = `${m.tool}${m.file ? ` · ${m.file}` : ''}`
    t.append(n)
    return
  }

  if (m.role === 'meta' || m.role === 'raw') {
    // 버리지 않고 접어 둔다 — 사용량 한도에 걸려 멈춘 것인지 알 방법이 있어야 한다.
    const d = el('details', 'msg')
    d.append(el('summary', null, m.role === 'meta' ? '내부 신호' : '해석 못 한 출력'))
    d.append(el('pre', null, m.text))
    t.append(d)
    return
  }

  t.append(el('div', `msg ${m.role}`, m.text))
}

/**
 * 🔴 AI 가 고친 파일. 접지 않는다.
 *
 * 터미널의 겉모습은 감춰도 결과를 감추면, 이 제품이 없애려던 공포
 * (DECISIONS.md D1 의 F2 — "AI 가 뭘 망가뜨렸는지 모른다")를 이 제품이
 * 직접 만들어내게 된다. 채팅으로 포장할수록 이 줄이 더 중요해진다.
 */
function touched(list) {
  const box = $('#touched')
  if (!list?.length) { box.hidden = true; box.replaceChildren(); return }
  box.replaceChildren()
  box.hidden = false
  const head = el('span')
  head.append(document.createTextNode('이 대화가 고친 파일 '))
  head.append(el('b', null, String(list.length)))
  head.append(document.createTextNode('개'))
  box.append(head)
  for (const t of list.slice(0, 6)) box.append(el('span', 'f', `${t.file}${t.n > 1 ? `  ×${t.n}` : ''}`))
  if (list.length > 6) box.append(el('span', 'f', `… 그 밖에 ${list.length - 6}개`))
}

function think(on) {
  const t = $('#thread')
  const cur = t.querySelector('.think')
  if (on && !cur) { t.append(el('div', 'think', '작업하는 중')); t.scrollTop = t.scrollHeight }
  if (!on && cur) cur.remove()
}

function fail(text) {
  $('#hello').hidden = true
  blank(false)
  $('#thread').append(el('div', 'msg error', text))
}

async function send() {
  const box = $('#input')
  const text = box.value.trim()
  if (!text || S.sending) return

  // 세션이 없으면 조용히 하나 만든다. 사용자는 "새 대화" 를 의식할 필요가 없다.
  if (!S.cur && !await create()) return

  S.sending = true
  box.value = ''
  box.style.height = 'auto'
  $('#send').disabled = true
  $('#hello').hidden = true
  blank(false)
  try {
    await post(`/api/session/${S.cur}/send`, { prompt: text })
  } catch (e) {
    fail(e.message)
    box.value = text // 사용자가 쓴 말을 잃지 않는다
  } finally { S.sending = false }
  await pump()
  await refreshChats()
}

// ── 분할선 ──────────────────────────────────────────────────────────────────

function gutters() {
  for (const g of document.querySelectorAll('.gut')) {
    const pane = g.dataset.pane === 'side' ? $('#side') : $('#chat')
    const fromLeft = g.dataset.pane === 'side'
    let on = false
    g.addEventListener('mousedown', (e) => { on = true; e.preventDefault() })
    window.addEventListener('mousemove', (e) => {
      if (!on) return
      const w = fromLeft ? e.clientX : window.innerWidth - e.clientX
      pane.style.width = `${Math.max(200, Math.min(900, w))}px`
    })
    window.addEventListener('mouseup', () => { on = false })
  }
}

// ── 입력 ────────────────────────────────────────────────────────────────────

function input() {
  const box = $('#input')
  box.addEventListener('input', () => {
    box.style.height = 'auto'
    box.style.height = `${Math.min(200, box.scrollHeight)}px`
  })
  box.addEventListener('keydown', (e) => {
    // Enter 로 보내고 Shift+Enter 로 줄을 바꾼다. 채팅의 관습 그대로다.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() }
  })
  $('#send').onclick = send
  $('#new').onclick = async () => {
    S.cur = null
    S.since = -1
    $('#thread').replaceChildren()
    $('#touched').hidden = true
    $('#title').textContent = ''
    $('#hello').hidden = false
    blank(true)
    await refreshChats()
    $('#input').focus()
  }
  $('#stop').onclick = async () => {
    if (!S.cur) return
    try { await post(`/api/session/${S.cur}/stop`) } catch { /* 이미 끝났으면 그만 */ }
    await pump()
  }
}

// ── 시작 ────────────────────────────────────────────────────────────────────

async function agents() {
  try {
    const r = await api('/api/agents')
    S.agent = r.preferred
    const pick = r.agents.find((a) => a.id === r.preferred)
    S.agentName = pick?.name ?? null
    S.agents = r.agents
    /**
     * 🔴 못 쓰는 이유를 **대화를 시작하기 전에** 말한다.
     * 터미널을 감춰 놨기 때문에, 로그인이 안 된 채로 프롬프트를 보내면
     * 사용자에게는 그냥 아무 일도 안 일어난 것으로 보인다.
     * 그 침묵이 이 설계에서 가장 위험한 실패 모드다.
     */
    if (!pick) {
      $('#agent').textContent = 'AI CLI 없음 — claude · agy · codex 중 하나를 설치하세요'
      $('#send').disabled = true
      return S.agents
    }
    $('#agent').textContent = pick.signedIn === 'unknown'
      ? `${pick.name} · 로그인 상태를 확인하지 못했습니다`
      : pick.name
  } catch (e) {
    $('#agent').textContent = `AI CLI 를 확인하지 못했습니다 — ${e.message}`
    $('#send').disabled = true
  }
  return S.agents ?? []
}

async function repo() {
  try {
    const g = await api('/api/graph')
    const name = String(g.root ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
    S.root = g.root ?? null
    $('#repo').textContent = name
    $('#repo').title = g.root ?? ''
    // 툴바 가운데가 창 제목 노릇을 한다 — VS Code 가 파일 이름을 두는 자리다
    $('#where').textContent = g.root ?? ''
    // 가운데 칸의 내용물은 `stage.js` 가 그린다. 여기는 이름만 적는다.
    drawStage()
  } catch { /* 대상을 못 읽으면 stage 가 스스로 이유를 말한다 */ }
}

async function init() {
  tabs()
  input()
  gutters()
  watchStage()
  blank(true)
  $('#note').textContent = 'Enter 로 보내기 · Shift+Enter 줄바꿈'

  toolbar()
  const list = await agents()
  await refreshChats()
  try { S.version = (await api('/api/version')).label } catch { /* 없으면 그만 */ }

  /**
   * 🔴 온보딩이 끝나기 전에는 **아무것도 분석하지 않는다.**
   *
   * 예전에는 시작하자마자 `/api/graph` 를 불렀다. 서버는 늘 어떤 대상을 갖고
   * 있으므로(기본값이 실행 디렉터리다) 사용자가 아무것도 고르지 않았는데도
   * "axMap · 파일 77개" 가 떴다. 묻지도 않고 남의 폴더를 읽어 놓고
   * 그 결과를 보여준 셈이다 — 무엇을 보고 있는지 사용자가 모른다.
   */
  if (await onboarding(list)) await repo()

  const tick = async () => {
    await pump()
    await refreshChats()
    setTimeout(tick, S.state === 'running' ? 600 : 3000)
  }
  setTimeout(tick, 800)

  /**
   * 🔴 여기까지 왔다는 표식. `tools/smoke.mjs` 가 이것을 본다.
   * 부트스트랩이 중간에 죽으면 화면이 조용히 빈 채로 뜨고, 문법 검사도 단위
   * 테스트도 그것을 못 잡는다 — 이 저장소가 하룻밤에 두 번 겪은 일이다.
   */
  document.body.dataset.shell = 'ready'
}


// ── 툴바 = 창 테두리 ────────────────────────────────────────────────────────

/**
 * 🔴 메뉴 이름을 글자로 늘어놓지 않는다.
 *
 * `저장소`·`보기`·`도움말` 셋을 나란히 두면 창 위에 띠가 하나 더 얹힌 것처럼
 * 보이고, 그 줄은 낭비다. 아이콘으로 대신할 수 있는 것은 아이콘으로 옮기고
 * 나머지는 전부 `☰` 하나에 접었다.
 *
 * 항목이 늘어나도 여기만 늘어난다 — 막대는 그대로다.
 */
const MENU = () => [
  ['저장소 열기…', 'Ctrl+O', () => openStep()],
  ['사이드바 접기·펴기', 'Ctrl+B', () => toggleSide()],
  null,
  ['감시', '', () => document.querySelector('.tab[data-mode="watch"]').click()],
  ['이해', '', () => document.querySelector('.tab[data-mode="understand"]').click()],
  ['새 대화', '', () => $('#new').click()],
  null,
  ['새로고침', 'Ctrl+R', () => location.reload()],
  ['처음 설정 다시 하기', '', () => resetOnboard()],
  null,
  [`대상: ${S.root ?? '—'}`, '', null],
  [`AI: ${S.agentName ?? '—'}`, '', null],
  /**
   * 🔴 지금 도는 것이 어느 빌드인가.
   * 바탕화면 아이콘은 마지막으로 **빌드한** 것을 가리킨다. 커밋만 하고 다시
   * 빌드하지 않으면 옛것이 계속 열린다 — 그것 때문에 한 번 헤맸다.
   */
  [`버전: ${S.version ?? '—'}`, '', null],
]

function closeDrop() {
  $('#drop').hidden = true
  for (const m of document.querySelectorAll('.ico[data-menu]')) m.classList.remove('open')
}

function openDrop(btn) {
  const drop = $('#drop')
  drop.replaceChildren()
  for (const it of MENU()) {
    if (!it) { drop.append(document.createElement('hr')); continue }
    const [label, key, run] = it
    const b = el('button', null, label)
    if (key) b.append(el('span', 'k', key))
    if (run) b.onclick = () => { closeDrop(); run() }
    else b.disabled = true
    drop.append(b)
  }
  const r = btn.getBoundingClientRect()
  drop.style.left = `${r.left}px`
  drop.style.top = `${r.bottom + 3}px`
  drop.hidden = false
  btn.classList.add('open')
}

/** 사이드바를 접어 가운데 칸에 자리를 준다. 배치 규칙은 전부 CSS 에 둔다. */
function toggleSide() {
  document.body.classList.toggle('no-side')
}

function toolbar() {
  for (const m of document.querySelectorAll('.ico[data-menu]')) {
    m.onclick = (e) => {
      e.stopPropagation()
      if (m.classList.contains('open')) closeDrop()
      else openDrop(m)
    }
  }
  $('#sidetoggle').onclick = toggleSide
  $('#openrepo').onclick = () => openStep()

  window.addEventListener('click', closeDrop)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeDrop(); closeModal() }
    // VS Code 와 같은 자리에 둔다. 손이 이미 기억하고 있는 조합이다.
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); openStep() }
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); toggleSide() }
  })

  /**
   * 창 단추는 데스크톱에서만 보인다.
   * 브라우저에는 이미 창 단추가 있고, 우리가 하나 더 그리면 두 벌이 된다.
   */
  const sh = window.axmapShell
  if (!sh?.window) return
  $('#wctl').hidden = false
  for (const b of document.querySelectorAll('#wctl button')) {
    b.onclick = () => sh.window(b.dataset.win)
  }
}

// ── 처음 오는 사람 ──────────────────────────────────────────────────────────

const PREF = 'axmap.agent'

const step = (n) => {
  for (const s of document.querySelectorAll('#onboard section')) s.hidden = s.dataset.step !== String(n)
  const dots = [...document.querySelectorAll('.steps i')]
  dots.forEach((d, i) => d.classList.toggle('on', i < n))
}

/**
 * 🔴 설치·로그인 상태를 카드에 **그대로 적는다.**
 *
 * 터미널을 감춰 놨기 때문에, 못 쓰는 CLI 를 고르면 첫 프롬프트에서 아무 일도
 * 안 일어난 것처럼 보인다. 그 침묵이 이 설계의 가장 위험한 실패 모드라
 * 고르기 전에 말한다. 모르면 모른다고 적는다 (`unknown`).
 */
function drawPicks(list) {
  const box = $('#picks')
  box.replaceChildren()
  for (const a of list) {
    const b = el('button', 'pick')
    b.append(el('span', 'nm', a.name))
    const st = a.installed
      ? (a.signedIn === 'yes' ? ['ok', '준비됨']
        : a.signedIn === 'unknown' ? ['warn', '로그인 확인 못 함'] : ['warn', '로그인 필요'])
      : ['', '설치되어 있지 않음']
    b.append(el('span', `st ${st[0]}`, st[1] + (a.unverified ? ' · 미검증' : '')))
    b.disabled = !a.installed
    b.onclick = () => {
      for (const o of box.children) o.classList.remove('on')
      b.classList.add('on')
      S.agent = a.id
      S.agentName = a.name
      $('#s1next').disabled = false
    }
    if (a.id === S.agent) { b.classList.add('on'); $('#s1next').disabled = false }
    box.append(b)
  }
  if (!list.some((a) => a.installed)) {
    box.append(el('div', 'empty', 'claude · agy · codex 중 하나를 설치한 뒤 다시 열어 주세요.'))
  }
}

/**
 * 저장소 열기 — **모달**로 띄운다.
 *
 * 🔴 처음 오는 사람에게는 화면 전체를 쓰고, 그 뒤로는 모달이다.
 *
 * 처음에는 다른 할 일이 없으니 전체를 써도 되지만, 이미 일하고 있는 사람에게
 * 화면을 통째로 뺏으면 하던 대화가 사라진 것처럼 보인다. 같은 markup 을 쓰고
 * 겉모습만 바꾼다 — 두 벌을 만들면 한쪽만 고쳐서 어긋난다.
 */
function openStep() {
  $('#onboard').classList.add('as-modal')
  $('#onboard').hidden = false
  step(2)
  setTimeout(() => $('#url').focus(), 0)
}

function closeModal() {
  // 전체화면(첫 실행)일 때는 닫히면 안 된다 — 고르기 전에는 할 수 있는 게 없다.
  if (!$('#onboard').classList.contains('as-modal')) return
  $('#onboard').hidden = true
}

function resetOnboard() {
  try { localStorage.removeItem(PREF) } catch { /* 사생활 모드면 그만 */ }
  $('#onboard').classList.remove('as-modal')
  $('#onboard').hidden = false
  step(1)
}

/**
 * 저장소를 연다. 서버는 **받아 오기만** 하고 대상을 바꾸지 않는다 —
 * 이유는 `/api/open` 의 주석에 있다. 바꾸는 것은 셸이 프로세스를 갈아끼워서 한다.
 */
async function openRepo(target) {
  const msg = $('#omsg')
  msg.className = ''
  msg.textContent = '확인하는 중…'
  $('#go').disabled = true
  try {
    let r = await post('/api/open', { target })

    /**
     * git 주소면 서버가 자식에게 클론을 맡기고 **작업 id 만** 돌려준다.
     * 여기서 끝날 때까지 기다리되, 진행 상황을 그대로 보여준다 —
     * 처음 받는 저장소는 몇 분이 걸리고, 그동안 아무 말도 없으면 멈춘 줄 안다.
     */
    if (r.job) {
      const current = r.current
      for (;;) {
        await new Promise((s) => setTimeout(s, 700))
        const j = await api(`/api/open/status?job=${encodeURIComponent(r.job)}`)
        if (j.state === 'error') throw new Error(j.error ?? '받아오지 못했습니다')
        msg.textContent = j.log.at(-1) ?? '받아오는 중…'
        if (j.state === 'done') { r = { root: j.root, current, commits: j.commits }; break }
      }
    }

    if (r.root === r.current) {
      msg.textContent = '이미 이 저장소를 보고 있습니다.'
      finishOnboard()
      return
    }
    const sh = window.axmapShell
    if (sh?.openPath) {
      msg.textContent = '여는 중…'
      await sh.openPath(r.root)   // 셸이 서버를 갈아끼운다. 곧 화면이 새로 뜬다
      return
    }
    /**
     * 브라우저에서는 프로세스를 갈아끼울 수 없다. 숨기지 않고 그대로 말한다 —
     * 조용히 이전 저장소를 계속 보여주는 것이 훨씬 나쁘다.
     */
    msg.className = 'err'
    msg.textContent = `받았습니다: ${r.root}\n브라우저에서는 서버를 다시 띄워야 합니다 — 데스크톱 앱에서는 바로 열립니다.`
  } catch (e) {
    msg.className = 'err'
    msg.textContent = e.message
  } finally { $('#go').disabled = false }
}

function finishOnboard() {
  try { if (S.agent) localStorage.setItem(PREF, S.agent) } catch { /* 그만 */ }
  $('#onboard').hidden = true
  $('#input').focus()
  // 🔴 여기서 **처음으로** 저장소를 읽는다. 이유는 `repo()` 주석 참고.
  repo()
}

async function onboarding(list) {
  let saved = null
  try { saved = localStorage.getItem(PREF) } catch { /* 사생활 모드 */ }

  /**
   * `?agent=claude` — 고를 값을 주소로 심는다.
   *
   * 왜 있나. 두 가지 다 진짜 쓰임이다.
   *   · 팀에서 쓰는 CLI 가 정해져 있으면 그 주소를 공유하면 된다.
   *     받는 사람은 1단계를 안 본다
   *   · 🔴 `npm run smoke` 가 **온보딩 뒤의 화면**에 닿는 유일한 길이다.
   *     헤드리스는 클릭을 못 하고 localStorage 도 비어 있어서, 이것이 없으면
   *     가운데 칸 렌더러가 검사에서 통째로 빠진다 — 검사기가 눈이 머는 것이 최악이다
   *
   * 설치돼 있지 않은 값이면 **무시한다.** 주소에 적혔다고 없는 CLI 를
   * 있다고 치면 첫 프롬프트에서 조용히 멈춘다.
   */
  try {
    const want = new URLSearchParams(location.search).get('agent')
    if (want && list.some((x) => x.id === want && x.installed)) {
      saved = want
      try { localStorage.setItem(PREF, want) } catch { /* 그만 */ }
    }
  } catch { /* 주소가 이상하면 그냥 묻는다 */ }

  // 저장된 선택이 아직 쓸 수 있으면 묻지 않는다. 매번 묻는 것도 실패다.
  const ok = list.find((a) => a.id === saved && a.installed)
  if (ok) { S.agent = ok.id; S.agentName = ok.name; return true }

  S.agent = null
  drawPicks(list)
  step(1)
  $('#onboard').hidden = false

  $('#s1next').onclick = () => step(2)
  $('#s2back').onclick = () => step(1)
  $('#skip').onclick = finishOnboard
  $('#go').onclick = () => openRepo($('#url').value.trim())
  $('#url').onkeydown = (e) => { if (e.key === 'Enter') $('#go').click() }
  $('#oclose').onclick = closeModal
  return false

}

/**
 * 🔴 여기가 파일의 **맨 끝**이어야 한다.
 *
 * 위쪽 어딘가에서 부르면 그 아래의 `const`(MENUS · PREF …)가 TDZ 에 걸려
 * 부트스트랩이 통째로 죽는다. 문법 검사도 단위 테스트도 통과하고 화면만 빈다 —
 * 이 저장소가 하룻밤에 두 번 겪은 실패가 정확히 이것이다.
 */
init()
