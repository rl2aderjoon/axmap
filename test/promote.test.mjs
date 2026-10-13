/**
 * 승격 봇 테스트.
 *
 * 두 층을 따로 본다. `test/version.test.mjs`(순수)와 `test/gate.test.mjs`(바깥
 * 세계)를 가른 것과 같은 이유다.
 *
 *   1. `src/promote.mjs`   짝을 만드는 순수 판정 — 전부 여기서 고정한다
 *   2. `tools/promote.mjs` GitLab 을 부르는 실행기 — fetch·gate·git 을 주입한다
 *
 * 🔴 **진짜 GitLab 을 부르지 않는다.** 주입한 fetch 는 테스트가 준비하지 않은
 *    호출을 받으면 던진다. 그래서 코드가 몰래 다른 곳을 부르기 시작하면 초록으로
 *    넘어가지 못한다.
 *
 * 🔴 이 파일에서 절대 지우면 안 되는 것 둘 —
 *
 *      "머지 호출에 sha 가 들어간다"      빠지면 표가 없는 커밋이 머지된다
 *      "409 를 받으면 재시도하지 않는다"  재시도하면 그게 정확히 위 사고다
 *
 *    둘 다 **음성 테스트**(막아야 하는 것이 실제로 막히는지 보는 테스트)다.
 *    한 번도 실패하지 않는 검사기는 검사기가 아니다.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { planPromotions, formatPlan, describeStep, mergeCommitMessage, reviewTrailers, STEPS } from '../src/promote.mjs'
import { checkTarget } from '../src/mrtarget.mjs'
import { run, EXIT } from '../tools/promote.mjs'

/** 이 팀 저장소에 실제로 있는 브랜치들. */
const REAL = ['main', 'front/main', 'front/dev', 'back/main', 'back/dev']

/** 장부와 표가 사는 도구 전용 브랜치. 승격 대상이 되면 안 된다. */
const TOOL = ['axmap/claims', 'axmap/votes']

const sources = (plan) => plan.pairs.map((p) => `${p.source} -> ${p.target}`)
const skippedCodes = (plan) => plan.skipped.map((s) => s.code)

// ===========================================================================
// 1. 순수 판정
// ===========================================================================

describe('planPromotions — 하루 한 번 (dev-to-part)', () => {
  it('존재하는 모든 파트 dev 를 같은 파트의 파트 브랜치로 올린다', () => {
    const plan = planPromotions(REAL, { step: 'dev-to-part' })
    assert.deepEqual(sources(plan), ['back/dev -> back/main', 'front/dev -> front/main'])
  })

  it('파트 브랜치 이름이 func 이어도 같게 취급한다', () => {
    const plan = planPromotions(['main', 'ai/func', 'ai/dev'], { step: 'dev-to-part' })
    assert.deepEqual(sources(plan), ['ai/dev -> ai/func'])
  })

  it('main 과 func 이 둘 다 있으면 main 쪽으로만 올리고 그 사실을 남긴다', () => {
    const plan = planPromotions(['ai/main', 'ai/func', 'ai/dev'], { step: 'dev-to-part' })
    assert.deepEqual(sources(plan), ['ai/dev -> ai/main'])
    assert.ok(skippedCodes(plan).includes('duplicate-target'))
  })

  it('🔴 짝이 실제로 없으면 만들지 않는다 — 없는 브랜치로 MR 을 열 수는 없다', () => {
    const plan = planPromotions(['main', 'ai/dev'], { step: 'dev-to-part' })
    assert.deepEqual(sources(plan), [])
    assert.ok(skippedCodes(plan).includes('no-target'))
    // 왜 안 올렸는지가 출력에 남아야 한다. 없으면 사람이 자기 브랜치를 의심한다.
    assert.match(formatPlan(plan), /ai\/main/)
  })

  it('파트 없는 dev 는 올릴 곳을 추측하지 않는다', () => {
    const plan = planPromotions(['main', 'dev'], { step: 'dev-to-part' })
    assert.deepEqual(sources(plan), [])
    assert.ok(skippedCodes(plan).includes('no-part'))
  })

  it('기능 브랜치는 소스가 되지 않는다 — 봇은 사람의 MR 을 대신 열지 않는다', () => {
    const plan = planPromotions([...REAL, 'feat/S15P21E201-144-login'], { step: 'dev-to-part' })
    assert.ok(!sources(plan).some((s) => s.startsWith('feat/')))
  })
})

describe('planPromotions — 주 한 번 (part-to-main)', () => {
  it('존재하는 모든 파트 브랜치를 최상위 main 으로 올린다', () => {
    const plan = planPromotions(REAL, { step: 'part-to-main' })
    assert.deepEqual(sources(plan), ['back/main -> main', 'front/main -> main'])
  })

  it('파트 dev 는 최상위로 건너뛰지 않는다', () => {
    const plan = planPromotions(REAL, { step: 'part-to-main' })
    assert.ok(!sources(plan).some((s) => s.startsWith('front/dev')))
    assert.ok(!sources(plan).some((s) => s.startsWith('back/dev')))
  })

  it('최상위 main 이 없으면 올릴 곳을 추측하지 않는다', () => {
    const plan = planPromotions(['front/main', 'front/dev'], { step: 'part-to-main' })
    assert.deepEqual(sources(plan), [])
    assert.ok(skippedCodes(plan).includes('no-top-main'))
  })

  it('최상위 main 은 자기 자신에게 올라가지 않는다 (최상위는 종점이다)', () => {
    const plan = planPromotions(REAL, { step: 'part-to-main' })
    assert.ok(!plan.pairs.some((p) => p.source === 'main'))
  })
})

describe('planPromotions — 봇은 자기 규칙의 예외가 아니다', () => {
  /**
   * 🔴 이 테스트가 이 파일에서 제일 중요하다.
   *
   * 봇이 만든 짝은 **사람이 여는 MR 과 같은 문**(`checkTarget`)을 지나야 한다.
   * 짝을 만드는 쪽에 규칙을 새로 적으면 `front/dev -> back/main` 같은 것이
   * 봇의 손으로만 통과하게 된다 — 프론트에서 검토된 적 없는 코드가 백엔드 파트의
   * 릴리스 후보로 들어간다.
   *
   * 그래서 "막히는 예를 하나 넣는" 대신 **모든 짝에 대해** 확인한다. 예를 하나만
   * 넣으면 짝을 만드는 방식이 바뀔 때 그 예가 더는 후보가 아니게 되어 조용히
   * 무의미해진다.
   */
  const HOSTILE = [
    ...REAL, ...TOOL,
    'ai/dev', 'ai/main', 'infra/func', 'infra/dev',
    'feat/S15P21E201-144-login', 'chore/axmap-bootstrap',
    'dev', 'func', 'master', 'axmap/claims/dev',
  ]

  for (const step of STEPS) {
    it(`${step} — 만든 짝은 전부 checkTarget 을 지난다`, () => {
      const plan = planPromotions(HOSTILE, { step })
      assert.ok(plan.pairs.length > 0, '아무 짝도 안 만들면 이 검사는 아무것도 안 본다')
      for (const p of plan.pairs) {
        const v = checkTarget(p.source, p.target)
        assert.equal(v.exit, 0, `${p.source} -> ${p.target} 가 브랜치 규칙을 어겼습니다: ${v.message}`)
      }
    })

    it(`${step} — 파트를 건너뛰는 짝은 만들지 않는다 (front/dev -> back/main)`, () => {
      const plan = planPromotions(HOSTILE, { step })
      assert.ok(!sources(plan).includes('front/dev -> back/main'))
      assert.ok(!sources(plan).includes('back/dev -> front/main'))
    })

    it(`${step} — 도구 전용 브랜치는 소스도 대상도 되지 않는다`, () => {
      const plan = planPromotions(HOSTILE, { step })
      for (const p of plan.pairs) {
        for (const reserved of TOOL) {
          assert.notEqual(p.source, reserved)
          assert.notEqual(p.target, reserved)
        }
      }
    })
  }

  it('모르는 주기는 추측하지 않고 던진다', () => {
    assert.throws(() => planPromotions(REAL, { step: 'everything-to-main' }), /알 수 없는 승격 주기/)
    assert.throws(() => planPromotions(REAL, {}), /알 수 없는 승격 주기/)
  })

  it('같은 브랜치가 두 번 들어와도 짝은 하나다', () => {
    const plan = planPromotions([...REAL, 'front/dev', 'front/dev'], { step: 'dev-to-part' })
    assert.equal(sources(plan).filter((s) => s.startsWith('front/dev')).length, 1)
  })

  it('주기 이름은 사람이 읽는 말로 나온다', () => {
    for (const step of STEPS) assert.notEqual(describeStep(step), '알 수 없는 주기')
  })
})

// ===========================================================================
// 2. 실행기 — 바깥 세계를 전부 주입한다
// ===========================================================================

const API = 'https://lab.example.com/api/v4'
const PROJECT = '4242'
const TOKEN = 'glpat-테스트토큰'
const ENV = { AXMAP_BOT_TOKEN: TOKEN, CI_API_V4_URL: API, CI_PROJECT_ID: PROJECT }

/** 판정에 쓴 커밋. 머지 호출에 이 값이 그대로 실려야 한다. */
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

/**
 * 가짜 GitLab.
 *
 * 🔴 준비하지 않은 호출을 받으면 **던진다.** 조용히 빈 응답을 주면 코드가 몰래
 *    다른 엔드포인트를 부르기 시작해도 테스트가 초록으로 남는다.
 */
function fakeGitlab(opts = {}) {
  const branches = opts.branches ?? ['main', 'front/main', 'front/dev']
  const ahead = opts.ahead ?? 3
  const openMr = opts.openMr ?? null
  const mergeStatus = opts.mergeStatus ?? 200
  const createStatus = opts.createStatus ?? 201
  const branchesStatus = opts.branchesStatus ?? 200
  const calls = []

  const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) })

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers: init.headers, href: u.href })

    if (method === 'GET' && u.pathname.endsWith('/repository/branches')) {
      if (branchesStatus !== 200) return reply(branchesStatus, { message: '401 Unauthorized' })
      const page = Number(u.searchParams.get('page') ?? '1')
      return reply(200, page === 1 ? branches.map((name) => ({ name })) : [])
    }
    if (method === 'GET' && u.pathname.endsWith('/repository/compare')) {
      const n = typeof ahead === 'function' ? ahead(u.searchParams.get('to'), u.searchParams.get('from')) : ahead
      return reply(200, { commits: Array.from({ length: n }, (_, i) => ({ id: `commit${i}` })) })
    }
    if (method === 'GET' && u.pathname.endsWith('/merge_requests')) {
      return reply(200, openMr ? [openMr] : [])
    }
    if (method === 'POST' && u.pathname.endsWith('/merge_requests')) {
      if (createStatus >= 300) return reply(createStatus, { message: 'branch not found' })
      return reply(createStatus, { iid: 7, web_url: 'https://lab.example.com/mr/7' })
    }
    if (method === 'PUT' && /\/merge_requests\/\d+\/merge$/.test(u.pathname)) {
      if (mergeStatus === 200) return reply(200, { iid: 7, state: 'merged' })
      if (mergeStatus === 409) return reply(409, { message: 'SHA does not match HEAD of source branch' })
      return reply(mergeStatus, { message: 'Method Not Allowed' })
    }
    throw new Error(`테스트가 준비하지 않은 호출: ${method} ${u.pathname}`)
  }

  return {
    fetchImpl,
    calls,
    of: (method) => calls.filter((c) => c.method === method),
    merges: () => calls.filter((c) => c.method === 'PUT' && /\/merge$/.test(c.path)),
    creates: () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/merge_requests')),
  }
}

/** 게이트를 주입한다. 진짜 게이트는 git 을 만지므로 여기서는 부르지 않는다. */
function fakeGate({ exit = 0, sha = SHA, text = '', tally = null, approvals = 0, threshold = 0 } = {}) {
  const seen = []
  // 🔴 `tally` 를 그대로 실어 준다. 실제 `gate.mjs --json` 이 `judge()` 의 결과를
  //    통째로 찍기 때문이다 — 표의 이유(note)도 그 안에 있다. 여기서 모양을 줄이면
  //    테스트만 통과하고 진짜 판정에서는 트레일러가 비어 나온다.
  const gate = ({ source, target }) => {
    seen.push({ source, target })
    return { exit, sha, text, tally, approvals, threshold }
  }
  gate.seen = seen
  return gate
}

/** 출력을 모아서 한 덩어리로 본다. */
function sink() {
  const lines = []
  const fn = (s) => lines.push(String(s))
  fn.lines = lines
  fn.text = () => lines.join('\n')
  return fn
}

/** fetch 가 한 번이라도 불리면 터진다 — 토큰 없는 길에서 쓴다. */
const forbiddenFetch = async () => { throw new Error('토큰이 없는데 GitLab 을 불렀습니다') }

describe('실행기 — 토큰이 없을 때', () => {
  /** 원격 추적 ref 만 아는 가짜 git. */
  const fakeGit = (names = ['main', 'front/main', 'front/dev', 'HEAD'], ahead = '2') => (args) => {
    const a = args.join(' ')
    if (a === 'remote') return { code: 0, out: 'origin', err: '' }
    if (a === 'config --get axmap.remote') return { code: 0, out: 'origin', err: '' }
    if (a.startsWith('for-each-ref --format=%(refname) refs/remotes/origin/')) {
      return { code: 0, out: names.map((n) => `refs/remotes/origin/${n}`).join('\n'), err: '' }
    }
    if (a.startsWith('rev-list --count')) return { code: 0, out: ahead, err: '' }
    return { code: 1, out: '', err: `테스트가 준비하지 않은 git 호출: ${a}` }
  }

  it('🔴 exit 0 이고, 무엇을 했을지 계산해 찍고, 설정하는 법을 안내한다', async () => {
    const log = sink()
    const code = await run(['--step', 'dev-to-part', '--dry-run'], {
      env: {}, fetch: forbiddenFetch, git: fakeGit(), log, warn: log,
    })
    assert.equal(code, EXIT.OK)
    const out = log.text()
    assert.match(out, /AXMAP_BOT_TOKEN 이 없습니다/)
    assert.match(out, /front\/dev -> front\/main/)      // 무엇을 했을지 계산했다
    assert.match(out, /커밋 2개를 올렸을 것입니다/)
    assert.match(out, /Access Tokens/)                   // 설정하는 법
    assert.match(out, /Protected/)                       // 조용히 초록인 함정까지
  })

  it('🔴 --dry-run 이 아닌데 토큰이 없으면 그 사실이 출력 맨 앞에 온다', async () => {
    const log = sink()
    const code = await run(['--step', 'part-to-main'], {
      env: {}, fetch: forbiddenFetch, git: fakeGit(), log, warn: log,
    })
    assert.equal(code, EXIT.OK)
    // 끝만 보는 사람이 승격이 된 줄 알면 안 된다. 첫 줄이어야 한다.
    assert.match(log.lines[0], /AXMAP_BOT_TOKEN 이 없습니다/)
    assert.match(log.lines[0], /아무것도 승격되지 않았습니다/)
  })

  it('올릴 것이 없으면 그렇게 적는다', async () => {
    const log = sink()
    await run(['--step', 'dev-to-part', '--dry-run'], {
      env: {}, fetch: forbiddenFetch, git: fakeGit(undefined, '0'), log, warn: log,
    })
    assert.match(log.text(), /올릴 것이 없습니다/)
  })
})

describe('실행기 — 설정이 모자랄 때', () => {
  it('--step 이 없으면 추측하지 않고 실패한다', async () => {
    const warn = sink()
    assert.equal(await run([], { env: ENV, fetch: forbiddenFetch, log: warn, warn }), EXIT.ERROR)
    assert.equal(await run(['--step', 'main-to-everything'], { env: ENV, fetch: forbiddenFetch, log: warn, warn }), EXIT.ERROR)
  })

  it('토큰은 있는데 프로젝트를 모르면 설정 오류다', async () => {
    const warn = sink()
    const code = await run(['--step', 'dev-to-part'], {
      env: { AXMAP_BOT_TOKEN: TOKEN }, fetch: forbiddenFetch, log: warn, warn,
    })
    assert.equal(code, EXIT.ERROR)
    assert.match(warn.text(), /어느 프로젝트/)
  })

  it('🔴 플래그가 환경변수를 이긴다', async () => {
    const gl = fakeGitlab({ ahead: 0 })
    await run(['--step', 'dev-to-part', '--project', '999', '--api', 'https://other.example/api/v4'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate(), log: sink(), warn: sink(),
    })
    assert.ok(gl.calls.length > 0)
    for (const c of gl.calls) {
      assert.match(c.href, /^https:\/\/other\.example\/api\/v4\/projects\/999\//)
    }
  })

  it('브랜치 목록을 못 읽으면 실패한다 — 못 읽은 것을 "올릴 게 없다" 로 읽지 않는다', async () => {
    const gl = fakeGitlab({ branchesStatus: 401 })
    const warn = sink()
    const code = await run(['--step', 'dev-to-part'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate(), log: warn, warn,
    })
    assert.equal(code, EXIT.ERROR)
    assert.equal(gl.creates().length, 0)
  })

  it('토큰은 URL 이 아니라 헤더로 간다', async () => {
    const gl = fakeGitlab({ ahead: 0 })
    await run(['--step', 'dev-to-part'], { env: ENV, fetch: gl.fetchImpl, gate: fakeGate(), log: sink(), warn: sink() })
    for (const c of gl.calls) {
      assert.ok(!c.href.includes(TOKEN), '토큰이 URL 에 들어갔습니다')
      assert.equal(c.headers['PRIVATE-TOKEN'], TOKEN)
    }
  })
})

describe('실행기 — 올릴 것이 없으면 아무것도 만들지 않는다', () => {
  it('🔴 소스에 새 커밋이 없으면 MR 을 만들지 않는다', async () => {
    const gl = fakeGitlab({ ahead: 0 })
    const gate = fakeGate()
    const log = sink()
    const code = await run(['--step', 'dev-to-part'], { env: ENV, fetch: gl.fetchImpl, gate, log, warn: log })

    assert.equal(code, EXIT.OK)          // 아무 일도 안 한 것은 성공이다
    assert.equal(gl.creates().length, 0) // MR 을 만들지 않았다
    assert.equal(gl.merges().length, 0)
    assert.equal(gate.seen.length, 0)    // 게이트까지 가지도 않았다
    assert.match(log.text(), /올릴 것이 없습니다/)
  })
})

describe('실행기 — 정족수', () => {
  it('🔴 게이트가 2(미달)면 머지 호출이 아예 일어나지 않는다', async () => {
    const gl = fakeGitlab()
    const log = sink()
    const code = await run(['--step', 'dev-to-part'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate({ exit: 2, text: '합의 미달 — 유효 찬성 1 / 필요 2' }), log, warn: log,
    })
    assert.equal(gl.merges().length, 0, '표가 모자란데 머지를 걸었습니다')
    assert.equal(code, EXIT.OK, '미달은 실패가 아니다 — 사람이 투표하면 다음 주기에 풀린다')
    assert.match(log.text(), /표가 모자랍니다/)
    assert.equal(gl.creates().length, 1, '표가 모자라도 MR 은 열어 둔다 — 열려 있어야 투표할 수 있다')
  })

  it('🔴 게이트가 1(판정 불가)이면 잡이 실패한다 — 판정 불가는 통과가 아니다', async () => {
    const gl = fakeGitlab()
    const log = sink()
    const code = await run(['--step', 'dev-to-part'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate({ exit: 1, sha: null, text: '합의 판정 불가' }), log, warn: log,
    })
    assert.equal(code, EXIT.ERROR)
    assert.equal(gl.merges().length, 0)
  })

  it('게이트가 4(정책이 깨짐)면 그 코드를 그대로 낸다', async () => {
    const gl = fakeGitlab()
    const code = await run(['--step', 'dev-to-part'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate({ exit: 4, sha: null }), log: sink(), warn: sink(),
    })
    assert.equal(code, EXIT.POLICY_BROKEN)
    assert.equal(gl.merges().length, 0)
  })

  it('충족인데 판정에 쓴 커밋을 못 받으면 머지하지 않는다', async () => {
    const gl = fakeGitlab()
    const log = sink()
    const code = await run(['--step', 'dev-to-part'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate({ exit: 0, sha: null }), log, warn: log,
    })
    assert.equal(gl.merges().length, 0, 'sha 없이 머지하면 표가 없는 커밋이 들어갈 수 있다')
    assert.equal(code, EXIT.ERROR)
  })

  it('게이트는 봇이 만든 그 짝으로 부른다', async () => {
    const gl = fakeGitlab()
    const gate = fakeGate({ exit: 2 })
    await run(['--step', 'dev-to-part'], { env: ENV, fetch: gl.fetchImpl, gate, log: sink(), warn: sink() })
    assert.deepEqual(gate.seen, [{ source: 'front/dev', target: 'front/main' }])
  })
})

describe('실행기 — 머지 (🔴 이 절이 이 작업의 핵심 요구다)', () => {
  it('🔴 머지 호출에 sha 가 들어간다 — 정족수를 판정할 때 쓴 그 커밋이다', async () => {
    const gl = fakeGitlab()
    const code = await run(['--step', 'dev-to-part'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate({ exit: 0, sha: SHA }), log: sink(), warn: sink(),
    })
    assert.equal(code, EXIT.OK)
    const merges = gl.merges()
    assert.equal(merges.length, 1)
    // 이 단언이 이 파일의 이유다. 빠지면 판정과 머지 사이에 들어온 커밋이
    // 표 없이 머지된다 (CAS 가 사라진다).
    assert.equal(merges[0].body.sha, SHA)
  })

  it('🔴 merge_when_pipeline_succeeds 를 쓰지 않는다 — 판정 시점과 머지 시점을 벌리지 않는다', async () => {
    const gl = fakeGitlab()
    await run(['--step', 'dev-to-part'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate(), log: sink(), warn: sink(),
    })
    const body = gl.merges()[0].body
    assert.notEqual(body.merge_when_pipeline_succeeds, true)
    assert.notEqual(body.merge_when_pipeline_succeeds, 'true')
  })

  it('소스 브랜치를 지우지 않는다 — front/dev 가 사라지면 그 파트가 멈춘다', async () => {
    const gl = fakeGitlab()
    await run(['--step', 'dev-to-part'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate(), log: sink(), warn: sink(),
    })
    assert.equal(gl.merges()[0].body.should_remove_source_branch, false)
    assert.equal(gl.creates()[0].body.remove_source_branch, false)
  })

  it('🔴 409 를 받으면 재시도하지 않는다 — 바뀐 내용은 새로 표를 받아야 한다', async () => {
    const gl = fakeGitlab({ mergeStatus: 409 })
    const log = sink()
    const code = await run(['--step', 'dev-to-part'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate(), log, warn: log,
    })
    // 재시도 루프를 넣으면 여기가 빨개진다.
    assert.equal(gl.merges().length, 1, '409 뒤에 머지를 다시 걸었습니다')
    assert.equal(code, EXIT.OK, '409 는 고장이 아니라 "내용이 바뀌었다" 는 뜻이다')
    assert.match(log.text(), /409/)
    assert.match(log.text(), /재시도하지 않습니다/)
  })

  /**
   * 🔴 405 는 실패가 아니다.
   *
   * `Pipelines must succeed` 가 켜져 있으면 파이프라인이 초록이 되기 전에는 머지가
   * 안 되는데, 봇은 바로 앞 단계에서 MR 을 **방금 만들었다.** 그 주기에는 거의
   * 언제나 405 다. 이걸 실패로 세면 **MR 을 만드는 밤마다 스케줄 잡이 빨개지고**,
   * 늘 빨간 잡은 아무도 안 읽는다.
   *
   * 넘어가되 조용히 넘어가지 않는다 — 다음 주기에 다시 온다.
   */
  it('405(아직 머지 불가)는 잡을 실패시키지 않고 다음 주기로 넘긴다', async () => {
    const gl = fakeGitlab({ mergeStatus: 405 })
    const log = sink()
    const code = await run(['--step', 'dev-to-part'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate(), log, warn: log,
    })
    assert.equal(code, EXIT.OK)
    assert.equal(gl.merges().length, 1)
    // 조용히 넘어가면 아무도 승격이 멈춘 것을 모른다.
    assert.match(log.text(), /다음 주기에 다시 봅니다/)
  })

  it('405·409 가 아닌 머지 실패는 잡을 실패시킨다', async () => {
    const gl = fakeGitlab({ mergeStatus: 500 })
    const code = await run(['--step', 'dev-to-part'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate(), log: sink(), warn: sink(),
    })
    assert.equal(code, EXIT.ERROR)
    assert.equal(gl.merges().length, 1)
  })
})

describe('실행기 — MR 을 두 번 만들지 않는다', () => {
  it('같은 (소스, 타깃) 의 열린 MR 이 있으면 그것을 쓴다', async () => {
    const gl = fakeGitlab({ openMr: { iid: 12, source_branch: 'front/dev', target_branch: 'front/main' } })
    const log = sink()
    await run(['--step', 'dev-to-part'], { env: ENV, fetch: gl.fetchImpl, gate: fakeGate(), log, warn: log })
    assert.equal(gl.creates().length, 0)
    assert.equal(gl.merges().length, 1)
    assert.match(gl.merges()[0].path, /\/merge_requests\/12\/merge$/)
    assert.match(log.text(), /이미 열려 있는 MR/)
  })

  it('열린 MR 을 찾을 때 소스와 타깃을 둘 다 건다', async () => {
    const gl = fakeGitlab()
    await run(['--step', 'dev-to-part'], { env: ENV, fetch: gl.fetchImpl, gate: fakeGate({ exit: 2 }), log: sink(), warn: sink() })
    const look = gl.of('GET').find((c) => c.path.endsWith('/merge_requests'))
    assert.equal(look.query.source_branch, 'front/dev')
    assert.equal(look.query.target_branch, 'front/main')
    assert.equal(look.query.state, 'opened')
  })
})

describe('실행기 — --dry-run 은 아무것도 쓰지 않는다', () => {
  it('MR 도 안 만들고 머지도 안 한다', async () => {
    const gl = fakeGitlab()
    const log = sink()
    const code = await run(['--step', 'part-to-main', '--dry-run'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate(), log, warn: log,
    })
    assert.equal(code, EXIT.OK)
    assert.equal(gl.of('POST').length, 0)
    assert.equal(gl.of('PUT').length, 0)
    assert.match(log.text(), /머지했을 것입니다/)
  })
})

describe('실행기 — 여러 짝', () => {
  const TWO = ['main', 'front/main', 'front/dev', 'back/main', 'back/dev']

  it('한 짝이 실패해도 나머지를 계속 돈다', async () => {
    // back 은 올릴 것이 있고 front 는 없다. 게이트는 판정 불가를 낸다.
    const gl = fakeGitlab({ branches: TWO, ahead: (to) => (to === 'back/dev' ? 2 : 0) })
    const log = sink()
    const code = await run(['--step', 'dev-to-part'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate({ exit: 1, sha: null }), log, warn: log,
    })
    assert.equal(code, EXIT.ERROR)
    assert.match(log.text(), /back\/dev/)
    assert.match(log.text(), /front\/dev/)
    assert.equal(gl.merges().length, 0)
  })

  it('정책이 깨진 것(4)이 판정 불가(1)보다 먼저 나온다 — 더 구체적인 신호다', async () => {
    const gl = fakeGitlab({ branches: TWO })
    let n = 0
    const gate = () => (n++ === 0 ? { exit: 1, sha: null, text: '' } : { exit: 4, sha: null, text: '' })
    const code = await run(['--step', 'dev-to-part'], { env: ENV, fetch: gl.fetchImpl, gate, log: sink(), warn: sink() })
    assert.equal(code, EXIT.POLICY_BROKEN)
  })

  it('요약에 실제로 무엇을 했는지 적는다', async () => {
    const gl = fakeGitlab({ branches: TWO })
    const log = sink()
    await run(['--step', 'part-to-main'], { env: ENV, fetch: gl.fetchImpl, gate: fakeGate(), log, warn: log })
    assert.match(log.text(), /요약/)
    assert.match(log.text(), /머지\s+: 2개/)
  })
})

/**
 * ── 표의 이유를 머지 커밋에 싣는다 ──────────────────────────────────────────
 *
 * 🔴 이 절에서 지우면 안 되는 것 —
 *
 *      "git 이 실제로 뽑아낸다"          라벨을 한글로 바꾸면 조용히 깨진다.
 *                                        진짜 git 을 불러서 확인한다
 *      "여러 줄 이유가 한 줄로 접힌다"   안 접으면 뒷줄이 트레일러 밖으로 샌다
 *      "표가 없으면 필드를 안 보낸다"    빈 값을 보내면 GitLab 기본 메시지를
 *                                        덮어써서 이력이 나빠진다
 */
const VOTE = (over = {}) => ({
  voter: 'yeaseung-lee', email: 'yeaseung.lee96@example.com', vote: 'approve',
  sha: SHA, at: '2026-08-28T00:00:00.000Z', note: 'ERD 칼럼 이름을 온톨로지와 대조했습니다', ...over,
})
const VERDICT = (over = {}) => ({
  exit: 0, ok: true, sha: SHA, approvals: 1, threshold: 2,
  tally: { approvals: 1, counted: [VOTE()], rejections: [], invalid: [] }, ...over,
})
const tallyOf = (counted, rejections = []) => ({ approvals: counted.length, counted, rejections, invalid: [] })

describe('표의 이유 — 트레일러로 만든다 (순수)', () => {
  it('찬성과 반대가 각자의 라벨로 나오고, 한글이 값의 맨 앞에 온다', () => {
    const t = reviewTrailers(VERDICT({
      tally: tallyOf(
        [VOTE()],
        [VOTE({ voter: 'jinmiri', email: 'wlsalfl321@example.com', vote: 'reject', note: '마이그레이션이 빠졌습니다' })],
      ),
    }))
    assert.equal(t.length, 2)
    assert.equal(t[0], 'Reviewed-by: 찬성 — yeaseung-lee <yeaseung.lee96@example.com> · ERD 칼럼 이름을 온톨로지와 대조했습니다')
    assert.equal(t[1], 'Rejected-by: 반대 — jinmiri <wlsalfl321@example.com> · 마이그레이션이 빠졌습니다')
  })

  it('🔴 반대표도 싣는다 — 반대는 정족수에 안 들어가므로 반대가 있어도 머지된다', () => {
    // 그때 반대가 아무 데도 안 남으면 나중에 "아무도 몰랐다" 로 기록된다.
    const t = reviewTrailers(VERDICT({
      tally: tallyOf(
        [VOTE(), VOTE({ voter: 'bob', email: 'bob@example.com' })],
        [VOTE({ voter: 'ann', email: 'ann@example.com', vote: 'reject', note: '되돌리기 어렵습니다' })],
      ),
    }))
    assert.equal(t.filter((l) => l.startsWith('Rejected-by:')).length, 1)
  })

  it('이유가 비어 있으면 꼬리를 안 붙인다 — 정책이 이유를 요구하지 않을 수 있다', () => {
    const t = reviewTrailers(VERDICT({ tally: tallyOf([VOTE({ note: '' })]) }))
    assert.equal(t[0], 'Reviewed-by: 찬성 — yeaseung-lee <yeaseung.lee96@example.com>')
    assert.ok(!t[0].includes('·'), '빈 이유에 꼬리를 붙이면 이유 칸이 깨진 것처럼 보인다')
  })

  it('🔴 여러 줄 이유가 한 줄로 접힌다 — 트레일러는 한 줄이어야 한다', () => {
    const t = reviewTrailers(VERDICT({ tally: tallyOf([VOTE({ note: '첫 줄\n\n둘째 줄\t셋째' })]) }))
    assert.equal(t.length, 1)
    assert.ok(!t[0].includes('\n'), '줄바꿈이 남으면 뒷줄이 트레일러 밖으로 새어 본문이 된다')
    assert.match(t[0], /· 첫 줄 둘째 줄 셋째$/)
  })

  it('아주 긴 이유는 자른다 — 한 줄은 유지한다', () => {
    const t = reviewTrailers(VERDICT({ tally: tallyOf([VOTE({ note: '가'.repeat(500) })]) }))
    assert.ok(t[0].length < 320, `너무 길다: ${t[0].length}`)
    assert.ok(t[0].endsWith('…'), '자른 것을 표시해야 원문이 더 있다는 것을 안다')
  })

  it('판정이 셀 수 없었으면 빈 배열이다 — 없는 것을 지어내지 않는다', () => {
    assert.deepEqual(reviewTrailers({ exit: 4, ok: false, stage: 'policy', problems: [] }), [])
    assert.deepEqual(reviewTrailers(null), [])
  })

  it('메시지 첫 줄은 GitLab 기본형 그대로다 — 봇 머지와 사람 머지가 달라 보이면 안 된다', () => {
    const m = mergeCommitMessage({ source: 'front/dev', target: 'front/main', verdict: VERDICT() })
    assert.equal(m.split('\n')[0], "Merge branch 'front/dev' into 'front/main'")
    assert.match(m, /정족수 1\/2 · 판정 커밋 a1b2c3d4e5f6/)
    assert.match(m, /\nReviewed-by: 찬성 — /)
  })

  it('🔴 표가 하나도 없으면 null 이다 — 빈 본문을 보내면 GitLab 기본 메시지를 덮어쓴다', () => {
    assert.equal(mergeCommitMessage({ source: 'a', target: 'b', verdict: VERDICT({ tally: tallyOf([]) }) }), null)
  })
})

/**
 * 🔴 **진짜 git 을 부른다.** 위의 순수 테스트는 "우리가 의도한 글자가 나오는가" 만
 *    본다. 그런데 이 기능의 값어치는 **git 이 그 줄을 뽑아낼 수 있는가** 에 전부
 *    걸려 있고, 그건 우리 코드가 아니라 git 이 정한다.
 *
 *    2026-08-28 실측: 콜론 앞자리에 한글이나 괄호가 섞이면 git 은 그 줄을
 *    트레일러가 아니라 평범한 본문으로 보고 **조용히 지나친다.** 오류도 안 난다.
 *    라벨을 한글로 바꾸는 것은 자연스러운 개선처럼 보이므로, 막아 두지 않으면
 *    다음 사람이 그렇게 고치고 아무도 못 알아챈다.
 */
describe('표의 이유 — git 이 실제로 뽑아내는가 (진짜 git)', () => {
  const parse = (msg) => spawnSync('git', ['interpret-trailers', '--parse'],
    { input: msg, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)

  it('🔴 git 이 우리가 만든 줄을 트레일러로 뽑아낸다', () => {
    const m = mergeCommitMessage({
      source: 'front/dev', target: 'front/main',
      verdict: VERDICT({
        approvals: 2, threshold: 2,
        tally: tallyOf([VOTE()], [VOTE({ voter: 'ann', email: 'ann@example.com', vote: 'reject', note: '되돌리기 어렵습니다' })]),
      }),
    })
    const got = parse(m)
    assert.equal(got.length, 2, `git 이 못 뽑았다. 콜론 앞자리를 한글로 바꾸지 않았는지 보라:\n${m}`)
    assert.ok(got[0].startsWith('Reviewed-by: 찬성 — '))
    assert.ok(got[1].startsWith('Rejected-by: 반대 — '))
  })

  it('🔴 콜론 앞을 한글로 바꾸면 git 이 무시한다 — 이 사실을 여기 고정한다', () => {
    // 이 테스트가 지키는 것은 우리 코드가 아니라 **판단의 근거**다. 언젠가
    // git 이 이걸 지원하게 되면 이 테스트가 빨개지고, 그때 라벨을 한글로
    // 바꾸는 선택지가 열린다. 근거가 바뀌면 결정도 다시 본다.
    assert.equal(parse('제목\n\n찬성(Reviewed-by): bob <b@x.com>').length, 0)
    assert.equal(parse('제목\n\n찬성: bob <b@x.com>').length, 0)
    assert.equal(parse('제목\n\nReviewed-by: bob <b@x.com>').length, 1)
  })
})

describe('실행기 — 머지 커밋에 표의 이유가 실린다', () => {
  it('🔴 머지 호출에 merge_commit_message 가 들어가고 그 안에 이유가 있다', async () => {
    const gl = fakeGitlab()
    const code = await run(['--step', 'dev-to-part'], {
      env: ENV,
      fetch: gl.fetchImpl,
      gate: fakeGate({
        exit: 0, sha: SHA, approvals: 2, threshold: 2,
        tally: tallyOf([VOTE(), VOTE({ voter: 'bob', email: 'bob@example.com', note: '스키마 되돌리기 확인' })]),
      }),
      log: sink(), warn: sink(),
    })
    assert.equal(code, EXIT.OK)
    const msg = gl.merges()[0].body.merge_commit_message
    assert.ok(msg, 'merge_commit_message 가 없으면 이유가 git 밖에만 남는다')
    assert.match(msg, /Reviewed-by: 찬성 — yeaseung-lee .*ERD 칼럼/)
    assert.match(msg, /Reviewed-by: 찬성 — bob .*스키마 되돌리기 확인/)
  })

  it('표를 못 받았으면 merge_commit_message 를 아예 안 보낸다', async () => {
    const gl = fakeGitlab()
    await run(['--step', 'dev-to-part'], {
      env: ENV, fetch: gl.fetchImpl, gate: fakeGate({ exit: 0, sha: SHA }), log: sink(), warn: sink(),
    })
    assert.ok(!('merge_commit_message' in gl.merges()[0].body),
      '빈 값을 보내면 GitLab 기본 메시지를 덮어쓴다')
  })

  it('sha 는 그대로 실린다 — 이 변경이 CAS 를 건드리지 않았는지 본다', async () => {
    const gl = fakeGitlab()
    await run(['--step', 'dev-to-part'], {
      env: ENV, fetch: gl.fetchImpl,
      gate: fakeGate({ exit: 0, sha: SHA, tally: tallyOf([VOTE()]) }),
      log: sink(), warn: sink(),
    })
    assert.equal(gl.merges()[0].body.sha, SHA)
  })
})
