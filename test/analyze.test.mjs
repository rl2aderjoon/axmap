/**
 * 그래프 구성 회귀 테스트.
 *
 * 여기 있는 테스트는 전부 **실제로 틀렸던 것**이다. 한 번도 실패한 적 없는
 * 검사기는 검사기가 아니라는 규칙(INVARIANTS.md)을 엣지 쪽에도 적용한다.
 *
 * 원 사건: e101 로봇 코드에서 `bbiyong_base/qos.py` 를 누르면 화면의 70%가
 * 물들었다. 파고 보니 두 가지가 겹쳐 있었다.
 *   ① 그 파일에 붙은 엣지 15개 중 7개가 오탐이었다 (`from rclpy.qos import ...`)
 *   ② 방향 없이 순회해서, 어느 노드를 눌러도 도달 노드가 52/76 으로 같았다
 *
 * build() 는 파일 목록을 받는 순수 함수라 fs 없이 잰다.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { displayName, askOf, build, depths } from '../app/lib/analyze.mjs'

/** scan() 이 만드는 모양을 손으로 만든다. */
const f = (path, text, lang) => ({
  path,
  lang: lang ?? (path.endsWith('.py') ? 'python' : 'js'),
  lines: text.split('\n').length,
  backup: false,
  text,
})

const importEdges = (g) => g.edges.filter((e) => e.kind === 'import')
const linked = (g, from, to) =>
  importEdges(g).some((e) => e.source === from && e.target === to)

// ---------------------------------------------------------------------------
// import 해석 — 오탐
// ---------------------------------------------------------------------------

test('외부 패키지가 이름만 같다고 우리 파일로 이어지면 안 된다', () => {
  // 실측: e101 에서 정확히 이 형태로 엣지 15개 중 7개가 오탐이었다.
  // 마지막 마디(`qos`)만 보면 rclpy 의 모듈과 우리 파일이 같은 것이 된다.
  const g = build([
    f('src/pkg/qos.py', 'CONTROL_STATE_QOS = 1\n'),
    f('src/pkg/node.py', 'from rclpy.qos import QoSProfile\n'),
  ])
  assert.equal(importEdges(g).length, 0, 'rclpy.qos 는 우리 qos.py 가 아니다')
})

test('점 경로가 실제 디렉터리와 맞으면 이어진다', () => {
  const g = build([
    f('src/pkg/qos.py', 'CONTROL_STATE_QOS = 1\n'),
    f('src/pkg/node.py', 'from pkg.qos import CONTROL_STATE_QOS\n'),
  ])
  assert.ok(linked(g, 'src/pkg/node.py', 'src/pkg/qos.py'))
})

test('파이썬 상대 import 는 같은 패키지로 이어진다', () => {
  const g = build([
    f('src/pkg/qos.py', 'X = 1\n'),
    f('src/pkg/node.py', 'from .qos import X\n'),
  ])
  assert.ok(linked(g, 'src/pkg/node.py', 'src/pkg/qos.py'))
})

test('같은 꼬리를 가진 파일이 둘이면 잇지 않는다 - 애매하면 거부', () => {
  const g = build([
    f('a/pkg/qos.py', 'X = 1\n'),
    f('b/pkg/qos.py', 'X = 1\n'),
    f('src/node.py', 'from pkg.qos import X\n'),
  ])
  assert.equal(importEdges(g).length, 0, '어느 pkg/qos.py 인지 알 수 없다')
})

// ---------------------------------------------------------------------------
// import 해석 — 놓치면 안 되는 것
// ---------------------------------------------------------------------------

test('마디가 하나인 import 는 저장소에 하나뿐이면 디렉터리가 달라도 잇는다', () => {
  // 실측: 처음에 같은 디렉터리만 인정했더니 AI 파트에서 진짜 엣지 16개를 잃었다.
  // pytest 가 scripts/ 를 sys.path 에 올리므로 tests/ 에서 이렇게 부른다.
  const g = build([
    f('AI/scripts/cascade.py', 'def run():\n    pass\n'),
    f('AI/tests/test_cascade.py', 'from cascade import run\n'),
  ])
  assert.ok(linked(g, 'AI/tests/test_cascade.py', 'AI/scripts/cascade.py'))
})

test('마디가 하나여도 이름이 둘 이상이면 잇지 않는다', () => {
  const g = build([
    f('a/util.py', 'X = 1\n'),
    f('b/util.py', 'X = 1\n'),
    f('c/main.py', 'from util import X\n'),
  ])
  assert.equal(importEdges(g).length, 0)
})

test('JS 상대 경로는 확장자를 적든 말든 이어진다', () => {
  // `./lib/analyze.mjs` 처럼 확장자를 적는 ESM 과 생략하는 번들러 관습이 둘 다 있다.
  // 색인이 확장자를 떼고 만들어져 있어서 한때 이쪽이 통째로 끊겼다 (엣지 17 → 1).
  const g = build([
    f('app/lib/analyze.mjs', 'export const x = 1\n'),
    f('app/server.mjs', "import { x } from './lib/analyze.mjs'\n"),
    f('app/other.mjs', "import { x } from './lib/analyze'\n"),
  ])
  assert.ok(linked(g, 'app/server.mjs', 'app/lib/analyze.mjs'), '확장자 있는 쪽')
  assert.ok(linked(g, 'app/other.mjs', 'app/lib/analyze.mjs'), '확장자 없는 쪽')
})

test('JS 상대 경로는 다른 디렉터리의 같은 이름을 잡지 않는다', () => {
  const g = build([
    f('src/a/util.js', 'export const x = 1\n'),
    f('src/b/util.js', 'export const x = 1\n'),
    f('src/a/main.js', "import { x } from './util'\n"),
  ])
  assert.ok(linked(g, 'src/a/main.js', 'src/a/util.js'))
  assert.ok(!linked(g, 'src/a/main.js', 'src/b/util.js'), '옆 디렉터리를 잡으면 안 된다')
})

test('확장자만 다른 짝은 부르는 쪽과 같은 계열로 이어진다', () => {
  // e101 FE 실측 — 50 노드 중 17쌍이 .jsx/.tsx 같은 컴포넌트 두 벌이었다.
  // 계열을 안 가리면 두 벌이 한 그래프로 엉킨다.
  const g = build([
    f('src/Nav.jsx', 'export default 1\n'),
    f('src/Nav.tsx', 'export default 1\n'),
    f('src/App.tsx', "import Nav from './Nav'\n"),
    f('src/App.jsx', "import Nav from './Nav'\n"),
  ])
  assert.ok(linked(g, 'src/App.tsx', 'src/Nav.tsx'))
  assert.ok(linked(g, 'src/App.jsx', 'src/Nav.jsx'))
  assert.ok(!linked(g, 'src/App.tsx', 'src/Nav.jsx'), '계열이 섞이면 안 된다')
})

// ---------------------------------------------------------------------------
// 노드의 역할과 방향
// ---------------------------------------------------------------------------

const roleFixture = () =>
  build([
    f('src/pkg/qos.py', 'X = 1\n'), // 남들이 쓰기만 한다
    f('src/pkg/mid.py', 'from .qos import X\n'), // 쓰기도 하고 쓰이기도 한다
    f('src/pkg/top.py', 'from .mid import Y\n'), // 쓰기만 한다
  ])

test('나가는 엣지가 없는 파일은 provider 다', () => {
  const g = roleFixture()
  const n = g.nodes.find((x) => x.id === 'src/pkg/qos.py')
  assert.equal(n.role, 'provider')
  assert.deepEqual(n.deg, { in: 1, out: 0, undirected: 0 })
})

test('들어오는 엣지가 없는 파일은 consumer, 양쪽이면 connector 다', () => {
  const g = roleFixture()
  assert.equal(g.nodes.find((x) => x.id === 'src/pkg/top.py').role, 'consumer')
  assert.equal(g.nodes.find((x) => x.id === 'src/pkg/mid.py').role, 'connector')
})

test('provider 에게는 반대 방향을 묻는다', () => {
  const g = roleFixture()
  const qos = g.nodes.find((x) => x.id === 'src/pkg/qos.py')
  const top = g.nodes.find((x) => x.id === 'src/pkg/top.py')
  assert.equal(askOf(qos), 'in', 'provider 는 out 이 비어 있으므로 뒤집는다')
  assert.equal(askOf(top), 'out')
})

test('방향을 가르면 답이 갈린다 - 무방향은 모든 노드에 같은 답을 준다', () => {
  // 이것이 화면이 매번 같은 68%를 칠하던 원인이다.
  const g = roleFixture()
  const ids = g.nodes.map((n) => n.id)

  const both = ids.map((id) => depths(g, id, { direction: 'both' }).size)
  assert.deepEqual(both, [3, 3, 3], '무방향이면 셋 다 전체에 도달한다 - 구분이 없다')

  assert.equal(depths(g, 'src/pkg/qos.py', { direction: 'out' }).size, 1, 'qos 는 아무 데도 안 나간다')
  assert.equal(depths(g, 'src/pkg/qos.py', { direction: 'in' }).size, 3, '거슬러 오르면 둘이 더 있다')
  assert.equal(depths(g, 'src/pkg/top.py', { direction: 'out' }).size, 3)
  assert.equal(depths(g, 'src/pkg/top.py', { direction: 'in' }).size, 1)
})

test('방향을 모르는 엣지는 어느 방향에서도 통과시킨다 - 모른다고 빠뜨리지 않는다', () => {
  // 채널을 쓰지만 pub/sub 을 못 가린 두 파일. directed:false 로 남는다.
  const g = build([
    f('a.py', 'topic = "/shared/thing"\n'),
    f('b.py', 'topic = "/shared/thing"\n'),
  ])
  const e = g.edges.find((x) => x.kind === 'channel')
  assert.equal(e.directed, false, '방향을 모르면 아는 척하지 않는다')
  for (const direction of ['both', 'out', 'in']) {
    assert.equal(depths(g, 'a.py', { direction }).size, 2, `${direction} 에서도 이어져 있어야 한다`)
  }
  assert.equal(g.nodes.find((n) => n.id === 'a.py').deg.undirected, 1)
})

// ---------------------------------------------------------------------------
// 파서가 못 읽는 언어도 노드로 세운다
// ---------------------------------------------------------------------------

test('파서가 못 읽는 언어도 노드가 된다 - 없는 것과 못 읽는 것은 다르다', () => {
  // 🔴 예전에는 6종 확장자만 노드로 만들어 Java 저장소가 노드 0개였다.
  // 기능을 눌러도 강조할 것이 없어 화면이 아무 반응도 못 했다.
  const g = build([
    f('src/AuthService.java', 'public class AuthService {}\n', 'other'),
    f('src/AuthController.java', 'public class AuthController {}\n', 'other'),
  ])
  assert.equal(g.nodes.length, 2)
  assert.equal(g.nodes[0].parsed, false, '못 읽었다는 사실은 남긴다')
  assert.equal(g.nodes[0].confidence, 'unparsed')
})

test('못 읽는 언어에서 import 를 지어내지 않는다', () => {
  // JS 정규식을 Java 에 들이대면 조용히 헛것을 잡는다.
  const g = build([
    f('a/Foo.java', 'import com.x.Bar;\nclass Foo {}\n', 'other'),
    f('a/Bar.java', 'class Bar {}\n', 'other'),
  ])
  assert.equal(g.edges.filter((e) => e.kind === 'import').length, 0)
})

test('읽을 수 있는 언어는 그대로 엣지가 나온다', () => {
  const g = build([
    f('a/util.py', 'X = 1\n'),
    f('a/main.py', 'from .util import X\n'),
    f('a/Legacy.java', 'class Legacy {}\n', 'other'),
  ])
  assert.equal(g.nodes.length, 3, 'Java 도 노드로는 있다')
  assert.equal(g.edges.filter((e) => e.kind === 'import').length, 1, 'Python 엣지는 그대로')
})

test('🔴 색인 중복이 정답을 거부하지 않는다 — 여러 마디 패키지 import', () => {
  // 실측: clips/pattern (파이썬 50,594줄). 내부 import 304개 중 엣지가 48개(16%)
  // 뿐이었다. 지배적 형태인 `from pattern.text import (...)` 43건이 전부 안 붙었다.
  //
  // 원인은 해석 규칙이 아니라 **세는 법**이었다. byPkg 가 `pattern/text` 를
  // dir 로 한 번, 꼬리 조각 루프에서 또 한 번 넣어서 후보가 2개가 됐고,
  // "둘 이상이면 애매하니 잇지 않는다" 는 fail-closed 검사가 그것을 걸렀다.
  // 후보는 사실 하나였다. 애매해서 막은 게 아니라 중복을 애매함으로 오인했다.
  //
  // 화면에 나오는 결과는 똑같이 "엣지 없음" 이라 눈으로는 구분이 안 된다.
  const g = build([
    f('pattern/__init__.py', 'X = 1\n'),
    f('pattern/text/__init__.py', 'def parse(): pass\n'),
    f('pattern/web/__init__.py', 'from pattern.text import parse\n'),
  ])
  const e = g.edges.filter((x) => x.kind === 'import')
  assert.equal(e.length, 1, `pattern.text 가 안 풀렸다: ${JSON.stringify(e)}`)
  assert.equal(e[0].source, 'pattern/web/__init__.py')
  assert.equal(e[0].target, 'pattern/text/__init__.py')
})

test('진짜로 애매하면 여전히 잇지 않는다', () => {
  // 위 수정이 fail-closed 를 무르게 만들지 않았는지 확인한다.
  // 서로 다른 두 파일이 같은 꼬리를 가지면 어느 쪽인지 알 수 없다.
  const g = build([
    f('a/text/__init__.py', 'def p(): pass\n'),
    f('b/text/__init__.py', 'def p(): pass\n'),
    f('c/use.py', 'from text import p\n'),
  ])
  assert.equal(g.edges.filter((x) => x.kind === 'import').length, 0)
})

test('🔴 패키지 표시자는 폴더 이름으로 부른다', () => {
  // 실측(clips/pattern, 스크린샷): 흐름 ③에서 노드 11개 중 6개가 `__init__.py`
  // 였다. 파이썬 패키지는 전부 그 이름이라 라벨이 있으나 마나였다.
  assert.equal(displayName('pattern/web/__init__.py'), 'web/')
  assert.equal(displayName('src/a/index.ts'), 'a/')
  assert.equal(displayName('crate/util/mod.rs'), 'util/')
  // 보통 파일은 그대로
  assert.equal(displayName('app/lib/flow.mjs'), 'flow.mjs')
  // 폴더가 없으면 부를 이름도 없다
  assert.equal(displayName('__init__.py'), '__init__.py')
})

// ---------------------------------------------------------------------------
// swift — 모듈까지만 푼다
// ---------------------------------------------------------------------------

/** 스위프트 파일 하나. */
const sw = (path, text) => f(path, text, 'swift')

test('swift: import 는 모듈 디렉터리의 파일들로 풀린다', () => {
  const g = build([
    sw('Sources/Core/Engine.swift', 'public struct Engine {}\n'),
    sw('Sources/Core/Util.swift', 'func u() {}\n'),
    sw('Sources/App/main.swift', 'import Core\n'),
  ])
  assert.ok(linked(g, 'Sources/App/main.swift', 'Sources/Core/Engine.swift'))
  assert.ok(linked(g, 'Sources/App/main.swift', 'Sources/Core/Util.swift'))
})

test('🔴 swift: 시스템 프레임워크는 같은 이름 폴더가 있어도 안 붙는다', () => {
  // App 밑의 Network 는 모듈이 아니라 그냥 하위 폴더다. `import Network` 는
  // 애플의 프레임워크를 뜻하고, 거기 붙이면 없는 관계를 지어내는 것이다.
  const g = build([
    sw('Sources/App/Network/Client.swift', 'struct Client {}\n'),
    sw('Sources/App/main.swift', 'import Network\nimport Foundation\n'),
  ])
  assert.equal(importEdges(g).length, 0)
})

test('swift: 저장소가 같은 이름의 진짜 모듈을 가지면 그쪽을 쓴다', () => {
  // swift-testing 의 Sources/Testing 처럼 이름이 겹치는 경우가 실제로 있다.
  // 모듈 뿌리로 실재하면 저장소 것이 맞다.
  const g = build([
    sw('Sources/Network/Socket.swift', 'public struct Socket {}\n'),
    sw('Sources/App/main.swift', 'import Network\n'),
  ])
  assert.ok(linked(g, 'Sources/App/main.swift', 'Sources/Network/Socket.swift'))
})

test('🔴 swift: 스위프트가 아닌 파일에는 안 붙는다', () => {
  // Sources/CShim 같은 C 타깃이 우연히 이름으로 걸리는 것을 막는다.
  const g = build([
    f('Sources/CShim/shim.c', 'int x;\n', 'c'),
    sw('Sources/App/main.swift', 'import CShim\n'),
  ])
  assert.equal(importEdges(g).length, 0)
})

test('swift: 자기 자신으로는 안 잇는다', () => {
  const g = build([
    sw('Sources/Core/A.swift', 'import Core\n'),
    sw('Sources/Core/B.swift', 'func b() {}\n'),
  ])
  assert.ok(!importEdges(g).some((e) => e.source === e.target))
  assert.ok(linked(g, 'Sources/Core/A.swift', 'Sources/Core/B.swift'))
})

test('🔴 swift: 상한을 넘는 모듈은 엣지가 아니라 배지로 남긴다 (D9)', () => {
  /**
   * 이 테스트는 **두 번 뒤집힌 결정을 못박는다.** 순서대로 —
   *
   *   ① 처음: Go 처럼 상한 초과를 통째로 버렸다 (`[]`).
   *   ② 실측이 뒤집었다: apple/swift-argument-parser (스위프트 파일 166개)
   *        Sources/ArgumentParser              52개  ← 이 저장소의 본체
   *        Sources/ArgumentParserToolInfo       1개
   *        Sources/ArgumentParserTestHelpers    2개
   *      버렸을 때 import 엣지 110개 중 **본체로 가는 것 0개.** 110개 전부가
   *      테스트 헬퍼를 가리켰다. 화면에서 그것은 "이 저장소의 중심은 테스트
   *      헬퍼다" 로 읽힌다 — 정확히 거짓말이다.
   *   ③ 그래서 hub 엣지로 기록해봤더니 **4,524개**가 나왔다 (부르는 쪽 87개 ×
   *      모듈 파일 52개). 그리지도 않을 것을 브라우저까지 내려보내는 셈이고
   *      더 큰 저장소에서는 그대로 터진다.
   *
   * 최종: **엣지가 아니라 배지.** D9 가 허브 채널에 쓰는 것과 같은 처리다.
   * 부르는 파일마다 한 줄이면 정보는 다 담긴다 —
   * "이 파일은 Huge 모듈(13개 파일)을 부른다."
   */
  const big = Array.from({ length: 13 }, (_, i) => sw(`Sources/Huge/F${i}.swift`, 'func x() {}\n'))
  const g = build([...big, sw('Sources/App/main.swift', 'import Huge\n')])

  // 🔴 그리지 않는다 — import 한 줄이 13개 선이 되면 거리가 거리를 뜻하지 않는다.
  assert.equal(importEdges(g).length, 0)

  // 🔴 그러나 없는 것이 아니다. 무엇을 왜 안 그렸는지 말한다.
  const main = g.nodes.find((n) => n.id === 'Sources/App/main.swift')
  assert.deepEqual(main.wideImports, [{ module: 'Huge', files: 13 }])
  assert.deepEqual(g.wideModules, [{ module: 'Huge', files: 13, importers: 1 }])

  // 경계 바로 아래(12개)는 진짜로 그린다 — 상한이 실제로 그 자리에 있다는 확인.
  const ok = Array.from({ length: 12 }, (_, i) => sw(`Sources/Fit/F${i}.swift`, 'func x() {}\n'))
  const g2 = build([...ok, sw('Sources/App/main.swift', 'import Fit\n')])
  assert.equal(importEdges(g2).length, 12)
  assert.deepEqual(g2.nodes.find((n) => n.id === 'Sources/App/main.swift').wideImports, [])
  assert.deepEqual(g2.wideModules, [])
})

test('🔴 swift: 없는 모듈과 큰 모듈은 다른 답이어야 한다', () => {
  /**
   * 이 저장소의 첫 규칙이다 — 없는 것과 못 읽은 것을 같은 값으로 말하지 않는다.
   * `import Ghost` 는 아무것도 없고, `import Huge` 는 크다. 둘 다 화면에는
   * 선이 안 그려진다. 그래서 **엣지만 보면 구별이 안 된다.** 배지가 그 차이다.
   *
   * 이 구별이 없으면 신입은 둘 다 "결합이 없다" 로 읽는다. 한 신입이 `claims: []`
   * 를 읽고 "부딪힐 사람 없음" 이라고 확신 있게 틀렸던 것과 같은 모양이다.
   */
  const big = Array.from({ length: 13 }, (_, i) => sw(`Sources/Huge/F${i}.swift`, 'func x() {}\n'))
  const at = (g) => g.nodes.find((n) => n.id === 'Sources/App/main.swift')

  const ghost = build([...big, sw('Sources/App/main.swift', 'import Ghost\n')])
  const huge = build([...big, sw('Sources/App/main.swift', 'import Huge\n')])

  // 엣지로는 똑같이 0 이다 — 여기까지만 보면 구별이 안 된다.
  assert.equal(importEdges(ghost).length, 0)
  assert.equal(importEdges(huge).length, 0)

  // 🔴 배지가 둘을 가른다.
  assert.deepEqual(at(ghost).wideImports, [], '없는 모듈은 할 말이 없다')
  assert.deepEqual(at(huge).wideImports, [{ module: 'Huge', files: 13 }], '큰 모듈은 크다고 말한다')
})

test('🔴 swift: 모듈은 재귀적이다 — 하위 폴더의 파일도 그 모듈이다', () => {
  /**
   * 🔴 **이 테스트가 없어서 실제 저장소에서 통째로 틀렸다.**
   *
   * 처음 구현은 디렉터리 꼬리 색인(`byDir`)을 썼다. Go 는 패키지가 디렉터리
   * 하나라 그것으로 맞는다. 스위프트 모듈은 `Sources/<이름>/` 아래 **몇 겹이든**
   * 전부 한 모듈이다.
   *
   * apple/swift-argument-parser 의 본체는 `Sources/ArgumentParser/` 밑에
   * `Parsing/` · `Usage/` · `Completions/` 로 나뉘어 있다. 꼬리 색인으로는
   * 그 52개가 거의 안 잡혀서 **본체로 가는 엣지가 0개**였다.
   *
   * 그때도 단위 테스트는 전부 초록이었다. 테스트가 쓰는 모듈이 전부
   * **평평했기 때문**이다. 실제 저장소로 재보지 않았으면 못 봤다.
   */
  const g = build([
    sw('Sources/Core/Parsing/Lexer.swift', 'struct Lexer {}\n'),
    sw('Sources/Core/Usage/Help.swift', 'struct Help {}\n'),
    sw('Sources/Core/Root.swift', 'struct Root {}\n'),
    sw('Sources/App/main.swift', 'import Core\n'),
  ])
  const from = 'Sources/App/main.swift'
  assert.ok(linked(g, from, 'Sources/Core/Parsing/Lexer.swift'), '하위 폴더도 모듈이다')
  assert.ok(linked(g, from, 'Sources/Core/Usage/Help.swift'))
  assert.ok(linked(g, from, 'Sources/Core/Root.swift'))
  assert.equal(importEdges(g).length, 3)
})

test('🔴 swift: 모듈 뿌리는 애플 이름보다 세다 (하위 폴더까지 포함해서)', () => {
  // swift-testing 의 `Sources/Testing` 이 실제 사례다. 저장소가 자기 모듈을
  // 가지면 그것이 맞고, 그 모듈의 하위 폴더까지 전부 포함해야 한다.
  const g = build([
    sw('Sources/Testing/Runner/Runner.swift', 'struct Runner {}\n'),
    sw('Sources/Testing/Expect.swift', 'func expect() {}\n'),
    sw('Sources/App/main.swift', 'import Testing\n'),
  ])
  assert.equal(importEdges(g).length, 2)
  assert.ok(linked(g, 'Sources/App/main.swift', 'Sources/Testing/Runner/Runner.swift'))
})
