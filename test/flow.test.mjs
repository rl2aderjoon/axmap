/**
 * 기본 흐름 (D15) — 다섯 걸음.
 *
 * 이 테스트가 지키는 것은 두 가지다.
 *   ① 흐름이 **순서**를 준다는 것 (병렬 목록이 아니다)
 *   ② 못 알아낸 것을 **말한다**는 것. 침묵으로 실패하지 않는다.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  basicFlow, classifyUnreached, entryCandidates, importTree, layersFrom, manifestInfo, readmeSummary,
} from '../app/lib/flow.mjs'

// ---------------------------------------------------------------------------

describe('① README 에서 무엇을 하는 물건인지 뽑는다', () => {
  it('배지 줄을 건너뛴다', () => {
    const r = readmeSummary([
      '<p align="center"><img src="logo.png"></p>',
      '',
      '# acme',
      '',
      '[![Build](https://img.shields.io/x)](https://ci) [![npm](https://img.shields.io/y)](https://npm)',
      '',
      '사진을 올리고 앨범으로 묶는 서버다.',
      '',
      '## 설치',
    ].join('\n'))
    assert.equal(r.title, 'acme')
    // 🔴 배지를 집으면 화면에 마크다운 이미지 문법이 프로젝트 설명으로 뜬다.
    assert.equal(r.summary, '사진을 올리고 앨범으로 묶는 서버다.')
  })

  it('설명이 없고 배지뿐이면 summary 는 null 이다', () => {
    const r = readmeSummary('# acme\n\n[![a](b)](c)\n\n## 설치\n\n어쩌고')
    // 제목은 있지만 설명은 없다. 없는 것을 지어내지 않는다.
    assert.equal(r.title, 'acme')
    assert.equal(r.summary, null)
  })

  it('빈 문자열이면 null', () => {
    assert.equal(readmeSummary(''), null)
    assert.equal(readmeSummary(null), null)
  })

  it('첫 문단만 가져온다 — 다음 제목에서 끊는다', () => {
    const r = readmeSummary('# a\n\n한 줄.\n이어지는 줄.\n\n## 다음\n\n여긴 아니다.')
    assert.equal(r.summary, '한 줄. 이어지는 줄.')
  })
})

// ---------------------------------------------------------------------------

describe('② 진입점은 근거의 종류와 함께 낸다', () => {
  let dir
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-flow-'))
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'acme', description: '사진 서버', bin: { acme: 'bin/cli.mjs' },
    }))
    fs.writeFileSync(path.join(dir, 'bin/cli.mjs'), '#!/usr/bin/env node\nimport "../src/core.mjs"\n')
    fs.writeFileSync(path.join(dir, 'src/core.mjs'), 'export const x = 1\n')
    fs.writeFileSync(path.join(dir, 'src/index.mjs'), 'export const y = 2\n')
  })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const nodes = () => [
    { id: 'bin/cli.mjs', lang: 'js', lines: 2 },
    { id: 'src/core.mjs', lang: 'js', lines: 1 },
    { id: 'src/index.mjs', lang: 'js', lines: 1 },
  ]
  const edges = () => [{ source: 'bin/cli.mjs', target: 'src/core.mjs', directed: true }]

  it('선언된 것이 관례적인 이름보다 앞선다', () => {
    const r = entryCandidates(dir, nodes(), edges())
    assert.equal(r[0].path, 'bin/cli.mjs')
    assert.equal(r[0].rank, 1)
    assert.ok(r[0].evidence.some((e) => e.includes('bin.acme')), r[0].evidence.join('/'))

    const idx = r.find((x) => x.path === 'src/index.mjs')
    assert.equal(idx.rank, 3, '이름만 그런 것은 3등급')
  })

  it('그래프에 없는 파일은 후보가 되지 않는다', () => {
    // package.json 이 선언했더라도 스캔에 안 잡힌 파일을 화면에 띄우면
    // 눌렀을 때 아무 일도 안 일어난다.
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'acme', bin: { acme: 'bin/없는파일.mjs' },
    }))
    const r = entryCandidates(dir, nodes(), edges())
    assert.ok(!r.some((x) => x.path.includes('없는파일')))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'acme', description: '사진 서버', bin: { acme: 'bin/cli.mjs' },
    }))
  })

  it('🔴 자기 자신을 탐지하지 않는다 — 언어 게이트', () => {
    // 실제로 있었던 오탐이다. flow.mjs 안에 적힌 설명 문자열
    //   what: "if __name__ == '__main__'"
    // 이 바로 위 정규식에 걸려서, 이 파일 자신이 파이썬 진입점으로 잡혔다.
    // 패턴은 그 패턴이 의미를 갖는 언어에서만 돌아야 한다.
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-flow2-'))
    try {
      fs.writeFileSync(path.join(d2, 'detector.mjs'),
        'const P = [{ re: /x/, what: "if __name__ == \'__main__\'" }]\nexport default P\n')
      fs.writeFileSync(path.join(d2, 'real.py'), "if __name__ == '__main__':\n    main()\n")
      const ns = [
        { id: 'detector.mjs', lang: 'js', lines: 2 },
        { id: 'real.py', lang: 'python', lines: 2 },
      ]
      const r = entryCandidates(d2, ns, [])
      assert.ok(!r.some((x) => x.path === 'detector.mjs' && x.rank === 2),
        'JS 파일이 파이썬 진입점으로 잡혔다')
      assert.ok(r.some((x) => x.path === 'real.py' && x.rank === 2),
        '진짜 파이썬 진입점을 놓쳤다')
    } finally {
      fs.rmSync(d2, { recursive: true, force: true })
    }
  })

  it('매니페스트를 읽는다', () => {
    const m = manifestInfo(dir)
    assert.equal(m[0].file, 'package.json')
    assert.equal(m[0].name, 'acme')
    assert.equal(m[0].description, '사진 서버')
  })

  it('매니페스트가 깨져 있으면 unparsable 로 표시하고 죽지 않는다', () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-flow3-'))
    try {
      fs.writeFileSync(path.join(d2, 'package.json'), '{ 이건 JSON 이 아니다')
      const m = manifestInfo(d2)
      assert.equal(m[0].unparsable, true)
    } finally {
      fs.rmSync(d2, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------

describe('③ 계층 — 시작점에서 몇 겹인가', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, lang: 'js', lines: 10 }))

  it('시작점 여러 개에서 재고, 더 가까운 쪽을 취한다', () => {
    // a → b → c,  d → c    이면 c 는 d 기준 1겹이다 (a 기준으로는 2겹)
    const edges = [
      { source: 'a', target: 'b', directed: true },
      { source: 'b', target: 'c', directed: true },
      { source: 'd', target: 'c', directed: true },
    ]
    const r = layersFrom(nodes, edges, ['a', 'd'])
    const depthOf = (id) => r.layers.find((l) => l.files.some((f) => f.path === id)).depth
    assert.equal(depthOf('a'), 0)
    assert.equal(depthOf('d'), 0)
    assert.equal(depthOf('b'), 1)
    assert.equal(depthOf('c'), 1, '시작점 하나만 썼다면 2가 됐을 것이다')
  })

  it('🔴 공변경 엣지는 계층에 쓰지 않는다', () => {
    // 방향이 없는 엣지로 계층을 만들면 "다음에 불린다" 가 아니라
    // 그냥 이웃 목록이 된다.
    const edges = [
      { source: 'a', target: 'b', directed: true },
      { source: 'b', target: 'e', origin: 'cochange' },
    ]
    const r = layersFrom(nodes, edges, ['a'])
    assert.equal(r.reached, 2, 'e 가 공변경으로 딸려 들어왔다')
  })

  it('허브 경유 엣지도 쓰지 않는다', () => {
    const edges = [
      { source: 'a', target: 'b', directed: true },
      { source: 'b', target: 'e', directed: true, hub: true },
    ]
    assert.equal(layersFrom(nodes, edges, ['a']).reached, 2)
  })

  it('방향을 모르는 엣지는 양쪽으로 통과시킨다', () => {
    // 모른다고 없는 것으로 치면 조용히 빠뜨리게 된다.
    const edges = [{ source: 'b', target: 'a', directed: false }]
    assert.equal(layersFrom(nodes, edges, ['a']).reached, 2)
  })

  it('도달 못한 노드를 세어 낸다', () => {
    const r = layersFrom(nodes, [{ source: 'a', target: 'b', directed: true }], ['a'])
    assert.equal(r.reached, 2)
    assert.equal(r.total, 5)
  })
})

// ---------------------------------------------------------------------------

describe('흐름 전체', () => {
  let dir
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-flow4-'))
    fs.writeFileSync(path.join(dir, 'README.md'), '# acme\n\n사진을 올리는 서버다.\n')
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'acme', bin: 'cli.mjs' }))
    fs.writeFileSync(path.join(dir, 'cli.mjs'), '#!/usr/bin/env node\n')
  })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const graph = () => ({
    nodes: [
      { id: 'cli.mjs', lang: 'js', lines: 1 },
      { id: 'core.mjs', lang: 'js', lines: 5 },
      { id: 'far.mjs', lang: 'js', lines: 5 },
    ],
    edges: [{ source: 'cli.mjs', target: 'core.mjs', directed: true }],
  })

  it('여섯 걸음이 번호 순서로 나온다', () => {
    const f = basicFlow(dir, graph(), {})
    assert.equal(f.steps.length, 6)
    assert.deepEqual(f.steps.map((s) => s.n), [1, 2, 3, 4, 5, 6])
    // ⑤ add 는 온보딩 실험에서 도구가 답하지 못한 유일한 질문을 맡는다.
    // ①~④ 는 읽는 걸음이고 ⑤ 가 첫 번째 쓰는 걸음이라 ⑥(선점) 바로 앞이어야 한다.
    assert.deepEqual(f.steps.map((s) => s.key), ['what', 'enter', 'layers', 'risk', 'add', 'yours'])
  })

  it('🔴 ⑤는 재료가 없으면 답하지 않고 그렇다고 말한다', () => {
    // newFile 을 안 넘긴 경우 — git 을 못 읽었을 때와 같은 상태다
    const s5 = basicFlow(dir, graph(), {}).steps.find((s) => s.key === 'add')
    assert.equal(s5.answer.answered, false)
    assert.ok(s5.gaps.length, '못 답한 이유가 비어 있으면 침묵을 결과로 내는 것이다')
  })

  it('🔴 ⑤는 등록 지점이 지금 잡혀 있으면 그 자리에서 말한다', () => {
    // "여기를 고쳐라" 와 "그건 지금 누가 잡고 있다" 가 다른 화면에 있으면
    // 둘을 겹치는 일이 사람 몫이 된다. 신입이 가장 못 하는 일이다.
    const newFile = {
      answered: true, n: 9, considered: 40, scope: 'src/plugins', capped: null,
      points: [{ path: 'src/registry.mjs', support: 8, share: 8 / 9 },
        { path: 'README.md', support: 4, share: 4 / 9 }],
      sentence: '…',
    }
    const claims = [{ agent: 'sora', task: 'T-1', intent: '레지스트리 정리', paths: ['src/registry.mjs'] }]
    const s5 = basicFlow(dir, graph(), { newFile, claims }).steps.find((s) => s.key === 'add')
    const held = s5.answer.points.find((p) => p.path === 'src/registry.mjs')
    assert.equal(held.heldBy, 'sora')
    assert.equal(held.heldTask, 'T-1')
    assert.equal(s5.answer.points.find((p) => p.path === 'README.md').heldBy, undefined)
    assert.equal(s5.answer.clash.length, 1)
    // 못 알아낸 것이 아니라 알아낸 것이므로 gaps 에도 남긴다
    assert.ok(s5.gaps.some((g) => /다른 사람이 잡고 있다/.test(g)))
  })

  it('폴더를 잡았으면 그 아래 등록 지점까지 물든다 — 어느 경로로 물들었는지 밝힌다', () => {
    const newFile = {
      answered: true, n: 9, considered: 40, scope: 'src/plugins', capped: null,
      points: [{ path: 'src/lib/core.mjs', support: 8, share: 0.9 }], sentence: '…',
    }
    const claims = [{ agent: 'ci-bot', task: 'T-2', intent: 'API 정리', paths: ['src/lib'] }]
    const s5 = basicFlow(dir, graph(), { newFile, claims }).steps.find((s) => s.key === 'add')
    assert.equal(s5.answer.points[0].heldBy, 'ci-bot')
    assert.equal(s5.answer.points[0].heldVia, 'src/lib')
  })

  it('⑤는 등록 지점을 focus 로 넘겨 그래프와 말이 같은 곳을 가리킨다', () => {
    const newFile = {
      answered: true, n: 9, considered: 40, scope: 'src/plugins', capped: null,
      points: [{ path: 'src/registry.mjs', support: 8, share: 8 / 9 }],
      sentence: '…',
    }
    const s5 = basicFlow(dir, graph(), { newFile }).steps.find((s) => s.key === 'add')
    assert.deepEqual(s5.focus, ['src/registry.mjs'])
    assert.equal(s5.gaps.length, 0)
  })

  it('걸음마다 질문·판정문·다음 이유가 있다', () => {
    for (const s of basicFlow(dir, graph(), {}).steps) {
      assert.ok(s.question, `${s.key} 에 질문이 없다`)
      // 🔴 done 은 도구가 아니라 사람이 스스로 확인하는 문장이다 (Q8).
      assert.ok(s.done, `${s.key} 에 done 이 없다`)
      assert.ok(Array.isArray(s.gaps), `${s.key} 에 gaps 가 없다`)
      if (s.n < 5) assert.ok(s.next, `${s.key} 에 next 가 없다`)
    }
  })

  it('①이 README 에서 설명을 가져온다', () => {
    const s = basicFlow(dir, graph(), {}).steps[0]
    assert.equal(s.answer.summary, '사진을 올리는 서버다.')
    assert.equal(s.answer.source, 'README.md')
  })

  it('🔴 도달률이 낮으면 반드시 말한다', () => {
    // Go·Java 에서 정적 파싱이 조용히 0개를 내놓고 화면이 그것을 결과로
    // 제시했던 실패다. 계층은 순서를 주기 때문에 더 위험하다 —
    // 사용자가 검증된 경로라고 믿는다.
    const g = graph()
    for (let i = 0; i < 20; i++) g.nodes.push({ id: `x${i}.mjs`, lang: 'js', lines: 3 })
    const f = basicFlow(dir, g, {})
    const s3 = f.steps[2]
    assert.ok(s3.answer.coveragePct < 40)
    assert.ok(s3.gaps.some((x) => x.includes('%')), `경고가 없다: ${JSON.stringify(s3.gaps)}`)
    assert.ok(f.gaps.some((x) => x.step === 3), '전체 gaps 에 안 올라왔다')
  })

  it('README 가 없으면 없다고 말한다', () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-flow5-'))
    try {
      const f = basicFlow(d2, graph(), {})
      assert.equal(f.steps[0].answer.summary, null)
      assert.ok(f.steps[0].gaps.some((g) => g.includes('README')))
    } finally {
      fs.rmSync(d2, { recursive: true, force: true })
    }
  })

  it('③은 근거가 약한 진입점(3·4등급)을 시작점으로 쓰지 않는다', () => {
    const f = basicFlow(dir, graph(), {})
    // cli.mjs 는 1등급(bin 선언). core.mjs 는 후보조차 아니다.
    assert.deepEqual(f.steps[2].answer.starts, ['cli.mjs'])
  })
})

// ---------------------------------------------------------------------------

describe('진입점에서 빠져야 하는 것', () => {
  it('🔴 문서·설정 노드는 진입점이 아니다', () => {
    // datanodes.mjs 가 .md/.json 을 노드로 올린다(숨은 결합을 잡기 위해).
    // 그게 진입점 목록으로 새면 `CLAUDE.md` 가 "아무도 부르지 않는데 남을
    // 부른다" 로 올라온다. 실제로 올라왔다. 문서는 실행되지 않는다.
    const nodes = [
      { id: 'CLAUDE.md', lang: 'data', lines: 100, confidence: 'history-only' },
      { id: 'main.mjs', lang: 'js', lines: 10 },
    ]
    const edges = [{ source: 'CLAUDE.md', target: 'main.mjs', directed: true }]
    const r = entryCandidates(process.cwd(), nodes, edges)
    assert.ok(!r.some((x) => x.path === 'CLAUDE.md'))
  })
})

describe('④는 entry 의 목록을 그대로 쓴다', () => {
  it('🔴 키 이름을 지어내지 않는다 — churn / risk', () => {
    // 처음에 'hot' 이라고 썼더니 조용히 null 이 되어 ④의 절반이 빈 채로
    // 나갔다. 빈 목록은 "여기는 활발한 곳이 없다" 로 읽힌다.
    const entry = {
      lists: [
        { key: 'churn', title: '자주 바뀌는 곳', hint: 'h', metric: 'freq', rows: [{ path: 'a.mjs', freq: 9 }] },
        { key: 'risk', title: '숨은 결합', hint: 'h', metric: 'hidden', rows: [{ path: 'b.mjs', hidden: 4 }] },
      ],
    }
    const s4 = basicFlow(process.cwd(), { nodes: [], edges: [] }, { entry }).steps[3]
    assert.equal(s4.answer.hot?.rows?.[0]?.path, 'a.mjs')
    assert.equal(s4.answer.risk?.rows?.[0]?.path, 'b.mjs')
    assert.deepEqual(s4.focus, ['a.mjs', 'b.mjs'])
  })
})

// ---------------------------------------------------------------------------

describe('README 맨 위의 공지', () => {
  it('🔴 보관 안내를 프로젝트 설명으로 집지 않는다', () => {
    // 실측(clips/pattern). README 가 이렇게 시작한다 —
    //   # WARNING: This repository is no longer maintained.
    // 그대로 집으면 ①의 답이 "이 프로젝트는 보관되었습니다" 가 된다.
    // 사실이지만 "무엇을 하는 물건인가" 에 대한 답이 아니다.
    const r = readmeSummary([
      '# WARNING: This repository is no longer maintained.',
      '',
      'This project is archived and will not receive further updates.',
      '',
      'Use this software at your own risk.',
      '__________________________________________________',
      '',
      'Pattern',
      '=======',
      '',
      '[![Build](https://img.shields.io/x)](https://ci)',
      '',
      'Pattern is a web mining module for Python.',
    ].join('\n'))
    assert.equal(r.title, 'Pattern')
    assert.equal(r.summary, 'Pattern is a web mining module for Python.')
    // 🔴 버리지는 않는다. 보관됐다는 사실은 읽으려는 사람에게 중요하다.
    assert.match(r.notice, /no longer maintained/)
  })

  it('공지 문단의 꼬리도 설명이 되지 않는다', () => {
    // "Use this software at your own risk." 는 공지 패턴에 안 걸리지만
    // 여전히 공지의 일부다. 배너 뒤에는 제목부터 다시 시작한다.
    const r = readmeSummary('# DEPRECATED\n\nUse at your own risk.\n\n# Acme\n\n진짜 설명이다.')
    assert.equal(r.summary, '진짜 설명이다.')
  })

  it('공지가 없으면 notice 는 null 이다', () => {
    assert.equal(readmeSummary('# acme\n\n설명이다.').notice, null)
  })
})

describe('라이브러리의 시작점', () => {
  it('🔴 setup.py 의 packages 를 시작점으로 쓴다', () => {
    // clips/pattern 에서 두 번 틀렸다. 데모 블록이 든 하위 모듈에서 출발해
    // 17%, 최상위 패키지 하나만 써서 1%. 답은 매니페스트에 적혀 있었다.
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-flow6-'))
    try {
      fs.writeFileSync(path.join(d, 'setup.py'),
        'setup(\n  name="Acme",\n  packages = [\n "acme",\n "acme.web",\n "acme.web.cache",\n  ],\n)\n')
      const nodes = [
        { id: 'acme/__init__.py', lang: 'python', lines: 5 },
        { id: 'acme/web/__init__.py', lang: 'python', lines: 5 },
        { id: 'acme/web/cache/__init__.py', lang: 'python', lines: 5 },
      ]
      const r = entryCandidates(d, nodes, [])
      const rank1 = r.filter((x) => x.rank === 1).map((x) => x.path)
      assert.ok(rank1.includes('acme/__init__.py'))
      assert.ok(rank1.includes('acme/web/__init__.py'))
      // 🔴 점 두 개짜리는 뺀다. 다 넣으면 "0겹" 이 저장소의 절반이 되고
      //    그러면 계층이 아니다.
      assert.ok(!rank1.includes('acme/web/cache/__init__.py'))
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })
})

describe('안 닿는 것을 갈래로 가른다', () => {
  it('🔴 예제·테스트가 안 닿는 것은 고장이 아니다', () => {
    // "도달 8%" 는 숫자만 보면 고장으로 읽힌다. pattern 은 130개 중
    // 예제 52 · 테스트 18 이고, 그것들은 라이브러리를 쓰는 쪽이라
    // 라이브러리에서 출발하면 안 닿는 게 맞다.
    const r = classifyUnreached([
      'test/test_db.py', 'tests/x.py', 'examples/01-web/a.py',
      'docs/index.md', 'tools/build.mjs', 'pattern/text/en/inflect.py',
    ])
    const by = Object.fromEntries(r.groups.map((g) => [g.key, g.count]))
    assert.equal(by.test, 2)
    assert.equal(by.example, 1)
    assert.equal(by.doc, 1)
    assert.equal(by.build, 1)
    assert.equal(r.rest, 1, '진짜로 설명이 필요한 몫만 남아야 한다')
  })

  it('도달률 경고는 예제·테스트를 뺀 수로 판정한다', () => {
    const nodes = [
      { id: 'lib/a.mjs', lang: 'js', lines: 5 },
      { id: 'lib/b.mjs', lang: 'js', lines: 5 },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `examples/e${i}.mjs`, lang: 'js', lines: 3 })),
    ]
    const edges = [{ source: 'lib/a.mjs', target: 'lib/b.mjs', directed: true }]
    const f = basicFlow(process.cwd(), { nodes, edges }, {})
    const a = f.steps[2].answer
    // 전체로는 2/22 = 9% 지만, 예제를 빼면 2/2 = 100% 다.
    assert.ok(a.coveragePct < 20)
    assert.equal(a.coreCoveragePct, 100)
    assert.equal(f.steps[2].gaps.length, 0, '멀쩡한 저장소에 경고를 띄웠다')
  })
})

describe('importTree — 방향 있는 호출 체인', () => {
  const nodes = ['main.go', 'cli.go', 'scan.go', 'sbom.go', 'far.go', 'unrelated.go']
    .map((id, i) => ({ id, lang: 'go', lines: 100 - i * 10 }))

  const dir = (source, target) => ({ source, target, directed: true, kind: 'import' })

  it('시작점에서 부르는 순서를 미리 순회로 낸다', () => {
    const t = importTree(nodes, [dir('main.go', 'cli.go'), dir('cli.go', 'scan.go'), dir('scan.go', 'sbom.go')], 'main.go')
    assert.deepEqual(t.rows.map((r) => r.path), ['cli.go', 'scan.go', 'sbom.go'])
    assert.deepEqual(t.rows.map((r) => r.depth), [1, 2, 3])
    // 그대로 들여쓰면 경로가 된다 — 각 줄이 자기 부모를 안다
    assert.equal(t.rows[1].from, 'cli.go')
    assert.equal(t.reached, 3)
  })

  it('🔴 방향을 아는 것과 모르는 것을 가른다', () => {
    const edges = [dir('main.go', 'cli.go'), { source: 'cli.go', target: 'scan.go', directed: false }]
    const t = importTree(nodes, edges, 'main.go')
    assert.equal(t.rows.find((r) => r.path === 'cli.go').directed, true)
    assert.equal(t.rows.find((r) => r.path === 'scan.go').directed, false)
    assert.equal(t.unknownDir, 1)
  })

  it('공변경과 허브는 체인에 쓰지 않는다', () => {
    const edges = [
      { source: 'main.go', target: 'far.go', origin: 'cochange' },
      { source: 'main.go', target: 'unrelated.go', directed: true, hub: true },
      dir('main.go', 'cli.go'),
    ]
    const t = importTree(nodes, edges, 'main.go')
    assert.deepEqual(t.rows.map((r) => r.path), ['cli.go'])
  })

  it('깊이를 넘어가면 멈춘다', () => {
    const edges = [dir('main.go', 'cli.go'), dir('cli.go', 'scan.go'), dir('scan.go', 'sbom.go'), dir('sbom.go', 'far.go')]
    const t = importTree(nodes, edges, 'main.go', { maxDepth: 2 })
    assert.deepEqual(t.rows.map((r) => r.path), ['cli.go', 'scan.go'])
  })

  it('🔴 자른 것을 말한다', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `k${i}.go`, lang: 'go', lines: 10 }))
    const t = importTree([...nodes, ...many], many.map((m) => dir('main.go', m.id)), 'main.go', { perNode: 3 })
    const cut = t.rows.find((r) => r.more)
    assert.ok(cut, '접은 개수를 안 냈다 — 조용한 절단은 "전부 봤다" 로 읽힌다')
    assert.equal(cut.more, 6)
  })

  it('같은 파일에 여러 경로가 있으면 짧은 쪽을 부모로 삼는다', () => {
    const edges = [dir('main.go', 'cli.go'), dir('main.go', 'scan.go'), dir('cli.go', 'scan.go')]
    const t = importTree(nodes, edges, 'main.go')
    assert.equal(t.rows.find((r) => r.path === 'scan.go').from, 'main.go')
  })

  it('시작점이 아무것도 안 부르면 그렇다고 말한다', () => {
    const t = importTree(nodes, [], 'main.go')
    assert.deepEqual(t.rows, [])
    assert.match(t.why, /못 찾았다/)
  })

  it('그래프에 없는 시작점은 거부한다', () => {
    const t = importTree(nodes, [], '없는파일.go')
    assert.equal(t.start, null)
    assert.match(t.why, /그래프에 없다/)
  })

  it('같은 입력이면 같은 답이다', () => {
    const edges = [dir('main.go', 'cli.go'), dir('main.go', 'scan.go')]
    assert.deepEqual(importTree(nodes, edges, 'main.go'), importTree(nodes, edges, 'main.go'))
  })
})
