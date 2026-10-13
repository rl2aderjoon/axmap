#!/usr/bin/env node
/**
 * axMap 이 자기 저장소로 떨어져 나가도 **팀 저장소의 CI 가 안 죽게** 하는 도구.
 *
 * 하는 일은 하나다 — CI 진입점에서 닿는 파일만 팀 저장소 안의 `ci/axmap/` 으로
 * 복사(**벤더링** vendoring — 남의 코드를 내 저장소 안에 사본으로 두고 그 사본으로
 * 돌리는 것)하고, 어디서 언제 무엇을 떠 왔는지를 같이 적어 둔다.
 *
 *   node axmap/tools/vendor.mjs --to <팀저장소 루트>   기본값: 지금 저장소 루트
 *   node axmap/tools/vendor.mjs --check               쓰지 않고 무엇이 바뀔지만 본다
 *   node axmap/tools/vendor.mjs --repo <URL>          출처 주소를 직접 준다
 *
 * 종료 코드: 0 성공 · 1 판정 불가(환경 문제) · 2 거부(고치면 풀린다)
 *            `--check` 는 사본이 낡았을 때도 2 를 낸다.
 *
 * ── 왜 서브모듈도 토큰도 아닌 복사인가 ──────────────────────────────────────
 *
 * 서브모듈(submodule — 다른 저장소를 내 저장소 안에 링크로 매다는 git 기능)이나
 * CI 에서 axMap 을 clone 하는 방식은 **팀 CI 가 남의 저장소를 쳐다보게** 만든다.
 * 그러면 axMap 이 잠깐 깨지거나 접근 토큰이 만료된 날 팀 파이프라인이 통째로
 * 빨개진다 — 팀의 코드는 하나도 안 바뀌었는데.
 *
 * 사본은 그 연결을 끊는다. 대신 "사본이 낡을 수 있다" 는 값을 치른다. 그 값을
 * 받아들이는 이유는 여기서 복사하는 것이 **판정 규칙**이지 제품 코드가 아니어서다.
 * 규칙은 자주 안 바뀌고, 바뀌면 사람이 이 명령을 다시 돌린다.
 *
 * ── 무엇을 복사할지 손으로 적지 않는다 ──────────────────────────────────────
 *
 * 목록은 `src/closure.mjs` 가 import 를 따라가 구한다. `test/closure.test.mjs`
 * 도 같은 함수를 쓴다 — 두 벌로 적으면 어긋난 날 테스트는 초록인데 사본만 깨진다.
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CI_ENTRYPOINTS, importClosure, formatClosureProblems } from '../src/closure.mjs'

const AXMAP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 사본이 놓이는 자리. 팀 저장소 루트 기준. */
const VENDOR_REL = 'ci/axmap'

/** 사본 안에서 나머지 전부의 해시를 들고 있는 파일. 자기 자신은 못 센다. */
const MANIFEST_NAME = 'manifest.sha256'
const SOURCE_NAME = 'SOURCE.json'
const README_NAME = 'README.md'

const EXIT = { OK: 0, UNDECIDABLE: 1, REFUSED: 2 }

// ── 인자 ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (n) => {
  const i = argv.indexOf(n)
  return i < 0 ? null : (argv[i + 1] ?? null)
}
const has = (n) => argv.includes(n)

if (has('--help') || has('-h')) {
  console.log(
    [
      '사용법:',
      '  node axmap/tools/vendor.mjs [--to <팀저장소 루트>] [--check] [--repo <URL>]',
      '',
      `  --to     사본을 놓을 저장소의 루트. 그 아래 ${VENDOR_REL}/ 이 만들어진다`,
      '           (기본값: 지금 저장소의 루트)',
      '  --check  아무것도 쓰지 않고 무엇이 달라질지만 본다. 낡았으면 종료 코드 2',
      '  --repo   SOURCE.json 에 적을 출처 주소. 안 주면 git remote 에서 찾는다',
    ].join('\n'),
  )
  process.exit(EXIT.OK)
}

const checkOnly = has('--check')

function die(msg, code = EXIT.UNDECIDABLE) {
  console.error(msg)
  process.exit(code)
}

// ── git ───────────────────────────────────────────────────────────────────

function git(args, cwd = AXMAP) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

const toplevel = git(['rev-parse', '--show-toplevel'])
if (toplevel.code !== 0) {
  die(`git 저장소 안이 아닙니다: ${AXMAP}\n  ${toplevel.err}`)
}
const SOURCE_ROOT = path.resolve(toplevel.out)

// ── 목적지 ────────────────────────────────────────────────────────────────

const dest = path.resolve(flag('--to') ?? SOURCE_ROOT)
if (!fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) {
  die(`--to 로 준 자리가 폴더가 아닙니다: ${dest}`)
}

const vendorDir = path.join(dest, ...VENDOR_REL.split('/'))

/**
 * 🔴 자기 안으로 복사하지 않는다. 사본이 폐포 안에 들어가면 다음 실행이 사본의
 *    사본을 만들고, 그 다음은 그 사본의 사본을 만든다.
 */
const insideSource = !path.relative(AXMAP, vendorDir).startsWith('..')
if (insideSource) {
  die(
    `사본을 axMap 자기 안에 만들 수는 없습니다: ${vendorDir}\n` +
      '  --to 로 팀 저장소의 루트를 주세요.\n' +
      '  예: node axmap/tools/vendor.mjs --to ../S15P21E201',
    EXIT.REFUSED,
  )
}

// ── 무엇을 복사할지 (손으로 적지 않는다) ──────────────────────────────────

const readSource = (rel) => {
  try {
    return fs.readFileSync(path.join(AXMAP, ...rel.split('/')), 'utf8')
  } catch {
    return null
  }
}

const closure = importClosure({ entries: CI_ENTRYPOINTS, readFile: readSource })
const problems = formatClosureProblems(closure)
if (problems.length > 0) {
  console.error('복사할 목록을 확정할 수 없습니다.')
  console.error('')
  for (const line of problems) console.error(`  🔴 ${line}`)
  console.error('')
  console.error('  고친 다음 다시 돌리세요. 반쪽짜리 사본을 만드는 것보다 안 만드는 것이 낫습니다.')
  process.exit(EXIT.REFUSED)
}

// ── 출처가 커밋된 상태인가 ────────────────────────────────────────────────

const sha = git(['rev-parse', 'HEAD']).out
if (!/^[0-9a-f]{40}$/.test(sha)) {
  die(`출처 커밋을 읽지 못했습니다 (git rev-parse HEAD → "${sha}")`)
}

/**
 * 🔴 **복사할 파일이 커밋된 상태여야 한다.**
 *
 * 사본에는 출처 커밋 sha 가 박힌다. 그 sha 가 가리키는 내용과 사본의 바이트가
 * 다르면 사본은 자기 출처에 대해 거짓말을 하는 것이고, 그게 벤더링에서 제일 나쁜
 * 상태다 — 사본이 낡은 것은 diff 로 보이지만, 출처를 속이는 사본은 안 보인다.
 *
 * 🔴 온 저장소가 아니라 **복사되는 파일만** 본다.
 *
 *    `git status --porcelain` 전체를 조건으로 걸면 이 도구 자신을 처음 만든 커밋
 *    직전에는 절대 돌릴 수 없다 — 새 파일이 있으니 언제나 더럽다. 그런데 지켜야
 *    하는 성질은 "저장소가 깨끗한가" 가 아니라 **"내가 복사하는 바이트가 이 sha 에
 *    있는 바이트와 같은가"** 다. 그건 복사 대상만 보면 정확히 판정된다.
 *    나머지 더러운 것은 아래에서 알려만 주고 막지 않는다.
 */
const absOfClosure = closure.files.map((rel) => path.join(AXMAP, ...rel.split('/')))
const dirtyCopied = git(['status', '--porcelain', '--', ...absOfClosure])
if (dirtyCopied.code !== 0) {
  die(`git status 를 읽지 못했습니다\n  ${dirtyCopied.err}`)
}
if (dirtyCopied.out !== '') {
  console.error('복사할 파일 중에 커밋되지 않은 것이 있습니다. 복사하지 않았습니다.')
  console.error('')
  for (const line of dirtyCopied.out.split('\n')) console.error(`  ${line}`)
  console.error('')
  console.error(`  사본에는 출처 커밋(${sha.slice(0, 8)})이 박힙니다. 지금 복사하면 그 sha 에`)
  console.error('  있는 내용과 사본의 내용이 달라지고, 나중에 아무도 그것을 알아챌 수 없습니다.')
  console.error('  먼저 커밋한 뒤 다시 돌리세요.')
  process.exit(EXIT.REFUSED)
}

const dirtyRest = git(['status', '--porcelain'])
if (dirtyRest.out !== '') {
  console.log('참고: 복사 대상은 아니지만 커밋되지 않은 것이 있습니다 (막지는 않습니다).')
  for (const line of dirtyRest.out.split('\n')) console.log(`  ${line}`)
  console.log('')
}

// ── 출처 주소 · 브랜치 ────────────────────────────────────────────────────

/** `bin/axmap.mjs` · `governance/gate.mjs` 와 같은 순서로 원격을 고른다. */
function sourceRepoUrl() {
  const given = flag('--repo')
  if (given) return given
  const named = git(['config', '--get', 'axmap.remote']).out || 'origin'
  const url = git(['remote', 'get-url', named]).out
  return url || null
}

const repoUrl = sourceRepoUrl()
const branch = (() => {
  const b = git(['rev-parse', '--abbrev-ref', 'HEAD']).out
  return b && b !== 'HEAD' ? b : null
})()

// ── 만들 내용을 먼저 메모리에 짓는다 ──────────────────────────────────────

/** @type {Map<string, Buffer>} 사본 안 상대 경로 → 바이트 */
const next = new Map()

/**
 * 🔴 바이트 그대로 옮긴다. 텍스트로 읽어 다시 쓰면 Windows 에서 줄바꿈이 CRLF 로
 *    바뀌고, 리눅스 러너에서 해시를 다시 재는 순간 전부 어긋난다.
 */
for (const rel of closure.files) {
  next.set(rel, fs.readFileSync(path.join(AXMAP, ...rel.split('/'))))
}

next.set(README_NAME, Buffer.from(renderReadme(), 'utf8'))

// ── 이미 있는 사본을 먼저 읽어 둔다 (무엇이 달라지는지 말하려고) ──────────

/** @type {Map<string, Buffer>} */
const prev = new Map()
if (fs.existsSync(vendorDir)) {
  for (const rel of walk(vendorDir)) {
    prev.set(rel, fs.readFileSync(path.join(vendorDir, ...rel.split('/'))))
  }
}

/**
 * 복사 시각. 내용이 하나도 안 바뀌었으면 **전에 적힌 시각을 그대로 둔다.**
 *
 * 안 그러면 돌릴 때마다 SOURCE.json 과 manifest 만 바뀐 diff 가 생기고, 리뷰어는
 * 곧 그 두 파일의 변경을 안 보게 된다. 그런데 이 두 파일이 바뀌었다는 사실이
 * 바로 `ci/verify-vendor.mjs` 가 리뷰어에게 보여 주려는 신호다 — 잡음으로 만들면
 * 그 신호가 죽는다.
 */
const contentSame =
  [...next.keys()].every((k) => prev.has(k) && prev.get(k).equals(next.get(k))) &&
  [...prev.keys()].every((k) => k === MANIFEST_NAME || k === SOURCE_NAME || next.has(k))

let vendoredAt = new Date().toISOString()
if (contentSame && prev.has(SOURCE_NAME)) {
  try {
    const old = JSON.parse(prev.get(SOURCE_NAME).toString('utf8'))
    if (old?.source?.commit === sha && typeof old.vendoredAt === 'string') vendoredAt = old.vendoredAt
  } catch {
    // 못 읽으면 그냥 지금 시각을 쓴다. 여기서 죽을 이유가 없다.
  }
}

next.set(SOURCE_NAME, Buffer.from(renderSourceJson(vendoredAt), 'utf8'))
next.set(MANIFEST_NAME, Buffer.from(renderManifest(next), 'utf8'))

// ── 무엇이 달라지는가 ─────────────────────────────────────────────────────

const added = [...next.keys()].filter((k) => !prev.has(k)).sort()
const removed = [...prev.keys()].filter((k) => !next.has(k)).sort()
const changed = [...next.keys()].filter((k) => prev.has(k) && !prev.get(k).equals(next.get(k))).sort()
const same = [...next.keys()].filter((k) => prev.has(k) && prev.get(k).equals(next.get(k))).sort()

console.log(`출처   ${repoUrl ?? '(원격을 찾지 못했습니다)'}`)
console.log(`커밋   ${sha}${branch ? `  (${branch})` : ''}`)
console.log(`사본   ${vendorDir}`)
console.log('')
for (const rel of removed) console.log(`  - 사라짐  ${rel}`)
for (const rel of added) console.log(`  + 새로    ${rel}`)
for (const rel of changed) console.log(`  ~ 바뀜    ${rel}`)
for (const rel of same) console.log(`    그대로  ${rel}`)
console.log('')

const differs = added.length > 0 || removed.length > 0 || changed.length > 0

if (checkOnly) {
  if (!differs) {
    console.log('사본은 출처와 같습니다. 아무것도 쓰지 않았습니다.')
    process.exit(EXIT.OK)
  }
  console.log('사본이 출처와 다릅니다. 아무것도 쓰지 않았습니다.')
  console.log(`  맞추려면: node axmap/tools/vendor.mjs --to ${dest}`)
  process.exit(EXIT.REFUSED)
}

// ── 쓴다 ──────────────────────────────────────────────────────────────────

/**
 * 🔴 지우고 새로 만든다. 덮어쓰기만 하면 출처에서 **사라진** 파일이 사본에 남고,
 *    남은 그 파일은 아무도 안 고치는데 계속 import 될 수 있다.
 */
if (fs.existsSync(vendorDir)) fs.rmSync(vendorDir, { recursive: true, force: true })
for (const [rel, buf] of [...next.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  const abs = path.join(vendorDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, buf)
}

console.log(differs ? '사본을 새로 만들었습니다.' : '사본을 다시 만들었습니다 (내용은 같습니다).')
console.log(`  확인:  node ${path.posix.join('ci', 'verify-vendor.mjs')}   (${dest} 에서)`)
process.exit(EXIT.OK)

// ── 만드는 것들 ───────────────────────────────────────────────────────────

/** 사본 폴더 아래의 모든 파일을 posix 상대 경로로. */
function walk(root, rel = '') {
  const out = []
  for (const e of fs.readdirSync(path.join(root, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(root, child))
    else out.push(child)
  }
  return out.sort()
}

/**
 * `<hex>  <상대경로>` 를 경로 정렬로. 줄바꿈은 LF 고정.
 *
 * 🔴 manifest 자신은 목록에 못 넣는다 — 자기 해시를 자기 안에 적을 수 없다.
 *    대신 `ci/verify-vendor.mjs` 가 manifest 를 뺀 나머지 전부를 세므로,
 *    목록에 없는 파일이 사본에 슬쩍 들어오는 것은 잡힌다.
 */
function renderManifest(files) {
  const rows = [...files.keys()]
    .filter((rel) => rel !== MANIFEST_NAME)
    .sort()
    .map((rel) => `${crypto.createHash('sha256').update(files.get(rel)).digest('hex')}  ${rel}`)
  return `${rows.join('\n')}\n`
}

function renderSourceJson(at) {
  const body = {
    _: '이 폴더는 다른 저장소에서 복사해 온 사본입니다. 손으로 고치지 마세요 — README.md 를 보세요.',
    source: {
      repository: repoUrl,
      commit: sha,
      branch,
      generator: 'axmap/tools/vendor.mjs',
    },
    vendoredAt: at,
    entrypoints: [...closure.entries].sort(),
    files: [...closure.files],
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

function renderReadme() {
  return [
    '# `ci/axmap/` — 손으로 고치지 마세요',
    '',
    '이 폴더의 파일은 전부 **다른 저장소에서 복사해 온 사본**입니다',
    '(**벤더링** vendoring — 남의 코드를 내 저장소 안에 두고 그 사본으로 돌리는 것).',
    '원본이 어디의 어느 커밋인지는 `SOURCE.json` 에 있습니다.',
    '',
    '## 왜 사본인가',
    '',
    '팀 CI(**코드를 올릴 때마다 자동으로 도는 검사**)가 이 파일들을 부릅니다.',
    'CI 가 실행할 때마다 axMap 저장소를 clone 해 오게 만들면, axMap 이 잠깐 깨지거나',
    '접근 토큰이 만료된 날 **팀 코드는 하나도 안 바뀌었는데 팀 파이프라인이 빨개집니다.**',
    '사본은 그 연결을 끊습니다. 팀 저장소는 axMap 을 쳐다보지 않습니다.',
    '',
    '## 고쳐야 한다면',
    '',
    '```bash',
    '# 1. axMap 저장소에서 고치고 커밋한다',
    '# 2. 거기서 이 명령을 돌린다',
    'node tools/vendor.mjs --to <이 저장소의 루트>',
    '# 3. 여기 생긴 변경을 MR 로 올린다',
    '```',
    '',
    '여기서 직접 고치면 `ci/verify-vendor.mjs` 가 파이프라인에서 막습니다.',
    '그 검사는 `manifest.sha256` 에 적힌 해시와 실제 파일을 대조합니다.',
    '',
    '## 폴더 구조를 평평하게 만들지 마세요',
    '',
    '`tools/promote.mjs` 는 형제 폴더의 `governance/gate.mjs` 를 경로로 찾아',
    '자식 프로세스로 띄웁니다. `src/…` 상대 import 도 마찬가지입니다.',
    '구조를 바꾸면 **테스트는 통과하는데 CI 에서만** 조용히 깨집니다.',
    '',
    '## 여기 없는 것',
    '',
    'CI 진입점에서 import 로 닿지 않는 파일은 복사되지 않습니다.',
    'axMap 의 나머지(선점 장부·MCP 서버·데스크톱 앱)는 팀 CI 가 부르지 않으므로',
    '여기 없습니다. 그것들이 필요하면 axMap 저장소를 직접 쓰세요.',
    '',
  ].join('\n')
}
