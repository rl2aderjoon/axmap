import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { agentNameError } from './protocol.mjs'

// Only the display name is global. Email is resolved from the working repo so
// a work identity never silently becomes the address used in a personal repo.
export const profilePath = (home = os.homedir()) => path.join(home, '.axmap', 'profile.json')

export function displayNameError(name) {
  if (typeof name !== 'string') return '표시 이름은 문자열이어야 합니다.'
  return agentNameError(name) || (/[,;@\u007f]/.test(name)
    ? '표시 이름에는 쉼표·세미콜론·@ 문자를 쓸 수 없습니다.'
    : name.toLowerCase() === 'all' ? 'all은 전체 수신자를 뜻하므로 표시 이름으로 쓸 수 없습니다.' : null)
}

export function readProfile(home) {
  const file = profilePath(home)
  let data
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    if (e.code === 'ENOENT') return null
    throw new Error(`표시 이름 설정을 읽지 못했습니다: ${file} (${e.message})`)
  }
  const error = displayNameError(data?.name)
  if (data?.version !== 1 || error || (data.updatedAt && !Number.isFinite(Date.parse(data.updatedAt)))) throw new Error(`표시 이름 설정이 올바르지 않습니다: ${file}${error ? ` (${error})` : ''}`)
  return data
}

export function writeProfile(name, home) {
  const error = displayNameError(name)
  if (error) throw new Error(error)
  const previous = readProfile(home)
  const file = profilePath(home)
  const data = { ...previous, version: 1, name,
    updatedAt: previous?.name === name && previous.updatedAt ? previous.updatedAt : new Date().toISOString() }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
  } finally { fs.rmSync(tmp, { force: true }) }
  return data
}

export function emailError(email) {
  // This address also becomes a filename on Windows; reject unsafe Git config
  // values rather than rewriting two different addresses to the same file.
  return typeof email !== 'string' || !/^[^\s@\\/:*?"<>|,;\u0000-\u001f]+@[^\s@\\/:*?"<>|,;\u0000-\u001f]+$/.test(email)
    || /[.\s]$/.test(email) ? 'Git 이메일이 없거나 사용자 주소로 쓸 수 없습니다. git config user.email을 확인하세요.' : null
}

export function syncConfiguredProfile(repo, bus, env = process.env) {
  if (env.AXMAP_SKIP_PROFILE_SYNC === '1') return ''
  try {
    if (!readProfile()) return ''
    const r = spawnSync(process.execPath, [bus, 'profile'], {
      cwd: repo, env, encoding: 'utf8', windowsHide: true,
    })
    return (r.stderr || (r.status !== 0 ? '경고: 쪽지 프로필 공유에 실패했습니다. 다음 사용 때 재시도합니다.' : '')).trim()
  } catch (e) { return `경고: ${e.message}` }
}
