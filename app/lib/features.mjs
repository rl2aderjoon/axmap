/**
 * 기능 클러스터 — 파일이 아니라 "무엇을 함께 이루는가"로 코드를 묶는다.
 *
 * ── 왜 git 동시변경인가 ───────────────────────────────────────────────────
 *
 * import 그래프는 "무엇에 기대는가"를 말하지 "무엇을 함께 이루는가"를 말하지
 * 않는다. `qos.py` 를 8개 파일이 import 하지만 그 8개는 한 기능이 아니라
 * 공용 상수를 쓰는 남남이다. 기능 경계에는 약한 신호다.
 *
 * 반면 **같은 커밋에서 함께 바뀐 파일**은 사람이 한 가지 일로 묶어 만진
 * 것이다. e101 저장소 실측:
 *
 *   BE_system  [5] User · SignupRequest · AuthService · AuthController · LoginRequest
 *   BE_system  [5] VideoController · VideoService · VideoResponses · VideoArchiveTests …
 *   FE         [5] AuthContext · authStore · AuthScreen · authApi · signupRules
 *
 * 그리고 결정적으로 **언어에 의존하지 않는다.** axMap 의 정적 파서는
 * `BE_system` 의 Java 18,279줄을 노드 0개로 본다. 동시변경은 같은 코드에서
 * 위 클러스터들을 그대로 찾아낸다. 최소 설치로 아무 저장소나 붙는다는
 * 목표와 같은 방향이다.
 *
 * ── 한계 (숨기지 않는다) ──────────────────────────────────────────────────
 *
 *   · 커버리지가 30~35% 다. 커밋이 적은 파일은 신호가 없다.
 *   · 히스토리가 짧은 저장소에서는 아무것도 안 나온다.
 *   · 테스트 파일끼리 묶이는 오탐이 있다 (함께 깨져서 함께 고쳐진 것).
 *   · 마이그레이션 중이면 같은 기능이 `.jsx` 것과 `.tsx` 것으로 갈린다.
 *
 * 그래서 이것은 **초안**이다. 이름은 파일명·디렉터리에서 뽑고(provisionalName,
 * disambiguate), 경계는 사람이 고친다(applyEdits).
 *
 * LLM 에게 이름을 시키지 않기로 한 이유는 disambiguate 주석에 있다 — 요약하면
 * 자동 이름이 이미 대부분 맞고, LLM 은 오탐에도 그럴듯한 이름을 붙여 준다.
 *
 * 사람의 수정은 결과가 아니라 **편집**으로 쌓는다. 그래야 코드가 바뀌어 초안을
 * 다시 계산해도 수정이 살아남는다 (applyEdits 주석).
 *
 * 순수 함수만 둔다. git 호출은 live.mjs 가 한다.
 */

/** 이보다 많은 파일을 건드린 커밋은 버린다. */
const BIG_COMMIT = 12

/** 이보다 약한 관계는 엣지로 치지 않는다. */
const MIN_TOGETHER = 2
const MIN_JACCARD = 0.35

/**
 * 파일 하나가 유지하는 최대 파트너 수. 왜 이 값인지는 mutualTop 주석과 아래 실측.
 *
 * 커버리지와 **응집도**를 함께 재서 골랐다. 응집도는
 * "클러스터 안에서 실제로 함께 바뀐 쌍 / 가능한 모든 쌍" 이고,
 * 체인으로 뭉친 덩어리는 가장자리끼리 만난 적이 없어 이 값이 급락한다.
 *
 *   자카드 0.35 기준 (e101 BE_system, 파일 180)
 *   topK   묶임    최대 클러스터   최저 응집도
 *     3     64%          7            0.67
 *     4     68%         11            0.68     ← 이 값
 *     5     69%         24            0.31     ← 24개 뭉텅이 부활
 *
 * 5 에서 무너지는 지점이 예전에 실제로 겪은 그 실패다. 4 는 커버리지를
 * 4%p 더 얻으면서 응집도가 그대로다 — 공짜라 올렸다.
 *
 * 자카드는 0.2~0.45 를 훑어도 0.35 보다 나은 곳이 없었다. 낮추면 커버리지가
 * 조금 늘지만 최저 응집도가 0.24 까지 떨어져 뭉침만 늘어난다. 그대로 둔다.
 */
const TOP_K = 4

/** 이 개수 미만이면 기능이라 부르지 않는다. */
const MIN_CLUSTER = 2

/**
 * 커밋을 `{subject, files}` 로 통일한다.
 *
 * 테스트와 옛 호출부는 `string[][]` 를 준다. 두 모양을 다 받아 주는 편이
 * 호출부마다 변환 코드를 흩뿌리는 것보다 낫다.
 */
const asCommits = (list) =>
  (list ?? []).map((c) => (Array.isArray(c) ? { subject: '', files: c } : { subject: c.subject ?? '', files: c.files ?? [] }))

/**
 * 커밋 제목에서 기능 이름을 뽑는다. 못 쓰겠으면 null.
 *
 * 🔴 이 함수가 실패해도 **명단은 그대로다.** 이름만 파일명 추출로 떨어진다.
 * 커밋 메시지 습관은 저장소마다 천차만별이라 여기 기대면 안 된다.
 *
 * 검증은 포기했다. "제목에 쓰인 말이 파일명에도 있는지" 대조해 보려 했는데
 * 실측에서 17개 중 9개를 잘못 걸렀다 — `실시간 맵 전송 경량화` ↔ `nav_bridge.py`
 * 처럼 **제목은 한국어, 파일명은 영어**면 겹칠 수가 없다. 좋은 이름을 버리는
 * 필터는 없느니만 못하다.
 *
 * 그래서 명백한 쓰레기만 거른다. 애매한 것은 통과시키고, 대신 화면이 출처를
 * `커밋` 으로 표시해 사람이 판단하게 한다. 나쁜 이름은 나쁘다는 게 드러나서
 * 오히려 안전하다 — 그럴듯하게 지어낸 이름이 훨씬 위험하다.
 */
const USELESS_SUBJECT =
  /^(wip|tmp|temp|test|fix|update[sd]?|change[sd]?|edit|minor|misc|cleanup|refactor|commit|save|init(ial)?( commit)?|초안|수정|반영|정리|추가|변경|작업|커밋|[.\d\s-]+)$/i

export function nameFromSubject(subject) {
  if (!subject) return null
  const cleaned = subject
    .replace(/^\[[A-Za-z0-9-]+\]\s*/, '') // [S15P11E101-509]
    .replace(/^(feat|fix|refactor|docs|chore|test|perf|style|build|ci)(\([^)]*\))?[:\s]\s*/i, '')
    .replace(/^\[[^\]]+\]\s*/, '') // [BE]
    // 뒤에 붙은 부제만 뗀다. ` + ` 로 좁힌 이유는 `·` 로 자르면
    // `저장·조회` 같은 접속 표현이 잘려 나가기 때문이다 (실측에서 나온 버그).
    .replace(/\s+\+\s.*$/, '')
    .trim()
  if (cleaned.length < 4 || USELESS_SUBJECT.test(cleaned)) return null
  return cleaned.length > 60 ? `${cleaned.slice(0, 58)}…` : cleaned
}

/**
 * 경로 B — 한 커밋이 **함께 만든** 파일들도 기능으로 본다.
 *
 * 🔴 왜 필요한가. 경로 A(반복 동시변경)는 "두 번 이상 함께 고쳐진 것"만 본다.
 * 뒤집으면 **자주 고쳐진 코드 = 문제가 많았던 코드**만 남는다는 뜻이고,
 * 한 번에 잘 만들어지고 안 고쳐진 코드는 존재하지 않게 된다.
 *
 * 실측이 명확했다. e101 `BE_system` 에서 기능에 안 묶인 파일 133개 중
 * **101개(76%)가 커밋 1회**였고, 그것들이 19개 커밋에 92개가 모여 있었다.
 * 그리고 그 커밋들은 전부 명백한 기능이었다 —
 * `순찰 지점(waypoint) 저장·조회 API`, `매핑 완료 시 2D 도면 자동 생성`.
 *
 * 4주짜리 프로젝트에서는 대부분의 코드가 한 번 쓰이고 안 고쳐지므로,
 * 신생 저장소일수록 이 편향이 크다. "아무 저장소나 붙는다" 와 정면으로 어긋난다.
 *
 * ⚠️ 근거는 A 보다 약하다 (한 번 vs 여러 번). `evidence:'once'` 로 구분한다.
 *
 * @param {Set<string>} taken 경로 A 가 이미 가져간 파일. 강한 근거가 이긴다.
 */
export function onceClusters(commits, taken, known = null, { bigCommit = BIG_COMMIT, minCluster = MIN_CLUSTER } = {}) {
  const list = asCommits(commits)

  // 이 파일이 몇 개의 커밋에 나오는가
  const seen = new Map()
  for (const c of list) for (const p of new Set(c.files)) seen.set(p, (seen.get(p) ?? 0) + 1)

  const out = []
  let droppedBig = 0
  for (const c of list) {
    const files = [...new Set(c.files)]
    if (files.length > bigCommit) {
      // 큰 커밋은 여러 일이 섞여 있다. 안에서 다시 쪼개 보려 했지만 안전한
      // 규칙이 없었다 — ROS2 는 디렉터리가 관심사라 잘 갈리는데, Spring 은
      // 디렉터리가 계층이라 한 기능이 9개 디렉터리에 1개씩 흩어진다.
      // 게다가 실측에서 큰 커밋 4개 중 3개가 revert·제거·리팩터였다.
      // 버리되 **몇 개를 버렸는지 화면에 알린다.**
      if (files.some((p) => (seen.get(p) ?? 0) === 1)) droppedBig++
      continue
    }
    const fresh = files
      .filter((p) => seen.get(p) === 1) // 이 커밋에서만 등장
      .filter((p) => !taken.has(p)) // 경로 A 가 이미 가져갔으면 그쪽이 이긴다
      .filter((p) => !known || known.has(p)) // 지워진 파일 제외
      .sort()
    if (fresh.length < minCluster) continue

    out.push({
      id: featureId(fresh),
      name: nameFromSubject(c.subject) ?? provisionalName(fresh),
      nameSource: nameFromSubject(c.subject) ? 'commit' : 'auto',
      paths: fresh,
      commits: 1,
      source: 'commit',
      evidence: 'once',
    })
  }
  return { features: out, droppedBig }
}

/**
 * 커밋 목록에서 파일 쌍의 동시변경 강도를 잰다.
 *
 * 횟수를 그대로 쓰지 않고 자카드로 정규화한다. 자주 바뀌는 파일은 무엇과도
 * 함께 바뀌므로, 횟수만 세면 그런 파일이 저장소 전체와 짝이 된다.
 *
 * @param {string[][]} commits 커밋마다 바뀐 경로 목록
 */
export function cochange(commits, { bigCommit = BIG_COMMIT, minTogether = MIN_TOGETHER, minJaccard = MIN_JACCARD } = {}) {
  const pair = new Map()
  const solo = new Map()

  for (const c of asCommits(commits)) {
    // 대량 커밋(일괄 포맷팅·대규모 이동)은 신호가 아니라 잡음이다.
    // 파일 수의 제곱으로 쌍이 늘어 클러스터를 통째로 뭉갠다.
    const files = [...new Set(c.files)]
    if (files.length < 2 || files.length > bigCommit) continue

    for (const p of files) solo.set(p, (solo.get(p) ?? 0) + 1)
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const [a, b] = files[i] < files[j] ? [files[i], files[j]] : [files[j], files[i]]
        const k = `${a}\u0000${b}`
        pair.set(k, (pair.get(k) ?? 0) + 1)
      }
    }
  }

  const links = []
  for (const [k, n] of pair) {
    const [a, b] = k.split('\u0000')
    const j = n / (solo.get(a) + solo.get(b) - n)
    if (n >= minTogether && j >= minJaccard) links.push({ a, b, n, j })
  }
  return { links, solo }
}

/**
 * 서로가 서로의 상위 파트너인 관계만 남긴다.
 *
 * 🔴 이것이 없으면 클러스터가 체인으로 뭉친다. A-B 가 강하고 B-C 가 강하면
 * A 와 C 가 아무 상관 없어도 연결 요소로는 한 덩어리다. 실측에서 `BE_system`
 * 이 정확히 그렇게 됐다 — 서로 다른 기능들이 24개짜리 덩어리 하나로 붙어
 * "기능별로 보기"라는 목적 자체가 사라졌다.
 *
 * 상호 top-K 를 걸면 24 → 7 로 줄고 회원가입·영상·맵이 각각 분리된다.
 * K 를 6 으로 올리면 다시 24가 된다. 3 이 실측에서 가장 깨끗했다.
 */
export function mutualTop(links, { topK = TOP_K } = {}) {
  const adj = new Map()
  for (const l of links) {
    for (const [x, y] of [[l.a, l.b], [l.b, l.a]]) {
      if (!adj.has(x)) adj.set(x, [])
      adj.get(x).push({ y, j: l.j })
    }
  }
  for (const v of adj.values()) v.sort((p, q) => q.j - p.j || (p.y < q.y ? -1 : 1))
  const top = new Map([...adj].map(([x, v]) => [x, new Set(v.slice(0, topK).map((o) => o.y))]))
  return links.filter((l) => top.get(l.a)?.has(l.b) && top.get(l.b)?.has(l.a))
}

/** 연결 요소. 상호 top-K 를 통과한 뒤라 체인이 이미 끊겨 있다. */
function components(links) {
  const par = new Map()
  const find = (x) => (par.get(x) === x ? x : (par.set(x, find(par.get(x))), par.get(x)))
  for (const l of links) for (const x of [l.a, l.b]) if (!par.has(x)) par.set(x, x)
  for (const l of links) {
    const ra = find(l.a)
    const rb = find(l.b)
    if (ra !== rb) par.set(ra, rb)
  }
  const out = new Map()
  for (const x of par.keys()) {
    const r = find(x)
    if (!out.has(r)) out.set(r, [])
    out.get(r).push(x)
  }
  return [...out.values()]
}

/**
 * 이름을 짓지 못했을 때 쓸 임시 이름.
 *
 * LLM 이 붙이기 전에도 목록이 읽혀야 한다. 공통 디렉터리와 가장 흔한
 * 파일명 어간을 쓴다 — `MapService`·`MapController` → `map`.
 * 이건 이름이 아니라 자리표시자이므로 화면에서 출처를 `auto` 로 표시한다.
 */
export function provisionalName(paths) {
  const stems = paths.map((p) => p.split('/').pop().replace(/\.[^.]+$/, ''))
  const freq = new Map()
  for (const s of stems) {
    // CamelCase 와 snake_case 를 같은 방식으로 쪼갠다
    for (const w of s.split(/(?=[A-Z])|[_\-.]/)) {
      const k = w.toLowerCase()
      if (k.length < 3 || k === 'test' || k === 'tests') continue
      freq.set(k, (freq.get(k) ?? 0) + 1)
    }
  }
  const best = [...freq].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]
  if (best && best[1] >= 2) return best[0]
  const dirs = paths.map((p) => p.split('/').slice(0, -1).join('/'))
  const common = dirs.reduce((a, b) => {
    const x = a.split('/')
    const y = b.split('/')
    let i = 0
    while (i < x.length && i < y.length && x[i] === y[i]) i++
    return x.slice(0, i).join('/')
  })
  return common.split('/').pop() || '(이름 없음)'
}

/** 이름 후보에서 뺄 말. 어느 묶음에나 있어서 아무것도 구별해 주지 못한다. */
const STOP = new Set([
  'test', 'tests', 'spec', 'src', 'main', 'java', 'com', 'org', 'lib', 'app',
  'index', 'util', 'utils', 'common', 'core', 'impl', 'base', 'node', 'py',
])

/** 파일 경로에서 이름 후보 토큰을 뽑는다. 파일명과 디렉터리 마디를 함께 본다. */
function tokensOf(p) {
  const out = []
  const parts = p.split('/')
  const file = parts.pop().replace(/\.[^.]+$/, '')
  for (const seg of [...parts, file]) {
    for (const w of seg.split(/(?=[A-Z])|[_\-.]/)) {
      const k = w.toLowerCase()
      if (k.length >= 3 && !STOP.has(k)) out.push(k)
    }
  }
  return out
}

/**
 * 이 비율을 넘는 파일에 나오는 말은 이름 후보에서 뺀다.
 *
 * `server` · `com` · 회사명 · 프로젝트명처럼 **패키지 뿌리에 있는 말**은
 * 모든 경로에 나오므로 아무것도 구별해 주지 못한다. 실측에서 실제로
 * `robot·server` 라는 이름이 나왔다 — 저장소의 모든 Java 경로가
 * `.../server/...` 였기 때문이다.
 *
 * STOP 목록에 프로젝트별 단어를 계속 더하는 대신 빈도로 거른다.
 * 그래야 다른 저장소에 붙여도 같은 규칙이 작동한다.
 */
const TOO_COMMON = 0.5

/**
 * 이름이 겹치는 기능들을 구별한다.
 *
 * 실측에서 `BE_system` 의 두 묶음이 똑같이 `robot` 이 됐다.
 *
 *   robot [5]  stomp/RobotEventListener · stomp/StompWebSocketConfig · wss/RobotWebSocketHandler …
 *   robot [4]  robot/domain/RobotState · robot/dto/RobotResponse · robot/service/RobotService …
 *
 * 목록에 같은 이름이 둘 있으면 무엇을 누르는지 알 수 없다. **이름의 목적은
 * 아름다움이 아니라 구별과 정직함**이므로 여기서 필요한 것은 좋은 작명이
 * 아니라 겹치지 않게 만드는 것이다.
 *
 * 그래서 **그 묶음에만 있는 말**을 붙인다 — 묶음 안 빈도를 저장소 전체 빈도로
 * 나눠 가장 높은 토큰을 고른다. `service` 처럼 어디에나 있는 말은 낮은 점수를
 * 받고, `stomp` · `cache` 처럼 그 묶음에 몰려 있는 말이 뽑힌다.
 *
 * LLM 에게 이름을 시키지 않는 이유도 여기 있다. LLM 은 `controller [7]` 같은
 * **오탐에도 그럴듯한 이름**을 붙여 준다. 어색한 이름은 사람이 열어보게
 * 만들지만, 그럴듯한 이름은 그냥 통과시키게 만든다 (D5).
 */

export function disambiguate(features) {
  const global = new Map()
  const docs = new Set()
  for (const f of features) {
    for (const p of f.paths) {
      docs.add(p)
      for (const t of new Set(tokensOf(p))) global.set(t, (global.get(t) ?? 0) + 1)
    }
  }
  const tooCommon = (t) => global.get(t) / docs.size > TOO_COMMON

  const byName = new Map()
  for (const f of features) {
    if (!byName.has(f.name)) byName.set(f.name, [])
    byName.get(f.name).push(f)
  }

  for (const [name, group] of byName) {
    if (group.length < 2) continue
    const taken = new Set()
    for (const f of group) {
      const local = new Map()
      for (const p of f.paths) {
        for (const t of new Set(tokensOf(p))) local.set(t, (local.get(t) ?? 0) + 1)
      }
      // 점수 = 묶음 안 빈도² / 저장소 전체 빈도.
      //   분자를 제곱하는 이유: **묶음을 넓게 덮는 말**이 그 묶음을 잘 설명한다.
      //   처음에 빈도/전체(구별력)만 봤더니 파일 하나에만 있는 `config` 가
      //   두 파일에 걸친 `stomp` 를 사전순 동점으로 이겼다. 둘 다 그 묶음에만
      //   있어 구별력은 같지만, 덮는 범위가 다르다.
      //   분모는 흔한 말(`service` 처럼 어디에나 있는 것)을 눌러 준다.
      const score = (t, n) => (n * n) / global.get(t)
      const best = [...local]
        .filter(([t]) => t !== name && !taken.has(t) && !tooCommon(t))
        // 점수가 같으면 사전순으로 못박는다. 같은 입력에 같은 이름이 나와야
        // 편집 기록의 anchor 가 흔들리지 않는다.
        .sort((a, b) => score(b[0], b[1]) - score(a[0], a[1]) || (a[0] < b[0] ? -1 : 1))[0]
      if (best) {
        taken.add(best[0])
        f.name = `${name}·${best[0]}`
      } else {
        // 구별할 말이 하나도 없으면 번호를 붙인다. 예쁘지 않지만 정직하다.
        f.name = `${name} ${group.indexOf(f) + 1}`
      }
    }
  }
  return features
}

/**
 * 기능 사이의 관계 — 같은 커밋에서 두 기능이 함께 바뀐 횟수.
 *
 * 자동으로 만든 기능들은 서로 **겹치는 파일이 없다** (연결 요소로 잘랐으므로).
 * 그래서 "공유 파일"로는 엣지가 하나도 안 생긴다. 대신 커밋을 본다 —
 * 로그인을 고치면서 이벤트 로그도 함께 고쳤다면 두 기능은 이어져 있다.
 *
 * import 를 쓰지 않는 이유는 파서가 읽는 언어가 6종뿐이기 때문이다.
 * 동시변경은 Java 든 Go 든 똑같이 잡힌다.
 */
export function featureEdges(features, commits, { minTogether = 1 } = {}) {
  const owner = new Map()
  features.forEach((f, i) => {
    for (const p of f.paths) {
      if (!owner.has(p)) owner.set(p, [])
      owner.get(p).push(i)
    }
  })

  const pair = new Map()
  for (const c of asCommits(commits)) {
    const hit = [...new Set(c.files.flatMap((p) => owner.get(p) ?? []))]
    if (hit.length < 2) continue
    for (let i = 0; i < hit.length; i++) {
      for (let j = i + 1; j < hit.length; j++) {
        const [a, b] = hit[i] < hit[j] ? [hit[i], hit[j]] : [hit[j], hit[i]]
        const k = `${a} ${b}`
        pair.set(k, (pair.get(k) ?? 0) + 1)
      }
    }
  }

  const edges = []
  for (const [k, n] of pair) {
    if (n < minTogether) continue
    const [a, b] = k.split(' ').map(Number)
    edges.push({
      source: features[a].id,
      target: features[b].id,
      n,
      // 방향은 모른다. 함께 바뀌었다는 사실에 앞뒤가 없다 (D5 — 아는 척하지 않는다).
      directed: false,
    })
  }
  return edges.sort((x, y) => y.n - x.n)
}

/**
 * 안정적인 식별자.
 *
 * 이름이 아니라 **구성 파일**에서 뽑는다. 사람이 이름을 바꿔도 같은 기능을
 * 계속 가리켜야 하고, 그래야 편집 기록이 이름 변경에도 살아남는다.
 * 파일이 하나 늘고 주는 정도로는 안 흔들리도록 가장 안정적인 축 —
 * 정렬된 경로 중 첫 번째 — 을 쓴다.
 */
export function featureId(paths) {
  const sorted = [...paths].sort()
  return sorted[0].replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60)
}

/**
 * 커밋 목록 → 기능 초안.
 *
 * @param {string[][]} commits
 * @param {Set<string>|null} known 지금 저장소에 실제로 있는 경로. 지워진 파일을 걸러낸다.
 */
export function draft(commits, known = null, opts = {}) {
  const list = asCommits(commits)
  const { links, solo } = cochange(list, opts)
  const kept = mutualTop(links, opts)

  const groups = components(kept)
    .map((g) => (known ? g.filter((p) => known.has(p)) : g))
    .filter((g) => g.length >= (opts.minCluster ?? MIN_CLUSTER))

  const features = groups
    .map((paths) => {
      const sorted = [...paths].sort()
      return {
        id: featureId(sorted),
        name: provisionalName(sorted),
        nameSource: 'auto', // 'auto' | 'llm' | 'human' — 화면이 출처를 숨기지 않는다
        paths: sorted,
        // 이 기능이 얼마나 자주 손대지는가. 목록 정렬과 D10 추세에 쓴다
        commits: Math.max(...sorted.map((p) => solo.get(p) ?? 0)),
        source: 'cochange',
        evidence: 'repeat', // 여러 번 함께 고쳐졌다 — 강한 근거
      }
    })
    .sort((a, b) => b.paths.length - a.paths.length || (a.id < b.id ? -1 : 1))

  // 경로 B — 반복 신호가 없는 것들을 커밋 단위로 건진다.
  // 경로 A 가 가져간 파일은 넘기지 않는다 (강한 근거가 이긴다).
  const taken = new Set(features.flatMap((f) => f.paths))
  const once = onceClusters(list, taken, known, opts)
  features.push(...once.features.sort((a, b) => b.paths.length - a.paths.length || (a.id < b.id ? -1 : 1)))

  // 이름이 겹치면 목록에서 무엇을 누르는지 알 수 없다. 초안 단계에서 갈라 둔다.
  disambiguate(features)

  const covered = new Set(features.flatMap((f) => f.paths))
  return {
    features,
    stats: {
      commitsSeen: list.length,
      commitsUsed: list.filter((c) => {
        const n = new Set(c.files).size
        return n >= 2 && n <= (opts.bigCommit ?? BIG_COMMIT)
      }).length,
      links: links.length,
      linksKept: kept.length,
      files: new Set(list.flatMap((c) => c.files)).size,
      covered: covered.size,
      // 근거별로 몇 개인지 숨기지 않는다
      repeatFeatures: features.filter((f) => f.evidence === 'repeat').length,
      onceFeatures: features.filter((f) => f.evidence === 'once').length,
      // 조용히 버리지 않는다 — 저장소마다 커밋 습관이 달라 이 판단이 틀릴 수 있다
      droppedBigCommits: once.droppedBig,
    },
  }
}

// ---------------------------------------------------------------------------
// 사람의 수정 — 결과가 아니라 "편집"을 저장한다
// ---------------------------------------------------------------------------

/**
 * 🔴 왜 결과가 아니라 편집을 쌓는가.
 *
 * 합쳐진 결과 하나만 저장하면 다음 두 가지 중 하나가 반드시 일어난다.
 *   · 코드가 바뀌어 초안을 다시 계산하면 **사람의 수정이 지워진다**
 *   · 지워지지 않게 하려면 다시 계산을 포기해야 하고, 지도가 코드와 어긋난다
 *
 * 편집만 따로 쌓으면 초안은 언제든 다시 계산되고 그 위에 수정이 다시 얹힌다.
 * 장부(ledger)가 claim 을 append-only 로 쌓고 `audit` 이 재생해 증명하는 것과
 * 같은 구조다. 여기서도 재생 가능성이 곧 신뢰다.
 *
 * 그리고 append-only 이므로 **머지 충돌이 거의 안 난다.** 두 사람이 각자
 * 다른 기능을 고치면 서로 다른 줄이 추가될 뿐이다. 같은 줄을 고치는 것이
 * 아니라 줄을 더하는 것이라 git 이 알아서 합친다.
 *
 * 편집 종류:
 *   rename   이름 바꾸기
 *   include  이 파일도 이 기능이다
 *   exclude  이 파일은 이 기능이 아니다
 *   create   초안에 없던 기능을 사람이 만든다
 *   hide     이 기능은 목록에서 빼라 (테스트 정비 같은 오탐)
 *   merge    두 기능은 사실 하나다
 */

/**
 * 편집이 가리키는 기능을 찾는다.
 *
 * id 만으로 찾으면 안 된다 — id 는 구성 파일에서 나오므로 파일이 하나
 * 빠지는 것만으로도 바뀔 수 있다. 그러면 어제 붙인 이름이 오늘 사라진다.
 *
 * 그래서 편집에 **그때의 파일 목록(anchor)** 을 함께 적어 두고, id 가 안
 * 맞으면 겹침이 가장 큰 기능으로 잇는다. 그마저 약하면 잇지 않고
 * `orphans` 로 돌려준다 — 조용히 버리면 사람이 한 일이 이유 없이 사라진다.
 */
const ORPHAN_BELOW = 0.4

function resolve(features, edit) {
  const byId = features.find((f) => f.id === edit.id)
  if (byId) return byId
  const anchor = edit.anchor ?? []
  if (!anchor.length) return null

  let best = null
  let bestJ = 0
  for (const f of features) {
    const set = new Set(f.paths)
    const hit = anchor.filter((p) => set.has(p)).length
    const j = hit / (new Set([...anchor, ...f.paths]).size || 1)
    if (j > bestJ) { bestJ = j; best = f }
  }
  return bestJ >= ORPHAN_BELOW ? best : null
}

/**
 * 초안 위에 사람의 편집을 얹는다. 초안은 건드리지 않는다.
 *
 * @param {object[]} features draft() 가 만든 초안
 * @param {object[]} edits    시간순 편집 기록
 */
export function applyEdits(features, edits = []) {
  // 초안을 복사한다. 원본을 고치면 다시 계산할 때 어디까지가 초안인지 알 수 없다.
  let out = features.map((f) => ({ ...f, paths: [...f.paths], edited: false }))
  const orphans = []

  for (const e of edits) {
    if (e.op === 'create') {
      const paths = [...new Set(e.paths ?? [])].sort()
      if (!paths.length) continue
      out.push({
        id: e.id ?? featureId(paths),
        name: e.name ?? provisionalName(paths),
        nameSource: 'human',
        paths,
        commits: 0,
        source: 'human',
        edited: true,
      })
      continue
    }

    const f = resolve(out, e)
    if (!f) { orphans.push(e); continue }
    f.edited = true

    switch (e.op) {
      case 'rename':
        f.name = e.name
        f.nameSource = e.by === 'llm' ? 'llm' : 'human'
        break
      case 'include':
        if (!f.paths.includes(e.path)) { f.paths.push(e.path); f.paths.sort() }
        break
      case 'exclude':
        f.paths = f.paths.filter((p) => p !== e.path)
        break
      case 'hide':
        f.hidden = true
        break
      case 'merge': {
        const into = resolve(out, { id: e.into, anchor: e.intoAnchor })
        if (!into || into === f) break
        into.paths = [...new Set([...into.paths, ...f.paths])].sort()
        into.edited = true
        f.merged = into.id
        f.hidden = true
        break
      }
      default:
        // 모르는 편집은 버리지 않고 드러낸다. 새 버전이 쓴 것일 수 있다.
        orphans.push(e)
    }
  }

  // 비어 버린 기능은 목록에서 뺀다 (사람이 파일을 다 빼낸 경우)
  out = out.filter((f) => f.paths.length > 0)
  return { features: out, orphans }
}

/** 편집 한 줄을 만든다. anchor 를 반드시 함께 적는다 — 위 resolve 주석 참조. */
export function editRecord(op, feature, extra = {}) {
  return { op, id: feature.id, anchor: feature.paths, ...extra }
}

/**
 * 한 파일이 속한 기능들.
 *
 * 기능은 파일의 **분할이 아니라 겹치는 덮개**다. `cmd_mux_node.py` 는
 * 주행에도 긴급정지에도 수동조종에도 속한다. 그래서 여기는 배열을 돌려준다.
 * 그리고 이 배열의 길이 자체가 D10 이 재려는 결합도다 —
 * "이 파일은 기능 5개에 걸쳐 있다" 는 평균 영향 범위보다 사람 말에 가깝다.
 */
export function featuresOf(features, path) {
  return features.filter((f) => f.paths.includes(path))
}
