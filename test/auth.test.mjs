/**
 * `--auth` 가 **모든** 경로를 막는지 확인한다.
 *
 * 🔴 이 테스트는 실제로 뚫려 있던 것을 잡는다.
 *
 * 인증 게이트가 핸들러 중간, 정적 분기와 `/api/graph` **아래** 놓여 있었다.
 * 그래서 `--auth` 를 켜고도 자격증명 없이 —
 *
 *   GET /            → 200  (화면 전체)
 *   GET /api/graph   → 200  (파일 경로·줄수·디렉터리 구조 전부)
 *
 * 가 나갔다. 주석에는 "정적 파일까지 포함해 모든 요청에 건다" 라고 적혀 있었고,
 * 코드는 그렇지 않았다. 락에서 금지한 fail-open 과 같은 종류다 —
 * 막아야 할 것을 조용히 통과시키고 아무도 에러를 보지 못한다.
 *
 * 단위 테스트로는 잡히지 않는다. 버그가 함수 안이 아니라 **분기 순서**에 있어서
 * 실제로 서버를 띄우고 요청을 보내야만 보인다.
 */

import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 39217          // 흔히 쓰지 않는 자리. 개발 중인 뷰어와 부딪히지 않게 한다
const CRED = 'bm:test-secret'
const BASE = `http://127.0.0.1:${PORT}`

let proc

/** 서버가 뜰 때까지 기다린다. 시간 대신 **응답**을 기다린다. */
async function waitUp(deadlineMs = 30_000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    try {
      // 401 이든 200 이든 "대답했다" 는 것이 뜬 것이다.
      await fetch(BASE, { signal: AbortSignal.timeout(1000) })
      return true
    } catch {
      if (proc?.exitCode != null) throw new Error(`서버가 죽었습니다 (exit ${proc.exitCode})`)
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error('서버가 뜨지 않았습니다')
}

const basic = () => `Basic ${Buffer.from(CRED).toString('base64')}`

// 🔴 훅을 최상위에 둔다. describe 안에 두면 그 블록이 끝날 때 서버가 죽어서
//    뒤에 오는 describe 가 통째로 연결 거부로 실패한다 (실제로 그랬다).
before(async () => {
  proc = spawn(
    process.execPath,
    [path.join(ROOT, 'app', 'server.mjs'), ROOT, String(PORT), '--readonly', '--auth', CRED],
    { cwd: ROOT, stdio: 'ignore', windowsHide: true },
  )
  await waitUp()
})

after(() => proc?.kill())

describe('--auth 는 모든 경로를 막는다', () => {
  // 🔴 정적 분기와 `/api/graph` 가 실제로 뚫려 있던 둘이다. 맨 앞에 둔다.
  for (const p of ['/', '/index.html', '/api/graph']) {
    it(`자격증명 없이 ${p} → 401`, async () => {
      const r = await fetch(BASE + p)
      assert.equal(r.status, 401, `${p} 가 인증 없이 ${r.status} 를 줬습니다`)
    })
  }

  for (const p of ['/api/overlay', '/api/entry', '/api/claims', '/없는-경로']) {
    it(`자격증명 없이 ${p} → 401`, async () => {
      // 없는 경로도 401 이어야 한다. 404 를 주면 무엇이 있고 없는지가 새어나간다.
      const r = await fetch(BASE + p)
      assert.equal(r.status, 401)
    })
  }

  it('틀린 자격증명 → 401', async () => {
    const r = await fetch(BASE, {
      headers: { authorization: `Basic ${Buffer.from('bm:wrong').toString('base64')}` },
    })
    assert.equal(r.status, 401)
  })

  it('맞는 자격증명 → 통과', async () => {
    for (const p of ['/', '/api/graph']) {
      const r = await fetch(BASE + p, { headers: { authorization: basic() } })
      assert.equal(r.status, 200, `${p} 가 ${r.status}`)
    }
  })

  it('401 은 WWW-Authenticate 를 준다', async () => {
    // 이게 없으면 브라우저가 로그인 창을 안 띄운다 — 사람이 들어갈 방법이 없어진다.
    const r = await fetch(BASE)
    assert.match(r.headers.get('www-authenticate') ?? '', /^Basic realm=/)
  })
})

/**
 * `/_bm/` 별칭이 실제로 API 로 간다.
 *
 * 🔴 이 테스트도 실제로 뚫려 있던 것을 잡는다 — 반대 방향으로.
 *
 * 별칭 재작성이 정적 분기 **뒤**에 있어서 `/_bm/*` 가 전부 정적 파일로
 * 취급돼 404 였다. 화면(overlay.js 의 api())은 언제나 `_bm/` 로 부르므로
 * 뷰어가 데이터를 하나도 못 받는 상태였다. 리버스 프록시 뒤에서만 깨지는 줄
 * 알았는데 로컬에서도 깨져 있었다.
 *
 * 커밋 하나 동안 아무도 못 봤다. API 를 직접 치는 확인만 했고 화면을 안 열었다.
 */
describe('/_bm/ 별칭', () => {
  for (const [alias, direct] of [['/_bm/graph', '/api/graph'], ['/_bm/flow', '/api/flow']]) {
    it(`${alias} 가 ${direct} 와 같은 것을 준다`, async () => {
      const h = { authorization: basic() }
      const a = await fetch(BASE + alias, { headers: h })
      const d = await fetch(BASE + direct, { headers: h })
      assert.equal(a.status, 200, `${alias} 가 ${a.status}`)
      assert.equal(a.status, d.status)
      assert.equal(a.headers.get('content-type'), 'application/json; charset=utf-8')
    })
  }

  it('별칭으로 인증을 우회할 수 없다', async () => {
    const r = await fetch(`${BASE}/_bm/graph`)
    assert.equal(r.status, 401)
  })
})

/**
 * 🔴 자격증명을 **환경변수**로도 받는다 — 그리고 그쪽이 상시 서비스의 기본이다.
 *
 * `--auth` 로 주면 값이 argv 에 들어가고, argv 는 `/proc/<pid>/cmdline` 에
 * 그대로 있으며 그 파일은 **누구나 읽는다.** `ps aux` 한 줄이면 비밀번호가 나온다.
 * AWS 에 systemd 로 올리면서 실제로 그렇게 새고 있었다.
 *
 * 이 테스트가 잡는 것은 "환경변수도 되나" 가 아니라 **"환경변수만으로도
 * 막히나"** 다. 인증이 안 걸린 채로 뜨면 소스가 그대로 나가고, 그것이
 * 이 파일 맨 위에 적힌 사고와 같은 모양이다.
 */
describe('AXMAP_AUTH 환경변수로도 막는다', () => {
  const PORT2 = 39218
  const BASE2 = `http://127.0.0.1:${PORT2}`
  const CRED2 = 'bm:env-secret'
  let proc2

  before(async () => {
    proc2 = spawn(
      process.execPath,
      // 🔴 `--auth` 를 **주지 않는다.** 환경변수만으로 걸려야 한다.
      [path.join(ROOT, 'app', 'server.mjs'), ROOT, String(PORT2), '--readonly'],
      { cwd: ROOT, stdio: 'ignore', windowsHide: true, env: { ...process.env, AXMAP_AUTH: CRED2 } },
    )
    const until = Date.now() + 30_000
    while (Date.now() < until) {
      try { await fetch(BASE2, { signal: AbortSignal.timeout(1000) }); return } catch {
        if (proc2?.exitCode != null) throw new Error(`서버가 죽었습니다 (exit ${proc2.exitCode})`)
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    throw new Error('서버가 뜨지 않았습니다')
  })

  after(() => proc2?.kill())

  for (const p of ['/', '/index.html', '/api/graph', '/없는-경로']) {
    it(`자격증명 없이 ${p} → 401`, async () => {
      const r = await fetch(BASE2 + p)
      assert.equal(r.status, 401, `${p} 가 인증 없이 ${r.status} 를 줬습니다`)
    })
  }

  it('맞는 자격증명 → 통과', async () => {
    const r = await fetch(BASE2, {
      headers: { authorization: `Basic ${Buffer.from(CRED2).toString('base64')}` },
    })
    assert.equal(r.status, 200)
  })

  it('🔴 argv 로 준 다른 값은 통하지 않는다 — 환경변수가 진짜 자물쇠다', async () => {
    const r = await fetch(BASE2, {
      headers: { authorization: `Basic ${Buffer.from('bm:test-secret').toString('base64')}` },
    })
    assert.equal(r.status, 401)
  })
})

/**
 * 🔴 공개로 열려는데 자격증명이 없으면 **뜨지 않아야** 한다.
 *
 * 예전에는 이 자리에 옛 이름 환경변수를 받아주는 한시적 호환이 있었다. 자격증명을
 * 서버의 env 파일이 공급하는데 거기가 아직 옛 이름이었기 때문이다. 그런데 그 호환이
 * 가리고 있던 진짜 문제는 따로 있었다 — **자격증명이 비면 AUTH 가 조용히 null 이
 * 되고, 공개 뷰어가 인증 없이 소스를 통째로 내보낸다.** 아무 오류도 안 난다.
 *
 * 호환은 이름을 하나 더 받을 뿐이고, 그 이름마저 틀리면 다시 열린다. 그래서
 * 호환을 늘리는 대신 실패 방향을 뒤집었다. 안 뜨는 것은 사람이 즉시 알고,
 * 조용히 열린 것은 아무도 모른다.
 */
describe('공개(--readonly)인데 자격증명이 없으면 뜨지 않는다', () => {
  it('서버가 종료 코드 1 로 죽는다 — 인증 없이 열리지 않는다', async () => {
    const env = { ...process.env }
    delete env.AXMAP_AUTH
    const proc = spawn(
      process.execPath,
      [path.join(ROOT, 'app', 'server.mjs'), ROOT, '39221', '--readonly'],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env },
    )
    let err = ''
    proc.stderr.on('data', (d) => { err += d })
    const code = await new Promise((res) => proc.on('exit', res))
    assert.equal(code, 1, '공개로 여는데 자격증명 없이 떴습니다 — 소스가 통째로 나갑니다')
    assert.match(err, /자격증명이 없습니다/)
  })

  it('--readonly 가 아니면 인증 없이도 뜬다 — 로컬에서 손으로 띄우는 경우', async () => {
    const env = { ...process.env }
    delete env.AXMAP_AUTH
    const PORT = 39222
    const proc = spawn(
      process.execPath,
      [path.join(ROOT, 'app', 'server.mjs'), ROOT, String(PORT)],
      { cwd: ROOT, stdio: 'ignore', windowsHide: true, env },
    )
    try {
      const until = Date.now() + 30_000
      let ok = false
      while (Date.now() < until) {
        try { await fetch(`http://127.0.0.1:${PORT}`, { signal: AbortSignal.timeout(1000) }); ok = true; break } catch {
          if (proc.exitCode != null) throw new Error(`서버가 죽었습니다 (exit ${proc.exitCode})`)
          await new Promise((r) => setTimeout(r, 200))
        }
      }
      assert.ok(ok, '로컬 모드에서 서버가 뜨지 않았습니다')
    } finally { proc.kill() }
  })
})
