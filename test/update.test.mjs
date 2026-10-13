/**
 * 갱신 확인의 규칙.
 *
 * 🔴 여기서 고정하는 것은 "새 버전을 받는다" 가 아니라 **"받지 않는다"** 다.
 *
 *    이 저장소가 두려워하는 실패는 조용한 성공이다. 갱신에서 그것은 *사람이 모르는
 *    사이에 도구가 바뀌는 것*이다 — 어제 되던 것이 오늘 안 되는데, 바뀐 것이 자기
 *    코드가 아니라서 어디를 볼지 알 수 없다. 그래서 이 층은 **알리기만** 한다.
 *
 *    그리고 벤더링된 사본(팀 저장소의 `ci/axmap/`)은 확인 자체를 하지 않아야 한다.
 *    사본이 레지스트리를 쳐다보면 벤더링이 끊으려던 바깥 의존이 CI 로 되돌아온다.
 *
 * 레지스트리는 127.0.0.1 에 진짜 http 서버를 띄워 재고, 바깥 네트워크는 치지 않는다.
 * 가짜 fetch 로만 재면 "URL 을 어떻게 만드는가" 가 한 번도 안 돈다.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHECK_INTERVAL_MS,
  PACKAGE_NAME,
  cacheFile,
  checkDisabled,
  compareVersions,
  fetchLatest,
  isStale,
  isVendored,
  noticeLine,
  readCache,
  registryUrl,
  writeCache,
} from '../src/update.mjs'

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `axmap-upd-${name}-`))

describe('버전 비교', () => {
  it('숫자 칸으로 센다 — 문자열 비교로는 1.10.0 < 1.9.0 이 된다', () => {
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
    assert.equal(compareVersions('1.9.0', '1.10.0'), -1)
    assert.equal(compareVersions('0.0.2', '0.0.1'), 1)
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  })

  it('칸 수가 달라도 센다', () => {
    assert.equal(compareVersions('1.2', '1.2.0'), 0)
    assert.equal(compareVersions('2', '1.99.99'), 1)
  })

  it("앞의 v 와 뒤의 빌드 정보는 무시한다", () => {
    assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
    assert.equal(compareVersions('1.2.3+abc', '1.2.3'), 0)
  })

  it('사전배포는 같은 자리의 정식판보다 낮다 — 안 그러면 rc 를 올린 날 모두에게 "내려가라" 가 뜬다', () => {
    assert.equal(compareVersions('1.2.0-rc.1', '1.2.0'), -1)
    assert.equal(compareVersions('1.2.0', '1.2.0-rc.1'), 1)
    assert.equal(compareVersions('1.2.0-rc.2', '1.2.0-rc.1'), 1)
  })
})

describe('꾸러미 이름', () => {
  it('🔴 package.json 의 name 과 같다 — 어긋나면 안내문의 npx 한 줄이 없는 꾸러미를 가리킨다', () => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    assert.equal(PACKAGE_NAME, pkg.name)
  })

  it('🔴 맨 이름 axmap 이 아니다 — npm 의 axmap 은 2022년부터 남의 꾸러미다', () => {
    // leozin_ 의 Map 라이브러리(1.1.2). `npx axmap` 이라고 안내하면 **그것이 깔린다.**
    //
    // 🔴 지켜야 하는 것은 "스코프가 붙어 있다" 가 아니라 "맨 이름 axmap 이 아니다" 다.
    //    앞의 것으로 적어 두면 스코프 없는 이름을 고르는 순간 멀쩡한 결정이 빨개진다.
    //    2026-08-28 에 axmap-cli 로 정했다 — 스코프는 npm 계정 이름에 묶여서
    //    조직으로 옮길 때 이름이 통째로 바뀐다 (docs/DISTRIBUTION.md).
    assert.notEqual(PACKAGE_NAME, 'axmap', '남의 꾸러미를 가리키고 있다')
    assert.match(PACKAGE_NAME, /^(@[^/]+\/)?[a-z0-9][a-z0-9._-]*$/, 'npm 이 받는 이름 꼴이 아니다')
  })
})

describe('안내문', () => {
  it('최신이거나 더 높으면 아무 말도 하지 않는다', () => {
    assert.equal(noticeLine('1.2.3', '1.2.3'), null)
    assert.equal(noticeLine('1.3.0', '1.2.3'), null)
  })

  it('낮으면 지금 버전과 받는 방법을 함께 낸다', () => {
    const n = noticeLine('1.2.3', '1.3.0')
    assert.ok(n, '새 버전이 있는데 아무 말도 안 했다')
    assert.match(n, /1\.2\.3/)
    assert.match(n, /1\.3\.0/)
    assert.match(n, new RegExp(`npx .*${PACKAGE_NAME}@latest setup`), '받는 방법이 안내에 없다')
  })

  // 🔴 **판이 이 PC 에 두 군데 있다** — `axmap` 명령(전역 설치)과 git 훅이 부르는
  //    사본(`~/.axmap/app`). `setup` 은 뒤의 것만 올린다 (`tools/setup.mjs` 에
  //    `npm i` 가 0건이다). 그래서 `setup` 만 안내하면 **시킨 대로 했는데 절반만
  //    올라간다** — 그 상태가 바로 1.2.4 가 경고하게 만든 그 상태다.
  //
  //    안내가 스스로 그 상태를 만들어 내면 안 된다. 두 줄이 다 있어야 한다.
  it('🔴 전역 설치도 같이 안내한다 — setup 은 훅 사본만 올린다', () => {
    const n = noticeLine('1.2.3', '1.3.0')
    assert.match(
      n, new RegExp(`npm i -g ${PACKAGE_NAME}@latest`),
      'setup 만 안내하면 axmap 명령이 옛 판으로 남는다',
    )
    assert.match(n, /두 줄 다 필요/, '둘 다 해야 한다는 것이 안 보인다')
  })

  it('버전을 모르면 아무 말도 하지 않는다 — 모르는 것을 낡았다고 하지 않는다', () => {
    assert.equal(noticeLine(null, '1.3.0'), null)
    assert.equal(noticeLine('1.2.3', null), null)
    assert.equal(noticeLine(null, null), null)
  })
})

describe('🔴 벤더링된 사본은 확인하지 않는다', () => {
  it('옆에 SOURCE.json 이 있으면 사본이다', () => {
    const d = tmp('vendored')
    assert.equal(isVendored(d), false, 'SOURCE.json 이 없는데 사본이라고 했다')
    fs.writeFileSync(path.join(d, 'SOURCE.json'), '{}')
    assert.equal(isVendored(d), true, 'SOURCE.json 이 있는데 사본이 아니라고 했다')
  })

  it('이 저장소 자신은 사본이 아니다 — 원본에는 SOURCE.json 이 없다', () => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
    assert.equal(isVendored(root), false, `원본을 사본으로 봤다: ${root}`)
  })
})

describe('확인을 끄는 자리', () => {
  it('CI 안에서는 묻지 않는다 — 파이프라인에서 바깥 네트워크를 치면 느려지고 아무도 안 읽는다', () => {
    assert.equal(checkDisabled({ CI: 'true' }), true)
    assert.equal(checkDisabled({ CI: '1' }), true)
  })

  it('AXMAP_NO_UPDATE_CHECK 로 손으로도 끈다', () => {
    assert.equal(checkDisabled({ AXMAP_NO_UPDATE_CHECK: '1' }), true)
  })

  it('아무것도 없으면 묻는다', () => {
    assert.equal(checkDisabled({}), false)
  })
})

describe('마지막 확인 결과 (캐시)', () => {
  let dir = null
  let prev

  before(() => {
    dir = tmp('state')
    prev = process.env.AXMAP_STATE_DIR
    // 🔴 진짜 홈을 건드리면 이 PC 를 쓰는 사람의 상태가 바뀐다.
    //    테스트가 사람의 작업 환경을 고치는 것은 어떤 이유로도 정당하지 않다.
    process.env.AXMAP_STATE_DIR = dir
  })
  after(() => {
    if (prev === undefined) delete process.env.AXMAP_STATE_DIR
    else process.env.AXMAP_STATE_DIR = prev
  })

  it('AXMAP_STATE_DIR 아래에 둔다 — 홈이 아니다', () => {
    assert.equal(path.dirname(cacheFile()), path.resolve(dir))
  })

  it('없으면 null 이다. 던지지 않는다', () => {
    assert.equal(readCache(), null)
  })

  it('쓴 것을 다시 읽는다', () => {
    assert.equal(writeCache({ latest: '9.9.9', current: '0.0.1', checkedAt: 1234 }), true)
    const c = readCache()
    assert.equal(c.latest, '9.9.9')
    assert.equal(c.checkedAt, 1234)
  })

  it('깨진 파일은 null 로 답한다 — 캐시 하나 때문에 CLI 가 죽지 않는다', () => {
    fs.writeFileSync(cacheFile(), '{ 이건 JSON 이 아니다')
    assert.equal(readCache(), null)
  })

  it('모양이 안 맞는 기록도 null 이다', () => {
    fs.writeFileSync(cacheFile(), JSON.stringify({ latest: 3, checkedAt: 'x' }))
    assert.equal(readCache(), null)
  })
})

describe('다시 물어볼 때', () => {
  it('기록이 없으면 언제나 물어본다', () => {
    assert.equal(isStale(null, Date.now()), true)
  })

  it('하루가 안 지났으면 안 묻는다 — 부를 때마다 레지스트리를 치는 것이 더 나쁜 버그다', () => {
    const now = 1_000_000_000
    assert.equal(isStale({ checkedAt: now - 1000, latest: '1.0.0' }, now), false)
    assert.equal(isStale({ checkedAt: now - CHECK_INTERVAL_MS, latest: '1.0.0' }, now), true)
  })
})

describe('레지스트리 주소', () => {
  it('AXMAP_REGISTRY 로 갈아끼운다 (시험과 사내 레지스트리를 위해)', () => {
    assert.equal(registryUrl({ AXMAP_REGISTRY: 'http://x.test/' }), 'http://x.test')
  })

  it('기본은 npm 공용 레지스트리다', () => {
    assert.match(registryUrl({}), /^https:\/\/registry\.npmjs\.org$/)
  })
})

describe('레지스트리에 묻기 (127.0.0.1 의 진짜 http)', () => {
  let server = null
  let base = null
  /** 다음 요청에 무엇으로 답할지. 테스트마다 갈아끼운다. */
  let reply = null
  /** 서버가 실제로 받은 경로. URL 을 어떻게 만드는지 여기서 고정한다. */
  let lastPath = null

  before(async () => {
    server = http.createServer((req, res) => {
      lastPath = req.url
      const r = reply ?? { status: 200, body: JSON.stringify({ version: '1.0.0' }) }
      if (r.hang) return // 일부러 안 답한다 — 시간 초과를 재기 위해
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(r.body)
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    base = `http://127.0.0.1:${server.address().port}`
  })
  after(async () => {
    await new Promise((done) => server.close(done))
  })

  it('<registry>/<이름>/latest 를 묻고 version 을 낸다', async () => {
    reply = { status: 200, body: JSON.stringify({ version: '2.5.1' }) }
    const v = await fetchLatest({ registry: base, name: 'plainname' })
    assert.equal(v, '2.5.1')
    assert.equal(lastPath, '/plainname/latest', `엉뚱한 곳에 물었다: ${lastPath}`)
  })

  it('스코프 붙은 이름은 인코딩해서 묻는다 — 이름의 / 가 경로 구분자로 새면 404 가 된다', async () => {
    reply = { status: 200, body: JSON.stringify({ version: '3.0.0' }) }
    // 🔴 재료를 PACKAGE_NAME 으로 쓰지 않는다. 우리 이름(axmap-cli)에는 스코프가 없어서
    //    이 경로를 한 번도 안 밟게 되고, 그러면 **테스트가 초록인 채로 죽는다.**
    //    나중에 @조직/axmap 으로 옮기는 날 여기가 조용히 404 를 낸다.
    const scoped = '@example/axmap'
    await fetchLatest({ registry: base, name: scoped })
    // 🔴 실측: registry.npmjs.org 는 @babel/core 를 세 꼴 모두 200 으로 답한다
    //    (`@babel/core` · `%40babel%2Fcore` · `@babel%2Fcore`). 그중 하나를 고정한다.
    assert.equal(lastPath, `/${encodeURIComponent(scoped)}/latest`, `엉뚱한 곳에 물었다: ${lastPath}`)
  })

  it('200 이 아니면 던진다 — 못 물어본 것을 "최신" 으로 삼지 않는다', async () => {
    reply = { status: 404, body: '{}' }
    await assert.rejects(() => fetchLatest({ registry: base }), /404/)
  })

  it('version 이 없는 응답도 던진다', async () => {
    reply = { status: 200, body: JSON.stringify({ name: 'axmap' }) }
    await assert.rejects(() => fetchLatest({ registry: base }), /version/)
  })

  it('레지스트리가 안 답하면 정해진 시간에 포기한다 — 선점이 여기서 멈추면 안 된다', async () => {
    reply = { hang: true }
    const t0 = Date.now()
    await assert.rejects(() => fetchLatest({ registry: base, timeoutMs: 120 }))
    assert.ok(Date.now() - t0 < 3000, '시간 초과가 안 걸렸다')
    reply = null
  })
})

/**
 * 명령이 **끝나는 자리**. 화면이 아니라 종료 코드만 본다.
 *
 * 문서에 적힌 약속(`0 물어봤다 · 1 못 물어봤다`)을 재는 층이 여기까지 없었다.
 * 위의 테스트들은 `fetchLatest` 를 직접 부르므로 **프로세스가 끝나지 않는다** —
 * 종료 코드라는 것이 아예 생기지 않는 자리다.
 */
describe('update 명령이 끝나는 자리 — 진짜 프로세스로 잰다', () => {
  const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'axmap.mjs')
  let server = null
  let base = null
  let reply = null
  let state = null

  /**
   * 진짜 CLI 를 돌린다. 캐시는 임시 폴더로 돌려서 이 PC 의 기록을 건드리지 않는다.
   *
   * 🔴 `spawnSync` 를 쓰지 않는다. 레지스트리 서버가 **이 프로세스 안에** 떠 있어서,
   *    동기로 기다리면 이벤트 루프가 멈춘 채라 서버가 답을 못 한다. 자식은 3초를
   *    기다리다 시간 초과로 죽고, 종료 코드가 틀린 이유를 엉뚱한 데서 찾게 된다.
   */
  const run = () =>
    new Promise((done) => {
      const p = spawn(process.execPath, [CLI, 'update'], {
        cwd: path.dirname(CLI),
        env: { ...process.env, AXMAP_REGISTRY: base, AXMAP_STATE_DIR: state },
        windowsHide: true,
      })
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => { out += d })
      p.stderr.on('data', (d) => { err += d })
      p.on('close', (status) => done({ status, stdout: out, stderr: err }))
    })

  before(async () => {
    state = tmp('cli')
    server = http.createServer((req, res) => {
      if (reply === null) {
        res.socket.destroy() // 못 물어본 경우를 만든다
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: reply }))
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    base = `http://127.0.0.1:${server.address().port}`
  })
  after(async () => {
    await new Promise((done) => server.close(done))
    fs.rmSync(state, { recursive: true, force: true })
  })

  it('최신이면 0 으로 끝난다', async () => {
    reply = '0.0.0' // 지금 것보다 낮다 = 알릴 것이 없다
    const r = await run()
    assert.equal(r.status, 0, `종료 코드 ${r.status}
${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /최신입니다/)
  })

  it('새 버전이 있어도 0 으로 끝난다 — 판정이 아니라 "물어봤는가" 가 종료 코드다', async () => {
    reply = '999.0.0'
    const r = await run()
    assert.equal(r.status, 0, `종료 코드 ${r.status}
${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /새 버전이 있습니다/)
  })

  it('못 물어보면 1 로 끝난다 — 127 도 0 도 아니다', async () => {
    reply = null
    const r = await run()
    assert.equal(r.status, 1, `종료 코드 ${r.status}
${r.stdout}${r.stderr}`)
  })
})

/**
 * 🔴 **네트워크를 친 뒤에는 `process.exit()` 를 부르지 않는다** (2026-09-10).
 *
 *    2026-09-10 에 `axmap update` 는 답을 정확히 찍고도 종료 코드 127 로 죽고
 *    있었다. 레지스트리에 묻느라 연 소켓이 아직 **닫히는 중**인데 `process.exit()`
 *    를 부르면 Windows 의 node 가 `Assertion failed: !(handle->flags &
 *    UV_HANDLE_CLOSING)` 로 스스로 중단한다. 화면은 멀쩡하고 종료 코드만 틀린,
 *    사람 눈으로는 안 보이는 종류다.
 *
 * 🔴 **이것을 행동으로 재려는 시도를 먼저 했고, 안 됐다. 그 실측을 여기 남긴다.**
 *
 *    바로 위의 세 테스트는 진짜 프로세스를 돌리지만 **고치기 전 코드에서도 초록이다.**
 *    127 은 127.0.0.1 의 로컬 서버로는 재현되지 않는다 — http 도, 자체서명 https 도,
 *    localhost 이름으로 도는 것도, IPv4/IPv6 경합을 끈 것도 전부 0 으로 끝났다.
 *    **진짜 바깥 호스트로 나가는 https 연결일 때만** 터진다. 그리고 이 저장소의
 *    테스트는 바깥 네트워크를 치지 않는다 (그게 CI 를 남의 사정에 묶는 일이라서).
 *
 *    그래서 행동 대신 **모양**을 고정한다. 이 검사는 고치기 전 코드에서 실제로
 *    빨개진다 — 그것을 확인하고 넣었다. 테스트가 잡지 못하는 것을 잡는 척하는 것이
 *    테스트가 없는 것보다 나쁘다.
 */
describe('update 는 네트워크 뒤에 프로세스를 강제로 끝내지 않는다', () => {
  it('fetchLatest 뒤로는 process.exit 이 없다 — exitCode 만 세우고 돌아간다', () => {
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'axmap.mjs'),
      'utf8',
    )
    const from = src.indexOf('async function cmdUpdate')
    assert.notEqual(from, -1, 'cmdUpdate 를 못 찾았다 — 이름이 바뀌었으면 이 검사도 함께 옮긴다')
    const end = src.indexOf('\n}\n', from)
    const body = src.slice(from, end)

    // 레지스트리를 치기 전(벤더링된 사본으로 빠지는 길)의 exit 은 소켓이 없으니 괜찮다.
    const afterFetch = body.slice(body.indexOf('fetchLatest'))
    assert.doesNotMatch(
      afterFetch,
      /process\.exit\(/,
      '네트워크 뒤에 process.exit 이 돌아왔다 — Windows 에서 종료 코드가 127 이 된다',
    )
  })
})
