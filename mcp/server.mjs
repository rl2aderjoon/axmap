#!/usr/bin/env node
/**
 * axMap MCP 서버.
 *
 * Claude Code 같은 AI 도구가 "나는 이 파일들을 건드리겠다"를 선언하게 만든다.
 * 다른 에이전트가 작업 범위와 목적을 확인할 수 있다.
 *
 * 설정 (.mcp.json 또는 도구별 MCP 설정):
 *   {
 *     "mcpServers": {
 *       "axmap": {
 *         "command": "node",
 *         "args": ["<axmap>/mcp/server.mjs"],
 *         "env": {
 *           "AXMAP_REPO": "<대상 저장소>",
 *           "AXMAP_ACTOR": "agent"
 *         }
 *       }
 *     }
 *   }
 *
 * 🔴 `env` 에 에이전트 이름을 **적어 두지 않는다.** 그 자리가 저장소에 커밋되는
 *    순간 모두가 같은 한 사람이 된다.
 *
 *    예전에는 `"AXMAP_AGENT": "${AXMAP_AGENT:-claude}"` 였다. clone 한 팀원 다섯이
 *    전부 `claude` 라는 한 명이 되고, `checkOverlap` 은 **자기 claim 을 겹침으로
 *    보지 않으므로** 서로의 영역을 아무 경고 없이 덮어쓴다. 락이 조용히 다섯 명에게
 *    발급된 것이고, 이 저장소가 fail-closed 로 막겠다고 선언한 바로 그 실패다.
 *
 *    그래서 이름은 아래 순서로만 정한다. **안전한 기본값으로 치환하지 않는다** —
 *    치환은 서로 다른 두 사람을 같은 사람으로 만들고, 그것이 곧 소유권 충돌이다.
 *
 *      1. AXMAP_AGENT
 *      2. git config user.name
 *      3. 없으면 die
 *
 * 판정은 전부 bin/axmap.mjs 에 맡긴다. 여기서 로직을 다시 구현하면
 * 두 경로의 동작이 갈라지고, 그러면 장부를 믿을 수 없게 된다.
 *
 * stdio 전송 — 줄바꿈으로 구분된 JSON-RPC 2.0.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { syncConfiguredProfile } from '../src/identity.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * axMap 저장소 자신. `REPO`(작업 대상)와 다를 수 있다 —
 * 다른 저장소에 붙어 있는 동안에도 이 도구의 **코드**는 여기 있다.
 *
 * 이 구분이 이 파일에서 가장 자주 틀리는 곳이다. 기준은 하나다:
 *   프로그램(실행할 것) → `SELF`,  데이터(대상 저장소의 것) → `REPO`.
 */
const SELF = path.resolve(HERE, '..')
const CLI = path.join(SELF, 'bin', 'axmap.mjs')
// Vendored copies may omit package.json; the protocol handshake must still work.
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(SELF, 'package.json'), 'utf8')).version } catch { return 'unknown' }
})()

/**
 * 대상 저장소 — **지금 이 서버가 겨누고 있는 폴더.**
 *
 * `const` 가 아니라 `let` 인 것이 요점이다. 예전에는 서버가 켜질 때 한 번 정해지면
 * 끝이어서, 사람이 앱에서 다른 저장소를 열어도 MCP 는 처음 폴더를 계속 붙잡고 있었다.
 * 지금은 **도구를 부를 때마다** `syncRepo()` 가 다시 정한다.
 */
let clientRoots = null
let rootsError = null
let rootsSupported = false
let rootsTask = null
let rootsGeneration = 0
let rootRequestId = 0
const pendingRoots = new Map()
let REPO = resolveRepo()

function gitRoot(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true })
  const top = r.status === 0 ? (r.stdout ?? '').trim() : ''
  return top ? fs.realpathSync(top) : null
}

/** Explicit pin > per-call cwd > client roots > launch cwd.
 * A global desktop selection must never redirect another CLI session. */
function resolveRepo(args = {}) {
  if (process.env.AXMAP_REPO) {
    const pinned = path.resolve(process.env.AXMAP_REPO)
    return gitRoot(pinned) || pinned
  }
  if (args.cwd !== undefined) {
    if (typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd)) {
      throw new Error('cwd 는 현재 작업 폴더의 절대 경로여야 합니다.')
    }
    const top = gitRoot(args.cwd)
    if (!top) throw new Error(`작업 폴더에서 Git 저장소를 찾지 못했습니다: ${args.cwd}`)
    return top
  }
  if (rootsError) throw new Error(`작업 폴더를 확인하지 못했습니다: ${rootsError}`)
  if (clientRoots !== null) {
    const dirs = [...new Set(clientRoots.map((root) => {
      if (typeof root?.uri !== 'string' || !root.uri.startsWith('file:')) {
        throw new Error('클라이언트가 유효한 file:// 작업 폴더를 보내지 않았습니다.')
      }
      const top = gitRoot(fileURLToPath(root.uri))
      if (!top) throw new Error(`작업 폴더에서 Git 저장소를 찾지 못했습니다: ${root.uri}`)
      return top
    }))]
    if (dirs.length === 1) return dirs[0]
    const launched = gitRoot(process.cwd())
    if (dirs.includes(launched)) return launched
    throw new Error('작업 저장소를 하나로 정할 수 없습니다. 도구의 cwd 에 작업 폴더 절대 경로를 지정하세요.')
  }
  return gitRoot(process.cwd()) || process.cwd()
}

/** axMap 저장소 자신을 겨누고 있는가. 브리핑이 무엇을 읽을지가 여기서 갈린다. */
const isForeign = () => REPO !== SELF

/**
 * 쪽지함 CLI. **`SELF` 기준이다 — `REPO` 가 아니다.**
 *
 * 🔴 예전에는 `path.join(REPO, 'tools', 'bus.mjs')` 였다. axMap 안에서 자기 자신을
 *    겨눠 쓰는 동안에는 두 경로가 같아서 아무 문제가 없었고, 남의 저장소에 붙이는
 *    순간 `MODULE_NOT_FOUND` 로 쪽지함이 통째로 죽었다. `bus.mjs` 는 **이 도구의
 *    일부**지 대상 저장소가 가진 파일이 아니다. 바로 위 `CLI` 가 처음부터 `SELF`
 *    기준이었던 것과 정확히 같은 이유다.
 *
 *    쪽지의 **내용**은 반대다. 그건 대상 저장소의 데이터이므로 `AXMAP_BUS_DIR` 로
 *    `REPO/docs/bus` 를 넘긴다. 안 그러면 팀의 쪽지가 axMap 저장소에 쌓여
 *    정작 그 팀의 저장소에는 아무것도 안 남는다.
 *
 *    이 버그가 오래 살아 있던 이유는 하나다 — REPO 와 SELF 가 다른 조합을
 *    아무도 돌려보지 않았다. `test/mcp.test.mjs` 가 그 조합을 고정한다.
 */
const BUS = path.join(SELF, 'tools', 'bus.mjs')

/**
 * 🔴 `AXMAP_BUS_DIR` 에 **폴더를 넘기지 않는다.** 빈 문자열로 넘긴다 —
 *    `bus.mjs` 는 빈 값을 "지정 안 됨" 으로 보므로 결과는 안 넘긴 것과 같고,
 *    동시에 **부모 환경에 남아 있던 값을 지운다.** 그냥 생략하면 물려받은
 *    엉뚱한 폴더로 쪽지가 떨어질 수 있다. (실제로 넘기는 자리는 `bus()` 안이다.)
 *
 * 예전에는 여기서 `REPO/docs/bus` 를 넘겼다. 쪽지가 작업 트리에 있었으니 폴더
 * 하나만 알려주면 됐다. 지금은 쪽지가 고아 브랜치(`axmap/bus`)의 worktree 에
 * 있고, `bus.mjs` 는 거기에 **커밋하고 push** 해야 한다. 폴더만 넘기면 그 파일은
 * 자기가 어느 저장소의 worktree 안에 있는지 알 수 없어 push 할 곳을 잃는다 —
 * 쪽지는 로컬에만 쌓이고 아무에게도 안 간다. 옛 버그의 정확한 재판이다.
 *
 * 대신 `cwd` 를 대상 저장소로 준다. `bus.mjs` 가 `git rev-parse` 로 스스로 찾는다.
 * 프로그램(`SELF`)과 데이터(`REPO`)를 가르는 규칙은 그대로다 — 알려주는 방식만
 * "폴더를 지정" 에서 "서 있을 자리를 지정" 으로 바뀌었다.
 */
/**
 * 에이전트 이름. 기본값이 **없다** — 이유는 이 파일 머리말에 적어 두었다.
 * 요약하면: 모두에게 같은 기본 이름을 주면 여러 사람이 장부에서 한 명이 되고,
 * 그 순간 서로의 claim 이 겹침으로 보이지 않는다.
 */
function resolveAgent() {
  if (process.env.AXMAP_AGENT) return process.env.AXMAP_AGENT
  const r = spawnSync('git', ['config', 'user.name'], { cwd: REPO, encoding: 'utf8', windowsHide: true })
  const name = (r.stdout ?? '').trim()
  if (name) return name
  // die. 기본 이름으로 대신 채우면 두 사람이 한 사람이 되고, 그것이 곧 소유권 충돌이다.
  process.stderr.write(
    'axMap MCP: 에이전트 이름을 알 수 없습니다.\n' +
      '  AXMAP_AGENT 를 설정하거나 git config user.name 을 지정하세요.\n' +
      '  기본 이름으로 대신 채우지 않습니다 — 여러 사람이 같은 이름이 되면\n' +
      '  서로의 claim 을 겹침으로 보지 못해 같은 파일을 조용히 함께 고칩니다.\n',
  )
  process.exit(1)
}

/**
 * 🔴 이름은 대상이 바뀌어도 **따라 바뀌지 않는다.** 시작할 때 한 번 정하고 끝이다.
 *
 * 저장소마다 `git config user.name` 이 다를 수 있는데, 대상을 따라 이름까지 바뀌면
 * 한 사람이 장부에서 둘이 된다. 그러면 자기가 잡아둔 것을 자기가 반납하지 못하고,
 * 겹침 판정도 자기 claim 을 남의 것으로 본다. **대상은 옮겨 다녀도 잡는 사람은 한 명**이다.
 */
const AGENT = resolveAgent()
const ACTOR = process.env.AXMAP_ACTOR ?? 'agent'
const TTL = process.env.AXMAP_TTL ?? '45m'

/**
 * 이 서버가 **어느 세션의 것인가**.
 *
 * 🔴 2026-08-28 에 두 번 재현된 사고가 정확히 여기서 났다. 한 PC 에서 AI 도구
 *    세션 두 개가 붙었고, 둘 다 `git config user.name` 이 같아 `AGENT` 가 같았다.
 *    장부가 이름당 레코드 하나였던 탓에 뒤에 온 쪽이 앞의 것을 덮었고, 경고도 없었다.
 *    지금은 (이름, 세션) 짝마다 레코드가 하나라 덮이지 않는다.
 *    이름은 "누구인가", 세션은 "어느 작업 주체인가" 다. 둘을 갈라야 서로를 막는다.
 *
 * 순서를 CLI(`resolveSessionId`)와 **앞 두 칸까지 똑같이** 맞춘다. 안 맞추면
 * 같은 세션인데 MCP 로 잡은 것을 셸에서 반납하지 못한다 — 이름이 갈렸을 때와
 * 똑같은 사고가 세션 쪽에서 되풀이된다.
 *
 *   1. AXMAP_SESSION            사람이 직접 지정
 *   2. CLAUDE_CODE_SESSION_ID   도구가 세션마다 다르게 준다 (셸에서도 같은 값)
 *   3. `mcp-<pid>`              둘 다 없을 때. **이 서버 프로세스 하나가 곧 한 세션**이다
 *
 * 🔴 3번에 난수를 쓰지 않는다. pid 는 서버가 사는 동안 안 변하므로 같은 세션의
 *    claim·release 가 짝이 맞고, 서버를 두 개 띄우면 반드시 다르다. 난수였다면
 *    그것도 되지만 로그에서 어느 프로세스였는지 되짚을 수 없다.
 *    서버가 재시작하면 pid 가 바뀌어 "다른 세션" 이 된다 — 그때 앞 서버가 두고 간
 *    줄은 **그대로 남는다** (덮지도, 대신 풀지도 않는다). TTL 이 지나 저절로
 *    걷히거나, 사람이 `release --all-sessions` 로 치운다.
 */
const SESSION = process.env.AXMAP_SESSION || process.env.CLAUDE_CODE_SESSION_ID || `mcp-${process.pid}`

const BRIDGE_TOOLS = new Set(['ax_sessions', 'ax_dispatch', 'ax_result', 'ax_chat', 'ax_dialogue', 'ax_chat_stop'])
function bridge(args, input) {
  const r = spawnSync(process.execPath, [path.join(SELF, 'tools', 'bridge.mjs'), ...args], {
    cwd: REPO, input, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, AXMAP_AGENT: AGENT }, timeout: 45000,
  })
  return { ok: r.status === 0, text: (r.stdout || '') + (r.stderr || '') + (r.error ? r.error.message : '') }
}

/**
 * 쪽지함 CLI 를 부른다. `cli` 와 달리 stdin 으로 본문을 넘긴다.
 *
 * 🔴 쪽지 하나 = 파일 하나라 두 에이전트가 동시에 보내도 안 부딪힌다.
 *    append-only 로그 파일 하나였다면 git 텍스트 충돌이 난다 —
 *    이 저장소가 장부를 파서로 만든 이유가 정확히 그것이다.
 */
function bus(args, input = undefined) {
  const r = spawnSync(process.execPath, [BUS, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    windowsHide: true,
    input,
    env: { ...process.env, AXMAP_AGENT: AGENT, AXMAP_ACTOR: ACTOR, AXMAP_BUS_DIR: '' },
  })
  return {
    code: r.status ?? 1,
    out: [(r.stdout ?? '').trim(), (r.stderr ?? '').trim()].filter(Boolean).join('\n'),
  }
}

/**
 * 요청하지 않아도 쪽지를 알린다. **모든 도구 결과 끝에 붙는다.**
 *
 * 🔴 왜 MCP 의 알림(notification)이 아닌가. 규격에는 서버가 클라이언트에게 먼저
 *    말을 거는 통로가 있지만, **에이전트가 그것을 본다는 보장이 없다.** 에이전트가
 *    확실히 읽는 것은 자기가 부른 도구의 결과뿐이다. 그래서 그 자리에 붙인다.
 *    무엇을 부르든 — status 든 claim 이든 brief 든 — 보인다.
 *
 * 🔴 매번 원격을 물으면 도구가 느려진다. 그 조절은 이제 `bus.mjs` 의 `--throttle`
 *    이 한다 — 시계가 스탬프 파일이라 훅(부를 때마다 새 프로세스)과 이 서버
 *    (세션 내내 살아 있음)가 **같은 창을 나눠 쓴다.**
 *
 *    예전에는 여기서 프로세스 안의 변수로 15초를 쟀다. 그 캐시는 이제 둘 수 없다 —
 *    아래에서 읽음을 찍기 때문에, 캐시가 남아 있으면 **이미 찍은 쪽지를 다시 그린다.**
 *    직전 결과를 재사용하는 것과 상태를 바꾸는 것은 같이 못 간다.
 *
 * 🔴 **그린 것만 찍는다.** 배너는 3건만 그리므로 3건만 읽음이 된다. `list` 에게
 *    찍게 하면(= `--unread` 만 주면) 화면에 뜬 적 없는 4번째부터가 읽음이 되어
 *    영영 안 보인다. 그래서 `--no-mark` 로 읽기만 하고 그린 id 만 `seen` 에 넘긴다.
 *    조용히 사라지는 쪽으로 틀리면 아무도 못 찾는다.
 */
/**
 * 🔴 **배너의 두 숫자는 설정에서 온다. 코드에 박지 않는다.**
 *
 *    `AXMAP_BUS_ROWS`  배너에 실제로 그리는 줄 수 (기본 3).
 *                      **0 이면 배너를 끈다** — 아래에서 그 즉시 나간다.
 *    `AXMAP_BUS_POLL`  원격을 다시 묻기까지의 초 (기본 15).
 *                      0 이면 도구를 부를 때마다 fetch 한다.
 *
 *    이 둘은 서로 다른 것을 조절한다. **줄 수는 시끄러움이고 주기는 비용이다.**
 *    줄 수를 줄이면 화면이 조용해지지만 원격을 묻는 횟수는 그대로이고,
 *    주기를 늘리면 원격 부담이 줄지만 새 쪽지가 그만큼 늦게 뜬다.
 *
 *    왜 기본이 15초인가 — 실측(2026-08-27, lab.ssafy.com): 쪽지 브랜치
 *    `git fetch` 한 번이 **0.77~0.84초**다. 이 배너는 도구 결과마다 붙으므로,
 *    창이 없으면 에이전트의 **모든 도구 호출이 0.8초씩 느려진다.** 15초 창을
 *    두면 한창 일하는 중에도 분당 4회를 넘지 않고, 도구 호출 하나가 느려지는
 *    일은 그중 한 번뿐이다. 새 쪽지는 최악 15초 늦게 뜬다 — 쪽지는 사람이
 *    읽고 방향을 바꾸는 것이라 15초는 늦은 축에 못 든다.
 *
 *    바쁜 폴링(busy polling — 짧은 간격으로 계속 물어보는 것)을 하지 않는
 *    이유가 여기 있다. **이 배너에는 자기 시계가 없다.** 에이전트가 도구를
 *    부를 때만 돌고, 세션이 놀고 있으면 fetch 도 0회다. 타이머로 돌리면
 *    아무도 안 보는 새벽에도 원격을 두들기고 배터리를 먹는다.
 */
const envNum = (v, dflt) => {
  const n = Number(v)
  // 🔴 못 읽은 값은 기본값으로 되돌린다. 오타 하나로 배너가 조용히 꺼지거나
  //    (NaN < 1) 매 호출마다 fetch 가 도는(NaN → 0) 쪽으로 가면 안 된다.
  return Number.isFinite(n) && n >= 0 ? n : dflt
}
const BANNER_ROWS = envNum(process.env.AXMAP_BUS_ROWS, 3)
const BUS_POLL = envNum(process.env.AXMAP_BUS_POLL, 15)

/**
 * 목록 출력에서 (제목 줄, id) 쌍을 뽑는다. `bus list` 는 두 줄이 한 쌍이다 —
 * 제목 줄에 화살표가 있고 **그 다음 줄이 id** 다.
 */
function busRows(out) {
  const lines = out.split('\n')
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('→')) continue
    rows.push({ line: lines[i].trim(), id: (lines[i + 1] ?? '').trim() })
  }
  return rows
}

function unreadBanner(tool, text) {
  // 🔴 `AXMAP_BUS_ROWS=0` 은 **끄는 스위치**다. 반드시 여기서 나간다 —
  //    아래로 내려가면 그릴 줄이 0개인 채로 git fetch 만 돌게 된다.
  if (BANNER_ROWS < 1) return ''
  // 지금 쪽지를 읽고 있는 사람에게 "쪽지가 있다" 고 또 말하지 않는다.
  if (tool === 'ax_inbox') return ''
  // 🔴 도구 이름으로 거르지 않고 **결과를 본다.** `claim` 과 `status` 는 CLI 가
  //    이미 같은 알림을 찍는다. 이름 목록으로 거르면 CLI 쪽이 알림을 붙이거나
  //    떼는 순간 여기가 조용히 낡는다 — 목록은 언제나 코드보다 먼저 낡는다.
  if (text.includes('안 읽은 쪽지')) return ''

  const r = bus(['list', '--mine', '--unread', '--no-mark',
    '--throttle', String(BUS_POLL), '--quiet-if-empty'])
  if (r.code !== 0) return ''
  const rows = busRows(r.out)
  if (!rows.length) return ''

  const shown = rows.slice(0, BANNER_ROWS)
  const head = shown.map((s) => '  ' + s.line).join('\n')
  const more = rows.length > shown.length ? `\n  … 그 밖에 ${rows.length - shown.length}건` : ''
  // 🔴 **문구가 `bin/axmap.mjs` 의 `printUnread` 와 같아야 한다.**
  //
  //    예전에는 "나에게 온 쪽지 N건" 이었다. 그런데 이 N 은 `--unread` 로
  //    거른 **안 읽은** 수다. 옆에서 CLI 는 같은 것을 "안 읽은 쪽지 N건" 이라
  //    부르니, 한 사람이 한 화면에서 이름이 다른 두 숫자를 본다. 그러면
  //    "하나는 전체고 하나는 미읽음인가?" 를 묻게 되는데 **둘 다 미읽음이다.**
  //    읽는 사람이 뜻을 물어야 하는 알림은 알림이 아니다.
  const banner = `\n\n───── 📬 안 읽은 쪽지 ${rows.length}건 — ax_inbox 로 읽으십시오 ─────\n${head}${more}`

  // 🔴 배너를 다 만든 뒤에 찍는다. 위에서 죽으면 안 찍혀야 다음에 다시 뜬다.
  const ids = shown.map((s) => s.id).filter(Boolean)
  if (ids.length) bus(['seen', '--mine', ...ids])
  return banner
}

/**
 * 🔴 **사람이 읽을 것과 기계가 읽을 것을 가른다.**
 *
 *    예전에는 `out` 하나뿐이었고 거기에 stdout 과 stderr 를 합쳐서 담았다.
 *    보여주기에는 그게 맞다 — 경고도 같이 보여야 한다. 그런데 `--json` 을
 *    **파싱하는 쪽**에는 재앙이었다.
 *
 *    `axmap status` 는 원격이 없으면 이렇게 경고한다:
 *
 *        경고: 원격이 없어 단일 작업자 모드로 돕니다. 관문 1(CAS)이 …
 *
 *    이 줄이 stderr 로 나와 JSON 뒤에 붙으면 `JSON.parse` 가 죽는다. 그리고
 *    `ax_check` 는 그 실패를 삼키고 **"겹치지 않습니다. claim 해도 됩니다"** 를
 *    냈다 — 장부에 남의 claim 이 몇 개가 있든 상관없이. 원격이 없는 저장소
 *    (새로 시작한 팀, 테스트 저장소)에서는 **언제나** 그랬다.
 *
 *    그래서 `out`(합친 것)은 보여주기용으로 남기고, 파싱은 `stdout` 만 본다.
 */
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, AXMAP_AGENT: AGENT, AXMAP_ACTOR: ACTOR, AXMAP_SESSION: SESSION, AXMAP_SKIP_PROFILE_SYNC: '1' },
  })
  const stdout = (r.stdout ?? '').trim()
  const stderr = (r.stderr ?? '').trim()
  return {
    code: r.status ?? 1,
    out: [stdout, stderr].filter(Boolean).join('\n'),   // 사람에게
    stdout,                                             // 기계에게 — 합치지 않는다
    stderr,
  }
}

// ---------------------------------------------------------------------------
// 도구
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'ax_sessions',
    description: '현재 repo에 연결된 로컬 AI 세션, 역할, 상태와 측정 토큰 사용량을 확인한다. stdio는 사용자가 bridge serve로 시작한 관리형 세션이다. 등록만으로 연결 가능성이나 실행 성공을 보장하지 않는다.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ax_dispatch',
    description: '사용자가 허용한 작업을 연결된 상대 세션에 전달한다. 기존 맥락을 유지하며 새 모델 프로세스를 만들지 않는다. submitted는 완료가 아니다. unknown이면 자동 재시도하지 말고 ax_result로 확인한다. Codex/agy 관리형 stdio, 별도로 실행한 Windows agy console, 실험용 PTY/agentapi 연결을 지원한다.',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string', description: 'ax_sessions에서 확인한 상대 세션 UUID' },
      prompt: { type: 'string', description: '상대가 실행할 작업 요청' },
    }, required: ['to', 'prompt'] },
  },
  {
    name: 'ax_result',
    description: '작업 요청의 제출/완료/불명 상태, 결과와 측정 사용량을 확인한다. 관리형 세션은 구조화된 완료 이벤트, PTY는 종료 훅, 독립 Windows console은 요청 UUID가 있는 대화 기록과 현재 빈 입력창의 대기 상태로 판정한다.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string', description: 'ax_dispatch가 반환한 요청 UUID' },
    }, required: ['id'] },
  },
  {
    name: 'ax_chat',
    description: '사용자가 허용한 범위에서 대기 중인 관리형 세션 두 개의 자동 대화를 시작한다. 기본 최대 4회 실행, 측정 처리 토큰 50000, 메시지 2000자. 대기 중 모델 호출 없음. 한 번의 실행은 토큰 한도를 넘을 수 있으며 다음 실행 전에 검사한다. 접수는 완료가 아니다. ax_dialogue로 조회한다. 사용자 승인이나 연결 실패를 자동 우회하지 않는다.',
    inputSchema: { type: 'object', properties: {
      left: { type: 'string', description: '먼저 요청받을 stdio 세션 UUID' },
      right: { type: 'string', description: '다른 stdio 세션 UUID' },
      prompt: { type: 'string', description: '사용자가 부여한 작업과 종료 기준. 기본 2000자 이하' },
      maxTurns: { type: 'integer', minimum: 1, maximum: 20 },
      maxTokens: { type: 'integer', minimum: 1 },
      maxMessageChars: { type: 'integer', minimum: 1, maximum: 8000 },
    }, required: ['left', 'right', 'prompt'] },
  },
  {
    name: 'ax_dialogue',
    description: '자동 대화의 상태, 요청별 사용량과 누적 사용량을 확인한다. usage_unavailable는 측정 불가로 중단, token_limit는 다음 실행 시작을 막은 상태다.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'ax_chat_stop',
    description: '자동 대화의 추가 중계를 중단한다. 이미 전달된 모델 요청은 계속 실행될 수 있다. 상대 CLI를 강제 종료하지 않는다.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'ax_brief',
    description:
      '이 저장소에서 처음 일한다면 **가장 먼저** 호출한다. 무엇을 만드는 프로젝트인지, ' +
      '이미 내려진 결정이 무엇인지(다시 논의하지 말 것), 어떤 파일이 무슨 일을 하는지, ' +
      '끝내기 전에 무엇을 통과해야 하는지를 한 번에 준다. ' +
      '내용은 저장소의 문서와 각 파일 머리말에서 그때그때 읽어오므로 낡지 않는다.',
    inputSchema: { type: 'object', properties: {} },
  },

  {
    name: 'ax_init',
    description:
      '명시적으로 장부와 부가 저장소를 준비한다. 일반적인 선점·조회는 장부를 자동으로 준비하므로 먼저 부를 필요가 없다. '
      + '이미 있으면 아무것도 바꾸지 않으므로 여러 번 불러도 안전하다. '
      + '원격을 직접 고르려면 remote 에 Git 원격 이름을 지정한다.',
    inputSchema: { type: 'object', properties: { remote: { type: 'string', description: 'Git 원격 이름' } } },
  },
  {
    name: 'ax_claim',
    description:
      '파일을 수정하기 전에 반드시 호출한다. 건드릴 경로를 선언해 다른 에이전트와 겹치지 않게 한다. ' +
      '거부되면(exit 2) 재시도하지 말고 겹치지 않는 다른 작업으로 옮겨라.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '저장소 루트 기준 상대 경로. 파일 또는 디렉터리' },
        intent: { type: 'string', description: '무엇을 하려는지 한 문장. 사람이 화면에서 이걸 본다' },
        task: { type: 'string', description: '작업/티켓 식별자 (선택)' },
      },
      required: ['paths', 'intent'],
    },
  },
  {
    name: 'ax_check',
    description: '선언하지 않고 겹침만 미리 확인한다. 작업 계획을 세울 때 쓴다.',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
      required: ['paths'],
    },
  },
  {
    name: 'ax_status',
    description: '지금 누가 어떤 경로를 잡고 있고 무엇을 하려는지 본다.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ax_release',
    description: '작업이 끝나면 호출한다. 경로를 생략하면 이 세션이 잡은 것을 전부 반납한다 (다른 창의 것은 안 건드린다).',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
    },
  },
  {
    name: 'ax_renew',
    description: '작업이 길어질 때 TTL 을 연장한다. 연장하지 않으면 락이 저절로 풀린다.',
    inputSchema: { type: 'object', properties: {} },
  },

  /**
   * 쪽지함 — 사람을 거치지 않고 다른 에이전트에게 말한다.
   *
   * 🔴 왜 MCP 인가. CLAUDE.md 에 적어두면 **읽은 에이전트만** 쓴다.
   *    도구로 내놓으면 목록에 뜨므로 존재를 알려줄 필요가 없다.
   *
   * ⚠️ 다만 MCP 도 "언제 쓸지" 는 못 정해준다. 그래서 안 읽은 쪽지 알림은
   *    `ax_claim` 응답에 함께 실린다 — claim 은 규칙상 반드시 부른다.
   */
  {
    name: 'ax_inbox',
    description:
      '다른 에이전트가 나에게 보낸 쪽지를 읽는다. 세션을 시작할 때, 그리고 방향을 '
      + '바꾸기 전에 확인하십시오. **안 읽은 것만 냅니다** — 한 번 뜬 쪽지는 다음부터 '
      + '안 나오므로, 필요하면 그 자리에서 처리하십시오. id 를 주면 그 쪽지의 본문 전체를 냅니다.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '본문을 볼 쪽지 id. 없으면 목록만.' },
        all: { type: 'boolean', description: '읽은 것과 남에게 간 것까지 전부 본다. 응답이 커지므로 필요할 때만.' },
      },
    },
  },
  {
    name: 'ax_send',
    description:
      '다른 에이전트에게 쪽지를 보낸다. 레인 배정, 방향 전환, 상대 코드에서 찾은 결함처럼 '
      + '**상대가 알아야 결정이 달라지는 것**을 보내십시오. 급한 것은 쪽지 대신 '
      + 'ax_claim 의 intent 에 한 줄로 적는 편이 빠릅니다(그건 status 에 바로 보입니다). '
      + '쪽지는 고아 브랜치로 바로 갑니다 — 커밋도 MR 도 필요 없습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '받는 사람. 이름도 이메일도 됩니다. 여럿이면 쉼표로 (예: "bob,carol"). 생략하면 모두에게.' },
        subject: { type: 'string', description: '한 줄 제목' },
        body: { type: 'string', description: '본문 (마크다운)' },
      },
      required: ['subject', 'body'],
    },
  },
]

// ── 브리핑 ──────────────────────────────────────────────────────────────────

for (const tool of TOOLS) {
  tool.inputSchema.properties.cwd = {
    type: 'string',
    description: '현재 작업 폴더의 절대 경로. roots 미지원 또는 여러 repo가 열려 있을 때 지정. 생략하면 세션의 작업 repo를 사용한다.',
  }
}

// `SELF` · `REPO` · `isForeign()` 은 파일 맨 위에 있다. 기준은 거기 적어 두었다.

const readFrom = (base, rel) => {
  try { return fs.readFileSync(path.join(base, rel), 'utf8') } catch { return null }
}
/** axMap 자신의 파일. 구성 목록처럼 **이 도구에 관한 것**만 여기서 읽는다. */
const readSelf = (rel) => readFrom(SELF, rel)
/** 대상 저장소의 파일. 브리핑의 내용은 원칙적으로 전부 이쪽이어야 한다. */
const readRepo = (rel) => readFrom(REPO, rel)

/** 제목·인용·빈 줄을 건너뛴 첫 문단. 남의 README 를 요약하지 않고 그대로 보여준다. */
function firstPara(text) {
  if (!text) return null
  const lines = text.split(/\r?\n/)
  const buf = []
  for (const raw of lines) {
    const l = raw.trim()
    if (!buf.length && (!l || l.startsWith('#') || l.startsWith('>') || l.startsWith('---'))) continue
    if (!l) break
    buf.push(l)
    if (buf.length >= 4) break
  }
  return buf.length ? buf.join(' ') : null
}

/** `docs/` 안에 무엇이 있는지. 목록일 뿐 지도가 아니다 — 지도는 지어내지 않는다. */
function docsList(base) {
  try {
    return fs.readdirSync(path.join(base, 'docs'))
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .sort()
  } catch { return [] }
}

/**
 * 파일 맨 위 블록 주석의 **첫 문장**.
 *
 * 🔴 지도를 여기에 적어 두지 않고 **파일에서 긁어오는** 이유.
 *
 * 손으로 적은 지도는 코드보다 먼저 낡는다. 그리고 낡은 지도는 없는 지도보다
 * 나쁘다 — 새로 들어온 에이전트가 그것을 믿고 엉뚱한 파일을 고친다.
 * 각 파일의 머리말을 읽어 오면 **파일을 고친 사람이 지도도 고친 것**이 된다.
 * 그래서 이 저장소의 규칙("주석은 왜를 쓴다")이 곧 인수인계 문서가 된다.
 */
function gist(rel) {
  const src = readSelf(rel)
  if (src === null) return '(파일 없음 — 지도가 낡았습니다)'
  const m = src.match(/\/\*\*([\s\S]*?)\*\//)
  if (!m) return '(머리말 주석 없음)'
  for (const raw of m[1].split('\n')) {
    const line = raw.replace(/^\s*\*\s?/, '').trim()
    if (line) return line
  }
  return '(머리말이 비어 있음)'
}

/**
 * 경로만 여기 적고 설명은 파일에서 가져온다.
 * 경로는 거의 안 바뀌고 설명은 자주 바뀌므로, 낡을 수 있는 쪽을 자동화한다.
 */
const COMPONENTS = [
  ['선점 판정', 'src/protocol.mjs'],
  ['불변식 검사', 'src/invariants.mjs'],
  ['CLI · Git · 훅', 'bin/axmap.mjs'],
  ['MCP 서버', 'mcp/server.mjs'],
  ['AI CLI 탐지', 'src/agentcli.mjs'],
  ['로컬 작업 요청', 'src/bridge.mjs'],
  ['터미널 세션 연결', 'src/terminal-bridge.mjs'],
  ['설치·설정', 'tools/setup.mjs'],
  ['쪽지함', 'tools/bus.mjs'],
]

/** axMap 자신을 겨눴을 때만 자체 구성 목록을 보여준다. */
function briefSelf() {
  const out = []
  out.push('# axMap — 새로 들어온 에이전트를 위한 브리핑')
  out.push('')
  out.push('이 브리핑은 **파일에서 긁어온 것**이라 코드와 함께 갱신된다.')
  out.push('낡았다고 느껴지면 그것은 브리핑이 아니라 그 파일의 머리말이 낡은 것이다.')
  out.push('')

  out.push('## 먼저 읽을 것')
  out.push('')
  out.push('| | |')
  out.push('|---|---|')
  out.push('| 작업 규칙 (필수) | `CLAUDE.md` — **파일을 고치기 전에 `claim` 이 먼저다** |')
  out.push('| 규격 | `docs/SPEC.md` — 명령과 claim 의미론. 코드보다 이쪽이 먼저다 |')
  out.push('| 제품 방향과 버린 대안 | `docs/DECISIONS.md` |')
  /**
   * 🔴 열려 있는 갈래는 코드에서 읽어낼 수 없다. DECISIONS 는 "이미 정한 것" 이라
   * "왜 아직 안 했나" 와 "다음 한 걸음" 이 어디에도 안 남는다. 그걸 THREADS 가 든다.
   * 이어받는 사람이 제일 먼저 묻는 것이 그것이므로 규격보다 앞이 아니라 바로 뒤에 둔다.
   */
  out.push('| **열려 있는 갈래** | `docs/THREADS.md` — 상태 · 다음 한 걸음 |')
  // 번호를 여기 적지 않는다. 늘릴 때마다 이 줄이 낡는다 — 실제로 I8 을 넣고 놓쳤다.
  out.push('| 지켜야 할 성질 | `docs/INVARIANTS.md` |')
  out.push('| 왜 파서인가 | `docs/EXPERIMENT.md` |')
  out.push('')

  out.push('## 주요 구성')
  out.push('')
  for (const [role, rel] of COMPONENTS) out.push(`- **${role}** — \`${rel}\`\n  ${gist(rel)}`)
  out.push('')
  return out
}

/**
 * 남의 저장소에 붙었을 때.
 *
 * 🔴 여기서 **axMap 의 문서를 대신 보여주지 않는다.**
 *
 * 예전에는 브리핑이 통째로 `readSelf` 였다. 그래서 남의 프로젝트에 붙여도
 * `src/protocol.mjs` · `src/bridge.mjs` 같은 **axMap 의 주요 구성**이 나왔고,
 * 받는 쪽에는 자기 저장소를 설명하는 것처럼 보인다.
 *
 * 이 저장소는 "낡은 지도는 없는 지도보다 나쁘다" 고 적어 두었는데,
 * 남의 지도를 자기 지도인 양 주는 것은 그보다 한 단계 더 나쁘다.
 * 낡은 지도는 언젠가 맞았기라도 하다.
 *
 * 그래서 대상에 문서가 없으면 **없다고 말하고 끝낸다.** 채워 넣지 않는다.
 * 구성 목록을 추측해서 만들지 않는다.
 */
function briefForeign() {
  const out = []
  out.push(`# ${path.basename(REPO)} — axMap 브리핑`)
  out.push('')
  out.push('⚠️ 아래는 전부 **이 대상 저장소에서 읽은 것**이다. axMap 자신의 문서가 아니다.')
  out.push('axMap 은 선점 도구로만 붙어 있고, 이 저장소의 코드에 관해서는 아무것도 모른다.')
  out.push('')

  out.push('## 이 저장소가 스스로 말하는 것')
  out.push('')
  const claude = readRepo('CLAUDE.md')
  out.push(claude
    ? `- \`CLAUDE.md\` **있음 — 가장 먼저 읽는다.** ${firstPara(claude) ?? ''}`.trimEnd()
    : '- `CLAUDE.md` 없음 — 이 저장소에는 에이전트가 지킬 규칙이 아직 적혀 있지 않다')
  const readme = readRepo('README.md')
  if (readme) out.push(`- \`README.md\` — ${firstPara(readme) ?? '(첫 문단이 비어 있다)'}`)
  const docs = docsList(REPO)
  out.push(docs.length
    ? `- \`docs/\` — ${docs.map((d) => `\`${d}\``).join(' · ')}`
    : '- `docs/` 없음')
  out.push('')
  return out
}

/** 제목만 뽑는다. 어느 저장소를 읽든 규칙은 같다. */
const headings = (text, re) => (text ? [...text.matchAll(re)].map((m) => m[1].trim()) : [])

function brief() {
  const read = isForeign() ? readRepo : readSelf
  const out = isForeign() ? briefForeign() : briefSelf()

  const decs = headings(read('docs/DECISIONS.md'), /^## (D\d+ · .+)$/gm)
  if (decs.length) {
    out.push('## 이미 내려진 결정 (다시 논의하지 말 것 — 뒤집으려면 근거를 새로 대야 한다)')
    out.push('')
    for (const t of decs) out.push(`- ${t}`)
    out.push('')
  }

  const invs = headings(read('docs/INVARIANTS.md'), /^#{2,3} *(I\d+[^\n]*)$/gm)
  if (invs.length) {
    out.push('## 불변식')
    out.push('')
    for (const t of invs) out.push(`- ${t}`)
    out.push('')
  }

  /**
   * 🔴 검증 목록을 `package.json` 에서 뽑지 않는다.
   *
   * scripts 에는 검사와 설치 같은 실행 명령이 섞일 수 있다.
   * 전부 나열하면 새 에이전트가 실행만 해 놓고 "검증했다" 고 여긴다.
   * **무엇이 통과해야 하는지를 정한 곳은 규칙 문서의 「검증」 절**이므로
   * 거기서 읽어 온다. 규격이 진실이고 목록은 그 사본이다.
   *
   * 🔴 **제목 글자에 그대로 묶지 않는다 (2026-09-11).**
   *    예전에는 `'## 검증'` 이라는 **문자열을 그대로** 찾았다. 그런데 규칙 문서가
   *    번호 절(`# 3. 검증`)로 바뀌자 이 줄이 아무것도 못 찾았고, 브리핑에서 검증
   *    목록이 **조용히 사라졌다.** 문서 모양을 바꿀 때마다 코드가 깨지면 둘 중
   *    하나는 안 고쳐진다 — 그래서 제목 단계와 번호를 안 따지게 한다.
   *
   * 🔴 **자리가 옮겨갈 수 있다.** `CLAUDE.md` 가 색인 한 장이 되면서 본문은
   *    `rule/` 로 나갔다. 그래서 색인에 없으면 규칙 본문에서 이어 찾는다.
   *    못 찾으면 **빈 목록**이 되고, 빈 목록은 위 블록이 통째로 안 나간다 —
   *    지어낸 명령을 내보내는 것보다 아무 말도 안 하는 편이 낫다.
   */
  const SECTION = /^#{1,6}\s*[0-9.]*\s*검증/m
  const pickFence = (text) => {
    if (!text) return null
    const m = SECTION.exec(text)
    if (!m) return null
    return text.slice(m.index).match(/```[a-z]*\n([\s\S]*?)```/)
  }
  const fence =
    pickFence(read('CLAUDE.md')) ??
    pickFence(read('rule/03-검증.md')) ??
    null
  const cmds = fence ? fence[1].split('\n').map((l) => l.trim()).filter((l) => l.startsWith('npm ')) : []
  if (cmds.length) {
    out.push('## 끝내기 전에 전부 통과해야 하는 것')
    out.push('')
    for (const c of cmds) out.push(`- \`${c}\``)
    out.push('')
  }

  out.push('장부는 선점·조회 시 자동으로 준비한다. 별도 `ax_init` 호출은 필요 없다.')
  out.push('')

  out.push('## 이 도구를 쓰는 순서')
  out.push('')
  out.push('1. `ax_status` — 지금 누가 무엇을 잡고 있나')
  out.push('2. `ax_check` — 내가 건드릴 곳이 비었나')
  out.push('3. `ax_claim` — 좁게 잡는다. 거부(exit 2)되면 재시도하지 말고 방향을 바꾼다')
  out.push('4. 작업 → `ax_renew` (길어지면) → `ax_release` (끝나면 즉시)')
  out.push('')
  out.push(`대상 저장소: \`${REPO}\``)
  out.push(`이 도구의 저장소: \`${SELF}\``)
  return out.join('\n')
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 대상 따라가기
// ---------------------------------------------------------------------------

/**
 * 이 저장소에 잡아둔 것을 **전부** 반납한다.
 *
 * `cwd` 를 인자로 받는 것이 요점이다 — 대상이 옮겨가는 길목에서 부르므로
 * 지금 `REPO` 가 아니라 **떠나는 저장소**를 겨눠야 한다.
 */
function releaseAllIn(dir) {
  const r = spawnSync(process.execPath, [CLI, 'release', '--if-present'], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, AXMAP_AGENT: AGENT, AXMAP_ACTOR: ACTOR, AXMAP_SESSION: SESSION, AXMAP_SKIP_PROFILE_SYNC: '1' },
  })
  return {
    code: r.status ?? 1,
    out: [(r.stdout ?? '').trim(), (r.stderr ?? '').trim()].filter(Boolean).join('\n'),
  }
}

/**
 * 이 세션의 클라이언트 작업 폴더가 바뀌면 따라간다.
 *
 * 🔴 **떠나기 전에 잡아둔 것을 전부 반납한다.**
 *
 *    안 하면 그 잠금을 풀 창구가 사라진다. `ax_release` 는 언제나 "지금 대상" 을
 *    겨누므로, 대상이 옮겨간 뒤에는 이전 저장소의 claim 을 아무도 못 푼다.
 *    TTL(기본 45분)이 지날 때까지 팀원이 그 파일을 잡지 못하고, 정작 잡고 있는
 *    사람은 이미 그 작업을 떠난 뒤다. **잠금이 조용히 남는 것 — 이 도구가 막으려는
 *    사고가 정확히 그것이다.**
 *
 *    사람이 폴더를 바꿨다는 것은 이전 작업을 떠났다는 뜻이므로 반납이 맞다.
 *    다시 필요하면 claim 한 번이면 된다. 남이 45분을 기다리는 것보다 싸다.
 *
 * 반납 실패를 **숨기지 않는다.** 조용히 넘어가면 위의 상황이 그대로 일어나는데
 * 아무도 그것을 모른다.
 */
function syncRepo(args) {
  const next = resolveRepo(args)
  if (next === REPO) return null
  const from = REPO
  const r = releaseAllIn(from)
  REPO = next
  // exit 5 = 잡고 있던 것이 없었다. 실패가 아니라 반납할 게 없었다는 뜻이다.
  return { from, to: next, released: r.code === 0, nothing: r.code === 5, out: r.out }
}

/** 따라간 사실을 에이전트에게 알린다. */
function switchNotice(s) {
  const head = `⟳ 대상 저장소가 바뀌었습니다: ${s.from} → ${s.to}`
  if (s.nothing) return `${head}
(이전 저장소에 잡아둔 것은 없었습니다.)`
  if (s.released) return `${head}
이전 저장소에 잡아둔 것은 **전부 반납했습니다.**`
  return `${head}
🔴 이전 저장소의 반납에 실패했습니다. 그 claim 은 TTL 이 지날 때까지 남습니다:
${s.out}`
}

/**
 * 도구 하나를 부른다. **부를 때마다 대상이 바뀌었는지 먼저 본다.**
 *
 * 🔴 사람 눈에는 안 보이게 하되 **에이전트에게는 보이게** 한다.
 *
 *    완전히 조용히 바꾸면, 에이전트가 방금 `ax_status` 로 본 장부와 지금
 *    `ax_claim` 이 쓰는 장부가 서로 다른 저장소일 수 있다. 그러면 에이전트는
 *    자기가 본 것을 근거로 확신 있게 틀린 답을 만든다 — 사람이 못 잡는 종류다.
 */
function callTool(name, args = {}) {
  let switched
  try { switched = syncRepo(args) } catch (e) { return { ok: false, text: e.message } }
  const r = dispatch(name, args)
  return switched ? { ...r, text: `${switchNotice(switched)}

${r.text}` } : r
}

function dispatch(name, args = {}) {
  const paths = Array.isArray(args.paths) ? args.paths.map(String) : []

  switch (name) {
    case 'ax_sessions': return bridge(['sessions'])
    case 'ax_dispatch': return bridge(['send', '--to', args.to], args.prompt)
    case 'ax_result': return bridge(['result', args.id])
    case 'ax_chat': return bridge(['chat', '--background', '--left', args.left, '--right', args.right,
      ...['maxTurns', 'maxTokens', 'maxMessageChars'].flatMap(key => args[key] === undefined ? [] :
        [`--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, String(args[key])])], args.prompt)
    case 'ax_dialogue': return bridge(['dialogue', args.id])
    case 'ax_chat_stop': return bridge(['stop', args.id])
    case 'ax_brief':
      return { ok: true, text: brief() }
    case 'ax_init': {
      const r = cli(['init', ...(args.remote ? ['--remote', String(args.remote)] : [])])
      return {
        ok: r.code === 0,
        text: r.code === 0
          ? `${r.out}\n이제 ax_claim 을 부를 수 있습니다.`
          : `장부를 만들지 못했습니다 (exit ${r.code})\n${r.out}`,
      }
    }
    case 'ax_claim': {
      if (!paths.length) return { ok: false, text: 'paths 가 비어 있습니다.' }
      const a = ['claim', ...paths, '--ttl', TTL, '--actor', ACTOR]
      if (args.intent) a.push('--intent', String(args.intent))
      if (args.task) a.push('--task', String(args.task))
      const r = cli(a)
      return {
        ok: r.code === 0,
        text:
          r.code === 0
            ? `선언 완료. 이 경로들만 수정하십시오.\n${r.out}`
            : r.code === 2
              ? `거부되었습니다. 재시도하지 말고 다른 작업으로 옮기십시오.\n${r.out}`
              // "장부가 없습니다" 를 여기서 따로 다루지 않는다. 그 안내는
              // `withInitHint` 가 길목에서 붙인다 — 다섯 군데가 따로 낡지 않게.
              : `실패 (exit ${r.code})\n${r.out}`,
      }
    }
    case 'ax_inbox': {
      // 🔴 받는 사람은 `AGENT` 다. `ACTOR` 가 아니다.
      //
      //    둘 다 문자열이라 자리를 바꿔 넣어도 아무도 못 막는다. 그런데 뜻이 다르다 —
      //    `AGENT` 는 **장부에 적히는 이름**(git config user.name, 예: `bob`)이고
      //    `ACTOR` 는 `.mcp.json` 이 넣는 **역할**(`agent`)이다. 사람 이름이 아니다.
      //
      //    여기에 `ACTOR` 가 들어가 있어서 서버는 `--to agent` 를 물었고, 그런 이름의
      //    수신자는 없으므로 **어떤 쪽지도 찾지 못했다.** 2026-08-26 팀 저장소에서
      //    실제 팀원 쪽지가 이 버그로 묻혀 있었다.
      //
      //    보내기는 멀쩡했던 것이 이 버그를 오래 살렸다 — `ax_send` 는 `AGENT` 를
      //    넘긴다. 보낸 쪽은 성공을 보고 받는 쪽은 "쪽지 없음" 을 본다. 양쪽 다
      //    오류가 없으므로 아무도 실패를 보지 못한다.
      // 🔴 `--unread` 가 없으면 쪽지가 쌓인 만큼 응답이 커진다. 여기는 사람이 보는
      //    화면이 아니라 **에이전트의 컨텍스트**라, 스크롤로 멈출 사람이 없다.
      //    2026-08-28 팀 저장소 실측: 42건에 7,463자(≈3,380토큰)였고 상한이 없었다.
      //    `/ax-start` 한 번의 75% 가 이 한 줄에서 나왔다.
      //
      //    `--unread` 는 `list` 안에서 `id > seen` 으로 거르고 **보여준 것을 스스로
      //    찍는다** (bus.mjs 「그린 쪽이, 그린 것만 찍는다」). 아래의 `seen` 호출과
      //    겹치지만 `markSeen` 은 뒤로 가지 않으므로 결과가 같다.
      //
      //    전부 보려면 `all: true` 가 이미 있다 — 그쪽은 거르지도 찍지도 않는다.
      const a = args.id ? ['read', String(args.id)] : ['list', ...(args.all ? ['--all'] : ['--mine', '--unread'])]
      const r = bus(a)

      // 🔴 여기도 **낸 것만 찍는다.** 목록을 자르지 않으므로 낸 것 전부다.
      //    이 자리가 비어 있으면 쪽지함을 열어도 배너가 안 줄어든다 — 사람이
      //    읽었는데 도구는 안 읽었다고 말하는 상태가 되고, 그러면 배너는 배경이 된다.
      //
      //    `all` 일 때는 안 찍는다. 남에게 간 쪽지까지 섞여 있어서 그중 가장 큰
      //    id 로 찍으면 **나에게 온 안 읽은 쪽지가 화면에 뜬 적 없이 묻힌다.**
      if (r.code === 0 && !args.id && !args.all) {
        const ids = busRows(r.out).map((s) => s.id).filter(Boolean)
        if (ids.length) bus(['seen', '--mine', ...ids])
      }
      return {
        ok: r.code === 0,
        // 🔴 "쪽지 없음" 을 실패로 내지 않는다. 없는 것과 못 읽은 것은 다르다.
        text: r.code === 0 ? (r.out.trim() || '쪽지 없음.') : `쪽지함을 읽지 못했습니다.\n${r.out}`,
      }
    }
    case 'ax_send': {
      if (!args.subject || !args.body) return { ok: false, text: 'subject 와 body 가 필요합니다.' }
      const a = ['post', '--subject', String(args.subject)]
      // 여럿에게 한 통을 보낼 수 있다. 문자열로 `"a,b"` 를 줘도, 배열로 줘도 같다 —
      // 같은 내용을 두 번 보내면 답장이 두 갈래로 갈려 대화가 쪼개진다.
      for (const t of (Array.isArray(args.to) ? args.to : (args.to ? [args.to] : []))) {
        if (String(t).trim()) a.push('--to', String(t).trim())
      }
      const r = bus(a, String(args.body))
      return {
        ok: r.code === 0,
        text: r.code === 0 ? r.out : `보내지 못했습니다.\n${r.out}`,
      }
    }
    case 'ax_check': {
      // status 를 읽어 겹침을 계산한다. 장부를 바꾸지 않는다.
      const r = cli(['status', '--json'])
      if (r.code !== 0) return { ok: false, text: r.out }

      // 🔴 **못 읽은 것을 비어 있는 것으로 답하지 않는다.**
      //
      //    예전에는 파싱이 실패하면 `{ active: [] }` 를 그대로 들고 내려갔다.
      //    그러면 겹침이 0건이 되어 **"겹치지 않습니다. claim 해도 됩니다"** 가
      //    나간다. 장부를 한 글자도 못 읽은 상태에서 통과를 내주는 것이다.
      //
      //    이 도구는 판정을 못 했을 때 막아야 한다. 못 읽었는데 무엇을 claim 할지
      //    어떻게 아는가 — 답은 "모른다" 이고, 모르는 것의 이름은 "안 겹침" 이 아니다.
      //
      //    🔴 `out` 이 아니라 `stdout` 을 판다. 합친 것을 파싱하면 경고 한 줄에
      //       판정이 무너진다 — 그 사고가 실제로 이 자리에서 났다. `cli` 주석에
      //       무엇이 붙어서 깨졌는지 적어 두었다.
      let live = null
      try { live = JSON.parse(r.stdout) } catch { /* 바로 아래에서 막는다 */ }
      if (!live || !Array.isArray(live.active)) {
        return {
          ok: false,
          text: '장부를 읽지 못했습니다 — 겹치는지 **판정할 수 없습니다.**\n'
            + 'claim 하지 마십시오. 못 읽은 것과 비어 있는 것은 다릅니다.\n\n'
            + `받은 것:\n${r.out}`,
        }
      }

      const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '')
      const hit = []
      for (const c of live.active) {
        if (c.agent === AGENT) continue
        for (const want of paths.map(norm)) {
          for (const held of (c.paths ?? []).map(norm)) {
            if (want === held || want.startsWith(held + '/') || held.startsWith(want + '/')) {
              hit.push(`${want} ← ${c.agent} (${c.intent ?? c.task ?? '이유 미기재'}) 가 ${held} 를 점유 중`)
            }
          }
        }
      }
      // 경고는 버리지 않는다. 판정에서 뺐을 뿐 사람은 봐야 한다 —
      // "원격이 없어 남의 claim 을 못 본다" 는 판정 자체의 한계를 말하고 있다.
      const note = r.stderr ? `\n\n${r.stderr}` : ''
      return {
        ok: true,
        text: (hit.length ? `겹칩니다:\n${hit.join('\n')}` : '겹치지 않습니다. claim 해도 됩니다.') + note,
      }
    }
    case 'ax_status': {
      const r = cli(['status'])
      return { ok: r.code === 0, text: r.out || '장부가 비어 있습니다.' }
    }
    case 'ax_release': {
      const r = cli(['release', ...paths])
      return { ok: r.code === 0, text: r.out }
    }
    case 'ax_renew': {
      const r = cli(['renew', '--ttl', TTL])
      return { ok: r.code === 0, text: r.out }
    }
    default:
      return { ok: false, text: `알 수 없는 도구: ${name}` }
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function refreshRoots() {
  const generation = ++rootsGeneration
  const id = `axmap-roots-${++rootRequestId}`
  rootsTask = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRoots.delete(id)
      if (generation === rootsGeneration) rootsError = 'roots/list 응답 시간 초과'
      resolve()
    }, 5000)
    pendingRoots.set(id, (msg) => {
      clearTimeout(timer)
      if (generation === rootsGeneration) {
        const roots = msg.result?.roots
        rootsError = msg.error?.message || (!Array.isArray(roots) ? '잘못된 roots/list 응답' : null)
        clientRoots = Array.isArray(roots) ? roots : null
      }
      resolve()
    })
    send({ jsonrpc: '2.0', id, method: 'roots/list' })
  })
}

async function handle(req) {
  const { id, method, params } = req

  if (method === 'initialize') {
    rootsSupported = !!params?.capabilities?.roots
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'axmap', version: VERSION },
    }
  }
  if (method === 'tools/list') return { tools: TOOLS }
  if (method === 'tools/call') {
    if (rootsSupported && !process.env.AXMAP_REPO) {
      if (!rootsTask || rootsError) refreshRoots()
      // A change notification may replace the task while the previous reply arrives.
      let task
      do { task = rootsTask; await task } while (task !== rootsTask)
    }
    const r = callTool(params?.name, params?.arguments ?? {})
    const localBridge = BRIDGE_TOOLS.has(params?.name)
    const warning = r.ok && !localBridge ? syncConfiguredProfile(REPO, BUS, { ...process.env, AXMAP_AGENT: AGENT }) : ''
    return { content: [{ type: 'text', text: r.text + (warning ? '\n' + warning : '') + (r.ok && !localBridge ? unreadBanner(params?.name, r.text) : '') }], isError: !r.ok }
  }
  if (method === 'ping') return {}
  return null // 알림이거나 지원하지 않는 메서드
}

const rl = readline.createInterface({ input: process.stdin })
// Execute tools in order, but keep reading client replies while a tool awaits roots.
let requests = Promise.resolve()
rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return
  let req
  try {
    req = JSON.parse(s)
  } catch {
    return
  }
  if (!req || typeof req !== 'object') return
  if (!req.method) {
    const done = pendingRoots.get(req.id)
    if (done) { pendingRoots.delete(req.id); done(req) }
    return
  }
  if (req.id === undefined) {
    if (rootsSupported && !process.env.AXMAP_REPO &&
      ['notifications/initialized', 'notifications/roots/list_changed'].includes(req.method)) refreshRoots()
    return
  }
  requests = requests.then(async () => {
    try {
      const result = await handle(req)
      if (result === null) {
        send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `지원하지 않는 메서드: ${req.method}` } })
      } else {
        send({ jsonrpc: '2.0', id: req.id, result })
      }
    } catch (e) {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: e.message } })
    }
  })
})

process.stderr.write(`axMap MCP · 저장소 ${REPO} · 에이전트 ${AGENT} (${ACTOR})\n`)
