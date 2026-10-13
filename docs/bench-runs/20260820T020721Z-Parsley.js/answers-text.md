# Parsley.js — 신입 개발자 조사 기록 (텍스트 API 전용)

조사 방법: `http://127.0.0.1:7860` 의 API 응답(JSON)만 사용했다. 화면 스크린샷, 대상 저장소 소스, blastmap 자체 코드, 웹 검색은 보지 않았다.
호출한 엔드포인트: `/api/flow`, `/api/entry`, `/api/watch`, `/api/featuregraph`, `/api/overlay`, `/api/graph`.

---

## M1. 이 저장소는 무엇을 하는 물건인가

**답**: `parsleyjs` — jQuery 기반 프론트엔드 **폼(form) 검증 라이브러리**다.
JS 코드를 직접 작성하지 않고 HTML data-속성만으로 폼 필드를 검증하게 해주는 물건.

**근거**: `/api/flow` 1단계(`what`) 응답.
- `answer.name = "parsleyjs"`, `answer.summary = "JavaScript form validation, without actually writing a single line of JavaScript!"`, `source = "README.md"`
- `manifests[0]`: `package.json` → `name: "parsleyjs"`, `description: "Validate your forms, frontend, without writing a single line of javascript!"`
- `shape`: `bower_components`(100파일/37,917줄, 전부 js), `src`(99파일/4,715줄), `test`(23파일/2,780줄), `doc`(3파일/4,902줄), 최상위(2파일/175줄), `tools`(2파일/50줄) — 전부 js.

- 도구 호출 수: 1

---

## M2. 실행은 어디서 시작하나 — 파일 하나

**답**: `src/parsley/main.js` (127줄)

**근거**: `/api/flow` 2단계(`enter`) 응답. `groups[rank=3]`("이름이 그렇게 생겼다" — 관례적 파일명) 목록의 첫 항목으로 `src/parsley/main.js`, `out: 9`(내보내는 import), `in: 7`(들어오는 import)이 잡혔다. `/api/entry`의 `hub` 목록에서도 `main.js`는 `deg: 16`으로 `src/parsley.js`(86) 다음으로 가장 많이 연결된 파일이다.

**주의**: API 스스로 이 단계의 `gaps`에 "가장 센 근거가 '이름이 그렇게 생겼다' 뿐이다 — 열어서 확인해야 한다"고 적어 놓았다. 즉 정적 신호(이름·차수)뿐이고 실제로 파일을 열어 `module.exports`나 진입 시퀀스를 확인한 것은 아니다 — 규칙상 소스를 열 수 없으므로 이 불확실성을 그대로 남긴다.

- 도구 호출 수: 1

---

## M3. 이 저장소의 큰 덩어리 셋

**답**:
1. **`bower_components`** (100파일, 37,917줄) — 외부 벤더 라이브러리 번들(jquery, bootstrap, mocha, sinon, expect.js, uwidget). `/api/entry`의 `isolated`(아무와도 안 이어진 곳) 목록 최상위 12개가 전부 이 폴더 소속(`deg:0, freq:0`) — import 그래프상 완전히 고립된 덩어리.
2. **`src`** (99파일, 4,715줄) — parsleyjs 본체. `/api/graph`의 `groups`로 더 잘게 보면 `i18n`(75파일, 번역 메시지), `parsley`(14파일, 핵심 엔진: main/field/form/validator_registry/ui 등), `extra`(7파일, 추가 검증자: comparison/dateiso 등), `src` 루트(2파일)로 나뉜다.
3. **`test`** (23파일, 2,780줄) — 단위 테스트(`test/unit/*`).

**근거**: `/api/flow` 1단계 `shape` + `/api/graph`의 `groups` 필드(`[{name:"bower_components",count:100},{name:"i18n",count:75},{name:"test",count:23},{name:"parsley",count:14},{name:"extra",count:7},{name:"doc",count:3},{name:"(root)",count:2},{name:"src",count:2},{name:"tools",count:2},{name:"vendor",count:1}]`).

- 도구 호출 수: 3 (`/api/flow` 1회, `/api/graph` fetch+파싱 2회)

---

## M4. "폼 검증" 관련 기능을 고치려면 어느 파일을 열어야 하나

**답**: `src/parsley/validator_registry.js`, `src/parsley/validator.js`, `src/parsley/field.js`, `src/parsley/form.js` 넷을 우선 열어야 한다. 세부 규칙(정규식 등)은 `validator_registry.js`, 필드 단위 검증 실행은 `field.js`, 폼 전체 오케스트레이션은 `form.js`, 개별 validator 정의는 `validator.js`.

**근거**:
- `/api/featuregraph`의 `clusters`(실제 반복 커밋 근거 기반 기능 묶음) 중:
  - `src-parsley-validator-registry-js` — 대표 커밋 메시지 `"email regex"` → 파일 `["src/parsley/validator_registry.js","test/unit/validator_registry.js"]`. "email regex"는 실제 검증 규칙을 고친 커밋이라 이 클러스터가 폼 검증 로직 자체임이 명확하다.
  - `src-parsley-form-js` — 대표 커밋 `"+ refresh."` → 파일 `["src/parsley/form.js","test/unit/form.js"]`.
- `/api/flow` 3단계(`layers`)의 호출 체인: `main.js → field.js → constraint.js`, `main.js → validator_registry.js → validator.js` 로 이어진다(각각 depth 1~2).
- `/api/watch` / `/api/flow` 6단계(`yours`): 지금 이 순간 `jihun`이 `src/parsley/field.js`, `src/parsley/form.js`를 "필드 검증 순서 - 비동기 검증이 순서를 어기던 것"(PARSLEY-214) 작업으로 잡고 있다 — 실시간으로 "폼 검증" 버그가 이 파일들에서 고쳐지고 있다는 직접 증거.

- 도구 호출 수: 4 (`/api/featuregraph` fetch 시도 1회 실패 + 재시도 성공 1회 + 구조 파악 2회)

---

## M5. 건드리면 파급이 큰 파일 하나와 근거

**답**: `src/parsley.js` (11줄짜리 작은 파일이지만 파급력은 최대)

**근거**: `/api/entry`의 `hub`(가장 많이 연결된 곳) 목록에서 `src/parsley.js`의 `deg: 86`으로 압도적 1위(2위는 `main.js`의 16). `/api/flow` 3단계의 `toCenter.inbound`에도 `src/i18n/ar.js, bg.js, ca.js, cs.extra.js, cs.js, da.js, de.extra.js, de.js` 등 75개 i18n 파일 전부가 이 파일을 import하는 것으로 나온다(`calledBy: 81`). 즉 번역 파일 전체 + 코어 상당수가 이 한 파일에 의존한다.

**주의**: `/api/flow` 4단계(`risk`, git 공변경 기반 "위험한 곳")는 `{"hot":null,"risk":null}`로 **비어 있었다**. `/api/overlay`에서 `stats.noGit: true`, `quadrant: {"both":0,"cochange":0,"stable":0,"unknown":160}`로 확인했다 — 이건 "위험한 파일이 없다"(=0)가 아니라 **이번 실행에서 git 공변경 데이터 자체를 못 읽었다**는 뜻이다(모든 160개 엣지가 "unknown"으로 분류됨). 그래서 M5 답은 git 히스토리 기반 위험도가 아니라 순수 정적 import 차수(86)에만 근거했다 — "실제로 자주 같이 깨지는 곳"까지는 이번 자료로 알 수 없다.

- 도구 호출 수: 3 (`/api/entry` 1회 + `/api/overlay` fetch+파싱 2회)

---

## M6. 지금 다른 사람이 잡고 있는 곳이 있나 — 누가 무엇을

**답**: 있다. 두 명이 활성 상태.
- **jihun** — task `PARSLEY-214` — "필드 검증 순서 - 비동기 검증이 순서를 어기던 것" — `src/parsley/field.js`, `src/parsley/form.js` — since 02:18:43Z, expires 02:48:43Z
- **minseo** — task `PARSLEY-231` — "에러 메시지 위치를 폼 기준으로 바꾼다" — `src/parsley/ui.js` — since 02:18:43Z, expires 02:48:43Z

추가로 `/api/watch`의 `modified` 필드에 `.gitignore`가 `state: "undeclared"`(code `M`, 아무도 claim하지 않은 채 수정됨)로 잡혀 있다.

**근거**: `/api/watch` 응답(`claims`, `overlay`, `modified`), `/api/flow` 6단계(`yours.active`)와 완전히 동일한 두 건.

- 도구 호출 수: 2

---

## M7. 내가 지금 어떤 파일을 고치면 누구와 부딪히나

**답**:
- `src/parsley/field.js` 또는 `src/parsley/form.js`를 고치면 → **jihun**(PARSLEY-214)과 충돌.
- `src/parsley/ui.js`를 고치면 → **minseo**(PARSLEY-231)과 충돌.
- 그 외 파일(예: `src/parsley/validator_registry.js`, `src/parsley.js` 등)은 지금 시점엔 비어 있다 — 단, M4에서 본 것처럼 "폼 검증"을 고치러 갈 때 가장 먼저 손이 가는 `field.js`/`form.js`가 하필 지금 jihun이 잡고 있는 파일과 정확히 겹친다는 점이 중요하다.

**근거**: `/api/watch`의 `overlay` 필드가 경로별로 상태를 직접 알려준다(`src/parsley/field.js` → `state:"declared", agent:"jihun"`, `src/parsley/form.js` → 동일, `src/parsley/ui.js` → `state:"declared", agent:"minseo"`). `adjacency: {"pairs":[],"checked":2}`로 봤을 때 jihun과 minseo의 claim 두 개는 서로 겹치지 않는다 — 겹침은 오직 "내가 그 경로를 새로 만지려 할 때"만 발생.

- 도구 호출 수: 2

---

## 마무리

### 1. 도구 호출 합계 / "못 함" 목록

- **도구 호출(Bash) 합계: 11회** (curl + node 파싱 조합, 그중 1회는 임시 경로 실수로 실패해 재시도함)
- **완전히 "못 함" 질문: 없음.** 7문항 모두 API로 답을 냈다.
- **부분적으로 "못 함"**: M5의 git 히스토리 기반 "위험도"(hot/risk) — `/api/flow` 4단계가 `null`, `/api/overlay`가 `noGit:true`로 명시. 이 채널은 데이터가 없어서 정적 import 차수로 대체했다. `/api/flow` 5단계(`add`, "새로 만들 때 어디를 같이 고치나")도 `answered:false`("새 파일을 추가한 커밋이 2건뿐 — 하한 5")로 공식적으로 미답변 처리되어 있었다 — 질문 목록엔 없었지만 참고로 남긴다.

### 2. 그림이 있었다면 더 빨랐을 질문

- **M5 (파급력 큰 파일)와 M3(덩어리 셋)**. `src/parsley.js`가 86개 파일에서 참조되고 `bower_components`가 통째로 고립돼 있다는 사실은, JSON 배열을 훑어서 `deg` 최댓값을 눈으로 찾고 `groups` 리스트와 `isolated` 리스트를 대조하는 대신, import 그래프를 노드 크기=차수·색=그룹으로 그린 그림 한 장이면 즉시 보였을 정보다. 텍스트로는 "가장 많이 연결된 곳" 표를 정독하고 숫자를 비교해야 했다.
- **M7 (누구와 부딪히나)**. 지금은 claim이 2건뿐이라 텍스트로도 충분했지만, claim이 여러 개로 늘어나면 파일 트리 위에 점유 영역을 색칠한 그림이 경로 문자열을 눈으로 대조하는 것보다 훨씬 빠를 것이다.
- 반면 M1, M2, M4, M6은 답이 이름·문장·목록 형태라 그림 없이 텍스트로 충분했다.

### 3. 읽기 힘들었던 응답

- `/api/featuregraph`의 `nodes` — `bower_components` 노드 하나의 `paths` 필드에 100개 파일 경로가 통째로 인라인돼 있어서 JSON을 직접 눈으로 훑기 어려웠다(스크립트로 파싱해야 했음). 또 `nodes`(3개, 디렉터리 단위)와 `clusters`(9개, 실제 "기능" 단위) 두 개념이 이름은 비슷한데 성격이 완전히 달라서 처음엔 `nodes`가 "기능"인 줄 알고 헷갈렸다.
- `/api/overlay`의 `stats.noGit: true` + `quadrant`가 전부 `"unknown"` — 다른 엔드포인트(`/api/featuregraph`의 `commits`/`works`, `/api/watch`의 `claims`)는 git 데이터를 잘 보여주는데 이 엔드포인트만 "git 없음"이라 처음엔 모순처럼 보였다. `0`(없음)과 `unknown`(못 읽음)을 구분하는 필드가 명시적으로 있어서 다행히 오판은 피했다.
- `/api/flow` 4단계의 `{"hot":null,"risk":null}` — `gaps` 배열을 같이 읽지 않으면 "위험한 파일이 없다"는 뜻으로 오해하기 쉬운 형태였다.

### 4. 알고 싶었는데 API에 없었던 것

- 실제 코드 내용(예: `main.js`가 정말 무엇을 export/실행하는지) — 규칙상 소스를 못 열므로 "이름이 그렇게 생겼다"는 추론 이상은 확인 불가.
- git 커밋 기반 "진짜 자주 바뀌고 위험한 파일" 순위 — 이번 실행에서는 `noGit:true`로 완전히 비어 있었다.
- 새 기능/파일을 추가할 때 함께 고쳐야 할 "등록 지점" 목록(`/api/flow` 5단계) — 근거 커밋이 2건뿐이라 답변 자체가 보류(`answered:false`) 상태였다.
- 함수/심볼 단위 콜그래프 — 제공되는 그래프는 전부 파일 단위 import 관계뿐이고, 파일 내부에서 어떤 함수가 어떤 함수를 부르는지는 알 수 없었다.
