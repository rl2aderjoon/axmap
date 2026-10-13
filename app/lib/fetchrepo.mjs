/**
 * git 주소를 받아 로컬로 가져온다 — 서사 1단계 (D14).
 *
 * "이해하고 싶은 저장소 주소를 넣는다" 가 사용자의 첫 동작인데, 그동안 뷰어는
 * **로컬 경로만** 받았다. 첫 걸음이 아예 없었다.
 *
 * 🔴 blobless 클론을 쓴다 (`--filter=blob:none`).
 *
 * 공변경에는 커밋과 트리만 있으면 되고 파일 내용은 HEAD 것만 있으면 된다.
 * 실측(immich): full clone 대비 받는 양이 크게 줄고, 커밋 수에 비례하므로
 * 저장소가 커도 히스토리가 짧으면 금방 끝난다.
 *
 * 대신 rename 탐지가 네트워크를 타게 되는데, 그건 cochange.mjs 가
 * promisor 설정을 보고 `--no-renames` 로 우회한다 (거기 주석 참조).
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 캐시 위치. 같은 주소를 다시 넣으면 다시 안 받는다. */
export const CACHE_DIR = path.join(os.tmpdir(), 'axmap-repos')

/**
 * 이게 원격 주소인가.
 *
 * 로컬 경로와 헷갈리지 않게 **명시적인 형태만** 받는다.
 * `github.com/x/y` 처럼 스킴이 없는 것도 흔하므로 함께 인정한다.
 */
/**
 * 스킴이 없는 주소도 받는다 — `lab.ssafy.com/팀/저장소` 처럼 붙여넣는 사람이 많다.
 *
 * 🔴 호스트를 **목록으로 두지 않는다.**
 *
 * 예전에는 `github|gitlab|bitbucket.com` 만 받았다. 그래서 사내·학교 GitLab
 * (SSAFY 의 `lab.ssafy.com` 같은)을 쓰는 사람이 주소를 그대로 붙여넣으면
 * **로컬 경로로 오인해서 "그런 폴더가 없습니다"** 를 봤다. 자기 저장소 주소가
 * 틀렸다고 생각하게 된다. 목록은 반드시 누군가를 빠뜨린다.
 *
 * 대신 **모양**으로 가른다 — 점이 든 호스트 + 경로 두 칸 이상.
 * 로컬과 헷갈리지 않게: `.`·`/` 로 시작하면 로컬이고, 윈도우 드라이브(`C:/…`)는
 * 점이 없어서 자연히 걸러진다. GitLab 의 중첩 그룹은 받는다.
 *
 * 🔴 스킴 없는 **포트(`host:8080/a/b`)는 일부러 안 받는다.** git 의 scp 문법
 * (`git@host:owner/repo`)과 모양이 겹쳐서, 받아 주면 어느 쪽인지 우리가 정해야
 * 한다. 애매하면 거부한다(CLAUDE.md) — 포트가 필요하면 스킴을 붙이면 되고,
 * 그때는 위의 스킴 갈래가 받는다.
 */
const HOSTISH = /^[A-Za-z0-9][\w-]*(\.[\w-]+)+\/[^/\s]+\/[^\s]+$/

export function isRemote(s) {
  const t = String(s ?? '').trim()
  if (!t || t.startsWith('.') || t.startsWith('/') || t.startsWith('\\')) return false
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(t) || HOSTISH.test(t)
}

/** 주소를 정규화한다. 스킴이 없으면 https 를 붙인다. */
export function normalizeUrl(s) {
  const t = s.trim().replace(/\/+$/, '')
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(t)) return t
  return `https://${t}`
}

/**
 * 캐시 폴더 이름.
 *
 * 🔴 `owner/repo` 를 그대로 폴더명으로 쓰면 서로 다른 두 저장소가 같은 자리에
 *    떨어진다 (`a/util` 과 `b/util` 이 둘 다 `util`). 소유자까지 넣고,
 *    경로에 못 쓰는 글자는 거부하지 말고 바꾸되 **원본을 함께 적어둔다** —
 *    치환은 서로 다른 둘을 같게 만들 수 있어서, 어느 주소였는지 남겨야 한다.
 */
export function cacheName(url) {
  /**
   * 🔴 마지막 두 칸만 쓰면 GitLab 의 **중첩 그룹**에서 서로 다른 저장소가 같은
   * 폴더에 떨어진다 — `lab.ssafy.com/A조/sub/proj` 와 `.../B조/sub/proj` 가 둘 다
   * `sub__proj` 가 된다. SSAFY 처럼 그룹을 겹쳐 쓰는 곳에서는 흔한 모양이라
   * **호스트와 경로를 통째로** 넣는다. 폴더 이름이 길어지는 것이 섞이는 것보다 낫다.
   */
  const t = String(url)
    .replace(/^[a-z+]+:\/\//i, '')  // 스킴
    .replace(/^[^@/]+@/, '')        // git@ 같은 사용자 부분
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  return t.replace(/[^\w.-]/g, '_').slice(0, 120)
}

/**
 * 원격 주소를 로컬로 가져온다.
 *
 * @returns {{dir: string, url: string, cached: boolean, commits: number}}
 * @throws  클론이 실패하면 이유를 담아 던진다. 조용히 빈 폴더를 돌려주지 않는다 —
 *          그러면 "저장소가 비었다" 는 틀린 결론이 화면에 뜬다.
 */
export function fetchRepo(input, { onLog = () => {} } = {}) {
  const url = normalizeUrl(input)
  const dir = path.join(CACHE_DIR, cacheName(url))

  /**
   * 🔴 `.git` 이 있다고 멀쩡한 저장소는 아니다.
   *
   * 클론 **도중에 프로세스가 죽으면**(강제 종료·전원·타임아웃) 아래의 정리 코드가
   * 못 돌아서 반쯤 받은 폴더가 그대로 남는다. 그 뒤로는 "캐시 있음" 으로 오인해
   * **커밋 0개짜리 저장소를 정상인 것처럼** 돌려준다 — 화면에는 빈 그래프가 뜨고
   * 아무 오류도 안 난다. 실제로 그렇게 됐다.
   *
   * HEAD 가 실제 커밋을 가리키는지로 판정한다. 안 가리키면 버리고 다시 받는다.
   */
  if (fs.existsSync(path.join(dir, '.git')) && !hasHead(dir)) {
    onLog('  (받다 만 캐시입니다 — 지우고 다시 받습니다)')
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 못 지우면 아래 클론이 실패로 말한다 */ }
  }

  if (fs.existsSync(path.join(dir, '.git'))) {
    onLog(`캐시 사용: ${dir}`)
    // 이미 받아둔 것은 최신으로만 맞춘다. 실패해도 있는 것으로 진행한다 —
    // 네트워크가 끊겨도 이미 받은 저장소는 볼 수 있어야 한다.
    const r = spawnSync('git', ['-C', dir, 'fetch', '--quiet', '--filter=blob:none', 'origin'], {
      encoding: 'utf8', windowsHide: true,
    })
    if (r.status !== 0) onLog('  (최신화 실패 — 받아둔 상태로 엽니다)')
    return { dir, url, cached: true, commits: countCommits(dir) }
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true })
  onLog(`클론: ${url}`)
  onLog(`  → ${dir}`)
  const r = spawnSync(
    'git',
    ['clone', '--filter=blob:none', '--single-branch', url, dir],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  if (r.status !== 0) {
    // 반쯤 받다 만 폴더는 지운다. 남겨두면 다음 실행이 "캐시 있음" 으로 오인한다.
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 지울 수 없으면 그대로 둔다 */ }
    const why = (r.stderr ?? '').trim().split('\n').filter(Boolean).slice(-2).join(' / ')
    throw new Error(`클론 실패: ${url}\n  ${why || '원인을 알 수 없습니다'}`)
  }
  return { dir, url, cached: false, commits: countCommits(dir) }
}

/**
 * HEAD 가 실제 커밋을 가리키는가.
 *
 * 받다 만 저장소와 `git init` 만 한 빈 폴더를 함께 가려낸다. 둘 다 `.git` 은
 * 있지만 읽을 것이 없고, 그 상태로 분석하면 **빈 그래프를 정상 결과처럼** 보여준다.
 */
export function hasHead(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD'],
    { encoding: 'utf8', windowsHide: true })
  return r.status === 0 && !!r.stdout?.trim()
}

function countCommits(dir) {
  try {
    return Number(
      execFileSync('git', ['-C', dir, 'rev-list', '--count', '--no-merges', 'HEAD'], {
        encoding: 'utf8', windowsHide: true,
      }).trim(),
    )
  } catch {
    return 0
  }
}
