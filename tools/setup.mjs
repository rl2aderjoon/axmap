#!/usr/bin/env node
/**
 * Install axMap globally from any directory. Installation is machine state;
 * repository ledgers are prepared at runtime in the caller's working repo.
 * Only explicit project options (--repo / --remote / --commands project)
 * select a repository during setup. Commit enforcement remains opt-in.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

import { displayNameError, readProfile, writeProfile, profilePath } from '../src/identity.mjs'
import { agentNameError } from '../src/protocol.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE_ROOT = path.resolve(HERE, '..')

const EXIT = { OK: 0, CANNOT_START: 1, PARTIAL: 2 }

// ── 화면 ────────────────────────────────────────────────────────────────────

const tty = process.stdout.isTTY
const C = tty
  ? { g: '\u001b[32m', y: '\u001b[33m', r: '\u001b[31m', d: '\u001b[2m', x: '\u001b[0m' }
  : { g: '', y: '', r: '', d: '', x: '' }

let bad = 0
const say = (s = '') => console.log(s)
const ok = (what, detail) => say(`${C.g}  OK  ${C.x}${String(what).padEnd(10)} ${detail}`)
const hm = (what, detail) => say(`${C.y}  ~~  ${C.x}${String(what).padEnd(10)} ${detail}`)
const no = (what, detail) => { bad++; say(`${C.r}  !!  ${C.x}${String(what).padEnd(10)} ${detail}`) }

function die(msg) {
  console.error(`\n${C.r}중단: ${msg}${C.x}\n`)
  process.exit(EXIT.CANNOT_START)
}

// ── 인자 ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (n) => {
  const i = argv.indexOf(n)
  if (i < 0) return null
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : null
}
const has = (n) => argv.includes(n)

if (has('-h') || has('--help')) {
  say(`
axmap setup — 어느 폴더에서든 이 PC에 axMap을 전역 설치·등록한다

  npx -y axmap-cli@latest setup
  npx -y axmap-cli@latest setup --remote <이름 또는 git 주소>

  --repo <경로>        선택 사항: 이 저장소의 장부·커밋 훅도 명시적으로 준비한다
  --remote <이름|URL>  장부를 둘 원격. git 주소를 주면, 그 주소를 가리키는 원격이
                       없을 때 'axmap' 이라는 이름으로 하나 더한다
  --name <이름>        쪽지 표시 이름을 저장한다 (대화형 실행에서는 직접 입력)
  --dest <경로>        프로그램을 둘 자리 (기본: ~/.axmap/app)
  --commands <곳>      슬래시 명령을 둘 자리: global(기본) · project · none
  --hook               프롬프트마다 쪽지를 받는 하네스 훅을 settings.json 에 더한다
                       (기본은 안 더한다 — 매 턴 도는 명령이라 사람이 고를 일이다)
  --no-register        이 PC 의 AI CLI 등록을 건너뛴다
  --no-ledger          --repo를 지정했어도 장부·커밋 훅을 건드리지 않는다
  --dry-run            아무것도 쓰지 않고 무엇을 할지만 찍는다

종료 코드: 0 성공 · 1 시작 불가 · 2 일부 실패
`)
  process.exit(EXIT.OK)
}

const DRY = has('--dry-run')
const commandsWhere = flag('--commands') ?? 'global'
if (!['global', 'project', 'none'].includes(commandsWhere)) {
  die(`--commands 는 global · project · none 중 하나입니다: ${commandsWhere}`)
}

// ── git ─────────────────────────────────────────────────────────────────────

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

// ── 1. node ─────────────────────────────────────────────────────────────────

const major = Number(process.versions.node.split('.')[0])

say('')
say(`axMap 설치${DRY ? `${C.d}  (dry-run — 아무것도 쓰지 않습니다)${C.x}` : ''}`)
say('')

if (major < 20) die(`Node v${process.versions.node} 입니다. 20 이상이 필요합니다.`)
ok('node', `v${process.versions.node}`)

// ── 2. 대상 저장소 ──────────────────────────────────────────────────────────
//
// Installation has no working repository. Only explicit project options use one.
const projectRequested = has('--repo') || has('--remote') || commandsWhere === 'project'
if (has('--repo') && !flag('--repo')) die('--repo 뒤에 저장소 경로를 지정하세요.')
let REPO = null
if (projectRequested) {
  const where = path.resolve(flag('--repo') ?? process.cwd())
  const top = git(['rev-parse', '--show-toplevel'], where)
  if (top.code !== 0) die(`프로젝트 옵션의 대상이 Git 저장소가 아닙니다: ${where}\n전역 설치만 하려면 --repo, --remote, --commands project 없이 axmap setup을 실행하세요.`)
  REPO = path.resolve(top.out)
  ok('저장소', `${REPO}  (명시적 프로젝트 설정)`)
} else {
  ok('설치 범위', '이 PC 전체 — 작업 repo는 이후 CLI·MCP 실행 위치에서 결정합니다')
}

// ── 3. 이름 ─────────────────────────────────────────────────────────────────
// Display labels are independent of claim ownership. The saved label is the
// default on upgrades; a first setup starts from this person's Git identity.
let name = flag('--name')
let nameFrom = '--name'
if (has('--name') && !name) die('--name 뒤에 표시 이름을 지정하세요.')
let saved
try { saved = readProfile() } catch (e) { die(e.message) }
if (!name && saved) { name = saved.name; nameFrom = '저장된 표시 이름' }
if (!name) {
  const g = git(REPO ? ['config', 'user.name'] : ['config', '--global', 'user.name'], REPO ?? os.homedir())
  if (g.code === 0 && g.out) { name = g.out; nameFrom = REPO ? 'git config user.name' : 'git config --global user.name' }
}
if (!name) {
  try { name = os.userInfo().username; nameFrom = 'OS 사용자 이름' } catch { /* 아래 */ }
}
if (!name) { name = os.hostname(); nameFrom = '호스트 이름' }
if (!name) die('이 PC 에서 쓸 이름을 정하지 못했습니다. --name "홍길동" 으로 직접 주세요.')

if (!has('--name') && !DRY && process.stdin.isTTY && process.stdout.isTTY) {
  const input = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const answer = (await input.question(`쪽지에 표시할 이름 [${name}]: `)).trim().normalize('NFC')
      const candidate = answer || name
      const error = displayNameError(candidate)
      if (error) { say(error); continue }
      name = candidate
      nameFrom = '표시 이름 입력'
      break
    }
  } finally { input.close() }
}

// 검사기를 다시 짜지 않는다. 여기서 통과시킨 이름을 서버가 거부하면 설치가 거짓말이 된다.
const nameErr = displayNameError(name)
if (nameErr) die(`이 표시 이름은 쓸 수 없습니다: ${name}\n\n${nameErr}`)
if (!DRY) {
  try { writeProfile(name) } catch (e) { die(e.message) }
}
ok('쪽지 이름', `${name}  (${nameFrom}${DRY ? ', 저장 예정' : ''})`)
const email = git(REPO ? ['config', 'user.email'] : ['config', '--global', 'user.email'], REPO ?? os.homedir()).out
if (email) ok('Git 이메일', `${email} — 실제 쪽지 주소는 작업 repo의 Git 설정을 사용합니다`)
else hm('Git 이메일', '작업 repo의 git config user.email을 사용합니다. 이메일은 별도로 저장하지 않습니다.')
say(`         이름 변경: axmap setup --name "새 이름"  (${profilePath()})`)
// Changing a message label must not change ownership of existing claims.
const agentIdentity = git(REPO ? ['config', 'user.name'] : ['config', '--global', 'user.name'], REPO ?? os.homedir()).out
  || (() => { try { return os.userInfo().username } catch { return os.hostname() } })()
if (agentNameError(agentIdentity)) die('Git 사용자 이름을 선점 이름으로 쓸 수 없습니다. git config user.name을 확인하세요.')

// ── 4. 장부를 둘 원격 ───────────────────────────────────────────────────────
//
// 사용자가 "자기 git 주소" 를 넣는 자리가 여기다. 코드가 아니라 **설정**으로
// 남는다 — `git config axmap.remote`. 이 저장소가 이미 쓰던 방식이고
// (`bin/axmap.mjs` 의 `resolveRemote`), 새 방식을 만들지 않았다.
//
// 순서는 그쪽이 정한 그대로다: `--remote` → `AXMAP_REMOTE` → `git config
// axmap.remote` → 유일한 원격 → origin. 여기서는 맨 앞의 한 칸만 채운다.
const looksLikeUrl = (s) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[^/]+@[^/]+:/.test(s) || /\.git$/i.test(s)

function configureRemote(spec) {
  if (!spec) {
    const cur = git(['config', '--get', 'axmap.remote'], REPO)
    if (cur.code === 0 && cur.out) ok('장부 원격', `${cur.out}  (이미 git config axmap.remote 에 있습니다)`)
    else hm('장부 원격', '지정하지 않았습니다 — axmap init 이 정합니다 (원격이 하나면 그것, origin 이 있으면 origin)')
    return
  }

  const names = git(['remote'], REPO).out.split('\n').map((s) => s.trim()).filter(Boolean)
  let picked = null

  if (looksLikeUrl(spec)) {
    // 같은 주소를 가리키는 원격이 이미 있으면 그것을 쓴다. 원격을 새로 만드는 것은
    // 마지막 수단이다 — 같은 곳을 가리키는 원격이 둘이면 사람이 헷갈린다.
    for (const n of names) {
      const url = git(['remote', 'get-url', n], REPO).out
      if (url && url.replace(/\.git$/, '') === spec.replace(/\.git$/, '')) { picked = n; break }
    }
    if (!picked) {
      if (DRY) { hm('장부 원격', `(dry-run) 'axmap' 이라는 원격을 더했을 것입니다 → ${spec}`); picked = 'axmap' }
      else if (names.includes('axmap')) {
        // 이름은 이미 있는데 주소가 다르다. 조용히 갈아끼우지 않는다 — 남의 원격이다.
        no('장부 원격', `'axmap' 이라는 원격이 이미 다른 곳을 가리킵니다: ${git(['remote', 'get-url', 'axmap'], REPO).out}\n         바꾸려면 직접:  git remote set-url axmap ${spec}`)
        return
      } else {
        const r = git(['remote', 'add', 'axmap', spec], REPO)
        if (r.code !== 0) { no('장부 원격', `원격을 더하지 못했습니다: ${r.err}`); return }
        picked = 'axmap'
        ok('장부 원격', `'axmap' 이라는 원격을 더했습니다 → ${spec}`)
      }
    } else {
      ok('장부 원격', `이미 있는 원격을 씁니다: ${picked} → ${spec}`)
    }
  } else {
    if (!names.includes(spec)) {
      no('장부 원격', `그런 원격이 없습니다: ${spec}\n         이 저장소의 원격: ${names.join(', ') || '(없음)'}`)
      return
    }
    picked = spec
  }

  if (DRY) { hm('장부 원격', `(dry-run) git config axmap.remote ${picked}`); return }
  const c = git(['config', 'axmap.remote', picked], REPO)
  if (c.code !== 0) no('장부 원격', `git config 에 적지 못했습니다: ${c.err}`)
  else ok('장부 원격', `git config axmap.remote = ${picked}`)
}

if (REPO) configureRemote(flag('--remote'))

// ── 5. 프로그램을 이 PC 에 둔다 + AI CLI 에 등록한다 ────────────────────────
//
// 🔴 여기를 다시 짜지 않는다. `mcp/install.sh` · `mcp/install.ps1` 이 이미 하고,
//    그 둘은 남의 설정 파일을 **읽어서 병합**하며 못 읽으면 손대지 않는다.
//    설치기를 하나 더 만들면 반드시 한쪽만 고쳐지고, 그때 두 OS 의 사용자가 서로
//    다른 설정을 갖게 된다.
const DEST = path.resolve(flag('--dest') ?? path.join(os.homedir(), '.axmap', 'app'))

function installAndRegister() {
  if (has('--no-register')) { hm('설치·등록', '--no-register — 건너뜁니다'); return }
  if (DRY) { hm('설치·등록', `(dry-run) ${process.platform === 'win32' ? 'mcp/install.ps1' : 'mcp/install.sh'} 를 돌렸을 것입니다 → ${DEST}`); return }

  const win = process.platform === 'win32'
  const script = path.join(SOURCE_ROOT, 'mcp', win ? 'install.ps1' : 'install.sh')
  if (!fs.existsSync(script)) { no('설치·등록', `설치기가 없습니다: ${script}`); return }

  say('')
  const r = win
    ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Source', SOURCE_ROOT, '-Dest', DEST, '-Name', agentIdentity], { cwd: os.homedir(), stdio: 'inherit', windowsHide: true })
    : spawnSync('bash', [script, '--source', SOURCE_ROOT, '--dest', DEST, '--name', agentIdentity], { cwd: os.homedir(), stdio: 'inherit' })
  say('')

  if (r.status === 0) ok('설치·등록', DEST)
  else no('설치·등록', `설치기가 종료 코드 ${r.status ?? '?'} 를 냈습니다 — 위 줄을 보세요`)
}

installAndRegister()

// The installed copy owns stable hook paths, including the bundled PTY runtime.
if (!has('--no-register')) {
  if (DRY) hm('세션 연결', '(dry-run) 설치된 사본에 CLI 연결 훅을 등록합니다')
  else {
    const hookRunner = path.join(DEST, 'tools', 'run.mjs')
    const r = spawnSync(process.execPath, [hookRunner, 'install-hooks'], { encoding: 'utf8', windowsHide: true })
    if (r.status === 0) ok('세션 연결', 'axmap run agy로 여는 CLI가 자동 연결됩니다')
    else no('세션 연결', r.stderr?.trim() || '연결 훅 등록 실패')
  }
}

// ── 6. 장부와 훅 ────────────────────────────────────────────────────────────
//
// 🔴 **설치된 사본**(`~/.axmap/app`)의 CLI 로 부른다. npx 가 푼 임시 폴더의 것으로
//    부르면 `hook install` 이 그 임시 경로를 훅에 박고, npx 캐시가 비워지는 순간
//    훅이 없는 파일을 가리킨다 — 커밋할 때마다 오류가 나는데 원인은 안 보인다.
function ledgerAndHook() {
  if (!REPO) { hm('장부·커밋 훅', '작업 repo의 장부는 첫 사용 때 자동 준비합니다. 커밋 훅은 axmap hook install로 선택합니다.'); return }
  if (has('--no-ledger')) { hm('장부', '--no-ledger — 건너뜁니다'); return }

  const installed = path.join(DEST, 'bin', 'axmap.mjs')
  const cli = fs.existsSync(installed) ? installed : path.join(SOURCE_ROOT, 'bin', 'axmap.mjs')
  if (cli !== installed) hm('장부', `설치된 사본이 없어 원본으로 돕니다 — 훅에 임시 경로가 박힐 수 있습니다: ${cli}`)

  if (DRY) { hm('장부', `(dry-run) node ${cli} init  ·  hook install  (cwd=${REPO})`); return }

  const run = (args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: REPO,
    stdio: 'inherit',
    // 이름을 넘겨서 판정을 한 번으로 못 박는다. 여기서 통과한 이름과 나중에 CLI 가
    // 스스로 고르는 이름이 다르면, 자기가 잡은 것을 자기가 반납하지 못한다.
    env: { ...process.env, AXMAP_AGENT: agentIdentity },
    windowsHide: true,
  })

  say('')
  const i = run(['init'])
  if (i.status !== 0) { no('장부', `axmap init 이 종료 코드 ${i.status ?? '?'} 를 냈습니다`); return }
  ok('장부', '.axmap/ledger  (axmap/claims · axmap/bus)')

  const h = run(['hook', 'install'])
  if (h.status !== 0) no('커밋 훅', `axmap hook install 이 종료 코드 ${h.status ?? '?'} 를 냈습니다`)
  else ok('커밋 훅', 'pre-commit — claim 하지 않은 파일은 커밋되지 않습니다')
}

ledgerAndHook()

// ── 7. 슬래시 명령 ──────────────────────────────────────────────────────────
//
// 기본은 **홈**(`~/.claude/commands/`)이다. 전역 설치의 원칙이 "작업할 저장소 안에
// axMap 파일을 하나도 남기지 않는다" 이기 때문이다 — 남기면 남의 저장소에 우리
// 파일이 커밋되거나, 남의 .gitignore 를 고치게 만든다. 홈에 두면 어느 저장소를
// 열어도 `/ax` 가 뜬다.
//
// `--commands project` 는 팀 전체가 같은 명령을 공유하고 싶을 때다. 그때는 저장소에
// 커밋되는 것이 맞다.
//
// 🔴 이미 있는 파일을 **덮어쓰지 않는다.** 내용이 같으면 조용히 넘어가고, 다르면
//    건드리지 않고 알린다. 남이 자기 용도로 고쳐 쓰고 있을 수 있고, 그걸 조용히
//    지우는 것이 이 작업에서 가장 나쁜 실패다.
function slashCommands() {
  if (commandsWhere === 'none') { hm('슬래시 명령', '--commands none — 건너뜁니다'); return }

  const from = path.join(SOURCE_ROOT, '.claude', 'commands')
  if (!fs.existsSync(from)) { no('슬래시 명령', `원본이 없습니다: ${from}`); return }

  const to = commandsWhere === 'project'
    ? path.join(REPO, '.claude', 'commands')
    : path.join(os.homedir(), '.claude', 'commands')

  const files = fs.readdirSync(from).filter((f) => f.endsWith('.md')).sort()
  if (!files.length) { no('슬래시 명령', `원본에 .md 가 없습니다: ${from}`); return }

  if (DRY) { hm('슬래시 명령', `(dry-run) ${files.length}개 → ${to}`); return }

  try { fs.mkdirSync(to, { recursive: true }) } catch (e) { no('슬래시 명령', `폴더를 만들지 못했습니다 (${e.message}): ${to}`); return }

  const wrote = []
  const same = []
  const kept = []
  for (const f of files) {
    const src = fs.readFileSync(path.join(from, f), 'utf8')
    const dst = path.join(to, f)
    if (fs.existsSync(dst)) {
      const cur = fs.readFileSync(dst, 'utf8')
      if (cur === src) { same.push(f); continue }
      kept.push(f)
      continue
    }
    try { fs.writeFileSync(dst, src); wrote.push(f) } catch { kept.push(f) }
  }

  const parts = []
  if (wrote.length) parts.push(`새로 ${wrote.length}개`)
  if (same.length) parts.push(`그대로 ${same.length}개`)
  ok('슬래시 명령', `${parts.join(' · ') || '없음'}  → ${to}`)
  if (kept.length) {
    hm('슬래시 명령', `내용이 다른 파일은 **건드리지 않았습니다**: ${kept.join(', ')}\n         바꾸려면 직접 지운 뒤 다시 실행하세요: ${to}`)
  }
}

slashCommands()

// ── 8. 쪽지 자동 수신 훅 (하네스 훅) ────────────────────────────────────────
//
// 🔴 여기서 말하는 훅은 **git 의 pre-commit 훅이 아니다.** 이름이 같고 하는 일이
//    전혀 다른 것이 둘 있다. 위 6절의 `hook install` 이 심는 것은 git 훅이고
//    (claim 안 한 파일의 커밋을 막는다), 이것은 **하네스 훅**(harness hook —
//    에이전트를 돌리는 프로그램이 정해진 시점마다 실행해서 그 출력을 모델 앞에
//    놓는 명령)이다.
//
// 왜 필요한가: 쪽지 알림은 지금 axMap **도구 결과에 얹혀서만** 뜬다. 그래서
// axMap 도구를 한 번도 안 부르는 세션에는 영영 안 뜬다(docs/BUS-NOTIFY.md 3.2).
// MCP 규격에는 서버가 모델 컨텍스트에 먼저 글을 넣는 수단이 없으므로(같은 문서
// 3.1 에서 규격을 확인했다), 그 구멍을 막을 수 있는 것은 하네스뿐이다.
//
// 🔴 **기본으로 심지 않는다. `--hook` 을 줘야 심는다.**
//
//    `settings.json` 은 그 사람의 Claude Code 전체를 지배하는 파일이다(권한·환경
//    변수·다른 훅). 거기에 **모든 프롬프트마다 도는 명령**을 묻지도 않고 넣는 것은
//    슬래시 명령 파일 하나를 놓는 것과 무게가 다르다. 매 턴 조금 느려지는 것도
//    그 사람이 고를 일이다. 그래서 기본은 "안 심고, 심는 법을 알려준다" 다.
function busHook() {
  const want = has('--hook')

  const installed = path.join(DEST, 'tools', 'bus.mjs')
  const busPath = fs.existsSync(installed) ? installed : path.join(SOURCE_ROOT, 'tools', 'bus.mjs')
  // 🔴 역슬래시를 쓰지 않는다. 이 문자열은 JSON 에 들어갔다가 셸이 다시 읽는다.
  //    윈도우 경로의 `\U` 같은 것이 이스케이프로 먹히면 훅이 조용히 안 돈다.
  const cmd = `node "${busPath.replace(/\\/g, '/')}" list --mine --unread --throttle 60 --quiet-if-empty`

  if (!want) {
    hm('쪽지 훅', '안 심었습니다 (기본값). 프롬프트마다 쪽지를 받으려면 --hook 을 붙여 다시 실행하세요')
    return
  }
  if (!fs.existsSync(busPath)) { no('쪽지 훅', `쪽지 도구가 없습니다: ${busPath}`); return }

  const file = commandsWhere === 'project'
    ? path.join(REPO, '.claude', 'settings.json')
    : path.join(os.homedir(), '.claude', 'settings.json')

  if (DRY) { hm('쪽지 훅', `(dry-run) UserPromptSubmit 를 더했을 파일: ${file}`); return }

  const snippet = () => {
    say('')
    say('      아래를 그 파일의 "hooks" 안에 직접 넣으세요:')
    say('')
    const one = { UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd, timeout: 20 }] }] }
    for (const l of JSON.stringify(one, null, 2).split('\n')) say(`        ${l}`)
    say('')
  }

  // 🔴 남의 설정을 덮어쓰지 않는다. 못 읽는 것을 지우는 것은 고치는 게 아니라
  //    부수는 것이다 — tools/mcp-register.mjs 가 MCP 설정에 대해 하는 판단과 같다.
  //    빈 파일은 "아직 아무것도 안 적혔다" 이지 "내가 못 읽는 내용" 이 아니다.
  let cfg = null
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8')
    if (raw.trim() === '') cfg = {}
    else {
      try { cfg = JSON.parse(raw) } catch { cfg = null }
      if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
        no('쪽지 훅', `설정을 읽지 못했습니다 — 건드리지 않았습니다: ${file}`)
        snippet()
        return
      }
    }
  } else cfg = {}

  if (cfg.hooks != null && (typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks))) {
    no('쪽지 훅', `hooks 가 객체가 아닙니다 — 건드리지 않았습니다: ${file}`)
    snippet()
    return
  }
  const hooks = cfg.hooks ?? {}
  if (hooks.UserPromptSubmit != null && !Array.isArray(hooks.UserPromptSubmit)) {
    no('쪽지 훅', `UserPromptSubmit 이 배열이 아닙니다 — 건드리지 않았습니다: ${file}`)
    snippet()
    return
  }
  const list = hooks.UserPromptSubmit ?? []

  // 우리 것만 찾아서 고친다. 남이 넣은 훅은 세지도 건드리지도 않는다.
  const isOurs = (h) => typeof h?.command === 'string' && /bus\.mjs/.test(h.command)
  let found = null
  for (const group of list) {
    if (!Array.isArray(group?.hooks)) continue
    const hit = group.hooks.find(isOurs)
    if (hit) { found = hit; break }
  }

  const write = (what) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
      ok('쪽지 훅', what)
      return true
    } catch (e) {
      no('쪽지 훅', `쓰지 못했습니다 (${e.message}): ${file}`)
      snippet()
      return false
    }
  }

  if (found) {
    if (found.command === cmd) { ok('쪽지 훅', `이미 있습니다: ${file}`); return }
    const before = found.command
    found.command = cmd
    found.timeout = found.timeout ?? 20
    write(`가리키는 곳을 고쳤습니다: ${file}\n         이전: ${before}`)
    return
  }

  list.push({ hooks: [{ type: 'command', command: cmd, timeout: 20 }] })
  hooks.UserPromptSubmit = list
  cfg.hooks = hooks
  write(`UserPromptSubmit 에 더했습니다: ${file}`)
}

busHook()

// ── 9. 끝 ───────────────────────────────────────────────────────────────────

say('')
if (bad) {
  say(`${C.r}!! 위의 ${bad}줄이 안 됐습니다. 그 부분은 동작하지 않습니다.${C.x}`)
  say('')
  process.exit(EXIT.PARTIAL)
}

say('설치가 끝났습니다.')
say('')
say('다음:')
say('  1. AI CLI 를 완전히 껐다가 다시 켭니다')
say('  2. 원하는 Git repo에서 AI CLI를 실행합니다. 실행한 repo에 자동으로 연결됩니다.')
say('  3. "ax_status로 지금 누가 뭘 잡고 있는지 보여줘"로 시작합니다. repo마다 setup이나 init을 반복하지 않습니다.')
say('')
say(`${C.d}  파일을 고치기 전에 claim → 끝나면 release. 그게 전부입니다.${C.x}`)
say(`${C.d}  조회: 원하는 Git repo에서 axmap status${C.x}`)
say('')
process.exit(EXIT.OK)
