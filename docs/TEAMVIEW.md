# 팀 뷰 — 화면에 붙이는 법

D14 3단계("함께 짠다")의 분석 층이다. 구현은 [`app/lib/teamview.mjs`](../app/lib/teamview.mjs),
테스트는 [`test/teamview.test.mjs`](../test/teamview.test.mjs).

이 문서에 적힌 모양은 **추측이 아니라 이 저장소 자신의 장부로 돌려서 나온 실제 반환값**이다.
붙이는 사람은 `server.mjs` 와 `overlay.js` 만 고치면 된다. 이 층은 순수 함수뿐이라
git 도 파일도 시계도 건드리지 않는다.

---

## 0. 한 줄 요약

| 함수 | 답하는 질문 |
|---|---|
| `whoIsWhere(claims, modified, featureNodes, {now})` | 누가 **어느 기능**을 잡고 있나 |
| `collisionRisk(claims, coEdges, freq, now, opts)` | **경로는 안 겹치는데** 같은 기능을 건드릴 사람은 누구인가 |
| `staleClaims(claims, now)` | 저 사람 아직 하고 있나 |
| `summary({who, risk, stale, me})` | 위 셋을 한 문단으로 |

🔴 **전부 경고이고 게이트가 아니다.** `checkOverlap` 은 한 줄도 안 건드렸다.
모든 위험 쌍과 요약에 `blocking: false` 가 박혀 있다. 화면이 이 값을 근거로
작업을 막으면 안 된다 — 막는 것은 `axmap claim` 의 종료 코드 2 뿐이다.

---

## 1. 서버에 붙이기 — `/api/teamview`

`/api/watch` 가 이미 `liveState()` + `featureAdjacency` 를 낸다. 그 옆에 하나 더 둔다.
**두 벌로 만들지 말 것** — `liveState()` 를 다시 구현하면 두 화면이 서로 다른 답을 한다.

```js
import { collisionRisk, staleClaims, summary, whoIsWhere } from './lib/teamview.mjs'

if (url.pathname === '/api/teamview') {
  const o = overlayGraph()                    // nodes · edges · co · freq
  const now = Date.now()

  // 🔴 장부 원본이 필요하다. readClaims() 는 만료를 이미 걸러서 주므로,
  //    그것만 쓰면 "아까 그 사람 어디 갔지" 에 답할 수 없다.
  //    (staleClaims 가 만료 레코드를 따로 내는 것이 이 함수의 일 절반이다.)
  const raw = readLedgerClaims(ROOT)          // .axmap/ledger/claims/*.json 그대로
  const { files } = modifiedFiles(ROOT)
  const fg = featureGraphCached()             // /api/featuregraph 와 같은 것을 재사용

  const who = whoIsWhere(raw, files, fg.nodes, { now })
  const risk = collisionRisk(raw, o.co?.edges ?? [], o.co?.freq, now, {
    featureNodes: fg.nodes,                   // 화면과 같은 모듈 경계를 쓰게 한다
    paths: o.nodes.map((n) => n.id),
  })
  const stale = staleClaims(raw, now)
  json(res, { ...summary({ who, risk, stale, me: ME }), who, risk, stale })
}
```

### 인자에 대한 주의

| 인자 | 어디서 | 안 주면 |
|---|---|---|
| `claims` | 장부 원본(`since`+`ttlMs`) 또는 `readClaims()` 결과(`expiresAt`) — **둘 다 받는다** | — |
| `now` | `Date.now()` — 순수 층이라 시계를 인자로 받는다 | 만료 판정을 **안 한다**. `gaps` 가 그렇게 말한다 |
| `freq` | `coChange()` 의 `freq` (Map) | `historyBlind` 가 전부 켜지고 `gaps` 에 경고가 뜬다 |
| `opts.featureNodes` | `/api/featuregraph` 의 `nodes` | `modulesOf` 로 직접 나눈다 (경계가 화면과 어긋날 수 있다) |
| `opts.paths` | 그래프 노드 id | 히스토리에 없는 파일이 세계에서 빠진다 |

> ⚠️ `freq` 는 Map 이다. **JSON 을 한 번 건너면 빈 객체가 된다.** 그러면 히스토리
> 판정이 통째로 사라지는데 아무도 모른다. 그 상황을 감지해 `gaps` 로 말하지만,
> 서버가 in-process 로 넘기는 것이 맞다.

---

## 2. `whoIsWhere` — 반환 모양 (실측)

```jsonc
{
  "features": [
    {
      "id": "app/web",
      "name": "web",
      "container": false,          // true 면 기능이 아니라 '나머지' 통이다 (§5)
      "nameSource": "path",        // 'docs' | 'path' — 이름을 어디서 얻었나
      "dir": "app/web",
      "files": 2,                  // 이 기능의 파일 수 (그래프 기준)
      "claimedFiles": 2,
      "freeFiles": 0,
      "touchedFiles": 0,
      "holders": [
        {
          "agent": "agent-pr",
          "task": "pr-view",
          "intent": "commitFiles 에 ref 옵션 …",
          "actor": null,           // 'human' | 'ai' | 'team' | null
          "files": ["app/web/graph.js", "app/web/overlay.js"],
          "count": 2,
          "share": 1,              // 0~1
          "whole": true,           // 🔴 부분 점유와 전체 점유를 반드시 나눠 그린다
          "touched": 0
        }
      ],
      "undeclared": [],            // 선언 없이 바뀐 파일 (D3)
      "free": [],                  // 🔴 지금 바로 claim 할 수 있는 경로
      "freeTruncated": 0,
      "state": "whole",            // free | partial | whole | contested
      "stateLabel": "전체 점유",
      "sentence": "agent-pr이 web 전체를 잡고 있다 (파일 2개 전부)"
    }
  ],
  "outside": [
    {
      "agent": "agent-team",
      "task": "team-view",
      "intent": "3단계 분석층",
      "paths": ["app/lib/teamview.mjs", "docs/TEAMVIEW.md", "test/teamview.test.mjs"],
      "near": [                    // 아직 커밋 안 된 새 파일이 어느 기능 옆인지
        { "path": "app/lib/teamview.mjs", "feature": "app/lib", "name": "lib" }
      ]
    }
  ],
  "expired": [{ "agent": "…", "task": "…", "paths": ["…"] }],
  "unreadable": [{ "agent": "(손상: x.json)" }],
  "stats": {
    "agents": 2, "totalFeatures": 4, "occupiedFeatures": 2,
    "contested": 0, "wholeHeld": 1, "partialHeld": 1, "containers": 1
  },
  "gaps": ["기능 지도에 없는 경로를 잡은 사람이 2명 있다 — …"]
}
```

### 🔴 `whole` 과 `free` 를 반드시 함께 그린다

부분 점유를 전체 점유처럼 칠하면 다른 사람이 **그 기능 전체가 막혔다고 오해한다.**
이 도구의 목적은 중복을 막는 것이지 사람을 세워두는 것이 아니다.
`free` 는 지금 당장 claim 할 수 있는 경로 목록이므로, 화면은 그것을
복사 가능한 명령으로 보여주는 것이 좋다.

```
민수가 Data Mining 을 잡고 있다 (파일 7개 중 3개 — 나머지 4개는 아직 비어 있다)
  → axmap claim src/vector/knn.py --task <내작업> --intent "…"
```

`features` 는 **점유되었거나 변경된 기능만** 들어 있다. 나머지는 자유롭다는 뜻이므로
화면은 목록에 없는 노드를 기본 색으로 두면 된다. 전체 개수는 `stats.totalFeatures`.

---

## 3. `collisionRisk` — 반환 모양 (실측)

```jsonc
{
  "pairs": [
    {
      "level": "high",             // certain | high | medium | low
      "label": "높음",
      "agents": ["agent-pr", "agent-team"],
      "tasks":  ["pr-view", "team-view"],
      "intents": ["commitFiles 에 ref 옵션 …", "3단계 분석층"],
      "actors": [null, null],
      "paths": [["app/lib/live.mjs", "…"], ["app/lib/teamview.mjs", "…"]],
      "files": [["app/lib/live.mjs", "…"], ["app/lib/teamview.mjs"]],
      "reasons": [
        {
          "kind": "module",        // path | module | cochange | folder
          "level": "high",
          "module": "app/lib",
          "name": "lib",
          "nameSource": "path",
          "files": [["app/lib/live.mjs"], ["app/lib/teamview.mjs"]],
          "inferredFrom": ["app/lib/teamview.mjs"],   // 그래프에 없어 디렉터리로 맞춘 새 파일
          "why": "같은 기능 \"lib\"(app/lib) 안에서 …"
        }
      ],
      "why": "…",                  // reasons 의 why 를 이어 붙인 한 문장
      "historyBlind": ["app/lib/teamview.mjs", "…"],  // 히스토리가 없는 파일 (null 이면 없음)
      "blocking": false            // 🔴 언제나 false
    }
  ],
  "counts": { "certain": 0, "high": 1, "medium": 0, "low": 0 },
  "checked": 2,
  "blocking": false,
  "gaps": ["…"]
}
```

사람이 읽는 여러 줄 경고문이 필요하면 `formatRisk(pair)` 를 쓴다.
`adjacent.mjs` 의 `formatAdjacency` 와 같은 재료·같은 모양이다.

### 등급이 뜻하는 것

| 등급 | 언제 | 근거의 성격 |
|---|---|---|
| `certain` 확실 | 두 claim 이 같은 경로를 덮는다 | 프로토콜이 이미 막는 사실. **보이면 장부가 갈라진 것이다** |
| `high` 높음 | 같은 기능 모듈 안의 **다른** 파일 | 앞(API)에서 오는 사람과 뒤(저장소)에서 오는 사람이 여기서 만난다 |
| `medium` 중간 | 모듈은 다른데 히스토리가 강하게 공변경 | `lift ≥ 3` · `support ≥ 4` — **조절 가능한 숫자**에 기댄다 |
| `low` 낮음 | 같은 폴더에 있다는 것뿐 | 아는 것이 없다 |

🔴 **이 순서는 결과의 심각도가 아니라 근거의 세기다.**
`low` 는 "안전하다" 가 아니라 "우리가 아는 것이 적다" 는 뜻이다. 화면 문구가
이 차이를 흐리면 사용자가 낮음을 안전으로 읽는다. `why` 문자열이 매번 그것을
말하므로 **문구를 화면에서 다시 짓지 말고 그대로 보여준다.**

### 색

등급을 색 하나로 뭉개지 말고, **근거의 종류(`reasons[].kind`)를 배지로** 붙인다 —
D12 가 엣지 출처를 사분면으로 나눈 것과 같은 이유다.

| 등급 | 제안 | 비고 |
|---|---|---|
| `certain` | 빨강, 실선, 굵게 | 이건 사고다. 눈에 띄어야 한다 |
| `high` | 주황, 실선 | 3단계의 주인공. 기본으로 켜 둔다 |
| `medium` | 노랑, 파선 | 파선 = 히스토리 추론이라는 표시 |
| `low` | 회색, 점선, **기본 꺼짐** | 켜는 것은 사용자가 고른다 |

그래프에서는 **두 claim 의 기능 노드 사이에 경고 엣지**를 그린다. 파일 노드끼리
잇지 않는다 — 3단계 사용자가 보는 축은 기능이고, 파일 단위로 그리면 §2 의
문장과 화면이 서로 다른 것을 말하게 된다.

`historyBlind` 가 있으면 그 엣지에 작은 표시를 하나 더 붙인다.
**"중간 등급이 없다"가 "히스토리가 안전을 말했다"로 읽히면 안 된다.**

---

## 4. `staleClaims` — 반환 모양 (실측)

```jsonc
{
  "active": [
    {
      "agent": "agent-pr", "task": "pr-view", "intent": "…", "actor": null,
      "paths": ["app/server.mjs", "…"],
      "since": "2026-08-19T09:57:26.909Z",
      "remainingMs": 1225596, "remaining": "20분",
      "heldMs": 574404, "heldSinceRenew": "10분",
      "ttlMs": 1800000,
      "flags": [],                 // expiring | spent | longTtl
      "note": null                 // 사람이 읽을 한 줄 (flags 가 있을 때만)
    }
  ],
  "expiring": [ /* active 중 flags 에 expiring 이 든 것 */ ],
  "longHeld": [ /* spent 또는 longTtl */ ],
  "expired":  [{ "agent": "…", "paths": ["…"], "expiredAgo": "5분", "inEffect": false }],
  "unreadable": [{ "agent": "…" }],
  "stats": { "active": 2, "expiring": 0, "longHeld": 0, "expired": 0, "unreadable": 0 },
  "gaps": ["renew 는 since 를 지금으로 되돌린다 — …"]
}
```

문턱값과 근거:

- `expiring` — 남은 시간 ≤ **5분**. 기본 TTL(30분)의 1/6. `renew` 한 번이 30분을
  다시 붙이므로 5분이면 보고 결정하기에 충분하고, 더 길게 잡으면 30분짜리 claim 의
  태반이 상시 켜져 있어 표시가 뜻을 잃는다.
- `spent` — TTL 의 **80%** 를 썼다. 절대값(5분)은 `--ttl 4h` 같은 긴 claim 에 늦게 켜진다.
- `longTtl` — TTL 이 **60분 이상**. 기본의 두 배. "오래 잡을 작정" 이라는 표시다.

### 🔴 화면이 반드시 지킬 것

`expired` 를 `active` 와 **같은 목록에 섞지 않는다.** 만료는 레코드가 사라지는 것이
아니라 효력만 잃는 것이므로(CLAUDE.md), 남겨서 보여주되 `inEffect: false` 를
시각적으로 못박아야 한다 — 흐리게, 취소선, "효력 없음" 배지 중 하나.
만료된 claim 을 유효한 것처럼 그리면 사람이 빈 자리를 비어 있지 않다고 읽는다.

### 알려진 계측 한계

`applyRenew` 가 `since` 를 지금으로 되돌린다. 그래서 **장부만으로는 "처음 잡은 시각"을
알 수 없다.** `heldSinceRenew` 는 마지막 갱신 이후다 — 두 시간을 붙잡고 10분마다
갱신한 사람은 늘 "10분"으로 보인다. 추정으로 메우지 않고 `gaps` 로 말한다.
고치려면 장부 레코드에 `firstClaimedAt` 같은 필드가 필요한데, 그것은 SPEC 변경이다.

---

## 5. 🔴 `container` — "기능처럼 보이지만 기능이 아닌 것"

`featuregraph.mjs` 의 `modulesOf` 는 **뿌리 밑이 아닌 코드를 뿌리 이름의 통에 넣는다.**
이 저장소 자신에게 돌렸을 때 이렇게 나왔다 —

```
app  ←  app/server.mjs · src/protocol.mjs · bin/axmap.mjs · mcp/server.mjs · corpus/*.mjs
```

그 결과 `app/server.mjs` 를 잡은 사람과 `corpus/serve.mjs` 를 잡은 사람이
**"같은 기능"으로 붙었다.** 둘은 아무 상관이 없다.

`teamview.mjs` 는 노드 자신의 내용으로 이것을 알아본다 —
**자기 디렉터리 밖의 파일을 담고 있으면 그것은 기능 경계가 아니다.**

- `whoIsWhere` — `container: true` 로 표시하고, 문장이 "기능이 아니라 …모인 자리다"
  라고 직접 말한다. `stats.contested` 에서도 뺀다.
- `collisionRisk` — 그 노드에서는 `high` 를 만들지 않는다.

화면은 `container: true` 인 노드를 **기능 이름으로 부르지 않는다.** 회색 상자나
"분류되지 않음" 같은 이름을 준다. 여기에 이름을 붙이면 비전공자가 없는 기능 하나를
믿게 되고, 그 사람은 코드로 확인할 수단이 없다.

---

## 6. `summary` — 화면 맨 위 한 문단

```jsonc
{
  "text": "지금 2명이 일하고 있고, 기능 2개가 점유되어 있다. 1개는 일부만 잡혀 있어 …",
  "gaps": [{ "from": "collisionRisk", "text": "…" }],
  "counts": {
    "agents": 2, "features": 2, "contested": 0,
    "risk": { "certain": 0, "high": 1, "medium": 0, "low": 0 },
    "expiring": 0, "expired": 0
  },
  "blocking": false
}
```

🔴 **`gaps` 를 버리지 않는다.** 한 문단으로 접는 과정에서 "못 알아낸 것"이 사라지면,
남는 문장은 실제보다 확신에 찬 문장이 된다. 화면은 문단 아래에 흐리게 깔되
접어두지는 않는다 (`flow.mjs` 가 걸음마다 `gaps` 를 내는 것과 같은 규칙).

---

## 7. 실측 — 이 저장소 자신

작성 시점에 세 에이전트가 동시에 붙어 있었다. 그 장부를 그대로 넣은 결과다.

```
파일 37개 · 커밋 31개 · 모듈 4개 · 공변경 엣지 9개 · claim 3건

[높음] agent-pr ↔ agent-team
  같은 기능 "lib"(app/lib) 안에서 서로 다른 파일을 잡았다.
  경로는 안 겹치므로 프로토콜은 통과시킨다.
  (app/lib/prdiff.mjs, app/lib/teamview.mjs 은 아직 그래프에 없는 새 파일이라
   디렉터리로 맞췄다)
```

`agent-pr` 은 `app/lib/live.mjs`, 나는 `app/lib/teamview.mjs`. **경로는 안 겹쳐서
프로토콜은 둘 다 통과시켰고, 실제로 둘 다 `app/lib` 안에서 일하고 있었다.**
이것이 3단계가 잡아야 한다고 한 바로 그 상황이다.

이 실측이 코드를 두 번 고쳤다 (둘 다 `npm test` 가 초록인 상태에서 살아 있던 오류다):

1. **새 파일이 어떤 모듈에도 안 들어가서 `높음` 이 `낮음` 으로 떨어졌다.**
   `teamview.mjs` 도 `prdiff.mjs` 도 아직 커밋된 적이 없어 `git ls-files` 에도
   히스토리에도 없다. 가장 활발한 작업이 정확히 그 이유로 가장 약하게 보였다.
   → 모듈 디렉터리로 한 번 더 맞추고 `inferredFrom` 으로 표시한다.
2. **`app` 이라는 '나머지' 통 때문에 상관없는 둘이 붙었다.** (§5)
