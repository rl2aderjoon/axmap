import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { cacheName, hasHead, isRemote } from '../app/lib/fetchrepo.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const tmp = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `axmap-${name}-`))
  return d
}

test('진짜 저장소는 HEAD 가 풀린다', () => {
  assert.equal(hasHead(ROOT), true)
})

test('🔴 받다 만 저장소를 멀쩡한 것으로 보지 않는다', () => {
  /**
   * 설계 근거이자 실제로 밟은 사고다.
   *
   * 클론 도중에 프로세스가 죽으면 `.git` 만 남고 HEAD 는 아무것도 안 가리킨다.
   * 그 폴더를 "캐시 있음" 으로 오인하면 **커밋 0개짜리 저장소를 정상 결과처럼**
   * 분석해서 빈 그래프를 띄운다 — 오류 없이. 이 검사를 지우면 그 사고가 돌아온다.
   */
  const d = tmp('halfclone')
  try {
    spawnSync('git', ['init', '--quiet', d], { windowsHide: true })
    assert.equal(fs.existsSync(path.join(d, '.git')), true, '.git 은 있다')
    assert.equal(hasHead(d), false, '그런데 읽을 커밋이 없다')
  } finally {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

test('git 이 아예 아닌 폴더도 false 다 — 던지지 않는다', () => {
  const d = tmp('plain')
  try { assert.equal(hasHead(d), false) } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('없는 경로에도 죽지 않는다', () => {
  assert.equal(hasHead(path.join(ROOT, '이런-폴더는-없다')), false)
})

test('원격 주소를 알아본다', () => {
  assert.equal(isRemote('https://github.com/a/b'), true)
  assert.equal(isRemote('github.com/a/b'), true)
  assert.equal(isRemote('git@github.com:a/b.git'), true)
  assert.equal(isRemote('ssh://git@host.io/a/b'), true)
})

test('🔴 github 이 아닌 곳도 받는다 — 사내·학교 GitLab', () => {
  /**
   * 설계 근거. 예전에는 호스트를 `github|gitlab|bitbucket.com` 으로 **목록**을
   * 두었다. 그래서 SSAFY 의 `lab.ssafy.com` 을 붙여넣으면 로컬 경로로 오인해
   * "그런 폴더가 없습니다" 가 떴다 — 자기 주소가 틀렸다고 생각하게 된다.
   * 목록은 반드시 누군가를 빠뜨린다. 이 검사를 지우면 그 실패가 돌아온다.
   */
  assert.equal(isRemote('lab.ssafy.com/s11-final/S11P31A101'), true)
  assert.equal(isRemote('https://lab.ssafy.com/s11-final/S11P31A101.git'), true)
  assert.equal(isRemote('lab.ssafy.com/그룹/하위그룹/저장소'), true, '중첩 그룹')
  assert.equal(isRemote('https://git.example.com:8080/team/repo'), true, '포트는 스킴과 함께')
})

test('스킴 없는 포트는 일부러 안 받는다 — scp 문법과 겹친다', () => {
  // `host:8080/a/b` 와 `git@host:owner/repo` 는 모양이 겹친다. 애매하면 거부한다.
  assert.equal(isRemote('git.example.com:8080/team/repo'), false)
})

test('로컬 경로를 원격으로 오해하지 않는다', () => {
  assert.equal(isRemote('.'), false)
  assert.equal(isRemote('./docs/a'), false)
  assert.equal(isRemote('C:/Users/x/repo'), false)
  assert.equal(isRemote('C:\\Users\\x\\repo'), false)
  assert.equal(isRemote('/home/me/repo'), false)
  assert.equal(isRemote('docs/bench-runs/x'), false, '점 없는 첫 칸은 호스트가 아니다')
  assert.equal(isRemote(''), false)
  assert.equal(isRemote(null), false)
})

test('🔴 중첩 그룹이 달라도 캐시 폴더가 섞이지 않는다', () => {
  /**
   * 마지막 두 칸만 쓰면 `A조/sub/proj` 와 `B조/sub/proj` 가 같은 폴더에 떨어진다.
   * 그러면 A조 저장소를 열었는데 B조 코드가 보인다 — 오류 없이. GitLab 을
   * 그룹으로 나눠 쓰는 곳에서는 흔한 모양이라 실제로 밟게 된다.
   */
  const a = cacheName('https://lab.ssafy.com/A조/sub/proj')
  const b = cacheName('https://lab.ssafy.com/B조/sub/proj')
  assert.notEqual(a, b)
  // 호스트가 달라도 섞이면 안 된다
  assert.notEqual(cacheName('https://github.com/x/y'), cacheName('https://gitlab.com/x/y'))
  // `.git` 이 붙고 안 붙고는 같은 저장소다 — 두 벌 받지 않는다
  assert.equal(cacheName('https://github.com/x/y'), cacheName('https://github.com/x/y.git'))
  // 폴더 이름으로 쓸 수 있어야 한다
  assert.ok(/^[\w.-]+$/.test(a), `폴더명에 못 쓰는 글자가 있다: ${a}`)
})
