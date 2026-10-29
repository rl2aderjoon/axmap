#!/usr/bin/env node
/**
 * 에이전트 사이의 쪽지함 — 사람을 거치지 않고 서로에게 말한다.
 *
 *   node tools/bus.mjs post --to <상대> --subject "<제목>"   (본문은 stdin)
 *   node tools/bus.mjs list [--to <나>|--mine] [--from <상대>] [--all]
 *                          [--throttle <초>] [--quiet-if-empty]   ← 훅용
 *   node tools/bus.mjs read <아이디>
 *   node tools/bus.mjs reply <아이디> --subject "<제목>"      (본문은 stdin)
 *
 * ── 왜 파일 하나가 아니라 **디렉터리**인가 ────────────────────────────────
 *
 * 🔴 쪽지 하나 = 파일 하나. 그래야 두 에이전트가 동시에 써도 안 부딪힌다.
 *
 * 처음엔 append-only 로그 파일 하나를 생각했다. 그런데 그건 우리가 이미
 * 아는 실패다 — 두 사람이 같은 파일 끝에 줄을 붙이면 git 이 텍스트 충돌을
 * 낸다. 이 저장소가 장부를 파서로 만든 이유가 정확히 그것이다
 * (docs/EXPERIMENT.md). 쪽지함에서 같은 실수를 반복하지 않는다.
 *
 * 파일 이름에 시각과 보낸 사람이 들어가므로 두 사람이 같은 이름을 쓸 일이 없다.
 * 충돌이 구조적으로 불가능하면 조율도 필요 없다.
 *
 * ── 왜 git 인가 ──────────────────────────────────────────────────────────
 *
 * 이미 있는 채널이다. 두 에이전트가 다른 컴퓨터에 있어도 pull/push 로 오간다.
 * 새 서버도, 새 의존성도, 새 인증도 필요 없다. 그리고 **기록이 남는다** —
 * 나중에 "왜 이렇게 정했나" 를 되짚을 수 있다.
 *
 * ⚠️ 실시간이 아니다. 상대가 pull 해야 읽는다. 급한 것은 claim 의 `--intent`
 *    에 한 줄로 적는 편이 빠르다 — 그건 `axmap status` 로 바로 보인다.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentNameError } from '../src/protocol.mjs'
import { readProfile, profilePath, emailError } from '../src/identity.mjs'
import { withRepoLock } from '../src/repolock.mjs'
import { randomUUID } from 'node:crypto'

/** **이 프로그램**의 뿌리. 데이터가 아니라 코드를 찾을 때만 쓴다 (`who` 의 axmap.mjs). */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 지금 서 있는 폴더가 속한 **대상 저장소**의 루트. git 이 없거나 밖이면 null. */
function targetRepo() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch { return null }
}

/**
 * 쪽지가 쌓이는 곳. **기본값은 대상 저장소이고 `AXMAP_BUS_DIR` 로 옮길 수 있다.**
 *
 * 🔴 프로그램은 여기(axMap)에 있고 데이터는 대상 저장소에 있어야 한다.
 *    MCP 서버가 남의 저장소에 붙었을 때 이 값을 `<대상>/docs/bus` 로 넘긴다.
 *    안 그러면 그 팀의 쪽지가 axMap 저장소에 쌓이고, 정작 팀의 저장소에는
 *    아무것도 안 남는다 — 쪽지는 커밋해야 상대에게 가는데 커밋할 저장소가
 *    엉뚱한 곳이 되는 것이다.
 *
 * 🔴 예전 기본값은 `ROOT/docs/bus` 였다. **사본에서 조용히 틀린다** — 팀 저장소의
 *    `ci/axmap/tools/bus.mjs` 에서 `ROOT` 는 `ci/axmap` 이므로 없는 폴더를 가리키고,
 *    `readdirSync` 가 던지면 `readAll` 이 빈 배열을 낸다. 즉 **쪽지가 있어도
 *    "쪽지 없음" 이라고 답한다.** 2026-08-26 에 팀 저장소에서 실제로 그랬다.
 *    프로그램 위치로 데이터를 찾은 것이 원인이므로 이제 대상 저장소에게 묻는다.
 *
 *    못 찾으면 `ROOT` 로 되돌리지 않는다. 그건 서로 다른 두 상황(대상 저장소 안 /
 *    엉뚱한 곳)을 한 값으로 만드는 치환이고, 위 사고가 정확히 그 치환이었다.
 *
 * 🔴 그리고 이제 그 자리는 `docs/bus` 가 **아니다.** 고아 브랜치 `axmap/bus` 의
 *    worktree(`.axmap/bus/messages`)다. 작업 트리에 두면 상대에게 가는 데
 *    커밋 -> MR -> 머지 -> pull 이 필요했고, 보내려면 `docs/bus` 를 claim 해야 해서
 *    한 번에 한 명만 쪽지를 보낼 수 있었다. 장부가 그 문제를 이미 안 겪으므로
 *    같은 방식으로 옮긴다. 근거는 `bin/axmap.mjs` 의 `BUS_BRANCH` 주석.
 */
const REPO = (() => {
  if (process.env.AXMAP_BUS_DIR) return null // 대상이 명시됐으면 저장소를 물을 필요가 없다
  const repo = targetRepo()
  if (!repo) {
    console.error(
      '쪽지함을 찾지 못했습니다 — 여기는 git 저장소 안이 아닙니다.\n' +
        '대상 저장소 안에서 실행하거나 AXMAP_BUS_DIR 로 쪽지함을 직접 지정하세요.',
    )
    process.exit(1)
  }
  return repo
})()

/** 쪽지 worktree 의 루트. 커밋·push 는 여기서 돈다. */
const COMMON = REPO ? path.resolve(REPO, execFileSync('git', ['rev-parse', '--git-common-dir'], {
  cwd: REPO, encoding: 'utf8', windowsHide: true,
}).trim()) : null
const DATA_HOME = COMMON ? (path.basename(COMMON) === '.git' ? path.dirname(COMMON) : REPO) : null
const BUS_WT = REPO ? path.join(DATA_HOME, '.axmap', 'bus') : null
const BUS_BRANCH = 'axmap/bus'

/** **쓰는 곳은 하나뿐이다.** */
const BOX = process.env.AXMAP_BUS_DIR
  ? path.resolve(process.env.AXMAP_BUS_DIR)
  : path.join(BUS_WT, 'messages')

/**
 * **읽는 곳은 둘이다.** 옛 쪽지함(`docs/bus`)은 읽기만 한다.
 *
 * 옮기지 않는 이유: 옮기면 같은 내용이 두 브랜치에 남고 어느 쪽이 진짜인지
 * 아무도 모른다. 새것은 전부 고아 브랜치로 가므로 옛것은 자연히 마른다.
 */
const READ_BOXES = [BOX, ...(REPO ? [path.join(REPO, 'docs', 'bus')] : [])]

function gitBus(argv, opts = {}) {
  try {
    return {
      code: 0,
      out: execFileSync('git', argv, {
        cwd: BUS_WT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts,
      }).trim(),
    }
  } catch (e) { return { code: e.status ?? 1, out: '', err: String(e.stderr ?? e.message) } }
}

const busReady = () => BUS_WT !== null && fs.existsSync(path.join(BUS_WT, '.git'))

/**
 * 쪽지함을 못 연 이유. `null` 이면 정상이다.
 *
 * 🔴 이 변수가 있는 이유는 하나다 — **"쪽지 없음" 과 "못 읽었음" 을 다른 문장으로
 *    내기 위해서다.**
 *
 *    2026-09-03 실측: 원격 `axmap/bus` 에 쪽지 129건이 있고 그중 오늘 온 것이
 *    있는데, 이 체크아웃에 worktree 가 없어서 `pull()` 이 **fetch 를 한 번도 안
 *    하고 조용히 반환**했다. 읽는 자리는 옛 함(`docs/bus`)으로 떨어졌고 거기 있던
 *    8월 것은 이미 읽음이라 화면에 나온 답은 `쪽지 없음.` 이었다. 경고도 없었다.
 *
 *    **보내기는 같은 상황에서 제대로 거부했다** (아래 `post`). 쓰기는 막고 읽기만
 *    통과시킨 것이다. 락 시스템에서 최악의 실패는 거부해야 할 것을 조용히
 *    통과시키는 것이고(CLAUDE.md 「애매하면 거부한다」), 쪽지함에서는 **못 읽은
 *    것을 "없다" 고 답하는 것**이 바로 그 자리다. 잘못 막으면 사람이 메시지를
 *    읽고 고치면 되지만, 조용히 없다고 하면 아무도 잘못됐다는 것을 모른다.
 */
let busProblem = null

/** 옛 함(`docs/bus`)에서만 읽었는가. 새 함을 못 연 채로 성공한 것처럼 보이지 않게 한다. */
let readFromLegacyOnly = false

/**
 * 쪽지함을 연다. **없으면 만든다. 만들었으면 만들었다고 말한다.**
 *
 * 🔴 만드는 코드를 여기에 복사하지 않는다. `bin/axmap.mjs` 의 `ensureBus` 하나뿐이고
 *    이 함수는 그것을 `bus-repair` 로 부른다. 사본을 두면 두 벌이 되고, 두 벌은
 *    반드시 어긋난다 — 이 저장소가 팀 사본을 걷어낸 것과 같은 이유다.
 *
 * 🔴 만들고 나서 **조용히 넘어가지 않는다.** 이 버그의 본질이 "말없이 넘어간 것"
 *    이라, 자동으로 만들어 놓고 또 말없이 넘어가면 증상만 다른 같은 병이 된다.
 *    stdout 이 아니라 stderr 로 낸다 — 목록을 파이프로 넘겨도 사람 눈에는 남는다.
 */
function openBus() {
  if (process.env.AXMAP_BUS_DIR) return true // 대상이 명시됐으면 물을 것이 없다
  if (busReady()) return true
  if (BUS_WT === null) {
    busProblem = '이 저장소를 찾지 못했습니다.'
    return false
  }

  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'axmap.mjs'), 'bus-repair'], {
    cwd: REPO, encoding: 'utf8', windowsHide: true,
  })
  if (busReady()) {
    console.error(`쪽지함이 없어서 만들었습니다: ${path.join('.axmap', 'bus')}  (${BUS_BRANCH})`)
    return true
  }
  busProblem = (r.stderr ?? '').trim() || (r.stdout ?? '').trim() || '알 수 없는 이유로 실패했습니다.'
  return false
}

/**
 * 쪽지함을 못 열었다는 것을 사람이 볼 수 있게 낸다.
 *
 * 🔴 **"없음" 이라고 말하지 않는다.** 받은 쪽지가 없는 것이 아니라 확인을 못 한
 *    것이고, 둘은 사람이 해야 할 일이 정반대다.
 */
function reportBusProblem() {
  // 🔴 순서가 뜻이다. **무슨 일인지 먼저, 이유는 그다음.** 이유부터 내면 그것이
  //    여러 줄일 때 안내가 아래로 밀려서, 급한 사람이 첫 줄만 보고 넘어간다.
  const why = busProblem
    .replace(/^경고: /, '')
    .split('\n')
    .map((s, i) => (i === 0 ? s : `        ${s.trim()}`))
    .join('\n')
  console.error(
    '쪽지함을 못 열었습니다 — 받은 쪽지가 없는 것이 아니라 확인을 못 한 것입니다.\n' +
      `\n  이유: ${why}\n` +
      '\n  고치기:  axmap bus-repair      (MCP 에서는 ax_init)',
  )
}

/**
 * 원격의 쪽지를 받아온다. **실패해도 죽지 않는다** — 못 받은 것은 위험이 아니라
 * 지연이다. 장부(`syncLedger`)가 같은 자리에서 죽는 것과 정반대이고, 그 차이의
 * 근거는 `bin/axmap.mjs` 의 `BUS_BRANCH` 주석에 있다.
 *
 * 🔴 `--throttle <초>` 는 **훅 때문에 생겼다.** MCP 서버는 세션 내내 살아 있어서
 *    `unreadBanner` 가 프로세스 안의 변수(`busCheckedAt`)로 15초를 잴 수 있었다.
 *    훅은 부를 때마다 **새 프로세스**라 그 변수가 매번 0에서 시작한다 — 즉 캐시가
 *    절대 안 맞고 훅이 뜰 때마다 `git fetch` 가 돈다. 그래서 시계를 프로세스
 *    밖(스탬프 파일)에 둔다. 캐시를 그대로 옮겨 붙이면 조용히 원격을 두들긴다.
 *
 *    스탬프는 `.axmap/.bus-lastfetch` 다. `.axmap/` 는 통째로 무시되고(.gitignore),
 *    쪽지 worktree(`.axmap/bus`) **바깥**이라 고아 브랜치에 섞이지 않는다.
 */
function pull() {
  // 🔴 예전에는 여기가 `if (!busReady()) return` 이었다. 쪽지함이 없으면 **fetch 를
  //    한 번도 안 하고 조용히 반환**했고, 그것이 "쪽지 없음" 으로 보였다.
  //    이제는 열어 보고, 못 열면 그 사실을 `busProblem` 에 남긴다.
  if (!openBus()) return
  // 🔴 주기는 **설정에서 온다.** `--throttle` 이 1순위(부르는 쪽이 그 자리에서
  //    정한다), 없으면 `AXMAP_BUS_POLL`(초), 그것도 없으면 0 = 매번 받아온다.
  //
  //    기본이 0 인 것은 이 파일을 **사람이 직접 부르는 쪽**이 기준이기 때문이다.
  //    손으로 `list` 를 친 사람은 지금 이 순간의 쪽지를 보려는 것이므로 캐시를
  //    쥐여주면 안 된다. 자동으로 자주 부르는 쪽(MCP 배너·훅)이 자기 창을
  //    명시한다 — 기본값을 늘리면 손으로 부른 사람까지 조용히 낡은 것을 본다.
  const sec = Number(flag('--throttle', process.env.AXMAP_BUS_POLL ?? '0'))
  const stampFile = REPO ? path.join(REPO, '.axmap', '.bus-lastfetch') : null
  if (sec > 0 && stampFile) {
    // 스탬프가 아직 신선하면 원격을 묻지 않고 **로컬 worktree 만** 읽는다.
    // 이미 받아둔 쪽지는 그대로 보인다 — 늦는 것은 새로 온 쪽지뿐이다.
    try {
      if (Date.now() - fs.statSync(stampFile).mtimeMs < sec * 1000) return
    } catch { /* 스탬프가 없으면 이번이 처음이다. 받아온다 */ }
  }
  const remote = gitBus(['config', '--get', 'axmap.remote'], { cwd: REPO }).out || 'origin'
  if (gitBus(['fetch', '--quiet', remote, BUS_BRANCH]).code !== 0) return
  gitBus(['reset', '--hard', '--quiet', 'FETCH_HEAD'])
  // 🔴 성공했을 때만 찍는다. 실패에도 찍으면 원격이 잠깐 막힌 사이에 스탬프가
  //    갱신되어 **다음 창까지 조용히 안 받는다.** 못 받은 것은 지연이지 성공이 아니다.
  if (stampFile) { try { fs.writeFileSync(stampFile, '') } catch { /* 스탬프 실패는 치명적이지 않다 */ } }
}

const args = process.argv.slice(2)
const cmd = args[0]
const flag = (n, d = null) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1] }
const has = (n) => args.includes(n)

/**
 * 같은 이름의 옵션이 여러 번 와도 전부 모은다. `flag` 는 첫 번째만 낸다.
 *
 * 🔴 쪽지 216통을 세어 보니 **같은 제목이 초 단위로 두 번씩 나간 것**이 여러
 *    건이었다. 같은 내용을 두 사람에게 보내려면 두 번 보내는 수밖에 없어서다.
 *    그러면 답장이 두 갈래로 갈려 대화가 쪼개지고, 나중에 읽는 사람은 어느
 *    쪽이 이어진 이야기인지 모른다. 그래서 사람들이 관계없는 사람까지 읽는
 *    전체공지로 도망쳤다 — 48통이 그렇게 나갔다.
 */
const flagAll = (n) => {
  const out = []
  for (let i = 0; i < args.length; i++) if (args[i] === n && args[i + 1] != null) out.push(args[i + 1])
  return out
}

/** 받는 사람 목록. `--to a --to b` 도, `--to "a,b"` 도 같은 것으로 본다. */
const recipientArgs = () => flagAll('--to')
  .flatMap((s) => String(s).split(','))
  .map((s) => s.trim())
  .filter(Boolean)

/** 쪽지 하나의 받는 사람들. 예전 쪽지는 값이 하나라 그대로 한 개짜리 목록이 된다. */
const recipientsOf = (m) => String(m.to ?? 'all').split(',').map(norm).filter(Boolean)

/**
 * 나는 누구인가. 선점 프로토콜과 **같은 값**을 쓴다 — 두 이름을 두면 갈린다.
 *
 * 🔴 MCP 서버는 `AXMAP_AGENT` 를 떨어뜨려 주지만 **훅은 그렇지 않다.** 훅은
 *    하네스가 직접 띄우는 새 프로세스라 서버의 환경을 물려받지 않는다. 그래서
 *    서버의 `resolveAgent()` 와 **같은 순서**로 되짚는다 — 환경변수가 없으면
 *    `git config user.name`. 두 곳이 다른 순서를 쓰면 같은 사람이 두 이름을
 *    갖게 되고, 그 순간 자기 앞으로 온 쪽지가 자기 함에 안 들어온다.
 *
 * 🔴 못 찾으면 기본 이름으로 채우지 않고 죽는다. 채우는 순간 clone 한 모두가
 *    한 사람이 되고 쪽지함이 하나로 합쳐진다 (`mcp/server.mjs` 의 같은 판단).
 */
function me() {
  const v = process.env.AXMAP_AGENT
  if (v && !agentNameError(v)) return v
  try {
    const n = execFileSync('git', ['config', 'user.name'], {
      cwd: REPO ?? process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    // 서버와 달리 여기서는 형식을 본다. 통과 못 하면 아래에서 죽는다 —
    // 못 읽는 이름을 그냥 쓰면 파일 이름과 필터가 조용히 어긋난다.
    if (n && !agentNameError(n)) return n
  } catch { /* 아래에서 죽는다 */ }
  console.error(
    'AXMAP_AGENT 를 먼저 정하세요 (선점과 같은 값).\n' +
      '  git config user.name 으로도 정하지 못했습니다.\n' +
      '  기본 이름으로 대신 채우지 않습니다 — 여러 사람이 같은 이름이 되면\n' +
      '  서로의 쪽지함이 하나로 합쳐집니다.',
  )
  process.exit(1)
}

/**
 * 사람의 주소는 **이메일**이다. 이름은 그 사람을 부르는 여러 별칭 중 하나일 뿐이다.
 *
 * 🔴 왜 이름이 아니라 이메일인가. 실측(2026-09-05, 팀 저장소 최근 300커밋):
 *
 *      사람 6명  →  git 이름 11개  →  git 이메일 6개
 *
 *    한 사람이 `yeaseung lee` · `yeaseung-lee` · `이예승` 셋으로 커밋한다.
 *    **이름은 갈리는데 이메일은 안 갈린다** — 표기는 바꿔도 이메일은 안 바꾼다.
 *
 *    그래서 이름을 주소로 쓰면, 보낸 쪽은 "보냈습니다" 를 보고 받는 쪽은
 *    "쪽지 없음" 을 본다. **양쪽 다 오류가 없어서 아무도 실패를 못 본다.**
 *    실제로 216통 중 존재하지 않는 이름으로 간 것이 1통 있었고, 보낸 사람이
 *    13분 뒤에 눈치채고 다시 보냈다.
 *
 *    그리고 이 저장소는 **이미 한쪽에서 옳게 하고 있었다** — 투표권자 명단
 *    (`governance/policy.json`)은 처음부터 이메일로 사람을 가른다. 쪽지함과
 *    선점만 이름을 썼다. 한 저장소가 두 개의 주소 체계를 갖고 있던 것이다.
 */
const norm = (s) => String(s ?? '').trim().toLowerCase()

/** 이 저장소를 쓰는 사람들. `{ email, names:Set }` 의 목록. 한 프로세스에서 한 번만 센다. */
let rosterCache = null

function roster() {
  if (rosterCache) return rosterCache
  const byEmail = new Map()

  // Keep homonyms as separate email identities. Recipient resolution rejects
  // an ambiguous label instead of silently assigning it to the first author.
  const add = (email, name) => {
    const e = norm(email)
    if (!e || !e.includes('@')) return
    if (!byEmail.has(e)) byEmail.set(e, { email: e, names: new Set() })
    const n = norm(name)
    if (!n) return
    byEmail.get(e).names.add(n)
  }

  // 1) git 이력 — 이 저장소에서 실제로 일한 사람이 곧 명단이다. 별도 파일도,
  //    별도 브랜치도 필요 없다. **아무 저장소에서나 성립한다**는 것이 중요하다.
  try {
    const out = execFileSync('git', ['log', '--all', '--format=%ae\t%an', '-n', '5000'], {
      cwd: REPO ?? process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    for (const line of out.split('\n')) {
      const [e, n] = line.split('\t')
      add(e, n)
    }
  } catch { /* 저장소가 아니거나 이력이 없다. 아래 2)로 채운다 */ }

  // 2) 쪽지를 보낸 적이 있는 사람. 커밋은 없지만 쪽지는 쓴 사람이 실제로 있다
  //    (기획·디자인). 여기서 안 주우면 그 사람에게는 답장을 못 보낸다.
  try {
    for (const m of readAll()) if (m.fromEmail) add(m.fromEmail, m.from)
  } catch { /* 쪽지함을 못 열었을 뿐이다. 1)만으로도 명단은 선다 */ }

  // 3) 적혀 있는 별칭. **git 이 모르는 이름이 여기 들어온다.**
  //
  //    🔴 여기서 받아오는 것이 중요하다. 예전에는 안 읽음 표시를 볼 때만 받아왔고,
  //       명단은 그 자리를 안 거쳤다. 그래서 **별칭 앞으로 온 쪽지가 그 사람에게
  //       안 갔다** — 보낸 쪽 PC 에는 별칭이 있고 받는 쪽 PC 에는 없었기 때문이다.
  //       이름이 어긋나서 쪽지가 묻히는 것, 정확히 고치려던 그 증상이 자리만
  //       바꿔서 되살아난 것이었다.
  pullUsers()
  //
  //    🔴 실측에서 커밋 로그에 없는 이름이 넷 있었다 — codex-jinmiri · jaehyeon-2 ·
  //       codex · rleaderjoon-desktop. 사람이 아니라 그 사람이 띄운 AI 도구이거나
  //       다른 PC 다. git 은 이것을 알 방법이 없으므로 적어 두는 자리가 필요하다.
  try {
    const dir = USERS_WT ? path.join(USERS_WT, 'users') : null
    for (const f of (dir ? fs.readdirSync(dir) : [])) {
      if (!f.endsWith('.json')) continue
      const st = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      const email = f.replace(/\.json$/, '')
      add(email, st.name)
      if (byEmail.has(norm(email))) byEmail.get(norm(email)).displayName = st.name
      for (const a of (st.aliases ?? [])) add(email, a)
    }
  } catch { /* 사람별 상태가 아직 없다. 1)·2)만으로도 명단은 선다 */ }

  rosterCache = [...byEmail.values()]
  return rosterCache
}

/**
 * 이 사람을 가리키는 **모든 주소**. 이름으로 물어도 이메일로 물어도 같은 답이 온다.
 *
 * 명단에 없으면 물어본 것 그대로 한 개짜리 집합을 낸다 — 모르는 사람을 아는 척
 * 하지 않는다. 그 판단은 부르는 쪽(`post`)이 한다.
 */
function addressesOf(who) {
  const w = norm(who)
  const people = roster()
  const matches = people.filter((p) => p.email === w || p.names.has(w))
  if (matches.length !== 1) return new Set([w])
  const p = matches[0]
  // A shared label must never make two mailboxes the same person. Known
  // homonyms can still receive mail through their unambiguous email addresses.
  return new Set([p.email, ...[...p.names].filter((n) => people.filter((x) => x.names.has(n)).length === 1)])
}

/**
 * 아는 주소 중 이것과 **거의 같은 것**들. 오타를 잡기 위한 것이지 검색이 아니다.
 *
 * 두 가지만 본다.
 *   1. 한쪽이 다른 쪽의 앞부분이다  — `ahwlstjd` / `ahwlstjd57` (실제로 난 오타)
 *   2. 글자 **하나** 차이다          — 손가락이 미끄러진 것
 *
 * 🔴 넓히지 않는다. 넓히면 남남인 이름끼리 "혹시 이것입니까" 가 뜨고, 그러면
 *    사람은 그 물음을 안 읽게 된다. 안 읽히는 확인은 없는 확인이다.
 *
 *    두 글자까지 봤다가 `reader` 와 `sender` 가 걸렸다 — 여섯 글자에서 두 글자면
 *    3분의 1이 다른 것이고, 그건 오타가 아니라 다른 낱말이다. 실제로 났던 오타는
 *    거리가 아니라 **앞부분 일치**로 잡히므로 좁혀도 잃는 것이 없다.
 */
function nearMatches(who) {
  const w = norm(who)
  const all = roster().flatMap((p) => [p.email, ...p.names])
  return all.filter((a) => {
    if (a === w) return false
    const [s, l] = a.length < w.length ? [a, w] : [w, a]
    if (l.startsWith(s) && l.length - s.length <= 4) return true
    return distance(w, a) <= 1
  }).slice(0, 5)
}

/** 두 글자열을 같게 만드는 데 필요한 최소 편집 횟수 (Levenshtein). */
function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const t = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = t
    }
  }
  return prev[b.length]
}

/** 내 이메일. 없으면 null — 없다고 죽지는 않는다. 이름만으로도 지금까지처럼 돈다. */
function myEmail() {
  const v = process.env.AXMAP_AGENT_EMAIL
  if (v && v.includes('@')) return norm(v)
  try {
    const e = execFileSync('git', ['config', 'user.email'], {
      cwd: REPO ?? process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return e.includes('@') ? norm(e) : null
  } catch { return null }
}

/**
 * 나에게 온 쪽지인지 판정할 때 쓰는 내 주소 전부.
 *
 * 🔴 `AXMAP_AGENT` 로 붙인 이름도 넣는다. 실측에서 `codex-jinmiri`·`jaehyeon-2`
 *    처럼 **커밋 로그에 없는 이름**이 넷 있었다. 사람이 아니라 그 사람이 띄운
 *    AI 도구라 git 이 모른다. 그것도 나다.
 */
function myAddresses() {
  const s = new Set()
  const e = myEmail()
  if (e) for (const a of addressesOf(e)) s.add(a)
  const ownName = (name) => {
    if (roster().filter((p) => p.names.has(norm(name))).length < 2) s.add(norm(name))
  }
  ownName(me())
  if (process.env.AXMAP_AGENT) ownName(process.env.AXMAP_AGENT)
  try { const p = readProfile(); if (p) ownName(p.name) } catch { /* reported during profile sync */ }
  return s
}

/**
 * 읽음 표시 — 규격은 `docs/SPEC.md` §2「읽음 표시」다. 여기와 `bin/axmap.mjs`
 * 의 `unreadNotes` 가 **같은 파일을 같은 규칙으로** 본다. 규칙이 한 줄이라
 * (`id > seen`) 공유 모듈로 빼지 않았지만, 한쪽을 고치면 반드시 다른 쪽도 본다.
 *
 * 🔴 장부에 넣지 않는다. 읽었는지는 나만의 상태라 남과 합의할 필요가 없고,
 *    장부에 쓰면 쪽지를 볼 때마다 push 경합이 생긴다.
 */
/**
 * 옛 자리 — **이 PC 안의 파일 하나.** 읽기만 한다. 새 자리로 옮기는 재료다.
 *
 * 🔴 여기 있었기 때문에 **PC 를 바꾸면 전부 다시 안 읽음**이 됐다. 쪽지 본문은
 *    고아 브랜치로 모두가 공유하는데, 읽었다는 사실만 그 PC 에 갇혀 있었다.
 *    다시 clone 하면 사라지고, 같은 사람이 도구를 둘 띄우면 각자 다른 상태를 봤다.
 */
const SEEN_FILE = REPO ? path.join(REPO, '.axmap-bus-seen.json') : null

/** 새 자리 — 고아 브랜치 `axmap/users` 의 worktree. 사람마다 파일 하나. */
const USERS_WT = REPO ? path.join(DATA_HOME, '.axmap', 'users') : null
const USERS_BRANCH = 'axmap/users'
const usersReady = () => USERS_WT !== null && fs.existsSync(path.join(USERS_WT, '.git'))

function gitUsers(argv, opts = {}) {
  try {
    return {
      code: 0,
      out: execFileSync('git', argv, {
        cwd: USERS_WT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts,
      }).trim(),
    }
  } catch (e) { return { code: e.status ?? 1, out: '', err: String(e.stderr ?? e.message) } }
}

/**
 * 사람별 상태를 연다. **못 열어도 죽지 않고, 말하지도 않는다.**
 *
 * 🔴 실패 방침이 쪽지함과 **정반대**다. 쪽지함은 못 읽으면 큰 소리로 말해야 한다 —
 *    거기서 조용하면 **온 쪽지를 없다고 답하게** 되기 때문이다. 여기서 조용하면
 *    **이미 읽은 쪽지가 한 번 더 뜰** 뿐이다.
 *
 *    즉 두 실패의 방향이 다르다. 하나는 **덜 보여주는 쪽**으로 틀리고 하나는
 *    **더 보여주는 쪽**으로 틀린다. 더 보여주는 실패는 사람이 알아서 넘긴다.
 *    그래서 여기에 경고를 달면 쓸모없는 줄이 매번 뜨고, 그러면 진짜 경고까지
 *    같이 안 읽히게 된다.
 */
function openUsers() {
  if (usersReady()) return true
  if (USERS_WT === null || process.env.AXMAP_BUS_DIR) return false
  spawnSync(process.execPath, [path.join(ROOT, 'bin', 'axmap.mjs'), 'users-repair'], {
    cwd: REPO, encoding: 'utf8', windowsHide: true,
  })
  return usersReady()
}

/** 이 사람의 파일 자리. **이메일이 정본**이고, 없는 사람만 이름으로 떨어진다. */
function userKey(who) {
  const w = norm(who)
  if (w.includes('@')) return w
  const matches = roster().filter((x) => x.names.has(w))
  return matches.length === 1 ? matches[0].email : w
}

const userFile = (who) => path.join(USERS_WT, 'users', `${userKey(who)}.json`)

function readUserState(who) {
  try { return JSON.parse(fs.readFileSync(userFile(who), 'utf8')) } catch { return {} }
}

/** 원격의 사람별 상태를 받아온다. 자주 물을 이유가 없어 느슨하게 맞춘다. */
function usersRemote() {
  const configured = process.env.AXMAP_REMOTE || gitUsers(['config', '--get', 'axmap.remote'], { cwd: REPO }).out
  if (configured) return configured
  const names = gitUsers(['remote'], { cwd: REPO }).out.split('\n').filter(Boolean)
  if (names.length === 1) return names[0]
  if (names.includes('origin')) return 'origin'
  if (names.length) throw new Error('사용자 정보를 공유할 원격이 모호합니다. git config axmap.remote <원격>을 지정하세요.')
  return null
}

function mustUsers(args) {
  const r = gitUsers(args)
  if (r.code !== 0) throw new Error(r.err || r.out || `git ${args[0]} 실패`)
  return r.out
}

function mergeState(local, incoming) {
  const newest = (incoming.profileUpdatedAt ?? '') > (local.profileUpdatedAt ?? '') ? incoming : local
  const aliases = [...new Set([...(local.aliases ?? []), ...(incoming.aliases ?? []), local.name, incoming.name].filter(Boolean))]
  const seen = [local.seen ?? '', incoming.seen ?? ''].sort().at(-1)
  return { ...incoming, ...local, ...newest, aliases: aliases.filter((a) => a !== newest.name), ...(seen ? { seen } : {}) }
}

// Never reset away unpublished profiles or read receipts. A rejected push is
// retried on the latest branch, merging only the dedicated JSON user records.
function syncUsers(remote) {
  if (!remote) return
  const exists = gitUsers(['ls-remote', '--exit-code', remote, `refs/heads/${USERS_BRANCH}`])
  if (exists.code === 2) return
  if (exists.code !== 0) throw new Error(exists.err || '사용자 정보 원격을 확인하지 못했습니다.')
  mustUsers(['fetch', '--quiet', remote, USERS_BRANCH])
  if (gitUsers(['merge', '--ff-only', '--quiet', 'FETCH_HEAD']).code === 0) return
  const merged = gitUsers(['merge', '--no-commit', '--no-ff', '--allow-unrelated-histories', 'FETCH_HEAD'])
  const conflicts = mustUsers(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean)
  try {
    for (const f of conflicts) {
      if (!/^users\/[^/]+\.json$/.test(f)) throw new Error(`사용자 정보 충돌을 자동으로 풀 수 없습니다: ${f}`)
      const local = JSON.parse(mustUsers(['show', `:2:${f}`]))
      const incoming = JSON.parse(mustUsers(['show', `:3:${f}`]))
      fs.writeFileSync(path.join(USERS_WT, f), JSON.stringify(mergeState(local, incoming), null, 2) + '\n')
      mustUsers(['add', '--', f])
    }
    if (merged.code !== 0 && !conflicts.length) throw new Error(merged.err || merged.out)
    mustUsers(['commit', '--quiet', '--no-verify', '-m', 'axmap: merge user profiles'])
  } catch (e) {
    gitUsers(['merge', '--abort'])
    throw e
  }
}

function withUsers(action) {
  if (!COMMON) return false
  return withRepoLock(path.join(COMMON, 'axmap-users.lock'), () => {
    if (!openUsers()) throw new Error('사용자 정보 브랜치를 준비하지 못했습니다.')
    return action()
  })
}

function pullUsers() {
  if (!REPO) return
  const stampFile = path.join(DATA_HOME, '.axmap', '.users-lastfetch')
  try { if (Date.now() - fs.statSync(stampFile).mtimeMs < 60_000) return } catch { /* first sync */ }
  try {
    withUsers(() => {
      // A fresh local-only orphan still has its seed files unstaged.
      if (gitUsers(['status', '--porcelain']).out) {
        mustUsers(['add', '-A'])
        mustUsers(['commit', '--quiet', '--no-verify', '-m', 'axmap: preserve user state'])
      }
      syncUsers(usersRemote())
      fs.writeFileSync(stampFile, '')
    })
  } catch { /* Read receipts remain conservative when synchronization fails. */ }
}

function updateUser(email, change) {
  if (emailError(email)) throw new Error(emailError(email))
  return withUsers(() => {
    const remote = usersRemote()
    for (let attempt = 0; attempt < 5; attempt++) {
      if (gitUsers(['status', '--porcelain']).out) {
        mustUsers(['add', '-A'])
        mustUsers(['commit', '--quiet', '--no-verify', '-m', 'axmap: preserve user state'])
      }
      syncUsers(remote)
      const f = path.join(USERS_WT, 'users', `${email}.json`)
      let cur = {}
      try { cur = JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
      const next = change(cur)
      if (JSON.stringify(cur) !== JSON.stringify(next)) {
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, JSON.stringify(next, null, 2) + '\n')
        mustUsers(['add', '--', `users/${email}.json`])
        mustUsers(['commit', '--quiet', '--no-verify', '-m', `user: ${email}`])
      }
      if (!remote) return 'local'
      const pushed = gitUsers(['push', '--quiet', remote, `HEAD:refs/heads/${USERS_BRANCH}`])
      if (pushed.code === 0) {
        fs.writeFileSync(path.join(DATA_HOME, '.axmap', '.users-lastfetch'), '')
        return 'shared'
      }
      if (attempt === 4) throw new Error(pushed.err || '사용자 정보 push 실패')
    }
  })
}

function publishProfile() {
  const profile = readProfile()
  if (!profile || !REPO) return null
  const email = myEmail()
  if (emailError(email)) throw new Error(emailError(email))
  // Successful unchanged profiles need no network more than once a minute.
  const stamp = path.join(DATA_HOME, '.axmap', '.profile-shared.json')
  const revision = profile.updatedAt || fs.statSync(profilePath()).mtime.toISOString()
  const key = JSON.stringify([profile.name, revision, email, me(), usersRemote()])
  try {
    const last = JSON.parse(fs.readFileSync(stamp, 'utf8'))
    if (last.key === key && Date.now() - last.at < 60_000) return last.result
  } catch { /* first use / changed identity */ }
  const result = updateUser(email, (cur) => {
    // An older PC must not undo a name correction made on another PC just
    // because it became active later. Revision belongs to setup, not to use.
    const name = (cur.profileUpdatedAt ?? '') > revision ? cur.name : profile.name
    const aliases = [...new Set([...(cur.aliases ?? []), cur.name, profile.name, me()].filter((n) => n && n !== name))]
    return { ...cur, name, aliases,
      profileUpdatedAt: (cur.profileUpdatedAt ?? '') > revision ? cur.profileUpdatedAt : revision }
  })
  rosterCache = null
  fs.writeFileSync(stamp, JSON.stringify({ key, at: Date.now(), result }) + '\n')
  if (result === 'local') console.error('※ 쪽지 프로필을 로컬에만 저장했습니다 — 원격이 없어 다른 팀원에게는 아직 보이지 않습니다.')
  return result
}

function messageName() {
  const profile = readProfile()
  if (!profile) return me()
  try {
    const state = JSON.parse(fs.readFileSync(path.join(USERS_WT, 'users', `${myEmail()}.json`), 'utf8'))
    const revision = profile.updatedAt || fs.statSync(profilePath()).mtime.toISOString()
    if ((state.profileUpdatedAt ?? '') > revision && state.name) return state.name
  } catch { /* unpublished profile / custom standalone mailbox */ }
  return profile.name
}

function readSeen(who) {
  pullUsers()
  const fromBranch = usersReady() ? (readUserState(who).seen ?? '') : ''
  // 🔴 옛 자리도 함께 본다. **둘 중 더 나아간 쪽**을 쓴다.
  //
  //    안 그러면 이 판으로 올린 날 모두의 쪽지가 전부 "안 읽음" 으로 되살아난다.
  //    수십 건이 한꺼번에 뜨면 사람은 그것을 배경으로 여기고 안 읽게 되는데,
  //    그건 이 도구가 고치려던 바로 그 상태다.
  let legacy = ''
  if (SEEN_FILE) {
    try {
      const known = addressesOf(who)
      for (const [name, id] of Object.entries(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')))) {
        if (known.has(norm(name)) && id > legacy) legacy = id
      }
    } catch { /* no legacy receipts */ }
  }
  return fromBranch > legacy ? fromBranch : legacy
}

/**
 * 🔴 **조용히 실패한다.** 못 찍으면 다음에 같은 쪽지가 한 번 더 뜰 뿐이다.
 *    여기서 죽으면 쪽지를 보려다 명령이 통째로 죽는다 — 그쪽이 훨씬 나쁘다.
 *
 * 🔴 읽고-고쳐-쓴다. 이 파일에는 여러 에이전트의 표시가 함께 들어 있어서
 *    통째로 덮으면 남의 표시가 지워진다. 같은 사람의 두 세션이 동시에 쓰면
 *    한쪽이 질 수 있는데, 지는 쪽의 손해는 "한 번 더 뜬다" 뿐이라 잠그지 않는다.
 */
function markSeen(who, id) {
  if (!who || !id) return
  // 옛 자리에도 계속 쓴다. 아직 옛 판을 쓰는 PC 가 같은 저장소에 있을 수 있고,
  // 그쪽에서는 이 자리만 읽는다. 새 판이 다 퍼지면 이 줄은 지운다.
  if (SEEN_FILE) {
    try {
      let all = {}
      try { all = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) } catch { /* 처음이다 */ }
      if ((all[who] ?? '') < id) {
        all[who] = id
        fs.writeFileSync(SEEN_FILE, JSON.stringify(all, null, 2) + '\n')
      }
    } catch { /* 조용히 */ }
  }

  const email = myEmail() || userKey(who)
  try {
    updateUser(email, (cur) => {
      const profile = readProfile()
      const name = profile ? messageName() : (cur.name || me())
      const aliases = [...new Set([...(cur.aliases ?? []), me()].filter((n) => n !== name))]
      return { ...cur, name, aliases, seen: (cur.seen ?? '') > id ? cur.seen : id }
    })
  } catch { /* Failed read receipts cause a repeat, never a hidden message. */ }
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const slug = (s) => s.toLowerCase().replace(/[^\w가-힣]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'msg'

/**
 * 시간대 치우침을 `+09:00` 처럼 적는다. 동쪽이 `+`, 서쪽이 `-` 다.
 *
 * 🔴 `getTimezoneOffset()` 은 **부호가 반대**다 — 서울에서 `-540`(분) 을 낸다.
 *    "이 시각을 UTC 로 만들려면 몇 분을 더해야 하나" 를 답하기 때문이다.
 *    그래서 뒤집는다. 여기서 부호를 놓치면 화면에 `-09:00` 이 찍혀, 고치려던
 *    것과 똑같은 병이 된다 — **시각은 맞는데 시간대가 거짓말**.
 *
 * 30분·45분 단위 시간대(인도 `+05:30`, 네팔 `+05:45`)도 그대로 나온다.
 */
function zoneOffset(d) {
  const mins = -d.getTimezoneOffset()
  const sign = mins < 0 ? '-' : '+'
  const abs = Math.abs(mins)
  const p = (n) => String(n).padStart(2, '0')
  return `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

/**
 * 쪽지 시각을 **이 PC 의 시간대**로 그린다.
 *
 * 🔴 **여기 있던 버그다.** `m.at.slice(0, 16).replace('T', ' ')` 였다. 저장된
 *    UTC 문자열을 앞에서 잘라 놓고 그것을 지역 시각인 척 보여준 것이라, 서울에서
 *    **9시간 이른 시각**이 떴다.
 *
 *    실측 (2026-09-07): 파일 이름이 `20260903T071235Z` 인 쪽지가 목록에
 *    `2026-09-03 07:12` 로 떴다. 한국 시간으로는 `16:12` 다. 오후에 온 쪽지가
 *    새벽에 온 것으로 보이니, 받은 사람은 그것을 **이미 지나간 일**로 여기고
 *    넘긴다. 틀린 시각은 없는 시각보다 나쁘다 — 없으면 물어보지만 있으면 믿는다.
 *
 * 🔴 **저장은 그대로 UTC 다.** 파일 이름의 `…Z` 도 머리말의 `at:` 도 안 건드린다.
 *    바뀌는 것은 **보여줄 때** 하나뿐이다. 저장을 지역 시간으로 옮기면 (1) 파일
 *    이름이 곧 정렬 키이자 읽음 표시의 기준(`id <= seen`)인데 시간대가 다른 PC
 *    끼리 순서가 어긋나고, (2) 이미 쌓인 쪽지가 전부 다른 시각을 뜻하게 된다.
 *
 * 🔴 `Asia/Seoul` 을 코드에 박지 않는다. 팀원이 다른 시간대에 있으면 그 사람
 *    시계로 보여야 맞다. PC 의 시간대를 따른다.
 *
 * 🔴 `Intl` 을 안 쓴다. Node 를 small-icu 로 빌드하면 시간대 이름이 `GMT+9` 로만
 *    나오거나 아예 없다. `Date` 의 지역 getter 와 `getTimezoneOffset()` 은 어느
 *    빌드에도 있고 로케일에 따라 흔들리지도 않는다.
 *
 * 못 읽는 값이면 **원문을 그대로 돌려준다.** 지어내지 않는다 — 시각을 그럴듯하게
 * 틀리게 보여주는 것이 이 함수가 고치러 온 버그다.
 */
function localTime(iso, { seconds = false } = {}) {
  if (!iso) return '(시각 없음)'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  const time = `${p(d.getHours())}:${p(d.getMinutes())}${seconds ? `:${p(d.getSeconds())}` : ''}`
  return `${date} ${time} ${zoneOffset(d)}`
}

function readAll() {
  const found = []
  let newBoxOpened = false
  for (const box of READ_BOXES) {
    let ns = []
    try { ns = fs.readdirSync(box).filter((f) => f.endsWith('.md')) } catch { continue }
    if (box === BOX) newBoxOpened = true
    for (const f of ns) found.push({ box, f })
  }
  // 🔴 옛 함(`docs/bus`)은 **읽기 전용 유산**이다. 새 함을 못 열었는데 옛 함이
  //    읽히면 지금까지는 그것이 **성공한 것처럼** 보였다 — 8월 20일자 8건이
  //    나오고 오늘 온 쪽지는 없는 것이 된다. 어느 함에서 읽었는지를 남긴다.
  readFromLegacyOnly = !newBoxOpened && found.length > 0
  return found.map(({ box, f }) => {
    const text = fs.readFileSync(path.join(box, f), 'utf8')
    const head = {}
    // 앞머리 `키: 값` 줄들. 빈 줄이 나오면 본문이 시작된다.
    //
    // 🔴 `split('\n')` 이 아니라 `\r?\n` 이다. 2026-08-26 에 여기서 물렸다.
    //
    //    쪽지가 고아 브랜치로 옮겨가면서 그 worktree 는 `.gitattributes` 가 닿지
    //    않는 트리가 됐고, Windows(`core.autocrlf=true`)에서 CRLF 로 체크아웃됐다.
    //    그러면 줄이 `from: alice\r` 이 되는데, **JS 정규식에서 `.` 은 `\r` 을
    //    안 먹는다** (`\r` 도 줄바꿈 문자다). `m` 플래그도 없어 `$` 는 문자열
    //    끝에서만 맞으므로 첫 줄부터 매치가 실패하고, 머리말이 통째로 빈 객체가
    //    된다. 그 결과가 "받는 사람이 없는 쪽지" 라 **목록에서 조용히 사라졌다.**
    //
    //    브랜치에 `.gitattributes` 도 함께 심었지만(`ensureBus`), 그것에만
    //    기대지 않는다. 데이터 포맷이 체크아웃 설정에 의존하면 그 설정이 닿지
    //    않는 자리가 생길 때마다 같은 사고가 난다 — 오늘 이미 세 번 났다.
    const lines = text.split(/\r?\n/)
    let i = 0
    for (; i < lines.length; i++) {
      const m = lines[i].match(/^(\w+):\s*(.*)$/)
      if (!m) break
      head[m[1]] = m[2].trim()
    }
    return { id: f.replace(/\.md$/, ''), file: f, ...head, body: lines.slice(i).join('\n').trim() }
  }).sort((a, b) => (a.id < b.id ? -1 : 1))
}

function stdin() {
  try { return fs.readFileSync(0, 'utf8') } catch { return '' }
}

function post({ to, subject, body, replyTo = null }) {
  const from = messageName()
  // 부르는 쪽이 하나를 주든 여럿을 주든 여기서는 목록 하나로 본다.
  let tos = (Array.isArray(to) ? to : (to == null ? [] : [to])).map((s) => String(s).trim()).filter(Boolean)

  // 🔴 대상을 안 주면 지금까지처럼 전체에게 간다. **바꾸지 않는다** — 바꾸면
  //    어제 되던 것이 오늘 안 되는 변경이고, 그건 맨 앞자리 번호를 올리고 먼저
  //    알린 뒤에 할 일이다 (MCP 의 ax_send 도 `to` 를 선택으로 두고 있다).
  //
  //    대신 **조용히 넘어가지는 않는다.** 옵션 하나를 빠뜨린 것과 전체에게
  //    보내려는 것은 명령줄에서 생김새가 똑같다. 실제로 216통 중 48통이
  //    전체공지였는데, 그중 몇이 의도한 것이었는지는 아무도 모른다.
  if (!tos.length) {
    console.error('※ 받는 사람을 주지 않았습니다 — 전체(all)에게 보냅니다.  한 사람에게 보내려면 --to <상대>')
    tos = ['all']
  }
  if (tos.length > 1 && tos.some((t) => norm(t) === 'all')) {
    console.error('※ all 이 섞여 있어 전체에게 보냅니다. 나머지 이름은 뜻이 없습니다.')
    tos = ['all']
  }
  if (!subject) { console.error('--subject 가 필요합니다.'); process.exit(1) }
  if (!body.trim()) { console.error('본문이 비었습니다 (stdin 으로 주세요).'); process.exit(1) }
  // 🔴 쪽지함이 없으면 **쓰지 않고 거부한다.**
  //
  //    그냥 쓰면 `.axmap/bus/messages` 가 worktree 아닌 맨 폴더로 생기고, 그러면
  //    나중에 `ensureBus` 가 "정상적인 쪽지함이 아닙니다 — 지운 뒤 다시 하세요"
  //    라고 안내한다. **안 간 쪽지를 지우라고 시키는 것**이다. 여기서 멈추면
  //    사람은 init 한 번 하고 다시 보내면 된다 — 잃는 것이 없다.
  if (!openBus()) {
    reportBusProblem()
    process.exit(1)
  }
  for (const one of tos) {
    const matches = roster().filter((p) => p.email === norm(one) || p.names.has(norm(one)))
    if (norm(one) !== 'all' && !norm(one).includes('@') && matches.length > 1) {
      console.error(`같은 이름의 수신자가 여러 명입니다: ${one}\n이메일로 지정하세요: ${matches.map((p) => p.email).join(', ')}`)
      process.exit(1)
    }
  }
  // 🔴 **모르는 주소로는 안 보낸다.**
  //
  //    지금까지는 받는 사람 이름을 아무도 검사하지 않았다. 오타 하나면 그 쪽지는
  //    아무에게도 안 가는데 보낸 쪽은 성공을 본다 — 실측에서 실제로 1통이
  //    `ahwlstjd` (뒤의 `57` 이 빠진 이름)로 갔고 13분 뒤에야 발견됐다.
  //
  //    거부하는 쪽을 고른 이유는 이 저장소가 정한 것 그대로다 — 잘못 막으면
  //    사람이 메시지를 읽고 고치면 되지만, 조용히 보내면 아무도 모른다.
  //    다만 **처음 오는 사람**(커밋도 쪽지도 아직 없는 사람)은 오타와 생김새가
  //    같으므로 빠져나갈 문을 둔다 — `--force`. 문이 없으면 사람은 시스템 밖으로
  //    나가고, 그때는 흔적도 안 남는다.
  for (const one of (has('--force') ? [] : tos)) {
    if (norm(one) === 'all') continue
    const known = roster().some((p) => p.email === norm(one) || p.names.has(norm(one)))
    if (!known) {
      const near = norm(one).includes('@') ? [] : nearMatches(one)
      if (near.length) {
        // 🔴 **거부하는 것은 오타뿐이다.** 아는 이름과 한 글자 차이거나 그 이름의
        //    앞부분이면 새 사람이 아니라 손이 미끄러진 것이다. 실측에서 실제로
        //    `ahwlstjd` 로 갔다 — 뒤의 `57` 이 빠졌고, 13분 뒤에야 발견됐다.
        console.error(
          `받는 사람을 찾지 못했습니다: ${one}\n` +
            `  혹시 이것입니까?  ${near.join('  ·  ')}\n\n` +
            '  이 이름 그대로 보내려면:  --force',
        )
        process.exit(1)
      }
      // 🔴 **모르는 사람이라고 막지는 않는다.** 아직 커밋이 없는 사람이 실제로
      //    있다 — 팀에 새로 온 사람에게 보내는 첫 쪽지가 정확히 그 모양이다.
      //    여기서 막으면 정상적인 첫 연락마다 `--force` 를 치게 되고, 그러면
      //    사람은 그것을 반사적으로 붙이게 되어 **오타 검사가 아무것도 못 잡는다.**
      //    대신 보내는 순간 눈에 띄게 말한다 — 조용히 보내는 것과는 다르다.
      console.error(`※ 이 저장소에서 처음 보는 이름입니다: ${one}  (그래도 보냅니다)`)
    }
  }

  // Resolve labels now: later profile corrections cannot redirect an old note.
  tos = [...new Set(tos.map((one) => {
    if (norm(one) === 'all') return 'all'
    const matches = roster().filter((p) => p.email === norm(one) || p.names.has(norm(one)))
    return matches.length === 1 ? matches[0].email : one
  }))]
  fs.mkdirSync(BOX, { recursive: true })
  const now = new Date()
  const id = `${stamp(now)}-${from}-${slug(subject)}-${randomUUID().slice(0, 8)}`
  // 🔴 `from` 은 **이름 그대로** 둔다. 파일 이름에 들어가는 값이라 바꾸면 예전
  //    쪽지와 형식이 갈린다. 대신 이메일을 한 줄 더 적는다 — 이름이 나중에
  //    바뀌어도 **누구였는지는 남는다.** 이것이 명단을 세우는 재료가 된다.
  const fromEmail = myEmail()
  const head = [
    `from: ${from}`,
    fromEmail ? `fromEmail: ${fromEmail}` : null,
    // 여럿이면 쉼표로 잇는다. 하나면 예전 쪽지와 글자 그대로 같은 모양이 된다 —
    // 형식을 새로 만들지 않으므로 옛 쪽지도 새 코드가 그대로 읽는다.
    `to: ${tos.join(', ')}`,
    `at: ${now.toISOString()}`,
    `subject: ${subject}`,
    replyTo ? `replyTo: ${replyTo}` : null,
  ].filter(Boolean).join('\n')
  // 임시 파일에 다 쓴 뒤 rename 한다. 같은 디렉터리 안의 rename 은 원자적이라
  // 읽는 쪽이 반쯤 쓰인 쪽지를 보는 일이 없다 — bin/axmap.mjs 의 writeFileAtomic 과
  // 같은 이유다. 장부만큼 치명적이진 않지만(쪽지는 판정에 쓰이지 않는다) 같은 값이면
  // 안전한 쪽으로 쓴다. 임시 이름이 `.md` 로 끝나지 않아 list 의 필터에도 안 걸린다.
  const dst = path.join(BOX, `${id}.md`)
  const tmp = `${dst}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, `${head}\n\n${body.trim()}\n`)
    fs.renameSync(tmp, dst)
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 무시 */
    }
    throw e
  }
  console.log(`보냄  ${id}`)
  console.log(`  쪽지함: ${BOX}`)
  console.log(`  ${publish(id)}`)
}

/**
 * 쪽지를 고아 브랜치에 실어 보낸다.
 *
 * 🔴 예전에는 여기서 아무것도 안 했다. 쪽지가 작업 트리(`docs/bus`)에 있어서
 *    "부르는 쪽이 자기 작업과 함께 올리게" 두는 것이 맞았다 — 여기서 커밋하면
 *    남이 작업 중인 트리를 건드리기 때문이다. 이제 쪽지는 **자기 worktree** 에
 *    있으므로 그 걱정이 사라졌고, 미루면 상대가 MR 한 사이클을 기다린다.
 *
 * 🔴 push 가 거부되면 **한 번만** 다시 시도한다. 쪽지 하나 = 파일 하나라 남과
 *    부딪힐 일이 없고, 거부는 곧 "그 사이 남이 쪽지를 넣었다" 는 뜻이다.
 *    받아서 다시 얹으면 끝난다. 그래도 안 되면 **죽이지 않는다** — 쪽지는
 *    로컬에 남아 있고 다음 호출에 함께 올라간다. 여기서 죽이면 원격이 잠깐
 *    흔들릴 때마다 사람의 작업이 멈춘다.
 */
function publish(id) {
  if (!busReady()) {
    return '아직 안 갔습니다 — 쪽지함이 준비되지 않았습니다. `axmap init` 을 한 번 실행하세요.'
  }
  const remote = gitBus(['config', '--get', 'axmap.remote'], { cwd: REPO }).out || 'origin'
  for (let attempt = 1; attempt <= 2; attempt++) {
    gitBus(['add', '-A'])
    // --no-verify: 연결된 worktree 는 훅을 공유한다. 쪽지함은 사용자 코드가 아니다.
    gitBus(['commit', '--quiet', '--no-verify', '-m', `bus: ${id}`])
    if (gitBus(['push', '--quiet', remote, `HEAD:${BUS_BRANCH}`]).code === 0) {
      return '보냈습니다. 상대는 아무 axMap 도구나 부르면 바로 봅니다.'
    }
    if (attempt === 1) {
      // 남이 먼저 넣었다. 받아서 내 쪽지를 그 위에 다시 얹는다.
      const mine = path.join(BOX, `${id}.md`)
      const keep = fs.existsSync(mine) ? fs.readFileSync(mine) : null
      pull()
      if (keep !== null) { fs.mkdirSync(BOX, { recursive: true }); fs.writeFileSync(mine, keep) }
    }
  }
  return '아직 안 갔습니다 — 원격에 못 올렸습니다. 다음 쪽지를 보낼 때 함께 올라갑니다.'
}

/**
 * 이 파일을 지금 폴더에서 부르는 명령. **문자열로 적지 않고 계산한다.**
 * 이 파일은 도구가 설치된 자리(npm 설치본·axMap 저장소)에 있고, 그 자리는 기계마다 다르다.
 */
function selfCmd() {
  const self = fileURLToPath(import.meta.url)
  const rel = path.relative(process.cwd(), self).replace(/\\/g, '/')
  // 🔴 상대경로가 늘 짧은 것은 아니다. 도구가 대상 저장소 **밖**에 있으면
  //    (전역 설치, 다른 드라이브) `../../..` 가 줄줄이 붙어 사람이 칠 수 없는
  //    문자열이 된다. 실측 (2026-08-27):
  //
  //      node ../../../../../../../../../Desktop/git/axmap/tools/bus.mjs read <아이디>
  //
  //    "쪽지가 있다" 고 말한 **바로 그 줄**이 읽는 방법을 못 쓰게 알려준다.
  //    받은 사람은 도구가 고장 났다고 결론짓는다. 둘 중 짧은 쪽을 쓴다 —
  //    안내는 맞기만 해서는 부족하고 **칠 수 있어야** 한다.
  //    `bin/axmap.mjs` 의 `busReadHint` 가 같은 판단을 이미 하고 있다.
  const abs = self.replace(/\\/g, '/')
  const use = rel.startsWith('../..') || rel.length >= abs.length
    ? abs
    : (rel.startsWith('.') ? rel : './' + rel)
  return `node ${use}`
}

/**
 * 🔴 `--mine` 과 `--quiet-if-empty` 도 훅 때문에 생겼다.
 *
 *    `--mine`  — 훅은 자기 이름을 모른다. `--to <이름>` 을 설정 파일에 박으면
 *                clone 한 모두가 한 사람의 함을 보게 된다. `me()` 가 풀게 한다.
 *    `--quiet` — 훅은 매 턴 돈다. 쪽지가 없을 때 "쪽지 없음." 을 찍으면 그 줄이
 *                대화의 절반을 채우고, 그러면 정작 쪽지가 왔을 때 안 보인다.
 *                **아무것도 없을 때 아무 말도 안 하는 것이 알림의 조건이다.**
 */
function list() {
  pull()
  const all = readAll()
  const to = has('--mine') ? (myEmail() || me()) : flag('--to')
  const from = flag('--from')

  // 🔴 **한 사람에게는 주소가 여럿이다.** `--to yeaseung-lee` 로 물어도
  //    `이예승` 앞으로 온 쪽지가 나와야 한다 — 같은 사람이기 때문이다.
  //    이름 하나로만 맞춰 보던 것이 쪽지를 묻은 원인이었다.
  //
  //    `--mine` 일 때는 내 이메일·git 이름·AXMAP_AGENT 를 전부 나로 친다.
  const toSet = to ? (has('--mine') ? myAddresses() : addressesOf(to)) : null
  const fromSet = from ? addressesOf(from) : null

  let rows = all.filter((m) => (has('--all') || !toSet
      || recipientsOf(m).some((r) => r === 'all' || toSet.has(r)))
    && (!fromSet || fromSet.has(norm(m.from)) || (m.fromEmail && fromSet.has(norm(m.fromEmail)))))

  // 🔴 `--unread` 는 자기 앞으로 온 것을 가릴 때만 뜻이 있다. 받는 사람이
  //    정해지지 않았는데 "안 읽음" 을 말하면 누구의 읽음인지가 없다.
  const who = has('--unread') ? (to || me()) : null
  if (who) {
    const seen = readSeen(who)
    // 🔴 `m.from !== who` — **내가 보낸 것은 내 안 읽은 쪽지가 아니다.**
    //
    //    `bin/axmap.mjs` 의 `unreadNotes` 는 처음부터 이 줄을 갖고 있었고
    //    ("내가 보낸 것은 뺀다 — 자기 쪽지에 자기가 놀라면 안 된다") 여기만
    //    없었다. 같은 것을 두 곳이 다른 규칙으로 세면 **한 사람이 같은 순간에**
    //    **두 숫자를 본다.**
    //
    //    실측 (2026-08-27, 팀 저장소): `ax_status` 는 "안 읽은 23건" 인데 같은
    //    시점 `ax_send` 결과의 배너는 "34건" 이었다. 차이 11 은 전부 그 사람이
    //    직접 보낸 전체공지였다 — `to: all` 이라 `m.to === 'all'` 에 자기 것이
    //    걸린다. 개인 쪽지에서는 안 드러난다. `to` 가 남의 이름이라 애초에
    //    안 잡히기 때문이고, 그래서 이 버그는 전체공지를 쓰기 시작한 날 나왔다.
    //
    //    숫자가 둘이면 사람은 어느 쪽도 안 믿는다. 그 순간 알림은 배경이 되고,
    //    배경이 된 알림은 진짜 쪽지가 왔을 때도 안 읽힌다.
    // 🔴 `m.from !== who` 였다. 이름이 하나일 때만 맞는 비교다 — 내가 `이예승`
    //    으로 커밋하고 `yeaseung-lee` 로 쪽지를 보냈으면, 내가 보낸 전체공지가
    //    **내 안 읽은 쪽지로 다시 잡힌다.** 주소 전부와 견준다.
    const mine = has('--mine') ? myAddresses() : addressesOf(who)
    rows = rows.filter((m) => m.id > seen
      && !(m.fromEmail ? mine.has(norm(m.fromEmail)) : mine.has(norm(m.from))))
  }

  // 🔴 **못 읽었으면 "없음" 이라고 답하지 않는다.** 이 세 줄이 이 파일에서 제일
  //    중요하다. 나머지는 편의고 이것만이 사고를 막는다.
  //
  //    종료 코드를 0 이 아닌 것으로 낸다 — MCP 서버(`mcp/server.mjs`)는 이미
  //    `ok: r.code === 0` 으로 갈라 "쪽지함을 읽지 못했습니다" 를 따로 내도록
  //    되어 있었다. 읽기가 그 신호를 **한 번도 낸 적이 없었을** 뿐이다.
  //
  //    `--quiet-if-empty`(훅·배너)일 때만 0 으로 끝낸다. 훅에서 0 이 아니면
  //    커밋이 막히는데, 쪽지를 못 읽은 것으로 커밋을 막는 것은 과하다.
  //    **다만 말은 한다** — stderr 는 그 경우에도 그대로 나간다.
  if (busProblem) {
    reportBusProblem()
    if (!has('--quiet-if-empty')) process.exit(1)
    return
  }
  if (!rows.length) {
    if (readFromLegacyOnly) console.error('※ 옛 쪽지함(docs/bus)만 읽었습니다 — 새 쪽지함은 비어 있습니다.')
    return has('--quiet-if-empty') ? undefined : console.log('쪽지 없음.')
  }
  for (const m of rows) {
    // 🔴 시간대 표시(`+09:00`)를 **줄마다** 붙인다. 목록 끝에 한 번만 적으면 안
    //    되는 이유가 있다 — 이 줄들은 그대로 **잘려서 다른 곳에 다시 실린다.**
    //    MCP 배너(`mcp/server.mjs` 의 `busRows`)와 프롬프트 훅은 화살표가 있는
    //    제목 줄만 가져가고 아래 요약 줄은 안 가져간다. 거기서 시간대가 사라지면
    //    사람이 실제로 보는 자리에서 다시 "이게 무슨 시간인가" 가 된다.
    console.log(`${localTime(m.at)}  ${(m.from ?? '?').padEnd(18)} → ${(m.to ?? 'all').padEnd(18)} ${m.subject ?? ''}`)
    console.log(`    ${m.id}`)
  }
  console.log(`\n총 ${rows.length}개. 본문:  ${selfCmd()} read <아이디>`)

  // 🔴 **찍는 것은 보여준 뒤다.** 위에서 죽으면 안 찍혀야 다음에 다시 뜬다.
  //    규격은 SPEC §2「읽음 표시」— 목록에 뜬 순간이 읽은 순간이다.
  //
  // 🔴 `--no-mark` 는 **목록을 잘라서 보여주는 쪽**을 위한 것이다. MCP 배너는
  //    받은 줄 중 3건만 그리는데, 여기서 전부를 찍으면 4번째부터는 화면에 뜬
  //    적도 없이 읽음이 되어 **영영 안 보인다.** 목록을 그대로 다 내보내는 쪽
  //    (사람이 부른 `list`)은 이 플래그가 필요 없다.
  //
  //    규칙 한 줄로 적으면 **그린 쪽이, 그린 것만 찍는다.** 자르는 쪽은
  //    `--no-mark` 로 읽기만 하고 자기가 그린 id 를 `seen` 에 넘긴다.
  if (who && !has('--no-mark')) {
    markSeen(who, rows.reduce((hi, m) => (m.id > hi ? m.id : hi), ''))
  }
}

function read(id) {
  pull()
  const m = readAll().find((x) => x.id === id || x.id.includes(id))
  // 🔴 못 열었으면 "없는 쪽지" 라고 말하지 않는다. 목록과 같은 이유다 — 사람은
  //    아이디를 잘못 적었다고 믿고 다시 치게 되는데, 몇 번을 쳐도 같은 답이 온다.
  if (!m && busProblem) { reportBusProblem(); process.exit(1) }
  if (!m) { console.error(`없는 쪽지: ${id}`); process.exit(1) }
  // 목록과 **같은 시간대**로 찍는다. 한쪽만 고치면 목록과 본문이 서로 다른 시각을
  // 말하게 되고, 숫자가 둘이면 사람은 어느 쪽도 안 믿는다. 본문은 한 통뿐이라
  // 초까지 보여준다 — 쪽지가 오간 순서를 따질 때 분 단위로는 모자란다.
  console.log(`── ${m.subject}\n   ${m.from} → ${m.to}   ${localTime(m.at, { seconds: true })}\n`)
  console.log(m.body)
}

/** 지금 누가 무엇을 잡고 있나 — 쪽지를 보내기 전에 상대가 뭘 하는지 본다. */
function who() {
  try {
    console.log(execFileSync('node', [path.join(ROOT, 'bin', 'axmap.mjs'), 'status'], {
      encoding: 'utf8', env: { ...process.env, AXMAP_AGENT: process.env.AXMAP_AGENT ?? 'bus' },
    }))
  } catch (e) { console.error(e.message) }
}

/**
 * 읽음 표시를 **주어진 쪽지에만** 찍는다. 규격은 SPEC §2「읽음 표시」.
 *
 * 🔴 이것이 따로 있는 이유는 하나다 — **목록을 잘라서 보여주는 쪽이 있기 때문이다.**
 *    `list` 는 자기가 낸 줄을 전부 알지만, MCP 배너처럼 그중 앞의 몇 줄만 그리는
 *    쪽은 `list` 에게 "내가 실제로 그린 것" 을 말해줄 방법이 없었다. 그래서
 *    찍는 일을 목록에서 떼어내 여기로 옮겼다.
 *
 * 🔴 `pull()` 을 하지 않는다. 로컬 파일 하나를 쓸 뿐이라 원격을 물을 이유가 없고,
 *    알림을 그릴 때마다 fetch 가 돌면 배너가 도구를 느리게 만든다.
 *
 * 고수위 하나만 들고 있으므로(SPEC §2) 여러 개를 받아도 가장 큰 것만 남는다.
 * 뒤로 가지 않는지는 `markSeen` 이 본다.
 */
function seen() {
  const ids = []
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--to') { i++; continue }        // 그 다음 것은 id 가 아니다
    if (args[i].startsWith('--')) continue
    ids.push(args[i])
  }
  if (!ids.length) {
    console.error(`찍을 쪽지 id 를 주세요.  예:  ${selfCmd()} seen <아이디> [<아이디>…]`)
    process.exit(1)
  }
  markSeen(has('--mine') ? (myEmail() || me()) : (flag('--to') || me()),
    ids.reduce((hi, id) => (id > hi ? id : hi), ''))
}

let profileResult = null
if (['profile', 'contacts', 'post', 'reply', 'list', 'read'].includes(cmd)) {
  try { profileResult = publishProfile() } catch (e) {
    console.error(`경고: 쪽지 프로필을 공유하지 못했습니다 — ${e.message}`)
    if (cmd === 'profile') process.exit(1)
  }
}

switch (cmd) {
  case 'profile':
    if (profileResult) console.log(`쪽지 프로필: ${profileResult}`)
    break
  case 'contacts':
    for (const p of roster()) console.log(`${p.displayName || [...p.names][0] || p.email}\t${p.email}`)
    break
  case 'post': post({ to: recipientArgs(), subject: flag('--subject'), body: stdin() }); break
  case 'reply': {
    const target = args[1]
    // 🔴 답장도 먼저 받아온다. 예전에는 받아오지 않고 찾아서, 원격에만 있는 쪽지에
    //    답장하면 **"없는 쪽지"** 가 나왔다. 아이디를 잘못 적은 것과 구별이 안 된다.
    pull()
    const src = readAll().find((x) => x.id === target || x.id.includes(target))
    if (!src && busProblem) { reportBusProblem(); process.exit(1) }
    if (!src) { console.error(`없는 쪽지: ${target}`); process.exit(1) }
    post({ to: src.fromEmail || src.from, subject: flag('--subject') ?? `Re: ${src.subject}`, body: stdin(), replyTo: src.id })
    break
  }
  case 'list': list(); break
  case 'read': read(args[1]); break
  case 'seen': seen(); break
  case 'who': who(); break
  default:
    console.log(`에이전트 쪽지함

  ${selfCmd()} post --to <상대> --subject "<제목>" < 본문.md
                   --to 를 여러 번 주거나 "a,b" 로 여럿에게 한 통을 보냅니다
                   --to 를 아예 안 주면 전체(all)에게 갑니다
  ${selfCmd()} list [--to <나>|--mine] [--from <상대>] [--all]
                   [--unread] [--no-mark] [--throttle <초>] [--quiet-if-empty]
  ${selfCmd()} read <아이디>
  ${selfCmd()} seen <아이디> [<아이디>…]   보여준 쪽지만 읽음으로 찍는다
  ${selfCmd()} reply <아이디> < 본문.md
  ${selfCmd()} who          지금 누가 무엇을 잡고 있나
  ${selfCmd()} contacts     이 저장소의 쪽지 수신자 이름·이메일

목록을 잘라서 보여주는 쪽은 --no-mark 로 읽기만 하고, 자기가 그린 아이디만
seen 에 넘기세요. 안 그러면 화면에 뜬 적 없는 쪽지가 읽음이 되어 안 보입니다.

AXMAP_AGENT      선점과 같은 값으로 두세요.
AXMAP_BUS_POLL   원격을 다시 묻기까지의 초. --throttle 이 없을 때만 씁니다.
쪽지는 고아 브랜치 ${BUS_BRANCH} 로 바로 갑니다 — 커밋도 MR 도 필요 없습니다.`)
}
