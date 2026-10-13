/**
 * 기능 단위 그래프 — 파일이 아니라 사람의 말로.
 *
 * 🔴 이 테스트가 지키는 것은 하나다. **틀린 이름을 확신 있게 보여주지 않는다.**
 *
 * 비전공자는 기능 이름이 맞는지 코드로 확인할 방법이 없다. 그래서 애매하면
 * 이름을 안 붙이고 폴더 이름으로 떨어지는 편이, 그럴듯한 이름을 붙이는 것보다
 * 언제나 낫다. 아래 테스트는 전부 실제로 틀렸던 것이다.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { docLines, featureGraph, matchDocs, modulesOf, worksIn } from '../app/lib/featuregraph.mjs'

// ---------------------------------------------------------------------------

describe('모듈 나누기', () => {
  it('코드가 한 폴더에 모여 있으면 한 단계 더 들어간다', () => {
    // 최상위로 나누면 모듈이 `pattern` 하나가 되어 그래프가 점 하나가 된다.
    const { mods, root } = modulesOf([
      'pattern/__init__.py', 'pattern/web/__init__.py', 'pattern/text/__init__.py',
      'pattern/text/tree.py', 'pattern/vector/__init__.py',
    ])
    assert.equal(root, 'pattern')
    assert.deepEqual([...mods.keys()].sort(), ['pattern', 'pattern/text', 'pattern/vector', 'pattern/web'])
  })

  it('예제·테스트는 모듈이 아니다', () => {
    // 라이브러리를 쓰는 쪽이다 (flow.mjs 의 같은 판단).
    const { mods } = modulesOf([
      'src/a/x.mjs', 'src/b/y.mjs',
      'examples/e1.py', 'test/t1.py', 'docs/d.md', 'tools/build.mjs',
    ])
    assert.ok(!mods.has('examples'))
    assert.ok(!mods.has('test'))
    assert.ok(!mods.has('docs'))
    assert.ok(!mods.has('tools'))
  })

  it('코드가 흩어져 있으면 최상위로 나눈다', () => {
    const { mods, root } = modulesOf(['api/a.mjs', 'web/b.mjs', 'worker/c.mjs'])
    assert.equal(root, null)
    assert.deepEqual([...mods.keys()].sort(), ['api', 'web', 'worker'])
  })
})

// ---------------------------------------------------------------------------

describe('README 에서 이름 얻기', () => {
  const README = [
    '# Pattern',
    '',
    'Pattern is a web mining module for Python. It has tools for:',
    '',
    ' * Data Mining: web services (Google, Twitter, Wikipedia), web crawler, HTML DOM parser',
    ' * Natural Language Processing: part-of-speech taggers, n-gram search, sentiment analysis, WordNet',
    ' * Machine Learning: vector space model, clustering, classification (KNN, SVM, Perceptron)',
    ' * Network Analysis: graph centrality and visualization.',
    '',
    '## Installation',
    '',
    ' * Put the pattern folder in the same folder as your script.',
  ].join('\n')

  const paths = [
    'pattern/__init__.py',
    'pattern/web/__init__.py', 'pattern/web/cache/__init__.py',
    'pattern/text/__init__.py', 'pattern/text/search.py', 'pattern/text/en/wordnet/__init__.py',
    'pattern/vector/__init__.py', 'pattern/vector/svm/__init__.py',
    'pattern/graph/__init__.py',
  ]

  it('저자가 쓴 이름을 그대로 가져온다', () => {
    const { mods, root } = modulesOf(paths)
    const d = matchDocs(mods, docLines(README), { skip: root })
    assert.equal(d.get('pattern/web').label, 'Data Mining')
    assert.equal(d.get('pattern/vector').label, 'Machine Learning')
    assert.equal(d.get('pattern/graph').label, 'Network Analysis')
    // 🔴 `text` 는 줄 어디에도 "text" 가 없다. `search`·`wordnet` 두 낱말이
    //    파일 이름과 겹쳐서 붙는다 — 이름이 아니라 내용으로 이어진 경우다.
    assert.equal(d.get('pattern/text').label, 'Natural Language Processing')
  })

  it('콜론 앞이 이름, 뒤가 설명', () => {
    const { mods, root } = modulesOf(paths)
    const d = matchDocs(mods, docLines(README), { skip: root })
    assert.match(d.get('pattern/web').detail, /web crawler/)
  })

  it('🔴 뿌리 모듈에는 문서 이름을 붙이지 않는다', () => {
    // 설치 안내는 프로젝트 이름을 계속 부른다 —
    // "Put the pattern folder in the same folder as your script."
    // 뿌리에 붙이면 그 문장이 기능 이름이 된다. 실제로 됐다.
    const { mods, root } = modulesOf(paths)
    const d = matchDocs(mods, docLines(README), { skip: root })
    assert.equal(d.get('pattern'), undefined)
  })

  it('🔴 한 낱말만 겹치면 붙이지 않는다', () => {
    // axMap 에서 `app/lib` 에 "Phase 4 · 시각화와 로컬 LLM" 이 붙었다.
    // `app/lib/llm.mjs` 때문에 "llm" 하나가 겹쳤을 뿐이다. 우연이다.
    const { mods, root } = modulesOf(['app/lib/llm.mjs', 'app/lib/graph.mjs', 'app/web/ui.mjs'])
    const d = matchDocs(mods, docLines('## Phase 4 · visualization and local LLM'), { skip: root })
    assert.equal(d.size, 0, `붙으면 안 되는데 붙었다: ${JSON.stringify([...d])}`)
  })

  it('두 모듈에 비슷하게 맞으면 붙이지 않는다', () => {
    // 어느 쪽인지 모르는 것이다. 억지로 붙이면 확신 있게 틀린 답이 된다.
    const { mods, root } = modulesOf(['a/user.mjs', 'a/auth.mjs', 'b/user.mjs', 'b/auth.mjs'])
    const d = matchDocs(mods, docLines(' * Accounts: user auth'), { skip: root })
    assert.equal(d.size, 0)
  })

  it('README 가 없으면 아무것도 안 붙인다', () => {
    const { mods } = modulesOf(['a/x.mjs', 'b/y.mjs'])
    assert.equal(matchDocs(mods, docLines(null)).size, 0)
    assert.equal(docLines(null).length, 0)
  })
})

// ---------------------------------------------------------------------------

describe('무슨 일이 있었나 — 커밋 제목 그대로', () => {
  it('이 묶음이 주인공인 커밋만 본다', () => {
    // 🔴 파일 하나만 스친 대형 커밋의 제목을 집으면 이름이 "bump deps" 가 된다.
    const commits = [
      { subject: '사진 업로드 실패 시 재시도', files: ['up/a.py', 'up/b.py'] },
      { subject: '사진 업로드 실패 시 재시도', files: ['up/a.py'] },
      { subject: 'chore: 의존성 일괄 업데이트', files: ['up/a.py', 'x/1', 'x/2', 'x/3', 'x/4', 'x/5'] },
    ]
    const w = worksIn(['up/a.py', 'up/b.py'], commits)
    assert.equal(w[0].subject, '사진 업로드 실패 시 재시도')
    assert.ok(!w.some((x) => /의존성/.test(x.subject)), '대형 커밋이 섞였다')
  })

  it('쓸모없는 제목은 이름이 되지 않는다', () => {
    const w = worksIn(['a.py'], [{ subject: 'wip', files: ['a.py'] }, { subject: '수정', files: ['a.py'] }])
    assert.equal(w.length, 0)
  })
})

// ---------------------------------------------------------------------------

describe('그래프', () => {
  const paths = ['app/a/x.mjs', 'app/a/y.mjs', 'app/b/z.mjs', 'app/c/w.mjs']
  const commits = [
    { subject: '로그인 화면을 만든다', files: ['app/a/x.mjs', 'app/b/z.mjs'] },
    { subject: '로그인 화면을 만든다', files: ['app/a/y.mjs', 'app/b/z.mjs'] },
  ]

  it('함께 바뀐 모듈이 이어진다', () => {
    const g = featureGraph({ paths, commits })
    const e = g.edges.find((x) => [x.source, x.target].sort().join() === 'app/a,app/b')
    assert.equal(e.n, 2)
    assert.equal(e.origin, 'cochange')
  })

  it('import 로도 이어지고, 출처를 구분한다', () => {
    const g = featureGraph({
      paths, commits,
      edges: [{ source: 'app/a/x.mjs', target: 'app/c/w.mjs', kind: 'import' }],
    })
    const e = g.edges.find((x) => [x.source, x.target].sort().join() === 'app/a,app/c')
    assert.equal(e.imports, 1)
    assert.equal(e.origin, 'static')
    // 둘 다인 것은 both
    const both = featureGraph({
      paths, commits,
      edges: [{ source: 'app/a/x.mjs', target: 'app/b/z.mjs', kind: 'import' }],
    }).edges.find((x) => [x.source, x.target].sort().join() === 'app/a,app/b')
    assert.equal(both.origin, 'both')
  })

  it('🔴 대형 커밋은 모듈을 잇지 않는다', () => {
    // 일괄 포맷팅 한 번이 모든 모듈을 서로 잇는다. 그러면 그래프가 완전그래프가
    // 되고, 완전그래프는 아무 말도 하지 않는다.
    const wide = [{
      subject: '전체 포맷팅',
      files: ['app/a/x.mjs', 'app/b/z.mjs', 'app/c/w.mjs', 'app/d/1.mjs',
        'app/e/2.mjs', 'app/f/3.mjs', 'app/g/4.mjs'],
    }]
    const all = [...paths, 'app/d/1.mjs', 'app/e/2.mjs', 'app/f/3.mjs', 'app/g/4.mjs']
    const g = featureGraph({ paths: all, commits: wide })
    assert.equal(g.edges.length, 0)
  })

  it('이름의 출처를 반드시 낸다', () => {
    const g = featureGraph({ paths, commits })
    for (const n of g.nodes) assert.ok(['docs', 'path'].includes(n.nameSource), n.nameSource)
    assert.equal(g.stats.namedFromDocs + g.stats.namedFromPath, g.nodes.length)
  })

  it('덮은 파일 수를 낸다 — "이게 전부" 로 읽히지 않게', () => {
    const g = featureGraph({ paths: [...paths, 'test/t.mjs', 'examples/e.mjs'], commits })
    assert.equal(g.stats.totalFiles, 6)
    assert.equal(g.stats.coveredFiles, 4, '예제·테스트는 모듈에 안 들어간다')
  })

  it('커밋이 없어도 그래프가 나온다', () => {
    // 히스토리가 없는 저장소에서도 모듈은 보여야 한다.
    const g = featureGraph({ paths })
    assert.equal(g.nodes.length, 3)
    assert.equal(g.edges.length, 0)
    for (const n of g.nodes) assert.deepEqual(n.works, [])
  })
})

describe('README 링크가 이름을 오염시키지 않는다', () => {
  it('마크다운 링크는 글자만 남긴다 — URL 콜론을 구분자로 읽지 않는다', () => {
    // syft 실측 회귀: 걸음⑤의 모듈 이름이 "Works seamlessly with [Grype](https"
    // 로 나오고 "출처 README.md" 배지까지 달렸다. matchDocs 의 콜론 분리가
    // URL 의 https: 를 "이름: 설명" 구분자로 읽은 탓이다.
    const lines = docLines('- Works seamlessly with [Grype](https://github.com/anchore/grype), a scanner for pkg')
    assert.equal(lines.length, 1)
    assert.ok(!lines[0].line.includes('https'), lines[0].line)
    assert.ok(!lines[0].line.includes(']('), lines[0].line)
    assert.match(lines[0].line, /Grype/)
  })

  it('이미지·배지는 통째로 버린다', () => {
    assert.deepEqual(docLines('- ![badge](https://img.shields.io/x)'), [])
  })

  it('맨 URL 도 걷어낸다', () => {
    const l = docLines('## Catalogers see https://example.com/docs for details')
    assert.ok(!l[0].line.includes('http'), l[0].line)
  })

  it('콜론 뒤가 // 면 이름과 설명으로 가르지 않는다', () => {
    const mods = new Map([['pkg/cataloger', ['pkg/cataloger/a.go', 'pkg/cataloger/b.go']]])
    const got = matchDocs(mods, [{ line: 'cataloger note: //not a description', kind: 'bullet' }])
    const d = got.get('pkg/cataloger')
    if (d) assert.ok(!/note$/.test(d.label), 'URL 콜론으로 갈랐다: ' + d.label)
  })

  it('진짜 콜론은 여전히 이름과 설명으로 가른다', () => {
    const mods = new Map([['src/mining', ['src/mining/a.py', 'src/mining/crawler.py']]])
    const got = matchDocs(mods, [{ line: 'Data Mining: web services, crawler', kind: 'bullet' }])
    const d = got.get('src/mining')
    assert.ok(d, '매칭 자체가 안 됐다')
    assert.equal(d.label, 'Data Mining')
    assert.match(d.detail, /crawler/)
  })
})
