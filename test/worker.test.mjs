/**
 * 코퍼스 일꾼의 **복원**.
 *
 * 🔴 순수 로직 테스트로는 못 잡는 층이다.
 *
 * `addRepo`·`snapshot` 은 언제나 정직했다. 사고는 그 앞, **파일을 읽는
 * 자리**에서 났다 — `repos.jsonl` 이 962MB 가 되자 V8 문자열 한계
 * (0x1fffffe8 = 537MB)에 걸려 던졌고, `catch { 처음이면 없다 }` 가 그것을
 * 삼켰다. 워커가 켜질 때마다 누적 6,470개를 버리고 0부터 다시 셌고,
 * 공개 스냅샷이 42칸·41개 usable → 20칸·**0개 usable** 로 무너졌다.
 *
 * 그래서 여기서는 진짜 파일을 만들고 진짜 프로세스를 돌린다.
 * 537MB 파일을 테스트에서 만들 수는 없으므로, **스트리밍을 쓰는지**를
 * 대신 확인한다 — 통째로 읽는 코드로 되돌아가면 이 테스트가 깨진다.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMeasured, parseSeen } from '../corpus/measure.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKER = path.join(ROOT, 'corpus', 'worker.mjs')

let dir = null
const run = () => spawnSync(process.execPath, [WORKER, '--data', dir, '--hours', '0'],
  { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60_000 })

const rec = (i) => JSON.stringify({
  lang: 'go', commits: 1500 + i, parseCoverage: 0.9, parser: 'test',
  files: [{ lines: 100, commits: 3, depth: 2 }],
})

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-worker-')) })
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 그만 */ } })

describe('복원', () => {
  it('레코드를 전부 복원한다', () => {
    fs.writeFileSync(path.join(dir, 'repos.jsonl'), Array.from({ length: 200 }, (_, i) => rec(i)).join('\n') + '\n')
    fs.writeFileSync(path.join(dir, 'seen.txt'), Array.from({ length: 200 }, (_, i) => `o/r${i}`).join('\n'))
    const r = run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(fs.readFileSync(path.join(dir, 'worker.log'), 'utf8'), /복원한 레코드 200개/)
  })

  it('깨진 줄은 세되 버리고 계속한다 — 반쯤 쓰인 마지막 줄이 흔하다', () => {
    fs.writeFileSync(path.join(dir, 'repos.jsonl'), `${rec(1)}\n{"lang":"go"\n${rec(2)}\n`)
    const r = run()
    assert.equal(r.status, 0)
    const log = fs.readFileSync(path.join(dir, 'worker.log'), 'utf8')
    assert.match(log, /복원한 레코드 2개/)
    assert.match(log, /못 읽은 줄 1개/, '조용히 버리면 언제부터 새는지 모른다')
  })

  it('🔴 본 것은 많은데 복원이 0이면 멈춘다 — 빈 것으로 덮어쓰지 않는다', () => {
    fs.writeFileSync(path.join(dir, 'repos.jsonl'), '')
    fs.writeFileSync(path.join(dir, 'seen.txt'), Array.from({ length: 200 }, (_, i) => `o/r${i}`).join('\n'))
    fs.rmSync(path.join(dir, 'baseline.json'), { force: true })
    const r = run()
    assert.equal(r.status, 1, '0 을 주면 감시자가 그대로 진행한다')
    assert.equal(fs.existsSync(path.join(dir, 'baseline.json')), false, '스냅샷을 쓰면 안 된다')
  })

  it('처음 도는 것은 막지 않는다 — 본 것도 복원도 0이면 정상', () => {
    fs.writeFileSync(path.join(dir, 'repos.jsonl'), '')
    fs.writeFileSync(path.join(dir, 'seen.txt'), '')
    assert.equal(run().status, 0)
  })
})

describe('🔴 파일을 통째로 읽지 않는다', () => {
  /**
   * 962MB 짜리 파일을 테스트에서 만들 수는 없다. 대신 **되돌아갔는지**를 본다.
   * `readFileSync` 로 `repos.jsonl` 을 읽는 코드가 다시 들어오면 여기서 걸린다.
   */
  const src = fs.readFileSync(WORKER, 'utf8')

  it('스트리밍으로 읽는다', () => {
    assert.match(src, /createReadStream\(F\.repos/, 'repos.jsonl 을 흘려 읽지 않는다')
    assert.match(src, /for await \(const line of/)
  })

  it('통째로 읽는 코드가 없다', () => {
    // 주석 안의 설명은 걸리지 않도록 실제 호출만 본다
    const calls = [...src.matchAll(/fs\.readFileSync\(([^)]*)\)/g)].map((m) => m[1])
    assert.deepEqual(calls.filter((a) => a.includes('F.repos')), [],
      'repos.jsonl 을 readFileSync 로 읽는다 — 어느 날 조용히 전부 잃는다')
  })
})

/**
 * 🔴 seen.txt 는 "봤다" 와 "지금 쓰는 지표로 쟀다" 를 구별해야 한다.
 *
 * 구별하지 않던 시절에 실제로 물렸다 — 군집 스윕을 넣은 날, 옛 저장소
 * 전부가 재측정 대상에서 **조용히** 빠졌다. 이름이 seen 에 있다는 이유만으로.
 * 새 지표를 넣을 때마다 사람이 그것을 기억해야 한다면 언젠가 반드시 잊는다.
 */

/**
 * 🔴 seen.txt 는 "봤다" 와 "지금 쓰는 지표로 쟀다" 를 구별해야 한다.
 *
 * 구별하지 않던 시절에 실제로 물렸다 — 군집 스윕을 넣은 날, 옛 저장소 전부가
 * 재측정 대상에서 **조용히** 빠졌다. 이름이 seen 에 있다는 이유만으로.
 *
 * 🔴 처음엔 프로세스를 돌려 로그의 "이미 본 저장소 N개" 를 봤는데, 그 검사는
 *    **옛 코드로도 통과한다.** 개수는 어느 쪽이든 같기 때문이다. 판별하려면
 *    판정 함수를 직접 불러야 한다.
 */
describe('seen.txt 의 스키마', () => {
  it('옛 형식(이름만)은 스키마 0 — 다시 재야 한다', () => {
    const seen = parseSeen('a/b\nc/d\n')
    assert.equal(seen.get('a/b'), 0)
    assert.equal(isMeasured(seen, 'a/b', 2), false, '옛 줄이 최신으로 둔갑했다')
    assert.equal(isMeasured(seen, 'a/b', 0), true)
  })

  it('스키마가 지금과 같거나 높으면 다시 재지 않는다', () => {
    const seen = parseSeen('a/b\t2\nc/d\t3\n')
    assert.equal(isMeasured(seen, 'a/b', 2), true)
    assert.equal(isMeasured(seen, 'c/d', 2), true, '더 새 것을 굳이 다시 재지 않는다')
    assert.equal(isMeasured(seen, 'a/b', 3), false, '지표가 늘면 다시 재야 한다')
  })

  it('숫자가 아닌 값은 0 으로 떨어뜨린다 — 지어낸 값으로 통과시키지 않는다', () => {
    const seen = parseSeen('a/b\t엉터리\n')
    assert.equal(seen.get('a/b'), 0)
    assert.equal(isMeasured(seen, 'a/b', 1), false)
  })

  it('같은 이름이 여러 줄이면 큰 쪽을 쓴다 — 덧붙이기만 하므로 중복이 정상이다', () => {
    const seen = parseSeen('a/b\nа/x\t1\na/b\t2\na/b\t1\n')
    assert.equal(seen.get('a/b'), 2, '나중 줄이 앞 줄을 낮추면 안 된다')
  })

  it('본 적 없는 이름은 언제나 다시 재는 쪽이다', () => {
    assert.equal(isMeasured(parseSeen(''), '모르는/것', 0), false)
  })
})
