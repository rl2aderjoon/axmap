import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MIN_FILES, findRoots, splitNeeded } from '../app/lib/roots.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 파일 목록을 그래프 노드 모양으로. `lang` 이 없으면 코드로 안 친다. */
const nodesOf = (paths, lang = 'js') => paths.map((id) => ({ id, lang }))

/** 임시 저장소를 만든다. 매니페스트만 있으면 되므로 내용은 비워도 된다. */
function repo(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-roots-'))
  for (const f of files) {
    fs.mkdirSync(path.join(d, path.dirname(f)), { recursive: true })
    fs.writeFileSync(path.join(d, f), '{}')
  }
  return d
}
const rm = (d) => fs.rmSync(d, { recursive: true, force: true })

// ── 매니페스트가 프로젝트를 선언한다 ────────────────────────────────────────

test('매니페스트가 있는 디렉터리를 프로젝트로 본다', () => {
  const d = repo(['FE/app/package.json', 'BE/build.gradle'])
  try {
    const roots = findRoots(d, nodesOf([
      ...Array.from({ length: 20 }, (_, i) => `FE/app/src/a${i}.ts`),
      ...Array.from({ length: 30 }, (_, i) => `BE/src/B${i}.java`),
    ]))
    assert.deepEqual(roots.map((r) => r.dir).sort(), ['BE', 'FE/app'])
    assert.equal(roots.find((r) => r.dir === 'BE').manifest, 'build.gradle')
  } finally { rm(d) }
})

test('🔴 안쪽 프로젝트가 있어도 바깥 프로젝트가 사라지지 않는다', () => {
  /**
   * 설계 근거이자 실제로 밟은 사고다.
   *
   * 처음에는 "매니페스트를 품은 조상은 뺀다" 로 했다. 그랬더니 axMap 자신이
   * 깨졌다 — 루트에 `package.json` 이 있고 `desktop/package.json` 도 있는데
   * 루트가 조상이라는 이유로 통째로 빠져서 본체 70여 개가 어디에도 안 속했고
   * 화면에 카드가 하나도 안 그려졌다.
   *
   * 조상은 지우는 것이 아니라 **안쪽에 넘겨준 만큼만 빼면** 된다.
   */
  const d = repo(['package.json', 'desktop/package.json'])
  try {
    const roots = findRoots(d, nodesOf([
      ...Array.from({ length: 40 }, (_, i) => `src/a${i}.js`),
      'desktop/main.js', 'desktop/preload.js',
    ]))
    const outer = roots.find((r) => r.dir === '')
    const inner = roots.find((r) => r.dir === 'desktop')
    assert.ok(outer, '바깥 프로젝트가 남아야 한다')
    assert.ok(inner, '안쪽 프로젝트도 남아야 한다')
    assert.equal(inner.files, 2)
    assert.equal(outer.files, 40, '안쪽에 넘겨준 것은 빼고 센다')
  } finally { rm(d) }
})

test('🔴 개수 합계가 파일 수와 정확히 맞는다 — 겹치지도 빠지지도 않는다', () => {
  const d = repo(['package.json', 'desktop/package.json', 'FE/app/package.json'])
  try {
    const files = [
      ...Array.from({ length: 15 }, (_, i) => `src/a${i}.js`),
      ...Array.from({ length: 5 }, (_, i) => `desktop/d${i}.js`),
      ...Array.from({ length: 9 }, (_, i) => `FE/app/f${i}.js`),
    ]
    const roots = findRoots(d, nodesOf(files))
    assert.equal(roots.reduce((n, r) => n + r.files, 0), files.length)
    assert.equal(splitNeeded(roots, nodesOf(files)).outside, 0)
  } finally { rm(d) }
})

// ── 매니페스트가 없는 덩어리 ────────────────────────────────────────────────

test('매니페스트가 없어도 큰 덩어리는 프로젝트로 짐작한다 — 다만 표시한다', () => {
  const d = repo(['AI/requirements.txt'])
  try {
    const roots = findRoots(d, nodesOf([
      ...Array.from({ length: 20 }, (_, i) => `AI/m${i}.py`),
      ...Array.from({ length: 20 }, (_, i) => `robot/dash/s${i}.py`),
    ], 'python'))
    const guess = roots.find((r) => r.dir === 'robot/dash')
    assert.ok(guess, '매니페스트 없는 덩어리도 잡는다')
    assert.equal(guess.manifest, null)
    assert.equal(guess.kind, 'dir', '짐작한 것은 종류로 구분된다 — 화면이 근거를 속이면 안 된다 (D5)')
  } finally { rm(d) }
})

test('🔴 루트 자체가 프로젝트면 그 안의 디렉터리를 프로젝트로 만들지 않는다', () => {
  /**
   * 실제로 밟은 사고. axMap 에서 `test/`(25개) · `app/lib/`(24개) · `tools/`
   * 가 각각 "프로젝트" 로 올라왔고, 가장 큰 `test` 에서 진입점을 찾다 못 찾아
   * 화면이 통째로 비었다. 그것들은 한 프로젝트 **안의 디렉터리**다.
   */
  const d = repo(['package.json'])
  try {
    const roots = findRoots(d, nodesOf([
      ...Array.from({ length: 30 }, (_, i) => `test/t${i}.js`),
      ...Array.from({ length: 30 }, (_, i) => `lib/l${i}.js`),
    ]))
    assert.deepEqual(roots.map((r) => r.dir), [''])
    assert.equal(roots[0].files, 60)
  } finally { rm(d) }
})

test('작은 덩어리는 프로젝트로 안 친다', () => {
  const d = repo(['package.json'])
  try {
    const roots = findRoots(d, nodesOf(['a.js', 'scripts/one.js']))
    assert.equal(roots.filter((r) => r.dir === 'scripts').length, 0, `파일 1개는 ${MIN_FILES}개 미만이다`)
  } finally { rm(d) }
})

// ── 언제 물어보나 ───────────────────────────────────────────────────────────

test('프로젝트가 하나면 고르라고 하지 않는다', () => {
  const d = repo(['package.json'])
  try {
    const n = nodesOf(Array.from({ length: 30 }, (_, i) => `src/a${i}.js`))
    assert.equal(splitNeeded(findRoots(d, n), n).multi, false)
  } finally { rm(d) }
})

test('덮이지 않은 파일이 있으면 몇 개인지 말한다', () => {
  const d = repo(['FE/package.json'])
  try {
    // 최상위에 흩어진 파일은 프로젝트가 아니다 — 그래도 몇 개인지는 알려야 한다
    const n = nodesOf([...Array.from({ length: 20 }, (_, i) => `FE/a${i}.js`), 'stray.js'])
    const s = splitNeeded(findRoots(d, n), n)
    assert.equal(s.outside, 1)
    assert.equal(s.covered, 20)
  } finally { rm(d) }
})

test('데이터 파일은 세지 않는다 — 프로젝트 크기는 코드로 잰다', () => {
  const d = repo(['package.json'])
  try {
    const n = [...nodesOf(Array.from({ length: 15 }, (_, i) => `src/a${i}.js`)),
      { id: 'README.md', lang: 'data' }]
    assert.equal(findRoots(d, n)[0].files, 15)
  } finally { rm(d) }
})

test('빈 입력에도 죽지 않는다', () => {
  const d = repo(['package.json'])
  try {
    assert.deepEqual(findRoots(d, []), [])
    assert.deepEqual(findRoots(d, null), [])
  } finally { rm(d) }
})

// ── 이 저장소 자신 ──────────────────────────────────────────────────────────

test('axMap 자신에서 루트와 desktop 둘이 나온다', () => {
  const n = nodesOf([
    'app/server.mjs', 'src/protocol.mjs', 'bin/axmap.mjs',
    'desktop/main.mjs', 'desktop/preload.cjs',
  ], 'js')
  const roots = findRoots(ROOT, n)
  assert.ok(roots.some((r) => r.dir === ''), '저장소 루트가 프로젝트다')
  assert.ok(roots.some((r) => r.dir === 'desktop'), 'desktop 도 프로젝트다')
  assert.equal(roots.reduce((s, r) => s + r.files, 0), n.length)
})
