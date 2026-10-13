#!/usr/bin/env node
/**
 * 이 PC 에 있는 AI CLI 를 찾아 axMap MCP 서버를 **각 CLI 의 설정에 등록**한다.
 *
 *   node axmap/tools/mcp-register.mjs [--dry-run]
 *
 * ── 왜 이 파일이 따로 있나 ────────────────────────────────────────────────
 *
 * MCP 서버 자체(`axmap/mcp/server.mjs`)는 표준 규격(stdio + 줄바꿈 JSON-RPC 2.0)이라
 * **MCP 를 지원하는 클라이언트면 무엇이든 붙는다.** 문제는 "자동으로 붙는 편의" 쪽이다.
 * 저장소에 든 `.mcp.json` 을 스스로 발견해 주는 것은 Claude Code 뿐이고,
 * 나머지 CLI 는 각자의 설정 파일에 손으로 적어야 한다. 그 손을 여기서 대신한다.
 *
 * setup.sh 와 setup.ps1 둘 다 이 파일을 부른다. 셸 두 벌에 같은 로직을 적으면
 * 반드시 한쪽만 고쳐지고, 그 순간 두 OS 의 사용자가 서로 다른 설정을 갖게 된다.
 *
 * ── 🔴 이 파일이 절대 하지 않는 두 가지 ───────────────────────────────────
 *
 * 1. **`AXMAP_AGENT` 를 어떤 설정에도 적지 않는다.**
 *    적는 순간 그 값이 clone 한 모두의 이름이 된다. 장부에는 한 명만 존재하게 되고,
 *    겹침 판정은 자기 claim 을 겹침으로 보지 않으므로 팀 전원이 서로의 영역을
 *    아무 경고 없이 덮어쓴다. 이 저장소가 뿌리뽑은 실패다(axmap/mcp/README.md).
 *    이름은 서버가 `git config user.name` 으로 떨어뜨리게 둔다.
 *
 * 2. **남의 설정 파일을 덮어쓰지 않는다.**
 *    이미 있으면 읽어서 `axmap` 항목만 더하고 나머지는 그대로 쓴다.
 *    파싱이 안 되면 **건드리지 말고** 사람이 붙일 스니펫을 출력한다.
 *    등록에 실패하는 것보다 남의 설정을 깨뜨리는 것이 훨씬 나쁘다 — 앞은 안 붙었다는
 *    것이 바로 보이지만, 뒤는 다른 도구가 조용히 죽고 원인을 못 찾는다.
 *
 * ── 감지는 새로 짜지 않는다 ───────────────────────────────────────────────
 *
 * 어떤 CLI 가 이 PC 에 있는지는 `app/lib/agentcli.mjs` 가 이미 안다(`AGENTS`, `resolveBin`).
 * 거기서 그대로 가져온다. 바이너리 이름이 두 군데에 적히면 한쪽만 낡는다.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AGENTS, resolveBin } from '../app/lib/agentcli.mjs'
import { claudeUserEntry } from '../src/mcpstate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AXMAP_DIR = path.resolve(HERE, '..')          // .../axmap
const SERVER = path.join(AXMAP_DIR, 'mcp', 'server.mjs')
const DRY = process.argv.includes('--dry-run')

const ok = (what, detail) => console.log(`  OK  ${what.padEnd(10)} ${detail}`)
const hm = (what, detail) => console.log(`  ~~  ${what.padEnd(10)} ${detail}`)
const no = (what, detail) => console.log(`  !!  ${what.padEnd(10)} ${detail}`)

/**
 * 모든 CLI 에 똑같이 들어가는 서버 정의.
 *
 * 🔴 `AXMAP_REPO` 를 **일부러 넣지 않는다.**
 *
 * 서버는 `AXMAP_REPO ?? process.cwd()` 로 대상 저장소를 정한다(mcp/server.mjs).
 * 여기서 이 저장소의 절대 경로를 박아 두면 등록은 전역인데 대상은 한 곳으로 고정돼,
 * 다른 저장소를 열었을 때 **엉뚱한 장부에 claim 이 쌓인다** — 아무 오류도 안 나면서.
 * 비워 두면 CLI 가 띄운 작업 폴더가 그대로 대상이 된다.
 *
 * 반대로 `args` 는 반드시 절대 경로다. 이건 "실행할 프로그램" 이라 어느 폴더에서 켜든
 * 같은 곳을 가리켜야 한다. 프로그램은 여기, 데이터는 거기(axmap/mcp/README.md).
 */
const entry = () => ({
  command: 'node',
  args: [SERVER],
  env: { AXMAP_ACTOR: 'agent', AXMAP_TTL: '45m' },
})

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ── Claude Code ────────────────────────────────────────────────────────────
//
// 🔴 **2026-08-31 — 여기서 전역 등록을 하도록 바꿨다.** 그전에는 저장소의
//    `.mcp.json` 이 있는지 확인만 하고 아무것도 하지 않았다.
//
//    그래서 Claude 만 **저장소에 파일을 커밋해야** 붙는 유일한 CLI 였다. npm 으로
//    설치해 남의 저장소에서 쓰는 사람은 그 파일을 넣을 권한이 없을 수도 있고,
//    넣더라도 "도구는 나가고 데이터만 남는다" 는 이 저장소의 방침에 어긋난다.
//    `mcp/install.ps1` 은 이미 전역 등록을 하고 있었다 — 설치 경로 둘이 서로 다르게
//    굴어서, 둘 다 돌린 PC 에는 **범위가 충돌하는 항목**이 남았다(claude mcp list 가
//    "Conflicting scopes" 로 알려 준다). 두 경로를 같은 동작으로 맞춘다.
//
// 설정: `~/.claude.json` 의 최상위 `mcpServers` (user 범위)
// 형식: `claude mcp add <이름> -s user [-e K=V] -- <명령> <인수...>`
//
// 🔴 `~/.claude.json` 을 **우리가 쓰지 않는다.** 그 파일에는 Claude Code 의 세션
//    상태까지 들어 있어 읽고 다시 쓰는 순간 남의 것을 깨뜨릴 위험이 생긴다.
//    있는지 **읽는 것만** 우리가 하고, 쓰는 일은 claude 자신에게 맡긴다 —
//    doCodex 와 같은 태도다.

// `claudeUserEntry` 는 `src/mcpstate.mjs` 에 있다 (위 import).
// 여기 두었다가 doctor 가 같은 판정을 한 벌 더 쓰게 됐고, 둘이 어긋나면
// "등록기는 넣었다는데 doctor 는 없다고 한다" 가 된다. 판정은 한 곳에만 둔다.

/**
 * 이미 쓸 만한 항목인가.
 *
 * env 는 **우리가 넣는 키만** 본다. 남이 `AXMAP_AGENT` 를 손으로 넣어 뒀을 수 있고,
 * 그건 그 사람의 이름이라 지우면 안 된다 (install.ps1 이 실제로 넣는다).
 */
const sameEntry = (cur, want) =>
  !!cur && cur.command === want.command &&
  JSON.stringify(cur.args || []) === JSON.stringify(want.args) &&
  Object.entries(want.env).every(([k, v]) => ((cur.env || {})[k] === v))

function doClaude(bin, repo) {
  const run = (args) => spawnSync(bin, args, { encoding: 'utf8', windowsHide: true })
  const want = entry()

  const cur = claudeUserEntry()
  if (cur === undefined) {
    no('claude', '~/.claude.json 을 읽지 못했습니다 — 건드리지 않았습니다')
    snippetClaude()
    return
  }
  if (sameEntry(cur, want)) { ok('claude', '이미 등록돼 있습니다 (user 범위)'); return }

  // 문서에 있다고 믿고 부르지 않는다 — 먼저 물어본다. doCodex 와 같다.
  const help = run(['mcp', 'add', '--help'])
  if (help.status !== 0 || !/--scope/.test(`${help.stdout}${help.stderr}`)) {
    hm('claude', "'claude mcp add -s user' 를 확인하지 못했습니다 — 손으로 넣으세요")
    snippetClaude()
    return
  }

  const add = ['mcp', 'add', 'axmap', '-s', 'user',
    ...Object.entries(want.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '--', want.command, ...want.args]

  if (DRY) {
    hm('claude', `(dry-run) ${cur ? 'claude mcp remove axmap -s user 뒤 ' : ''}claude ${add.join(' ')}`)
    return
  }

  // 자리를 비워야 add 가 덮어쓴다. 지우는 것은 **우리 이름(`axmap`)의 항목뿐**이다.
  if (cur) run(['mcp', 'remove', 'axmap', '-s', 'user'])

  const r = run(add)
  if (r.status === 0 && sameEntry(claudeUserEntry(), want)) {
    ok('claude', 'user 범위에 등록했습니다 — 어느 폴더에서 열어도 붙습니다')
  } else {
    no('claude', `claude mcp add 가 실패했습니다 (${(r.stderr || r.stdout || '').trim().split('\n')[0] || `exit ${r.status}`})`)
    snippetClaude()
  }

  // 저장소에 `.mcp.json` 이 남아 있으면 **그쪽이 이긴다.** 조용히 두면 방금 등록한
  // 것이 왜 안 쓰이는지 아무도 못 찾는다.
  const f = path.join(repo, '.mcp.json')
  if (fs.existsSync(f)) hm('claude', `저장소의 .mcp.json 이 먼저 쓰입니다 (같은 서버라면 문제 없습니다): ${f}`)
}

/** 손으로 넣을 한 줄. 경로에 공백이 있을 수 있어 겹따옴표로 감싼다. */
function snippetClaude() {
  console.log('')
  console.log('      아래 한 줄을 치세요:')
  console.log('')
  console.log(`        claude mcp add axmap -s user -e AXMAP_ACTOR=agent -e AXMAP_TTL=45m -- node "${SERVER}"`)
  console.log('')
  console.log('      AXMAP_AGENT 는 적지 마세요 — 여러 사람이 같은 이름이 되면')
  console.log('      서로의 선점을 겹침으로 보지 못합니다.')
  console.log('')
}

// ── Antigravity CLI (agy) ──────────────────────────────────────────────────
//
// 설정: ~/.gemini/config/mcp_config.json  (전역)
// 형식: .mcp.json 과 같은 { "mcpServers": { ... } }
//
// ✅ 이 PC 의 agy 1.1.10 으로 **실물 확인했다.**
//    - 전역 파일에 적으면 도구가 뜬다 (헤드리스에서 "mcp 권한이 필요하다" 까지 도달)
//    - 저장소의 `.mcp.json` 은 **읽지 않는다** (같은 조건에서 도구가 아예 안 뜬다)
//    - 서버를 **작업 폴더를 cwd 로** 띄운다 (상대 경로 `./axmap/mcp/server.mjs` 가 풀렸다)
//    - 일부러 없는 파일을 가리키면 도구가 사라진다 — 위 결과가 캐시가 아님을 확인한 대조군
//
// ⚠️ 공식 문서가 말하는 작업 폴더용 `.agents/mcp_config.json` 은 **CLI 에서는 안 먹었다.**
//    IDE 쪽 경로로 보인다. 그래서 여기서는 전역 파일만 건드린다.
function doAgy() {
  const f = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json')
  mergeJson('agy', f)
}

/**
 * `{ mcpServers: {...} }` 꼴의 JSON 설정에 `axmap` 항목만 더한다.
 *
 * 파일이 없거나 **비어 있으면** 새로 쓴다. 빈 파일은 "아직 아무것도 안 적혔다" 이지
 * "내가 못 읽는 내용이 들어 있다" 가 아니다 — 실제로 agy 는 설치할 때 0바이트 파일을
 * 만들어 둔다. 이걸 파싱 실패로 취급하면 정상 설치가 전부 수동 안내로 떨어진다.
 */
function mergeJson(label, file) {
  const want = entry()
  let cfg = null

  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8')
    if (raw.trim() === '') {
      cfg = {}
    } else {
      try { cfg = JSON.parse(raw) } catch { cfg = null }
      if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
        // 🔴 여기서 덮어쓰지 않는다. 사람이 쓴 설정이 들어 있는데 우리가 못 읽는 것뿐일
        //    수도 있다. 못 읽는 것을 지우는 것은 고치는 게 아니라 부수는 것이다.
        no(label, `설정을 읽지 못했습니다 — 건드리지 않았습니다: ${file}`)
        snippetJson()
        return
      }
    }
  } else {
    cfg = {}
  }

  if (cfg.mcpServers != null && (typeof cfg.mcpServers !== 'object' || Array.isArray(cfg.mcpServers))) {
    no(label, `mcpServers 가 객체가 아닙니다 — 건드리지 않았습니다: ${file}`)
    snippetJson()
    return
  }

  const servers = cfg.mcpServers ?? {}
  if (same(servers.axmap, want)) { ok(label, `이미 등록돼 있습니다: ${file}`); return }

  const had = servers.axmap !== undefined
  servers.axmap = want
  cfg.mcpServers = servers

  if (DRY) { hm(label, `(dry-run) ${had ? '갱신' : '추가'}했을 파일: ${file}`); return }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
    ok(label, `${had ? '갱신' : '등록'}했습니다: ${file}`)
  } catch (e) {
    no(label, `쓰지 못했습니다 (${e.message}): ${file}`)
    snippetJson()
  }
}

function snippetJson() {
  console.log('')
  console.log('      아래를 그 파일의 "mcpServers" 안에 직접 넣으세요:')
  console.log('')
  for (const l of JSON.stringify({ axmap: entry() }, null, 2).split('\n')) console.log(`        ${l}`)
  console.log('')
}

// ── Codex CLI ──────────────────────────────────────────────────────────────
//
// 설정: ~/.codex/config.toml  (전역) / 신뢰된 프로젝트의 .codex/config.toml
// 형식: TOML — [mcp_servers.<이름>] + [mcp_servers.<이름>.env]
//
// ⚠️ **이 PC 에 codex 가 없어 실물로 확인하지 못했다.** 아래는 공식 문서
//    (learn.chatgpt.com/docs/extend/mcp?surface=cli) 에 적힌 것을 그대로 따른 것이다.
//
// 그래서 문서에 적힌 명령을 **있다고 가정하고 부르지 않는다.** 먼저 `codex mcp --help`
// 로 그 하위 명령이 실제로 있는지 물어보고, 있을 때만 `codex mcp add` 를 부른다.
// 없으면 TOML 스니펫을 찍고 끝낸다.
//
// 🔴 TOML 을 직접 파싱하지 않는다. 파서를 새로 짜는 것은 이 저장소의 "의존성 없음" 과
//    "판정을 복잡하게 만들지 않는다" 에 둘 다 어긋나고, 어설픈 파서가 남의 config.toml 을
//    깨뜨리는 것이 이 작업에서 나올 수 있는 최악의 결과다. 쓰는 일은 codex 자신에게 맡긴다.
function doCodex(bin) {
  const run = (args) => spawnSync(bin, args, { encoding: 'utf8', windowsHide: true })

  const help = run(['mcp', '--help'])
  if (help.status !== 0 || !/\badd\b/.test(`${help.stdout}${help.stderr}`)) {
    hm('codex', "'codex mcp add' 를 확인하지 못했습니다 — 손으로 넣으세요")
    snippetToml()
    return
  }

  // 이미 들어 있으면 다시 넣지 않는다. setup 은 몇 번을 돌려도 안전해야 한다.
  const list = run(['mcp', 'list'])
  if (list.status === 0 && /\baxmap\b/.test(`${list.stdout}`)) {
    ok('codex', `이미 등록돼 있습니다 (codex mcp list)`)
    return
  }

  const add = ['mcp', 'add', 'axmap', '--env', 'AXMAP_ACTOR=agent', '--env', 'AXMAP_TTL=45m', '--', 'node', SERVER]
  if (DRY) { hm('codex', `(dry-run) codex ${add.join(' ')}`); return }

  const r = run(add)
  if (r.status === 0) ok('codex', 'codex mcp add 로 등록했습니다')
  else {
    no('codex', `codex mcp add 가 실패했습니다 (${(r.stderr || r.stdout || '').trim().split('\n')[0] || `exit ${r.status}`})`)
    snippetToml()
  }
}

/**
 * TOML 스니펫.
 *
 * 경로에 홑따옴표를 쓴다(TOML 의 literal string). 윈도우 경로의 역슬래시가
 * 이스케이프로 먹히지 않게 하기 위해서다 — 겹따옴표로 적으면 `C:\Users` 의 `\U` 가
 * 유니코드 이스케이프로 해석돼 파일이 아예 안 읽힌다.
 */
function snippetToml() {
  console.log('')
  console.log('      ~/.codex/config.toml 에 아래를 붙여 넣으세요:')
  console.log('')
  for (const l of [
    '[mcp_servers.axmap]',
    'command = "node"',
    `args = ['${SERVER}']`,
    '',
    '[mcp_servers.axmap.env]',
    'AXMAP_ACTOR = "agent"',
    'AXMAP_TTL = "45m"',
  ]) console.log(`        ${l}`)
  console.log('')
  console.log('      AXMAP_AGENT 는 적지 마세요 — 여러 사람이 같은 이름이 되면')
  console.log('      서로의 선점을 겹침으로 보지 못합니다.')
  console.log('')
}

// ── 본체 ───────────────────────────────────────────────────────────────────

function main() {
  const repo = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true })
  const root = repo.status === 0 ? path.resolve(repo.stdout.trim()) : path.resolve(AXMAP_DIR, '..')

  console.log('')
  console.log('AI CLI 에 axmap 을 등록합니다' + (DRY ? '  (dry-run — 아무것도 쓰지 않습니다)' : ''))
  console.log(`  서버: ${SERVER}`)
  console.log('')

  if (!fs.existsSync(SERVER)) {
    no('서버', `파일이 없습니다: ${SERVER}`)
    return 0
  }

  // 감지는 agentcli.mjs 가 아는 바이너리 이름을 그대로 쓴다.
  let any = false
  for (const a of AGENTS) {
    const bin = resolveBin(a.bin)
    if (!bin) continue
    any = true
    if (a.id === 'claude') doClaude(bin, root)
    else if (a.id === 'agy') doAgy()
    else if (a.id === 'codex') doCodex(bin)
  }

  if (!any) hm('CLI', '이 PC 에서 AI CLI 를 찾지 못했습니다 — 나중에 다시 실행하세요')

  console.log('')
  // 🔴 등록 실패로 setup 을 멈추지 않는다. 장부와 훅은 이미 심겨 있고, 그쪽이 본체다.
  //    MCP 는 편의일 뿐이라 못 붙어도 사람이 CLI 로 claim 할 수 있다.
  return 0
}

process.exit(main())
