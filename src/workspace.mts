/** 작업 폴더 → 대상 Git 저장소. MCP 서버·로컬 세션 연결·CLI가 이 한 곳에서 정한다.
 *
 * 사람이 AI 도구를 여는 폴더가 Git 저장소가 아닐 수 있다. 예: 한 저장소의 worktree
 * 여러 개를 나란히 담아 둔 `robotable_hj_workspace`. 위로만 찾으면 이 폴더는
 * "Git 저장소 아님"이 되어 연결이 끊긴다. 그래서 위로 찾기에 실패한 폴더에 한해
 * 아래 순서로 정한다 (D30).
 *
 *   0. 수동 설정 — 그 폴더나 조상에 있는 `.axmap.json` 의 `{ "repo": "<경로>" }`
 *   1. 자동 탐색 — 바로 아래 자식 폴더(깊이 1)의 Git 저장소를 공통 디렉터리로 묶어
 *                  묶음이 정확히 하나면 그 저장소
 *   2. 모호함   — 묶음이 둘 이상이면 고르지 않고 후보를 적은 오류를 낸다
 *
 * 매번 디스크와 git 에게 다시 묻는다. 캐시하면 사람이 설정 파일을 쓰거나 폴더를
 * 추가한 뒤에도 서버를 다시 켜기 전까지 옛 판단이 남는다.
 *
 * 읽지 못한 것과 없는 것을 구별한다. `.git` 이 있는데 git 이 읽지 못한 자식 폴더를
 * "저장소 없음"으로 세면, 실제로는 두 저장소인데 하나로 보고 엉뚱한 장부를 잡는다.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// bin/axmap.mjs·mcp/server.mjs 가 CLI 를 띄울 때마다 import 하므로 Node 내장만 쓴다.
// 그래서 session-types 의 작은 도우미도 가져오지 않는다.
const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e)
const errorCode = (e: unknown) => e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : undefined

export const WORKSPACE_CONFIG = '.axmap.json'

export interface WorkspaceMember { name: string; top: string }
export interface RepoGroup { key: string; common: string; target: string; members: WorkspaceMember[] }
export type TargetResolution =
  | { kind: 'git'; from: string; repo: string }
  | { kind: 'manual'; from: string; repo: string; config: string }
  | { kind: 'auto'; from: string; repo: string; group: RepoGroup }
  | { kind: 'ambiguous'; from: string; groups: RepoGroup[] }
  | { kind: 'none'; from: string }

/** 오류 문구만으로 종류를 가르지 않도록 사유를 붙인다. */
export class WorkspaceError extends Error {
  constructor(message: string, readonly reason: 'ambiguous' | 'manual' | 'unreadable') { super(message) }
}

// 커밋 훅 안에서는 GIT_DIR 등이 설정돼 있다. 그대로 두면 자식 폴더마다 같은 저장소로
// 답해서 서로 다른 저장소가 하나로 묶인다. bin/axmap.mjs 의 GIT_ENV_KEYS 와 같은 목록이다.
const GIT_ENV_KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX']
function gitEnv(): NodeJS.ProcessEnv {
  // "not a git repository" 문구로 판정하므로 번역된 메시지가 나오지 않게 고정한다.
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' }
  for (const key of GIT_ENV_KEYS) delete env[key]
  return env
}

type GitAnswer = { ok: true; lines: string[] } | { ok: false; notRepo: boolean; detail: string }
function askGit(cwd: string, args: string[]): GitAnswer {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', windowsHide: true })
  if (r.error) return { ok: false, notRepo: false, detail: r.error.message }
  if (r.status === 0) return { ok: true, lines: (r.stdout ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean) }
  const detail = (r.stderr ?? '').trim() || `git 종료 코드 ${r.status}`
  return { ok: false, notRepo: /not a git repository/i.test(detail), detail }
}

const real = (p: string) => fs.realpathSync(p)
/** 공통 디렉터리 비교 키. bridge 의 repoKey 와 같은 규칙이다 (Windows 는 대소문자 무시). */
export const commonKey = (common: string) => process.platform === 'win32' ? common.toLowerCase() : common

function statOrNull(p: string): fs.Stats | null {
  try { return fs.statSync(p) } catch (e) {
    if (['ENOENT', 'ENOTDIR'].includes(errorCode(e) || '')) return null
    throw e
  }
}

/** 폴더가 속한 Git 저장소의 최상위. 저장소 밖이면 null, 판정하지 못하면 예외. */
export function gitTop(dir: string): string | null {
  const stat = statOrNull(dir)
  if (!stat || !stat.isDirectory()) return null
  const r = askGit(dir, ['rev-parse', '--show-toplevel'])
  if (r.ok) {
    if (!r.lines[0]) throw new WorkspaceError(`Git 최상위 폴더를 읽지 못했습니다: ${dir}`, 'unreadable')
    return real(r.lines[0])
  }
  if (r.notRepo) return null
  throw new WorkspaceError(`Git 저장소인지 확인하지 못했습니다: ${dir}\n  ${r.detail}`, 'unreadable')
}

/** 그 폴더나 조상에 있는 `.axmap.json`. 없으면 null. 읽지 못하면 예외. */
export function findWorkspaceConfig(dir: string): string | null {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    const candidate = path.join(at, WORKSPACE_CONFIG)
    const stat = statOrNull(candidate)
    if (stat) return candidate
    if (path.dirname(at) === at) return null
  }
}

function manualTarget(config: string): string {
  let data: unknown
  try { data = JSON.parse(fs.readFileSync(config, 'utf8')) } catch (e) {
    throw new WorkspaceError(`작업 폴더 설정을 읽지 못했습니다: ${config}\n  ${errorMessage(e)}`, 'manual')
  }
  const repo = (data as { repo?: unknown } | null)?.repo
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof repo !== 'string' || !repo.trim()) {
    throw new WorkspaceError(`작업 폴더 설정에 "repo" 경로가 없습니다: ${config}\n  예: { "repo": "폴더이름" }`, 'manual')
  }
  const wanted = path.resolve(path.dirname(config), repo)
  // 설정이 틀렸을 때 자동 탐색으로 넘어가지 않는다. 사람이 고른 것을 몰래 바꾸면
  // 다른 저장소의 장부에 선점이 남는다.
  const top = gitTop(wanted)
  if (!top) throw new WorkspaceError(`작업 폴더 설정의 저장소가 Git 저장소가 아닙니다: ${wanted}\n  (설정 파일: ${config})`, 'manual')
  return top
}

function scanChildren(dir: string): { groups: RepoGroup[]; unreadable: string[] } {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) {
    throw new WorkspaceError(`작업 폴더의 하위 폴더를 읽지 못했습니다: ${dir}\n  ${errorMessage(e)}`, 'unreadable')
  }
  const groups = new Map<string, RepoGroup>(), unreadable: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const child = path.join(dir, entry.name)
    try {
      // worktree 폴더가 심볼릭 링크·junction 일 수 있어 링크는 따라가서 본다.
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && !!statOrNull(child)?.isDirectory())
      if (!isDir) continue
      // `.git` 이 없는 폴더는 저장소의 최상위가 아니다. git 을 띄우지 않고 넘어간다.
      if (fs.lstatSync(path.join(child, '.git'), { throwIfNoEntry: false }) === undefined) continue
    } catch (e) { unreadable.push(`${entry.name} (${errorMessage(e)})`); continue }
    const r = askGit(child, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])
    if (!r.ok || r.lines.length < 2) { unreadable.push(`${entry.name} (${r.ok ? 'git 응답이 비어 있음' : r.detail})`); continue }
    let top: string, common: string
    try { top = real(r.lines[0]); common = real(r.lines[1]) } catch (e) { unreadable.push(`${entry.name} (${errorMessage(e)})`); continue }
    const key = commonKey(common)
    const group = groups.get(key) ?? { key, common, target: '', members: [] }
    group.members.push({ name: entry.name, top })
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    // 메인 체크아웃(공통 디렉터리 `.git` 의 부모)을 겨눈다. 장부도 거기 있다.
    // bare 저장소처럼 그 부모가 체크아웃이 아니면 첫 번째 worktree 를 쓴다.
    const parent = path.dirname(group.common)
    group.target = path.basename(group.common).toLowerCase() === '.git' && statOrNull(parent)?.isDirectory()
      ? real(parent) : group.members[0].top
  }
  return { groups: [...groups.values()], unreadable }
}

/** 무엇을 왜 고르는지까지 돌려준다. 모호함은 예외가 아니라 결과다 (`workspace show` 용). */
export function inspectTarget(dir: string): TargetResolution {
  const from = path.resolve(dir)
  const top = gitTop(from)
  if (top) return { kind: 'git', from, repo: top }
  if (!statOrNull(from)?.isDirectory()) return { kind: 'none', from }
  const config = findWorkspaceConfig(from)
  if (config) return { kind: 'manual', from, repo: manualTarget(config), config }
  const { groups, unreadable } = scanChildren(from)
  if (unreadable.length) {
    throw new WorkspaceError([
      `작업 폴더 ${from} 아래에서 확인하지 못한 Git 폴더가 있어 대상 저장소를 정하지 않았습니다.`,
      ...unreadable.map(s => `  - ${s}`),
      `저장소를 직접 고르려면 이 폴더에서 \`axmap workspace use <폴더>\` 를 실행하세요.`,
    ].join('\n'), 'unreadable')
  }
  if (groups.length === 1) return { kind: 'auto', from, repo: groups[0].target, group: groups[0] }
  if (groups.length > 1) return { kind: 'ambiguous', from, groups }
  return { kind: 'none', from }
}

export function ambiguityMessage(r: Extract<TargetResolution, { kind: 'ambiguous' }>): string {
  return [
    `작업 폴더 ${r.from} 아래에 서로 다른 Git 저장소가 ${r.groups.length}개 있어 하나로 정하지 않았습니다.`,
    ...r.groups.map(g => `  - ${g.target}  (폴더: ${g.members.map(m => m.name).join(', ')})`),
    '고르는 방법 (둘 중 하나):',
    '  1. 도구를 부를 때 cwd 에 작업할 저장소 폴더의 절대 경로를 넘긴다.',
    `  2. 이 폴더에 ${WORKSPACE_CONFIG} 을 둔다: { "repo": "${r.groups[0].members[0].name}" }`,
    `     터미널에서는: axmap workspace use ${r.groups[0].members[0].name}`,
  ].join('\n')
}

/** 대상 저장소 경로. 저장소가 없으면 null, 모호하거나 판정하지 못하면 예외. */
export function resolveTarget(dir: string): string | null {
  const r = inspectTarget(dir)
  if (r.kind === 'ambiguous') throw new WorkspaceError(ambiguityMessage(r), 'ambiguous')
  return r.kind === 'none' ? null : r.repo
}

export function describeTarget(r: TargetResolution): string {
  switch (r.kind) {
    case 'git': return `대상 저장소: ${r.repo}\n이유: 작업 폴더가 Git 저장소 안에 있습니다.`
    case 'manual': return `대상 저장소: ${r.repo}\n이유: 수동 설정 ${r.config}`
    case 'auto': return `대상 저장소: ${r.repo}\n이유: 자동 탐색 — 하위 폴더가 모두 같은 저장소입니다 (${r.group.members.map(m => m.name).join(', ')}).`
    case 'ambiguous': return ambiguityMessage(r)
    case 'none': return `대상 저장소 없음: ${r.from}\n이유: 이 폴더와 바로 아래 폴더에서 Git 저장소를 찾지 못했습니다.`
  }
}

/** `axmap workspace use` — 사람이 고른 저장소를 작업 폴더의 `.axmap.json` 에 적는다. */
export function writeWorkspaceChoice(dir: string, choice: string): { config: string; repo: string; value: string } {
  const from = path.resolve(dir)
  if (gitTop(from)) throw new WorkspaceError(`이 폴더는 이미 Git 저장소 안이라 ${WORKSPACE_CONFIG} 를 쓰지 않습니다: ${from}`, 'manual')
  const wanted = path.resolve(from, choice)
  const repo = gitTop(wanted)
  if (!repo) throw new WorkspaceError(`Git 저장소가 아닙니다: ${wanted}`, 'manual')
  const config = path.join(from, WORKSPACE_CONFIG)
  let data: Record<string, unknown> = {}
  if (statOrNull(config)) {
    // 읽지 못한 설정은 덮어쓰지 않는다 (D23 과 같은 원칙).
    try { data = JSON.parse(fs.readFileSync(config, 'utf8')) } catch (e) {
      throw new WorkspaceError(`기존 ${config} 를 읽지 못해 바꾸지 않았습니다: ${errorMessage(e)}`, 'manual')
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WorkspaceError(`기존 ${config} 가 객체가 아니라 바꾸지 않았습니다.`, 'manual')
  }
  // 폴더 안의 저장소는 상대 경로로 적어 작업 폴더를 통째로 옮겨도 맞게 한다.
  const relative = path.relative(from, wanted)
  const value = !relative || relative.startsWith('..') || path.isAbsolute(relative) ? wanted : relative.replaceAll(path.sep, '/')
  fs.writeFileSync(config, JSON.stringify({ ...data, repo: value }, null, 2) + '\n')
  return { config, repo, value }
}
