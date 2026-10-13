/**
 * 코드베이스 스캔 + 그래프 구성.
 *
 * docs/DECISIONS.md 의 D5·D6·D9 를 구현한다.
 *   D5  엣지마다 출처를 붙인다 (지금은 정적 파싱만. LLM 독해는 lib/llm.mjs)
 *   D6  적응형 노드 — 임계값 넘는 파일만 함수 단위로 펼친다
 *   D9  허브는 엣지에서 빼고 배지로
 *
 * 순수 함수 + fs 읽기만. 서버 로직 없음.
 */

import fs from 'node:fs'
import path from 'node:path'
import { EXT_TO_LANG, PARSED_LANG, extractImports, resolveKind } from './langs.mjs'

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build',
  '.axmap', '.next', 'target', '.pytest_cache', '.mypy_cache',
])

// 백업/스냅샷 디렉터리. e101 의 orin-live-backup 처럼 같은 파일이 수십 벌 있으면
// 그래프가 복제본으로 뒤덮인다. 사람이 읽으려는 건 살아있는 코드 한 벌이다.
const BACKUP_HINT = /backup|snapshot|\.bak|-old|_old|archive/i

/** 정적으로 **읽을 수 있는** 언어. import 를 여기서만 뽑는다. */
/**
 * 확장자 → 언어. **`lib/langs.mjs` 의 표에서 파생한다.**
 *
 * 🔴 예전에는 여기에 직접 적었다. 그러면 언어를 추가할 때 표와 이 목록
 *    두 곳을 고쳐야 하고, 한쪽만 고치면 조용히 갈린다 — 실제로 `INDEX_EXT`
 *    한 줄이 안 맞아서 Java 엣지가 통째로 0개였던 적이 있다(아래 주석).
 *    진실의 출처는 하나여야 한다.
 */
const LANG = EXT_TO_LANG

/**
 * import 를 뽑을 수 있는 언어 이름. LANG 의 값 집합이다.
 *
 * 🔴 Go 와 Java 를 넣은 이유는 실측이다.
 *
 * 온보딩 평가로 인기 저장소 5개를 추첨해 돌렸는데 **2개가 Go 와 Java** 였고,
 * 둘 다 정적 층이 통째로 죽었다 —
 *
 *   anchore/syft (Go)        노드 1,244 · 정적 엣지 **1개**
 *   cabaletta/baritone (Java) 노드   363 · 정적 엣지 **0개**
 *
 * 그 상태에서는 이 제품의 중심 은유인 2×2 사분면이 무너진다. 네 칸 중 세 칸이
 * import 를 전제하므로 syft 에서 `1 / 1,082 / 0 / 0` 이 됐다.
 * **사분면이 무너진 axMap 은 그냥 공변경 뷰어다.**
 *
 * 그리고 관찰자가 실제로 틀린 답을 받았다 — syft 의 "고치면 파급이 큰 곳" 1위가
 * 저장소 전체 엣지 1개를 만든 CI 라벨링 스크립트였다.
 */
// PARSED_LANG 은 `lib/langs.mjs` 의 표에서 온다 (위 import).

/**
 * 노드로 세울 코드 파일. 읽을 수 있는 것보다 넓다.
 *
 * 🔴 예전에는 LANG 에 든 6종만 노드로 만들었다. 그래서 e101 `BE_system` 의
 * Java 18,279줄이 **노드 0개**였고, 기능을 눌러도 강조할 노드가 없어
 * 화면이 아무 반응도 못 했다.
 *
 * 파싱과 존재는 다른 문제다. **파서가 못 읽는다고 그 파일이 없는 것은 아니다.**
 * 노드로는 세우고, 엣지는 읽을 수 있는 만큼만 그린다. 기능 클러스터(git
 * 동시변경)와 이름 참조는 언어를 안 가리므로 이 노드들도 관계를 갖는다.
 *
 * 실측 영향: besys 69 → 179 노드. 다른 저장소(E101_HJ 600, axMap 19)는
 * 이미 전부 읽히는 언어라 변화 없다.
 */
const CODE_EXT = new Set([
  '.py', '.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx',
  '.java', '.kt', '.go', '.rs', '.rb', '.php', '.cs', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.scala', '.m', '.mm',
])

/** ROS2 처럼 문자열로 배선되는 시스템의 채널 이름. */
const TOPIC_RE = /["'](\/[A-Za-z0-9_/]{2,})["']/g

/**
 * 채널의 방향을 그 줄의 문맥에서 읽는다.
 *
 * 정적으로 알 수 있는 것은 여기까지다. 파라미터 이름이 애매하면 unknown 으로 두고
 * 화면에서 방향 없는 선으로 그린다. 모르는 것을 아는 척하지 않는다 (D5).
 */
const PUB_HINT = /create_publisher|Publisher\s*\(|\badvertise\b|out_topic|output_topic|_out\b|publish/i
const SUB_HINT = /create_subscription|Subscriber\s*\(|\bsubscribe\b|in_topic|input_topic|_in\b|callback/i

function directionOf(line) {
  const pub = PUB_HINT.test(line)
  const sub = SUB_HINT.test(line)
  if (pub && !sub) return 'pub'
  if (sub && !pub) return 'sub'
  return 'unknown'
}

/**
 * 노드를 색으로 묶을 그룹을 고른다.
 *
 * 전부 흰색이면 어떤 것이 어느 갈래인지 눈에 들어오지 않는다.
 * 경로에서 의미 있는 마디를 골라 그룹으로 쓴다 — 대개 패키지/모듈 이름이다.
 */
const GENERIC_DIRS = new Set([
  'src', 'lib', 'app', 'apps', 'packages', 'source', 'sources', 'ros2_ws', 'ws',
  'code', 'project', 'main', 'java', 'python', 'ts', 'js',
])

/** 굵은 갈래 — FE/BE 처럼 한눈에 나누고 싶은 축. */
const KIND_HINT = [
  [/(^|\/)(test|tests|spec|__tests__)(\/|$)/i, 'test'],
  [/(^|\/)(launch|config|configs|conf|deploy|infra)(\/|$)|\.(ya?ml|json|toml|ini)$/i, 'config'],
  [/(^|\/)(ui|web|frontend|front|client|views?|pages?|components?|screens?)(\/|$)/i, 'fe'],
  [/(^|\/)(api|server|backend|back|service|services|controller|controllers|routes?|models?|db|database)(\/|$)/i, 'be'],
]

export function classify(rel) {
  const parts = rel.split('/')
  const dirs = parts.slice(0, -1)
  const group =
    dirs.find((d) => !GENERIC_DIRS.has(d.toLowerCase())) ?? dirs[dirs.length - 1] ?? '(root)'
  const kind = KIND_HINT.find(([re]) => re.test(rel))?.[1] ?? 'other'
  return { group, kind }
}
/** python import */
/** js/ts import — 상대 경로만 (외부 패키지는 그래프에 의미 없음) */

/**
 * Java import — `import a.b.C;` · `import static a.b.C.member;` · `import a.b.*;`
 *
 * 세 형태를 한 정규식으로 받고 해석 쪽에서 가른다. 와일드카드는 패키지 전체를
 * 뜻하므로 파일 하나로 못 푼다 — 잇지 않는다 (fail-closed).
 */

/**
 * Go import — 한 줄짜리와 괄호 묶음 둘 다.
 *
 *   import "fmt"
 *   import (
 *       "fmt"
 *       alias "github.com/x/y/z"
 *       _ "github.com/blank/import"
 *   )
 *
 * 괄호 안을 통째로 잡은 뒤 줄 단위로 문자열만 뽑는다. 별칭(`alias`)과
 * 빈 import(`_`)는 경로가 뒤에 오므로 마지막 따옴표 쌍만 보면 된다.
 */

// ---------------------------------------------------------------------------
// 스캔
// ---------------------------------------------------------------------------

export function scan(root, { maxFiles = 4000 } = {}) {
  const files = []
  const walk = (dir, rel) => {
    if (files.length >= maxFiles) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue
        walk(abs, r)
      } else if (CODE_EXT.has(path.extname(e.name).toLowerCase())) {
        let text
        try {
          text = fs.readFileSync(abs, 'utf8')
        } catch {
          continue
        }
        const lang = LANG[path.extname(e.name)]
        files.push({
          path: r,
          // 읽을 수 있는 언어면 그 이름을, 아니면 'other'. 이 값이 곧
          // "엣지를 뽑을 수 있는가"의 판정 기준이라 한 곳에서만 정한다.
          lang: lang ?? 'other',
          lines: text.split('\n').length,
          backup: BACKUP_HINT.test(r),
          text,
        })
        if (files.length >= maxFiles) return
      }
    }
  }
  walk(root, '')
  return files
}

// ---------------------------------------------------------------------------
// D6 · 적응형 노드
// ---------------------------------------------------------------------------

/**
 * 파일 안의 최상위 정의를 뽑는다.
 *
 * 정규식이다. 진짜 파서가 아니다. D5 의 원칙대로 이 사실을 숨기지 않고
 * 노드에 confidence: 'regex' 로 표시해 화면에서 구분되게 한다.
 */
export function outline(text, lang) {
  const out = []
  const lines = text.split('\n')
  const re =
    lang === 'python'
      ? /^(def|class)\s+(\w+)/
      : /^(?:export\s+)?(?:async\s+)?(function|class)\s+(\w+)/
  lines.forEach((l, i) => {
    const m = l.match(re)
    if (m) out.push({ name: m[2], kind: m[1], line: i + 1 })
  })
  for (let i = 0; i < out.length; i++) {
    out[i].endLine = i + 1 < out.length ? out[i + 1].line - 1 : lines.length
  }
  return out
}

// ---------------------------------------------------------------------------
// 엣지 재료 추출
// ---------------------------------------------------------------------------

/**
 * 파일이 쓰는 채널과 그 방향.
 * @returns Map<channel, 'pub'|'sub'|'unknown'>
 */
// export 인 이유: app/eval/edges.mjs 가 LLM 이 읽은 엣지를 정적 추출과 대조한다.
// TOPIC_RE 를 복사해 가면 두 판정 기준이 서로 모르게 갈라진다.
/**
 * 이 줄이 메시지 채널을 다루는 줄인가.
 *
 * 🔴 이게 없으면 `/` 로 시작하는 **모든 문자열**이 토픽이 된다.
 *
 * flask 에서 실측된 상황이다. `@app.route("/add")`, `"/login"`, `"/hello"` 가
 * 전부 채널로 잡혀서 채널 엣지 35개가 만들어졌고, **35개 전부 오탐**이었다.
 * `tests/test_json.py` 와 `examples/celery/.../views.py` 가 "같은 채널을 쓴다"고
 * 이어졌는데 두 파일은 아무 관계도 없다. URL 경로와 pub/sub 토픽은 생김새가 같다.
 *
 * 그래서 **줄에 pub/sub 신호가 있을 때만** 채널로 본다.
 * 잃는 것: 아무 힌트 없이 토픽 문자열만 있는 줄. 그런 줄은 방향도 모르므로
 * 원래도 `unknown` 이었다 — 잇지 않는 편이 낫다 (D5, 모르는 것을 아는 척하지 않는다).
 *
 * D5 가 근거로 든 `declare_parameter("output_topic", "/cmd_vel/autonomy")` 는
 * `output_topic` 이 PUB_HINT 에 걸리므로 그대로 남는다 — 확인했다.
 */
const CHANNEL_CONTEXT =
  /create_publisher|create_subscription|Publisher|Subscriber|Subscription|advertise|subscribe|publish|declare_parameter|topic|Topic|emit\(|\.on\(|channel|queue|JobName/

export function channelsOf(file) {
  const out = new Map()
  for (const line of file.text.split('\n')) {
    if (!CHANNEL_CONTEXT.test(line)) continue
    for (const m of line.matchAll(TOPIC_RE)) {
      const ch = m[1]
      const dir = directionOf(line)
      const prev = out.get(ch)
      // 한 파일이 같은 채널을 발행도 하고 구독도 하면 unknown 으로 둔다
      if (!prev) out.set(ch, dir)
      else if (prev !== dir && dir !== 'unknown') out.set(ch, prev === 'unknown' ? dir : 'both')
    }
  }
  return out
}

/**
 * 파일이 import 한 것을 "명세" 그대로 뽑는다. 여기서 파일로 해석하지 않는다.
 *
 * 예전에는 여기서 곧바로 점 경로의 마지막 마디만 떼어냈다(`rclpy.qos` → `qos`).
 * 그러면 외부 패키지와 우리 파일이 이름만 같아도 같은 것이 된다.
 * 해석은 저장소 전체를 아는 resolveImport() 가 한다.
 */
function importsOf(file) {
  // 규칙은 `lib/langs.mjs` 의 표 한 곳에만 있다. 여기서 갈래를 치면
  // 언어를 추가할 때 두 곳을 고쳐야 하고, 한쪽만 고치면 조용히 갈린다.
  return extractImports(file.lang, file.text, file.path)
}

/** 확장자를 뗀 이름. `App.tsx` → `App` */
const stem = (p) => path.basename(p).replace(/\.[^.]+$/, '')

/** 경로 구분자를 `/` 로 통일한다. 윈도우에서 path.dirname 이 `\` 를 준다. */
const slash = (p) => p.replace(/\\/g, '/')

const JS_EXT = /\.(mjs|cjs|js|jsx|ts|tsx)$/

/**
 * 색인 키에서 떼어낼 확장자.
 *
 * 🔴 예전에는 JS 와 Python 것만 뗐다. 그래서 Java 를 파싱하기 시작했을 때
 *    색인 키가 `baritone/api/.../IPath.java` 가 되어 `import baritone.api...IPath`
 *    가 **한 건도 안 맞았다.** 정규식·색인·해석이 전부 맞는데 엣지가 0개인
 *    상태였고, 원인이 이 한 줄이었다.
 *
 *    Go 가 멀쩡했던 것은 디렉터리 색인을 써서 확장자와 무관했기 때문이다 —
 *    언어를 늘릴 때 한쪽만 고치면 이렇게 조용히 갈린다.
 */
const INDEX_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|py|java|go|kt|rs|rb|php|cs|swift|scala)$/

/**
 * 확장자만 다른 같은 경로가 여럿일 때 하나를 고른다.
 *
 * e101 FE 에서 실제로 나온 상황이다 — `Nav.jsx` 와 `Nav.tsx` 가 나란히 있고
 * `./components/Nav` 는 둘 다를 가리킨다 (50 노드 중 17쌍이 이 꼴이었다).
 * 번들러가 그러듯 **부르는 쪽과 같은 계열**을 고른다. `App.tsx` 가 부르면 `.tsx`.
 * 그래야 두 벌이 섞이지 않고 각자의 그래프가 된다.
 */
function pick(cands, from) {
  if (!cands?.length) return null
  if (cands.length === 1) return cands[0]
  const ts = /\.tsx?$/.test(from)
  return cands.find((p) => /\.tsx?$/.test(p) === ts) ?? cands[0]
}

/**
 * import 명세를 저장소 안의 실제 파일로 해석한다. 못 찾으면 null.
 *
 * 🔴 왜 이렇게까지 하는가 — 실측 때문이다.
 *
 * 예전 방식(마지막 마디만 파일명에 매칭)으로 e101 로봇 코드를 재니
 * `bbiyong_base/qos.py` 에 붙은 엣지 15개 중 **7개가 오탐**이었다(47%).
 * 전부 `from rclpy.qos import ...` — ROS 표준 패키지인데 우리 `qos.py` 로 이어졌다.
 *
 * D5 는 "F1 을 가진 사람에게 확신 있게 틀린 답이 가장 해롭다"고 적었다.
 * 오탐 엣지는 정확히 그것이다. 화면은 의존을 자신 있게 그리고, 사람은
 * 존재하지 않는 연결을 따라 읽는다. 놓치는 것보다 나쁘다.
 *
 * 그래서 **점 경로 전체가 파일 경로와 맞아떨어질 때만** 잇는다.
 * 애매하면 잇지 않는다 (fail-closed).
 */
/**
 * Go 의 import 를 푼다. **패키지가 곧 디렉터리**라 파일 여럿으로 풀린다.
 *
 * `go.mod` 를 읽지 않는다. 모듈 이름을 몰라도 되도록 **경로 꼬리**로 맞춘다 —
 *   `github.com/anchore/syft/internal/log`
 *     → `anchore/syft/internal/log` → `syft/internal/log` → `internal/log` ✓
 * 긴 꼬리부터 시도하므로 우연한 짧은 일치보다 정확한 긴 일치가 이긴다.
 *
 * 마디가 하나뿐인 꼬리(`log`)는 쓰지 않는다. 표준 라이브러리(`fmt`·`log`·`os`)가
 * 저장소의 같은 이름 디렉터리에 잘못 붙는다. 두 마디 이상만 인정한다 (fail-closed).
 */
const GO_PKG_CAP = 12

function resolveGo(spec, from, index) {
  if (!spec.includes('/')) return [] // 표준 라이브러리
  const segs = spec.split('/')
  for (let i = 0; i <= segs.length - 2; i++) {
    const tail = segs.slice(i).join('/')
    const hit = index.byDir?.get(tail)
    if (!hit?.length) continue
    /**
     * 🔴 큰 패키지는 엣지에서 뺀다 — D9 의 허브 원칙 그대로다.
     *
     * syft 의 `syft/pkg` 는 **파일이 445개**다. import 한 번이 445개 엣지를
     * 만들고, 전체 엣지가 44,121개가 됐다. 의미상으로는 맞지만
     * (Go 에서 패키지를 import 하면 그 안 전부에 의존한다) 그래프는 죽는다.
     *
     * D9 가 정한 것과 같은 상황이다 — "N개 이상이 공유하는 것은 개별 연결이
     * 아니라 방송으로 본다." 여기서도 거리가 거리를 뜻하게 하려면 빼야 한다.
     *
     * 진짜 해법은 **패키지를 노드로 만드는 것**이다 (Go 의 단위는 파일이 아니라
     * 패키지다). 그건 D6 의 적응형 노드를 한 단계 더 여는 일이라 따로 다룬다.
     */
    if (hit.length > GO_PKG_CAP) return []
    return hit.filter((p) => p !== from)
  }
  return []
}

/**
 * `#include "..."` 를 파일로 해석한다.
 *
 * 🔴 C 계열만 따로 있는 이유는 명세의 모양이 다르기 때문이다.
 *
 *    다른 언어의 명세는 마디를 점으로 가른 논리 이름(`a.b.C`)이라
 *    `resolveImport` 가 점을 슬래시로 바꿔 찾는다. include 는 **파일 경로에
 *    확장자까지 붙은 것**(`google/protobuf/message.h`)이라 그 길로는 못 간다 —
 *    점으로 가르면 `google/protobuf/message/h` 가 된다.
 *
 * 🔴 같은 따옴표 include 가 저장소마다 다른 기준을 쓴다. 둘 다 시도한다.
 *
 *    ① **여는 파일 기준** — 작은 프로젝트의 기본. `util.c` 의
 *       `#include "util.h"` 는 옆에 있는 파일이다.
 *    ② **루트/포함경로 기준** — 큰 프로젝트의 기본. protobuf 의
 *       `src/google/protobuf/foo.cc` 가 `#include "google/protobuf/message.h"`
 *       를 쓰면 자기 디렉터리가 아니라 `src/` 밑을 가리킨다.
 *
 *    ①을 먼저 본다. 그쪽이 더 확실하기 때문이다. ②는 **꼬리가 유일할 때만**
 *    잇는다 — 같은 꼬리가 둘이면 어느 쪽인지 모르므로 잇지 않는다(fail-closed).
 */
/**
 * 네임스페이스를 푼다 — **파일 먼저, 안 되면 디렉터리.**
 *
 * 🔴 c# 과 scala 가 자바와 다른 지점이다.
 *
 * 자바는 `import a.b.C` 가 파일 하나(`a/b/C.java`)로 정확히 풀린다.
 * c# 의 `using MyApp.Models;` 는 **네임스페이스**를 부르고 그 안에 파일이
 * 여럿이다. scala 의 `import a.b._` 도 패키지 전체다.
 *
 * 실측에서 이게 드러났다 —
 *
 *   Dapper (c#)   파일 156개 · import 엣지 **1개**
 *   scalaz        파일 569개 · import 엣지 **22개**
 *
 * 원인이 둘이었다. c# 은 `using Dapper;` 처럼 마디가 하나인 것이 실은
 * 디렉터리인데 "마디가 하나면 위험하다" 는 규칙에 걸려 버려졌고,
 * scala 는 압도적 다수가 `import scalaz._` 같은 와일드카드인데 그것도
 * 패키지라 버려졌다. 둘 다 **파일이 아니라 디렉터리**를 가리키고 있었다.
 *
 * Go 에서 이미 푼 문제다. 다만 Go 는 명세가 슬래시고 이쪽은 점이라
 * 바꿔서 같은 길로 보낸다. 큰 패키지를 빼는 상한도 그대로 받는다 —
 * 패키지 하나를 부르는 것이 445개 엣지가 되면 그래프가 죽는다(D9).
 */
function resolveNs(spec, fromPath, index) {
  // ① 파일로 정확히 풀리면 그쪽이 강한 근거다 (`import a.b.C` → a/b/C.scala)
  const one = resolveImport(spec, fromPath, index)
  if (one) return [one]

  /**
   * ② 아니면 디렉터리.
   *
   * 🔴 `resolveGo` 를 그대로 못 쓴다. 그쪽은 **슬래시 없는 명세를 표준
   *    라이브러리로 보고 즉시 버린다** — Go 에서는 `import "fmt"` 가 늘
   *    표준이라 맞는 판단이다. 그런데 c# 의 `using Dapper;` 는 마디가
   *    하나여도 저장소 안의 진짜 디렉터리다. 그 규칙을 물려받았더니
   *    Dapper 에서 엣지가 156개 파일에 4개였다.
   *
   * 큰 패키지를 빼는 상한은 그대로 받는다 — 패키지 하나를 부르는 것이
   * 수백 개 엣지가 되면 거리가 거리를 뜻하지 않게 된다 (D9).
   */
  const segs = spec.split('.').filter(Boolean)
  for (let i = 0; i < segs.length; i++) {
    const hit = index.byDir?.get(segs.slice(i).join('/'))
    if (!hit?.length) continue
    if (hit.length > GO_PKG_CAP) return []
    return hit.filter((p) => p !== fromPath)
  }
  return []
}

/**
 * 애플이 제공하는 모듈들. 저장소 안에 같은 이름의 **하위 폴더**가 우연히 있을 때
 * 거기에 붙지 않게 하려고만 쓴다.
 *
 * 🔴 이 목록에 있어도 `Sources/<이름>/` 이 실재하면 그쪽을 쓴다. 저장소가
 *    같은 이름의 자기 모듈을 가진 경우가 실제로 있고(swift-testing 의
 *    `Sources/Testing`), 그때는 저장소 것이 맞다. 목록은 "이름이 겹칠 때
 *    어느 쪽을 믿을지" 의 기본값이지 금지어가 아니다.
 */
const SWIFT_SYSTEM = new Set([
  'Foundation', 'UIKit', 'SwiftUI', 'AppKit', 'Combine', 'Dispatch', 'XCTest', 'Testing',
  'CoreData', 'CoreGraphics', 'CoreLocation', 'CoreImage', 'CoreML', 'CoreText', 'CoreAudio',
  'AVFoundation', 'WebKit', 'MapKit', 'StoreKit', 'WatchKit', 'ARKit', 'SpriteKit', 'SceneKit',
  'Metal', 'MetalKit', 'Accelerate', 'CryptoKit', 'Security', 'Network', 'NaturalLanguage',
  'QuartzCore', 'UserNotifications', 'PhotosUI', 'Photos', 'Vision', 'Charts', 'Observation',
  'os', 'Darwin', 'Glibc', 'ObjectiveC', 'SystemConfiguration', 'Swift', 'Builtin',
])

/**
 * 스위프트의 `import <모듈>` 을 푼다.
 *
 * 🔴 파일이 아니라 **모듈**이라 여러 파일로 풀린다. Go 의 패키지와 비슷해
 *    보이지만 결정적으로 다른 점이 둘 있고, 둘 다 실측에서 물렸다 —
 *
 *    ① 모듈은 **재귀적**이다. `Sources/<이름>/` 아래 몇 겹이든 한 모듈이다.
 *       그래서 디렉터리 꼬리 색인(`byDir`)이 아니라 전용 색인
 *       (`bySwiftModule`)을 쓴다. Go 패키지는 디렉터리 하나라 안 겹쳤다.
 *    ② 모듈은 **크다**. 패키지당 수십 개가 보통이라 상한 초과가 예외가
 *       아니라 기본값이다. 그래서 버리지 않고 `hub` 로 기록한다(아래).
 *
 * 두 겹으로 fail-closed —
 *   ① **모듈 뿌리가 실재하면 그것을 쓴다.** `Sources|Source|src/<이름>/` 은
 *      SwiftPM 에서 모듈의 정의 그 자체라 지어내기가 아니라 관측이다.
 *      이름이 애플 프레임워크와 겹쳐도 저장소 것이 맞다 — swift-testing 의
 *      `Sources/Testing` 이 실제 사례다.
 *   ② 뿌리가 없으면 **애플 프레임워크 이름은 버린다.** `import Network` 가
 *      저장소의 `App/Network/` 하위 폴더를 뜻할 리 없다. 못 잇는 것보다
 *      잘못 잇는 것이 나쁘다 — 신입은 화면에 있는 선을 사실로 읽는다.
 *      (그리고 `.swift` 가 아닌 결과는 어느 쪽에서도 버린다. `Sources/CShim/`
 *       같은 C 타깃이 우연히 이름으로 걸리는 것을 막는다.)
 *
 * @returns `{ targets, hub }`. 다른 해석기는 배열만 준다 — 이것만 다른 이유는
 *   `hub` 설명에 있다. 부르는 쪽이 두 모양을 다 받는다.
 */
function resolveSwift(spec, fromPath, index) {
  const none = { targets: [], hub: false }
  const swiftOnly = (list) => list.filter((p) => p.endsWith('.swift') && p !== fromPath)

  // ① 모듈 뿌리가 실재하나 — `Sources/<spec>/**`
  let pick = swiftOnly(index.bySwiftModule?.get(spec) ?? [])

  // ② 없으면 같은 이름의 폴더로 물러선다. 단 애플 이름이면 물러서지 않는다.
  if (!pick.length) {
    if (SWIFT_SYSTEM.has(spec)) return none
    pick = swiftOnly(index.byDir?.get(spec) ?? [])
  }
  if (!pick.length) return none

  /**
   * 🔴 상한을 넘어도 **버리지 않고 `hub` 로 기록한다.** 여기가 Go 와 갈리는 자리다.
   *
   * 실측(apple/swift-argument-parser, 스위프트 파일 166개) —
   *   Sources/ArgumentParser              52개  ← 이 저장소의 본체
   *   Sources/ArgumentParserToolInfo       1개
   *   Sources/ArgumentParserTestHelpers    2개
   *
   * 상한에서 `[]` 를 돌려주니 **본체로 가는 엣지가 0개**가 되고, 남은 110개가
   * 전부 테스트 헬퍼를 가리켰다. 화면에서 그것은 "이 저장소의 중심은 테스트
   * 헬퍼다" 로 읽힌다 — 정확히 거짓말이다.
   *
   * 그렇다고 52개를 다 그리면 D9 가 막으려던 것이 그대로 일어난다. import 한
   * 줄이 52개 선이 되면 거리가 거리를 뜻하지 않는다.
   *
   * 그래서 셋째 답을 쓴다. **알지만 안 그린다.** `hub:true` 는 이 저장소에
   * 이미 있는 개념이고(D9), `deg` 계산과 기본 화면에서 빠지되 장부에는 남는다.
   * `[]` 와 결정적으로 다른 점은 **"없다"가 아니라 "크다"라고 말한다**는 것이다.
   * 없는 것과 못 읽은 것을 같은 값으로 말하지 않는다 — 이 저장소의 첫 규칙이다.
   */
  return { targets: pick, hub: pick.length > GO_PKG_CAP }
}

function resolveInclude(spec, fromPath, index) {
  const from = slash(fromPath)
  const fromDir = slash(path.dirname(from))

  const rel = slash(path.posix.normalize(path.posix.join(fromDir, spec)))
  const near = index.byPath.get(rel)
  if (near?.length) return pick(near, from)

  const hit = index.bySuffix.get(spec)
  return hit?.length === 1 ? hit[0] : null
}

function resolveImport(spec, fromPath, index) {
  const from = slash(fromPath)
  const fromDir = slash(path.dirname(from))

  // ── JS/TS — 상대 경로만 잡히므로 실제로 경로를 계산한다 ──────────────────
  // 예전에는 `./utils` 를 basename 으로만 봐서 저장소 어디의 utils 든 걸렸다.
  if (spec.startsWith('.') && /[/\\]/.test(spec)) {
    // 색인은 확장자를 떼고 만들었으므로 여기서도 떼야 한다.
    // `./lib/analyze.mjs` 처럼 확장자를 적는 쪽(ESM)과 생략하는 쪽이 둘 다 있다.
    const base = slash(path.posix.normalize(path.posix.join(fromDir, spec))).replace(JS_EXT, '')
    return pick(index.byPath.get(base) ?? index.byPath.get(`${base}/index`), from)
  }

  const segs = spec.split('.')

  // ── 파이썬 상대 import (`from .qos import`) ──────────────────────────────
  // 앞의 빈 마디 수가 곧 거슬러 올라갈 단계다. `.` 은 같은 패키지.
  if (segs[0] === '') {
    let up = 0
    while (segs[up] === '') up++
    const dir = up <= 1 ? fromDir : slash(path.posix.normalize(`${fromDir}/${'../'.repeat(up - 1)}`))
    const rest = segs.slice(up)
    return rest.length ? pick(index.byPath.get(`${dir}/${rest.join('/')}`), from) : null
  }

  // ── 점 경로가 여러 마디면 경로가 통째로 맞아야 한다 ──────────────────────
  // `bbiyong_base.qos` 는 `.../bbiyong_base/qos.py` 에만 붙는다.
  // `rclpy.qos` 는 저장소에 `rclpy/` 가 없으므로 아무 데도 안 붙는다 — 이게 핵심이다.
  if (segs.length > 1) {
    const hit = index.bySuffix.get(segs.join('/'))
    // 같은 꼬리를 가진 파일이 둘 이상이면 어느 쪽인지 알 수 없다 — 잇지 않는다(fail-closed).
    if (hit?.length === 1) return hit[0]
    // 서브패키지일 수 있다 — `flask.json` 은 `src/flask/json/__init__.py` 다.
    const pkg = index.byPkg?.get(segs.join('/'))
    return pkg?.length === 1 ? pkg[0] : null
  }

  // ── 마디가 하나뿐이면 (`import cascade`) ────────────────────────────────
  // 같은 디렉터리를 먼저 보고, 없으면 **저장소에 하나뿐일 때만** 잇는다.
  //
  // 처음에는 같은 디렉터리만 인정했는데 실측에서 진짜 엣지 16개를 잃었다 —
  // `AI/tests/test_cascade.py` 의 `from cascade import ...` 가 `AI/scripts/cascade.py`
  // 를 가리킨다 (pytest 가 scripts/ 를 sys.path 에 올린다). 테스트→원본 엣지는
  // "이 파일을 검증하는 곳"이라 오히려 보고 싶은 연결이다.
  //
  // 느슨하게 풀어도 qos 오탐은 돌아오지 않는다. 그건 전부 `rclpy.qos` 라는
  // **점 경로**였고 위에서 이미 막힌다. 여기서 다루는 것은 마디가 하나인 경우뿐이다.
  //
  // ⚠️ 남는 위험: 저장소에 `json.py` 같은 파일이 있으면 표준 라이브러리 import 가
  // 거기 붙는다. 이름이 저장소에 하나뿐이어야 한다는 조건이 그 폭을 좁히지만
  // 없애지는 못한다. 런타임 관측(D5 의 보류 항목)이 들어오면 그때 갈린다.
  const same = index.byPath.get(`${fromDir}/${segs[0]}`)
  if (same?.length) return pick(same, from)

  // 🔴 패키지를 파일보다 먼저 본다.
  //
  // `import flask` 는 저장소가 제공하는 패키지 `src/flask/` 를 뜻하지,
  // 우연히 이름이 같은 `tests/.../flask.py` 를 뜻하지 않는다.
  // 이름 색인을 먼저 보면 후자로 간다 (flask 에서 실측 — 가짜 엣지 47개).
  const pkg = index.byPkg?.get(segs[0])
  if (pkg?.length === 1) return pkg[0]

  const all = index.byName.get(segs[0])
  return all?.length === 1 ? all[0] : null
}

/**
 * 해석에 쓸 색인. 확장자를 뗀 경로와, 그 경로의 모든 꼬리 조각.
 * 값이 배열인 이유는 `Nav.jsx` / `Nav.tsx` 처럼 확장자만 다른 짝이 실제로 있기 때문이다.
 */
function buildIndex(files) {
  /** 디렉터리 꼬리 → 그 안의 파일들. Go 는 패키지가 곧 디렉터리라 이게 필요하다. */
  const byDir = new Map()
  /** 스위프트 모듈 이름 → 그 모듈의 모든 파일. 아래 채우는 자리에 이유가 있다. */
  const bySwiftModule = new Map()
  const byPath = new Map() // 'a/b/c'  → ['a/b/c.py']
  const bySuffix = new Map() // 'b/c'    → ['a/b/c.py', ...]
  const byName = new Map() // 'c'      → ['a/b/c.py', ...]
  /**
   * 패키지 이름 → 그 패키지의 `__init__.py`.
   *
   * 🔴 이게 없으면 저장소가 스스로 제공하는 패키지를 못 찾는다.
   *
   * flask 에서 실측된 상황이다. `src/flask/__init__.py` 는 확장자를 떼면
   * `src/flask/__init__` 이라 이름 색인에 `__init__` 으로만 들어간다.
   * **패키지 이름 `flask` 가 색인에서 사라진다.**
   *
   * 그 상태에서 `from flask import Flask` 를 풀면, 저장소에서 이름이 `flask` 인
   * 유일한 파일 — `tests/test_apps/cliapp/inner1/inner2/flask.py`, 3줄짜리
   * 테스트 픽스처 — 로 간다. import 엣지 178개 중 **47개(26%)** 가 거기로 몰렸고,
   * 그 픽스처가 "고치면 파급이 큰 곳 3위" 로 첫 화면에 떴다.
   *
   * 확신 있게 틀린 답이고, 그것도 첫 화면에서. 이 도구가 하지 말아야 할 일이다 (D5).
   */
  const byPkg = new Map() // 'flask' → ['src/flask/__init__.py'],  'src/flask' → 같은 것
  /**
   * 색인에 넣는다. **같은 키에 같은 파일을 두 번 넣지 않는다.**
   *
   * 🔴 중복이 fail-closed 검사를 뒤집는다.
   *
   * 해석기는 후보가 둘 이상이면 "어느 쪽인지 알 수 없다" 며 잇지 않는다.
   * 그 판단은 옳지만, 같은 파일이 두 번 들어가면 후보가 **하나뿐인데도**
   * 둘로 세어져서 정답이 거부된다. 애매해서 막은 게 아니라 세는 법이 틀려서
   * 막은 것이고, 화면에는 똑같이 "엣지 없음" 으로 보인다.
   *
   * 실측(clips/pattern, 파이썬 50,594줄): 아래 byPkg 가 `pattern/text` 를
   * `dir` 로 한 번, 꼬리 조각 루프에서 또 한 번 넣었다. 그래서
   * `from pattern.text import (...)` 43건이 전부 안 붙었다.
   * 내부 import 304개 중 엣지가 48개(16%)뿐이었다.
   *
   * flask 가 멀쩡했던 것은 운이었다 — 거기 쓰이는 `from flask import` 는
   * 마디가 하나라 중복이 안 생기는 다른 키를 탄다.
   */
  const push = (map, k, v) => {
    const cur = map.get(k)
    if (!cur) return map.set(k, [v])
    if (!cur.includes(v)) cur.push(v)
    return map
  }
  for (const f of files) {
    const s = slash(f.path)
    const noExt = s.replace(INDEX_EXT, '')
    push(byPath, noExt, f.path)
    const parts = noExt.split('/')
    push(byName, parts[parts.length - 1], f.path)
    for (let i = parts.length - 2; i >= 0; i--) push(bySuffix, parts.slice(i).join('/'), f.path)

    /**
     * 디렉터리 꼬리 → 그 안의 파일들.
     *
     * Go 는 **패키지가 곧 디렉터리**라 import 가 파일 하나로 안 풀린다.
     * `github.com/anchore/syft/internal/log` 는 `internal/log/` 안의 모든
     * `.go` 파일을 뜻한다. 그래서 파일 색인과 별도로 디렉터리 색인이 필요하다.
     */
    const d = noExt.slice(0, noExt.lastIndexOf('/'))
    if (d) {
      const dp = d.split('/')
      for (let i = 0; i < dp.length; i++) push(byDir, dp.slice(i).join('/'), f.path)
    }

    /**
     * 🔴 스위프트 모듈 이름 → 그 모듈의 **모든** 파일 (하위 폴더 포함).
     *
     * `byDir` 로는 안 된다. `byDir` 는 디렉터리 경로의 **꼬리**로 거는데,
     * Go 는 패키지가 디렉터리 하나라 그것으로 충분하지만 스위프트 모듈은
     * **재귀적**이다 — `Sources/<이름>/` 아래 몇 겹이든 전부 한 모듈이다.
     *
     * 실측(apple/swift-argument-parser)에서 정확히 이것에 물렸다.
     * `Sources/ArgumentParser/` 밑에 `Parsing/` · `Usage/` · `Completions/`
     * 같은 폴더가 있어서, 52개 파일 중 `byDir.get('ArgumentParser')` 로
     * 잡히는 것이 거의 없었다. 결과는 "본체로 가는 엣지 0개" 였고 화면에서는
     * 테스트 헬퍼가 저장소의 중심으로 보였다.
     *
     * 평평한 모듈만 있는 테스트로는 안 잡힌다 — 그래서 중첩 모듈 테스트를
     * 함께 넣었다(`test/analyze.test.mjs`).
     */
    const sm = /(^|\/)(?:Sources|Source|src)\/([^/]+)\//.exec(s)
    if (sm && s.endsWith('.swift')) push(bySwiftModule, sm[2], f.path)

    // 패키지 진입점을 그 디렉터리 이름으로도 건다.
    // 파이썬의 `__init__.py`, JS 의 `index.*` 가 같은 역할을 한다.
    if (/\/(__init__\.py|index\.(mjs|cjs|js|jsx|ts|tsx))$/.test(s)) {
      const dir = s.slice(0, s.lastIndexOf('/'))
      push(byPkg, dir, f.path)
      const name = dir.slice(dir.lastIndexOf('/') + 1)
      if (name) push(byPkg, name, f.path)
      // 꼬리 조각으로도 건다 — `flask.json` 이 `src/flask/json/__init__.py` 로 가야 한다
      const dp = dir.split('/')
      for (let i = dp.length - 2; i >= 0; i--) push(byPkg, dp.slice(i).join('/'), f.path)
    }
  }
  return { byPath, bySuffix, byName, byPkg, byDir, bySwiftModule }
}

// ---------------------------------------------------------------------------
// 그래프 구성
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 *   hubCap      이 수를 넘게 공유되는 채널은 엣지에서 제외하고 배지로 (D9)
 *   splitOver   이 줄 수를 넘는 파일은 함수 노드로 펼친다 (D6)
 */
/**
 * 화면에 띄울 이름.
 *
 * 🔴 패키지 표시자는 파일명이 아니라 **폴더 이름**으로 부른다.
 *
 * 실측(clips/pattern, 스크린샷): 흐름 ③에서 노드 11개 중 6개가
 * `__init__.py` 였다. 파이썬 패키지는 전부 그 이름이라 파일명만 보면
 * 어느 것이 어느 것인지 알 수 없다 — 라벨이 있으나 마나다.
 *
 * `pattern/web/__init__.py` 는 `web/` 이라고 부르는 편이 정확하다.
 * 실제로 그 파일이 담고 있는 것이 "web 패키지" 이기 때문이다.
 * JS 의 `index.*`, 러스트의 `mod.rs` 도 같다.
 *
 * 뒤에 `/` 를 붙여 파일이 아니라 묶음이라는 것을 표시한다.
 */
const PKG_MARKER = /^(__init__\.py|index\.(mjs|cjs|js|jsx|ts|tsx)|mod\.rs|__init__\.pyi)$/

export function displayName(rel) {
  const p = slash(rel)
  const cut = p.lastIndexOf('/')
  const base = p.slice(cut + 1)
  // 폴더가 없으면 부를 이름도 없다. 저장소 최상위의 `__init__.py` 가 그렇다.
  if (cut < 0 || !PKG_MARKER.test(base)) return base
  const dir = p.slice(0, cut)
  return `${dir.slice(dir.lastIndexOf('/') + 1)}/`
}

export function build(files, { hubCap = 6, splitOver = 300, includeBackups = false } = {}) {
  const live = includeBackups ? files : files.filter((f) => !f.backup)

  const channelMap = new Map() // channel -> Map(path -> dir)
  const index = buildIndex(live) // import 명세 → 실제 파일
  const meta = new Map()

  for (const f of live) {
    const ch = channelsOf(f)
    meta.set(f.path, { ...f, channels: ch, text: undefined })
    for (const [c, dir] of ch) {
      if (!channelMap.has(c)) channelMap.set(c, new Map())
      channelMap.get(c).set(f.path, dir)
    }
  }

  const hubs = new Set([...channelMap].filter(([, s]) => s.size > hubCap).map(([c]) => c))

  // ── 엣지 ─────────────────────────────────────────────────────────────────
  // 방향을 아는 것은 source→target 으로, 모르는 것은 directed:false 로 둔다.
  const edges = new Map()
  /** 경로 → Map(모듈 이름 → 그 모듈의 파일 수). 커서 안 그린 것 (D9). */
  const wideImports = new Map()
  const addEdge = (a, b, via, kind, hub, directed) => {
    if (a === b) return
    // 방향을 아는 엣지는 a→b 순서가 의미를 가지므로 정렬하지 않는다
    const key = directed ? `${a}\0${b}\0d` : a < b ? `${a}\0${b}` : `${b}\0${a}`
    let e = edges.get(key)
    if (!e) {
      const [s, t] = directed ? [a, b] : a < b ? [a, b] : [b, a]
      e = { source: s, target: t, via: new Set(), kind, hub, directed, origin: 'static' }
      edges.set(key, e)
    }
    e.via.add(via)
    if (!hub) e.hub = false
  }

  for (const [c, group] of channelMap) {
    const isHub = hubs.has(c)
    const entries = [...group]
    const pubs = entries.filter(([, d]) => d === 'pub' || d === 'both').map(([p]) => p)
    const subs = entries.filter(([, d]) => d === 'sub' || d === 'both').map(([p]) => p)
    const unknown = entries.filter(([, d]) => d === 'unknown').map(([p]) => p)

    // 발행자 → 구독자. 데이터가 실제로 흐르는 방향이다.
    for (const p of pubs) for (const s of subs) addEdge(p, s, c, 'channel', isHub, true)

    // 방향을 모르는 쪽은 서로 이어만 둔다. 아는 척하지 않는다.
    const rest = [...unknown, ...(pubs.length && subs.length ? [] : [...pubs, ...subs])]
    for (let i = 0; i < rest.length; i++)
      for (let j = i + 1; j < rest.length; j++) addEdge(rest[i], rest[j], c, 'channel', isHub, false)
    // 방향 아는 짝이 하나도 없으면 unknown 끼리도 pub/sub 후보와 이어준다
    if (!(pubs.length && subs.length)) {
      for (const u of unknown)
        for (const p of [...pubs, ...subs]) addEdge(u, p, c, 'channel', isHub, false)
    }
  }

  // import 는 "쓰는 쪽 → 쓰이는 쪽" 으로 방향이 분명하다
  for (const f of live) {
    for (const spec of importsOf(f)) {
      // 🔴 Go 는 하나가 여럿으로 풀린다 — 패키지가 디렉터리이기 때문이다.
      //    다른 언어는 파일 하나로 풀리므로 배열로 감싸 같은 경로를 태운다.
      // 해석 방식은 언어 표가 정한다 (lib/langs.mjs 의 `resolve`).
      // 여기서 언어 이름으로 갈래를 치면 표와 두 곳이 되고, 한쪽만 고치면 갈린다.
      const kind = resolveKind(f.lang)
      const raw = kind === 'dir' ? resolveGo(spec, f.path, index)
        : kind === 'swift' ? resolveSwift(spec, f.path, index)
          : kind === 'ns' ? resolveNs(spec, f.path, index)
            : [(kind === 'include' ? resolveInclude : resolveImport)(spec, f.path, index)].filter(Boolean)
      // resolveImport 는 확신할 때만 경로를 준다. 빈 배열은 외부 패키지이거나 애매한 것이다.
      //
      // 🔴 `resolveSwift` 만 `{targets, hub}` 를 준다. 스위프트 모듈은 상한 초과가
      //    예외가 아니라 기본이라, "크다"를 "없다"로 말하지 않으려면 그 사실을
      //    여기까지 들고 와야 한다 (resolveSwift 주석).
      const targets = Array.isArray(raw) ? raw : raw.targets
      const wide = Array.isArray(raw) ? false : raw.hub

      /**
       * 🔴 큰 모듈은 **엣지가 아니라 배지**로 남긴다. D9 가 허브 채널에 쓰는 것과
       *    같은 처리이고, 이유도 같다.
       *
       *    엣지로 남기면 부르는 쪽 87개 × 모듈 파일 52개 = **4,524개**가 된다
       *    (apple/swift-argument-parser 실측). 그리지도 않을 것을 그만큼 만들어
       *    브라우저까지 내려보낸다. 더 큰 저장소에서는 그대로 터진다.
       *
       *    배지로 남기면 부르는 파일마다 한 줄이다 — 87개. 정보는 같다:
       *    "이 파일은 ArgumentParser 모듈(52개 파일)을 부른다."
       *
       *    **`[]` 와 다른 점이 핵심이다.** 없어서 안 그린 것이 아니라 커서 안
       *    그린 것이라고 말한다. 없는 것과 못 읽은 것을 같은 값으로 말하지 않는다.
       */
      if (wide) {
        if (!wideImports.has(f.path)) wideImports.set(f.path, new Map())
        wideImports.get(f.path).set(spec, targets.length)
        continue
      }
      for (const target of targets) {
        if (target !== f.path) addEdge(f.path, target, stem(target), 'import', false, true)
      }
    }
  }

  // ── 노드의 역할 ───────────────────────────────────────────────────────────
  /**
   * 노드를 누를 때 **물어야 할 질문이 서로 다르다.** 그래서 역할을 나눈다.
   *
   * 이 구분은 실측에서 나왔다. `bbiyong_base/qos.py` 를 누르면 화면의 70%
   * (53/76 노드)가 물들어 색이 정보를 잃었다. 그 파일은 21줄짜리 공용 QoS
   * 상수이고 **나가는 엣지가 0개**다.
   *
   * 거리 계산이 틀린 것이 아니라 **질문이 틀렸다.** 아무 데도 안 나가는 파일에
   * "여기서부터 어디로 가나"(D8 의 거리)는 물을 수 있는 질문이 아니다.
   * 물어야 할 것은 "누가 나를 쓰나" 이고, 그건 반대 방향이다.
   *
   * 기본 화면(허브 제외)에서 보이는 엣지로만 센다. 사람이 보고 있는 것과
   * 판정 근거가 다르면 설명할 수 없는 화면이 된다.
   */
  const deg = new Map(live.map((f) => [f.path, { in: 0, out: 0, undirected: 0 }]))
  for (const e of edges.values()) {
    if (e.hub) continue
    const s = deg.get(e.source)
    const t = deg.get(e.target)
    if (!e.directed) {
      // 방향을 모르는 엣지는 in/out 어느 쪽으로도 세지 않는다 (D5 — 아는 척하지 않는다).
      if (s) s.undirected++
      if (t) t.undirected++
      continue
    }
    if (s) s.out++
    if (t) t.in++
  }
  const roleOf = (d) => {
    if (d.out === 0 && d.in > 0) return 'provider' // 남들이 쓰기만 한다 — qos.py, kinematics.py
    if (d.in === 0 && d.out > 0) return 'consumer' // 쓰기만 한다 — 진입점·테스트
    if (d.in > 0 && d.out > 0) return 'connector'
    return 'isolated' // 방향 있는 연결이 없다. undirected 가 있을 수는 있다
  }

  // ── 노드 ─────────────────────────────────────────────────────────────────
  const groups = new Map()
  const nodes = live.map((f) => {
    const m = meta.get(f.path)
    const chans = [...m.channels.keys()]
    const { group, kind } = classify(f.path)
    const d = deg.get(f.path)
    groups.set(group, (groups.get(group) ?? 0) + 1)
    return {
      id: f.path,
      name: displayName(f.path),
      dir: path.dirname(f.path),
      lang: f.lang,
      lines: f.lines,
      big: f.lines > splitOver,
      group,
      kind,
      role: roleOf(d),
      deg: d,
      badges: chans.filter((c) => hubs.has(c)), // D9 — 허브는 엣지 대신 배지로
      // 🔴 커서 안 그린 import. 빈 배열과 `없음` 은 다른 뜻이다 —
      //    여기 값이 있으면 화면은 '결합 없음' 이 아니라 '너무 커서 안 그림' 이라고 말해야 한다.
      wideImports: [...(wideImports.get(f.path) ?? new Map())].map(([module, files]) => ({ module, files })),
      channels: chans
        .filter((c) => !hubs.has(c))
        .map((c) => ({ channel: c, dir: m.channels.get(c) })),
      // 파서가 못 읽은 파일은 노드로는 있지만 엣지가 없다. 그 사실을 숨기지
      // 않는다 — 화면에서 "연결이 없다"와 "연결을 못 읽었다"는 다르게 읽혀야 한다.
      parsed: PARSED_LANG.has(f.lang),
      confidence: PARSED_LANG.has(f.lang) ? 'static' : 'unparsed',
    }
  })

  return {
    nodes,
    edges: [...edges.values()].map((e) => ({ ...e, via: [...e.via] })),
    hubs: [...hubs].map((c) => ({ channel: c, count: channelMap.get(c).size })),
    // 모듈 이름 → { files, importers }. 상한을 넘어 안 그린 것들의 전체 목록.
    wideModules: [...wideImports.values()].reduce((acc, byMod) => {
      for (const [module, files] of byMod) {
        const cur = acc.find((x) => x.module === module)
        if (cur) cur.importers++
        else acc.push({ module, files, importers: 1 })
      }
      return acc
    }, []).sort((a, b) => b.importers - a.importers),
    groups: [...groups].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    stats: {
      files: live.length,
      skippedBackups: files.length - live.length,
      totalLines: live.reduce((a, f) => a + f.lines, 0),
      channels: channelMap.size,
      big: live.filter((f) => f.lines > splitOver).length,
      directed: [...edges.values()].filter((e) => e.directed).length,
    },
  }
}

// ---------------------------------------------------------------------------
// 기능 안의 참조 — 파서가 못 읽는 언어에서도 순서를 세운다
// ---------------------------------------------------------------------------

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 파일 B 의 이름이 파일 A 안에서 **참조처럼** 쓰였는지.
 *
 * `\bB\b` 만 보면 주석·docstring·산문까지 걸린다. 실측에서 정밀도가 14~15%
 * 였다. 호출(`B(`)·멤버 접근(`B.`)·import 행 세 가지로 좁히면 재현율은
 * 그대로(83~100%)인데 정밀도가 19~35% 로 오른다.
 *
 * `B(` 만 보는 것은 오히려 나빴다 (재현 6~13%) — 파이썬은 `from x import y`
 * 로만 쓰고 이름을 직접 부르지 않는 경우가 많다. 그래서 import 행을 함께 본다.
 */
const referenceRe = (name) =>
  new RegExp(
    `(?:^|\\n)[ \\t]*(?:from|import)[ \\t][\\w., ]*\\b${reEsc(name)}\\b` +
    `|\\b${reEsc(name)}\\s*[(.]`,
  )

/** 이 비율을 넘는 파일에 이름이 나오면 후보에서 뺀다 — `server`·`config` 같은 말. */
const NAME_TOO_COMMON = 0.3
/** 이보다 짧은 이름은 아무 데나 걸린다. */
const NAME_MIN = 4
/** 문서빈도 필터를 켤 최소 모집단. 이보다 적으면 df 가 뜻을 갖지 못한다. */
const DF_MIN_CORPUS = 20

/**
 * 파일 몇 개 사이의 참조 관계를 만든다. 기능 안 트리를 그리는 재료다.
 *
 * 🔴 왜 정적 import 만으로 안 되는가 — `LANG` 에 든 6종 확장자만 파싱하기
 * 때문이다. e101 의 `BE_system` (Java 18,279줄)에서는 import 엣지가 **0개**다.
 * 그러면 "로그인 기능 안이 어떻게 생겼나"에 아무 답도 못 한다.
 *
 * 이름 참조는 언어를 가리지 않는다. Java 에서 실제로 이렇게 나온다:
 *
 *   AuthController → AuthService · LoginRequest · SignupRequest
 *   AuthService    → User · LoginRequest · SignupRequest
 *
 * ⚠️ 정확한 신호가 아니다. 그래서 `origin:'mention'` 을 붙여 화면이
 * 정적으로 확인된 엣지와 구분해 그리게 한다 (D5 — 확신 수준을 속이지 않는다).
 * import 로 이미 확인된 쌍은 그쪽을 남기고 여기서 만들지 않는다.
 *
 * @param {object[]} files scan() 결과 (text 포함)
 * @param {string[]} subset 이 경로들 사이만 본다 (기능 하나)
 * @param {Set<string>} confirmed 이미 정적으로 확인된 `a>b` 쌍
 */
export function referenceEdges(files, subset, confirmed = new Set()) {
  const inSet = new Set(subset)
  const mine = files.filter((f) => inSet.has(f.path))
  if (mine.length < 2) return []

  // 흔한 이름을 걸러낼 문서빈도는 **넓은 모집단**으로 재야 한다.
  // 기능 안 5개만 보면 "5개 중 2개에 나온다"를 흔한 말로 오해한다.
  // 모집단이 너무 작으면 이 필터는 판단 근거가 없으므로 아예 끈다 —
  // 근거 없는 필터는 조용히 진짜 엣지를 지운다.
  const df = new Map()
  if (files.length >= DF_MIN_CORPUS) {
    for (const b of mine) {
      const s = stem(b.path)
      if (s.length < NAME_MIN) continue
      const re = new RegExp(`\\b${reEsc(s)}\\b`)
      let n = 0
      for (const a of files) if (a.path !== b.path && re.test(a.text)) n++
      df.set(s, n / files.length)
    }
  }

  const edges = []
  for (const a of mine) {
    for (const b of mine) {
      if (a.path === b.path) continue
      const s = stem(b.path)
      if (s.length < NAME_MIN || (df.get(s) ?? 0) > NAME_TOO_COMMON) continue
      if (confirmed.has(`${a.path}>${b.path}`)) continue
      if (!referenceRe(s).test(a.text)) continue
      edges.push({
        source: a.path,
        target: b.path,
        via: [s],
        kind: 'reference',
        hub: false,
        directed: true,
        origin: 'mention',
      })
    }
  }
  return edges
}

/**
 * 이 파일들 중 어디부터 읽어야 하나 — 아무도 부르지 않는 것이 진입점이다.
 *
 * `AuthController` 를 부르는 파일은 기능 안에 없다. 반대로 `User` 는 여럿이
 * 부른다. 그래서 들어오는 화살표가 없는 쪽이 뿌리다.
 *
 * 전부 서로를 부르면(순환) 뿌리가 없다. 그때는 나가는 화살표가 가장 많은
 * 것을 고른다 — 없는 답을 만들어내는 것보다 "가장 많이 쓰는 쪽"이 정직하다.
 */
export function entryOf(paths, edges) {
  const inDeg = new Map(paths.map((p) => [p, 0]))
  const outDeg = new Map(paths.map((p) => [p, 0]))
  for (const e of edges) {
    if (!inDeg.has(e.target) || !outDeg.has(e.source)) continue
    inDeg.set(e.target, inDeg.get(e.target) + 1)
    outDeg.set(e.source, outDeg.get(e.source) + 1)
  }
  const roots = paths.filter((p) => inDeg.get(p) === 0 && outDeg.get(p) > 0)
  if (roots.length) return roots.sort((a, b) => outDeg.get(b) - outDeg.get(a) || (a < b ? -1 : 1))[0]
  const any = [...paths].sort((a, b) => outDeg.get(b) - outDeg.get(a) || (a < b ? -1 : 1))
  return any[0] ?? null
}

// ---------------------------------------------------------------------------
// D7 · 시작점으로부터의 깊이
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 *   includeHubEdges  허브 경유 엣지도 거리에 넣을지 (D9)
 *   direction        'both' | 'out' | 'in'
 *
 * 🔴 direction 을 넣은 이유 — 무방향 순회가 fan-in 노드에서 무의미해진다.
 *
 * `qos.py` 는 나가는 엣지가 0인데 'both' 로 재면 53/76 노드가 걸린다.
 * 그 53개는 전부 "qos.py 를 쓰는 쪽"이라 사실은 **반대 방향 한 겹**이다.
 * 방향을 갈라야 "내가 쓰는 것"과 "나를 쓰는 것"이 서로 다른 답이 된다.
 *
 * ⚠️ 방향을 **모르는** 엣지(`directed:false`)는 'out'/'in' 어느 쪽에서도
 * 양쪽으로 통과시킨다. 모른다고 해서 없는 것으로 치면 조용히 빠뜨리게 되고,
 * 그건 이 도구가 가장 하면 안 되는 일이다 (D5). 대신 그런 엣지가 있었다는
 * 사실은 노드의 `deg.undirected` 로 드러난다.
 */
export function depths(graph, start, { includeHubEdges = false, direction = 'both' } = {}) {
  const adj = new Map()
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set())
    adj.get(a).add(b)
  }
  for (const e of graph.edges) {
    if (e.hub && !includeHubEdges) continue
    const bidi = direction === 'both' || !e.directed
    if (bidi || direction === 'out') link(e.source, e.target)
    if (bidi || direction === 'in') link(e.target, e.source)
  }
  const out = new Map([[start, 0]])
  let frontier = [start]
  let d = 0
  while (frontier.length) {
    d++
    const next = []
    for (const n of frontier) {
      for (const m of adj.get(n) ?? []) {
        if (!out.has(m)) {
          out.set(m, d)
          next.push(m)
        }
      }
    }
    frontier = next
  }
  return out
}

/**
 * 그 노드를 눌렀을 때 기본으로 물을 방향.
 *
 * 실측이 이 함수의 존재 이유다. e101 로봇 코드에서 `direction:'both'` 로 재면
 * **어느 노드를 눌러도 도달 노드가 52/76 으로 똑같다.** 무방향으로 보면 이
 * 그래프가 한 덩어리라서, 거리가 노드마다 다른 답을 주지 못한다.
 * 화면이 매번 같은 68%를 칠하고 있었다는 뜻이다.
 *
 * 방향을 가르면 답이 갈린다 — `qos.py` 는 out 1 / in 29,
 * `exploration_node.py` 는 out 32 / in 21.
 *
 * 기본값은 "내가 무엇에 기대는가"(out)다. 코드를 읽는 자연스러운 방향이고,
 * 공용 유틸을 통해 형제 노드로 번지는 것을 막는다.
 * 다만 provider 는 out 이 비어 있으므로(정의상 나가는 엣지가 0) 뒤집는다.
 *
 * ⚠️ 이건 **기본값**이지 판정이 아니다. 화면은 양쪽 수를 함께 보여주고
 * 사용자가 뒤집을 수 있어야 한다. 어느 쪽이 궁금한지는 도구가 알 수 없다.
 */
export function askOf(node) {
  return node?.role === 'provider' ? 'in' : 'out'
}

/** 파일 하나를 열어 코드와 (큰 파일이면) 함수 목록을 준다. */
export function detail(root, rel, { splitOver = 300 } = {}) {
  const abs = path.join(root, rel)
  const text = fs.readFileSync(abs, 'utf8')
  const lang = LANG[path.extname(rel)] ?? 'text'
  const lines = text.split('\n').length
  return {
    path: rel,
    lang,
    lines,
    text,
    // D6 — 큰 파일만 펼친다. 작은 파일은 통째로 읽는 게 낫다.
    outline: lines > splitOver ? outline(text, lang) : [],
    outlineConfidence: 'regex',
  }
}

/** D10 · 결합도 지표 — 평균 영향 범위와 크기 꼬리. */
export function coupling(graph) {
  const reach = graph.nodes.map((n) => depths(graph, n.id).size - 1)
  const avg = reach.length ? reach.reduce((a, b) => a + b, 0) / reach.length : 0
  const big = graph.nodes.filter((n) => n.lines >= 600)
  const total = graph.stats.totalLines || 1
  const top5 = [...graph.nodes].sort((a, b) => b.lines - a.lines).slice(0, 5)
  return {
    avgReach: Number(avg.toFixed(1)),
    maxReach: Math.max(0, ...reach),
    over600: big.length,
    top5Share: Number(((top5.reduce((a, n) => a + n.lines, 0) / total) * 100).toFixed(1)),
    top5: top5.map((n) => ({ path: n.id, lines: n.lines })),
  }
}
