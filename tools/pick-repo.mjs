#!/usr/bin/env node
/**
 * 온보딩 평가용 저장소 추첨기.
 *
 * 🔴 **우리 저장소로 평가하면 안 된다. 같은 저장소를 두 번 써도 안 된다.**
 *
 * 이 도구의 목표는 "처음 보는 코드베이스를 빨리 이해하게 하는 것" 이다.
 * 그런데 그 목표를 우리가 이미 아는 코드로 재면 아무것도 못 잰다.
 * 실제로 한동안 axMap 자신과 immich 만 반복해서 봤는데, 그건
 * 없애려던 편향을 다른 형태로 되살린 것이었다.
 *
 * 그래서 매번 **본 적 없는 인기 저장소**를 뽑는다.
 * 뽑은 이력은 파일로 남겨 다시는 같은 것이 나오지 않게 한다.
 *
 * 외부 의존성 0 — Node 의 fetch 와 git 만 쓴다.
 *
 *   node tools/pick-repo.mjs                    한 개 뽑아서 클론
 *   node tools/pick-repo.mjs --lang python      언어 지정
 *   node tools/pick-repo.mjs --min-commits 300  히스토리 하한 (기본 400)
 *   node tools/pick-repo.mjs --list             지금까지 본 것
 *   node tools/pick-repo.mjs --dry              뽑기만 하고 클론 안 함
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SEEN = path.join(HERE, '..', 'docs', 'evaluated-repos.txt')

/**
 * 파서가 실제로 읽는 언어만 고른다.
 * 읽지 못하는 언어를 뽑으면 "도구가 못 읽는다" 만 반복 확인하게 된다 —
 * 그것도 사실이지만 매번 확인할 필요는 없다.
 */
const LANGS = ['typescript', 'python', 'javascript', 'go', 'java']

/**
 * 별 구간을 나눠 뽑는다.
 *
 * 상위만 보면 매번 리액트·리눅스 같은 초대형 저장소가 나온다. 그런 저장소는
 * 클론만 몇 십 분이고, 대부분의 사람이 실제로 온보딩하는 규모와도 다르다.
 */
const STAR_BANDS = ['1000..2000', '2000..5000', '5000..10000', '10000..20000', '20000..50000']

/**
 * 히스토리 하한.
 *
 * 🔴 별 수는 커밋 수를 뜻하지 않는다.
 *
 * 첫 추첨에서 별 1,959개짜리가 뽑혔는데 커밋이 **37개**였다. 인기 있는
 * 단일 목적 라이브러리는 흔히 그렇다. 그런 저장소로는 공변경이 아예 안 나오고,
 * 평가가 "히스토리가 없어서 못 했다" 만 반복 확인하게 된다.
 *
 * 커밋 수는 GitHub 검색 API 가 안 주므로 클론해야 알 수 있다.
 * 뽑고 → 클론하고 → 미달이면 버리고 다시 뽑는다.
 * **버린 것도 기록한다** — 다음에 또 뽑아서 또 클론하지 않기 위해서다.
 */
const MIN_COMMITS = 400
const MAX_TRIES = 6

const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] ?? true) : null }

function seen() {
  try {
    return new Set(
      fs.readFileSync(SEEN, 'utf8').split('\n')
        .map((l) => l.split('#')[0].trim().toLowerCase())
        .filter(Boolean),
    )
  } catch {
    return new Set()
  }
}

function remember(full, note) {
  fs.appendFileSync(SEEN, `${full}  # ${note}\n`)
}

/**
 * 결정론적이지 않아도 되는 유일한 자리다 — 추첨은 무작위여야 한다.
 * 다만 **무엇이 뽑혔는지는 반드시 기록**해서 나중에 재현할 수 있게 한다.
 */
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)]

async function search(lang, band, page) {
  const q = `stars:${band} language:${lang} archived:false`
  const url = 'https://api.github.com/search/repositories'
    + `?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${page}`
  const r = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      // 토큰이 있으면 쓴다. 없어도 시간당 10회는 되므로 추첨에는 충분하다.
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      'user-agent': 'axmap-onboarding-eval',
    },
  })
  if (!r.ok) throw new Error(`GitHub API ${r.status} ${r.statusText}`)
  return (await r.json()).items ?? []
}

/** @returns {{done:true}|{retry:true, why:string}} */
async function attempt(minCommits) {
  const already = seen() // 매 회차 다시 읽는다 — 직전 시도가 기록을 남겼다
  const lang = flag('--lang') ?? pickOne(LANGS)
  const band = flag('--stars') ?? pickOne(STAR_BANDS)

  let items = []
  for (const page of [1, 2, 3]) {
    try {
      items = items.concat(await search(lang, band, page))
    } catch (e) {
      if (items.length) break
      console.error(`GitHub 검색 실패: ${e.message}`)
      console.error('토큰을 주면 한도가 올라갑니다: GITHUB_TOKEN=<토큰>')
      process.exit(1)
    }
  }

  const fresh = items.filter((x) => !already.has(x.full_name.toLowerCase()))
  if (!fresh.length) return { retry: true, why: `${lang} / ${band} 에 새 저장소가 없습니다` }

  const pick = pickOne(fresh)
  const dir = path.join(process.env.TEMP ?? '/tmp', 'axmap-eval', pick.name.replace(/[^\w.-]/g, '_'))

  console.log(`추첨  ${pick.full_name}`)
  console.log(`  별 ${pick.stargazers_count.toLocaleString()} · ${pick.language} · ${(pick.size / 1024).toFixed(0)}MB`)
  console.log(`  ${pick.description ?? '(설명 없음)'}`)
  console.log(`  ${pick.html_url}`)
  console.log(`  (${lang} / ${band} 후보 ${fresh.length}개 중 추첨 · 이미 본 것 ${already.size}개 제외)`)

  if (args.includes('--dry')) return { done: true }

  fs.mkdirSync(path.dirname(dir), { recursive: true })
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })

  console.log(`\n클론 중... ${dir}`)
  /**
   * 🔴 **통째로 받는다.** 전에는 `--filter=blob:none` (blobless) 였다.
   *
   * 공변경에는 커밋과 트리만 있으면 되므로 blobless 가 이론적으로는 맞다.
   * 그런데 벤치 2회차에서 그것이 화면을 거짓말하게 만들었다 —
   *
   *   평가 클론의 장부를 남의 GitHub 에 push 하지 않으려고 `origin` 을
   *   로컬 베어 저장소로 바꿔 달았는데, 그때 `extensions.partialclone` 설정이
   *   통째로 지워졌다. blobless 인데 blobless 가 아니라고 적힌 저장소가 됐다.
   *   그 상태에서 rename 탐지가 켜지면 없는 blob 을 읽으려다 git 이 죽는다.
   *
   *   readCommitSets 가 `fatal: unable to read <sha>` 로 죽고 null 을 조용히
   *   돌려줬고, 화면은 그것을 **"커밋 0개, 히스토리 부족"** 이라고 번역했다.
   *   히스토리는 있었다. 못 읽은 것을 없는 것으로 말한 것이다.
   *
   * 느리지만 이 함정이 사라진다. 벤치는 하루에 한 번 도는 것이고,
   * 화면이 거짓말하면 그 판 전체가 무의미해진다.
   */
  execFileSync('git', ['clone', '--single-branch', pick.clone_url, dir], { stdio: 'inherit' })

  const n = Number(
    execFileSync('git', ['-C', dir, 'rev-list', '--count', '--no-merges', 'HEAD'], { encoding: 'utf8' }).trim(),
  )
  const stamp = new Date().toISOString().slice(0, 10)

  if (n < minCommits) {
    remember(pick.full_name, `건너뜀 — 커밋 ${n}개 (하한 ${minCommits}) · ${stamp}`)
    fs.rmSync(dir, { recursive: true, force: true })
    return { retry: true, why: `커밋이 ${n}개뿐이라 건너뜁니다 (하한 ${minCommits})` }
  }

  remember(pick.full_name, `${pick.language} · 별 ${pick.stargazers_count} · 커밋 ${n} · ${stamp}`)
  console.log(`\n커밋 ${n.toLocaleString()}개`)
  return { done: true, dir }
}

/**
 * 뽑은 저장소를 공개 주소에 올린다.
 *
 * 🔴 추첨과 게시를 붙여둔다.
 *
 * 떼어놓으면 두 가지가 어긋난다 — 새 저장소를 보고 있는데 **밖에서는 지난
 * 저장소가 계속 보이고**, 손으로 띄우다 인증을 빠뜨린다.
 * 평가의 목적은 남이 보고 판단하는 것이라, 밖이 최신이 아니면 평가가 아니다.
 *
 * 자격증명은 여기서 만들지 않는다. 없으면 serve-public.mjs 가 거부한다 —
 * 기본 비밀번호를 심어두면 그건 비밀번호가 아니다.
 */
function serve(dir) {
  if (args.includes('--no-serve')) {
    console.log(`
다음:
  node tools/serve-public.mjs "${dir}" --auth 아이디:비밀번호`)
    return
  }
  const pass = []
  const i = args.indexOf('--auth')
  if (i >= 0 && args[i + 1]) pass.push('--auth', args[i + 1])
  const r = spawnSync(process.execPath, [path.join(HERE, 'serve-public.mjs'), dir, ...pass], {
    stdio: 'inherit', windowsHide: true,
  })
  if (r.status !== 0) {
    console.log(`
게시는 못 했지만 클론은 끝났습니다:
  node tools/serve-public.mjs "${dir}" --auth 아이디:비밀번호`)
  }
}

async function main() {
  if (args.includes('--list')) {
    const s = [...seen()]
    console.log(s.length ? s.join('\n') : '(아직 없음)')
    console.log(`\n총 ${s.length}개`)
    return
  }

  const minCommits = Number(flag('--min-commits') ?? MIN_COMMITS)
  for (let i = 1; i <= MAX_TRIES; i++) {
    const r = await attempt(minCommits)
    if (r.done) return serve(r.dir)
    console.log(`  ↻ ${r.why} — 다시 뽑습니다 (${i}/${MAX_TRIES})\n`)
  }
  console.error(`${MAX_TRIES}회 시도했지만 조건에 맞는 저장소를 못 찾았습니다.`)
  process.exit(1)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
