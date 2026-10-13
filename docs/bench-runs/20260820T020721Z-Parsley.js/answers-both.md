# Parsley.js 저장소 파악 — 화면 + API 병행 조사

조사 방식: `shots/` 의 스크린샷 7장(01~07)을 전부 먼저 본 다음, `http://127.0.0.1:7860` 의 API
6종(`/api/flow` `/api/entry` `/api/featuregraph` `/api/watch` `/api/overlay` `/api/graph`)을 순서대로
호출했다. 그래서 아래 모든 질문에서 "먼저 본 것"은 화면이고, API 는 화면이 부족하거나 검증이
필요할 때만 추가로 봤다. 대상 저장소 소스와 blastmap 자신의 코드는 보지 않았다.

---

## M1. 이 저장소는 무엇을 하는 물건인가

**답**: `parsleyjs` — "JavaScript form validation, without actually writing a single line of JavaScript!"
(README 문구 그대로). 구성은 `bower_components`(100파일, 자바스크립트 벤더 라이브러리 묶음),
`src`(99파일, 실제 라이브러리 코드), `test`(23파일), `doc`(3), 최상위(2), `tools`(2).

**근거**: 01-first.png 카드① "이 저장소는 무엇을 하는 물건인가" — README.md 출처, package.json
manifest(`name: parsleyjs`), 디렉터리별 파일수/줄수 막대그래프.
API(`/api/flow` step 1)로 동일 값 확인: `name:"parsleyjs"`, `summary`, `source:"README.md"`,
`shape` 배열(bower_components 100/37917줄, src 99/4715줄, test 23/2780줄, doc 3/4902줄,
최상위 2/175줄, tools 2/50줄) — 화면 숫자와 정확히 일치.

**먼저 본 것**: 화면 · **그걸로 됐나**: 예 (API 는 검증용으로만 봄)
**도구 호출 수**: 2 (스크린샷 1 + `/api/flow` 1)

---

## M2. 실행은 어디서 시작하나 — 파일 하나

**답**: `src/parsley/main.js` (127줄).

**근거**: 03-flow2.png 카드② "실행은 어디서 시작하나". 가장 높은 등급(rank 3, "이름이 그렇게 생겼다"
그룹) 3개 후보 중 `src/parsley/main.js`(import 나가는 것 9, 들어오는 것 7)가 `src/` 안에 있는
실제 라이브러리 코드다. 나머지 두 후보는 `bower_components/expect.js/index.js`(벤더 테스트 도구)와
`test/unit/index.js`(테스트 진입점)라서 제외했다.
카드 자체가 "가장 센 근거가 '이름이 그렇게 생겼다' 뿐이다 — 열어서 확인해야 한다"고 경고한다.
소스를 열어볼 수 없어 이름·구조 근거만으로 판단했다는 한계가 있다.
API(`/api/flow` step 2)에 동일한 groups/rows 데이터 있음 — 화면과 일치.

**먼저 본 것**: 화면 · **그걸로 됐나**: 예 (다만 도구 스스로 "확신 낮음"이라고 표시함)
**도구 호출 수**: 2 (스크린샷 1 + `/api/flow` step2, 앞서 받은 flow.json 재사용)

---

## M3. 이 저장소의 큰 덩어리 셋

**답**: `bower_components` · `src` · `(최상위)` — 세 "기능(묶음)".

**근거**: 06-feature.png 상단에 "기능 3 · 이어짐 1 · 덮은 파일 201/229"이라고 명시되어 있고,
좌측에 정확히 이 세 묶음 카드가 파일수(100/99/2)와 "여기서 한 일"(각 묶음의 대표 커밋 메시지)과
함께 나열됨. `/api/featuregraph` 로 확인하니 `nodes` 배열도 정확히 이 3개 모듈뿐이었다
(`bower_components` commits:2, `src` commits:98, `(최상위)` commits:7).
※ 파일 개수 기준 "큰 덩어리"로 다시 읽으면 `bower_components`(100) `src`(99) `test`(23) 순이 되어
`test` 가 들어가고 `(최상위)`(2)가 빠진다 — 01-first.png의 "무엇으로 이뤄져 있나" 막대그래프 기준.
두 해석이 있어서 둘 다 적었다.

**먼저 본 것**: 화면 · **그걸로 됐나**: 예
**도구 호출 수**: 3 (스크린샷 06 1 + 01-first 재확인 1 + `/api/featuregraph` 1)

---

## M4. "폼 검증" 관련 기능을 고치려면 어느 파일을 열어야 하나

**답**: 확정할 수 없음 — 다만 근거를 종합하면 `src/parsley/field.js`(필드별 검증, main.js가
1겹에서 직접 부름, 404줄) 또는 `src/parsley/validator_registry.js`(개별 검증 규칙 등록 — 예:
"email regex" 커밋 클러스터, 376줄)가 유력하다.

**근거**: 이 저장소는 애초에 전체가 "폼 검증" 라이브러리라(M1), `기능` 화면(06-feature.png)에는
`bower_components`/`src`/`(최상위)` 세 덩어리만 있고 "폼 검증"이라는 하위 기능은 따로 이름 붙여
갈라져 있지 않다. `/api/featuregraph` 로도 module 노드가 3개뿐임을 재확인 — 화면에 없는 세부
기능 이름이 API 에도 없다. 대신 `/api/graph` 노드 상세에서 `src/parsley/field.js`(in4/out3),
`src/parsley/validator_registry.js`(in2/out3), `src/parsley/validator.js`(in4/out1),
`src/parsley/constraint.js`(in1/out2)를 확인했고, `/api/featuregraph` 의 co-change 클러스터에
`{"id":"src-parsley-validator-registry-js","name":"email regex", paths:[validator_registry.js,
test/unit/validator_registry.js]}` 가 있어 검증 규칙 로직이 이 파일에 몰려 있다는 정황을 잡았다.
확신 있는 단일 정답은 못 냈다.

**먼저 본 것**: 화면 · **그걸로 됐나**: 아니오 (화면에 "폼 검증"이라는 하위 기능이 없어서 API 로
그래프 노드를 추가로 봤지만, API 에도 그 수준의 세분화는 없었다)
**도구 호출 수**: 4 (스크린샷 06 재사용 + `/api/featuregraph` 재사용 + `/api/graph` 노드 조회 2회)

---

## M5. 건드리면 파급이 큰 파일 하나와 근거

**답**: `src/parsley.js` (11줄짜리 작은 파일이지만 다른 파일 86개와 import 로 이어짐: 들어오는 연결
81개, 나가는 연결 5개).

**근거**: 03-flow2.png 카드③ "이 저장소에서 이 저장소의 중심까지" 문단에 "parsley.js 를 부르는
파일이 81개로 가장 많습니다(테스트·예제 제외)"라고 직접 명시. `/api/entry` 의 "가장 많이 연결된 곳"
목록 1위가 `src/parsley.js`(`deg:86`)로 정확히 일치했고, `/api/graph` 노드 상세에서도
`"deg":{"in":81,"out":5}`로 확인. 세 군데(화면 서술, entry 목록, graph 노드) 숫자가 전부 맞아떨어짐.
줄 수는 작지만(11줄) 연결 수가 압도적으로 커서 "작아 보이는데 건드리면 위험한" 대표적인 파일이다.

**먼저 본 것**: 화면 · **그걸로 됐나**: 예 (API 는 숫자 교차검증용)
**도구 호출 수**: 2 (스크린샷 03 재사용 + `/api/entry` 1)

---

## M6. 지금 다른 사람이 잡고 있는 곳 — 누가 무엇을

**답**: 지금 2건이 잡혀 있다.
- **jihun** (`PARSLEY-214`, 29분 남음) — "필드 검증 순서 - 비동기 검증이 순서를 어기던 것" —
  `src/parsley/field.js`, `src/parsley/form.js`
- **minseo** (`PARSLEY-231`, 29분 남음) — "에러 메시지 위치를 폼 기준으로 바꾼다" —
  `src/parsley/ui.js`

**근거**: 07-watch.png 상단 "지금 2건이 잡혀 있습니다" 아래 두 사람의 이름·작업ID·의도·파일이
그대로 나열됨. `/api/watch` 의 `claims` 배열이 동일한 두 건(경로, `since`/`expiresAt` 타임스탬프
포함)으로 정확히 일치했다.

**먼저 본 것**: 화면 · **그걸로 됐나**: 예
**도구 호출 수**: 2 (스크린샷 07 1 + `/api/watch` 1)

---

## M7. 내가 지금 어떤 파일을 고치면 누구와 부딪히나

**답**:
- `src/parsley/field.js` 또는 `src/parsley/form.js` 를 고치면 → **jihun**(PARSLEY-214)과 부딪힌다.
- `src/parsley/ui.js` 를 고치면 → **minseo**(PARSLEY-231)와 부딪힌다.
- 그 외에 `.gitignore` 는 **아무도 claim 하지 않았는데 이미 수정된 상태**다(선언 밖 수정) — 지금
  이 파일을 잡으면 이미 누군가 손댄 코드를 나도 모르게 같이 고치게 될 수 있다.
- 인접 파일 경고(같이 자주 바뀌는 이웃)는 현재 0건(`adjacency.pairs: []`) — 위 claim 경로들과
  직접 겹치지 않는 다른 파일이라도 "간접 충돌 후보"로 뜨는 것은 지금 없다.

**근거**: 07-watch.png 상단 "선언 밖 수정 1"이라는 **개수**는 보였지만 **어떤 파일인지는 화면에
나오지 않았다**(스크롤/뷰포트 밖). `/api/watch` 의 `modified:[{"path":".gitignore","code":"M"}]`
와 `overlay["gitignore"].state:"undeclared"` 를 보고서야 그 파일이 `.gitignore` 라는 걸 알았다.
claim 충돌 대상(jihun/minseo)은 M6 과 같은 화면·API 로 확인.

**먼저 본 것**: 화면 · **그걸로 됐나**: 아니오 (화면은 "선언 밖 수정 1건"이라는 개수만 보여주고
파일명은 안 보여줘서 API 로 확인했다)
**도구 호출 수**: 2 (스크린샷 07 재사용 + `/api/watch` 재사용, 이번엔 `modified`/`overlay` 필드까지 읽음)

---

## 마지막 정리

### 1. 도구 호출 합계 · "못 함" 목록

- **총 도구 호출 수(조사 전체)**: 약 26회
  - 스크린샷 읽기 7회 (01~07, `g1~g3` 는 지시대로 열지 않음)
  - API 호출 6회 (`/api/flow` `/api/entry` `/api/featuregraph` `/api/watch` `/api/overlay` `/api/graph`)
  - 위 JSON을 들여다보기 위한 후속 검색(grep)·재확인 호출 약 13회
    (그중 `/api/overlay` 전체 읽기 1회는 파일이 너무 커서 실패, 대신 grep 으로 나눠 읽음)
- **"못 함" 질문**: 완전한 "못 함"은 없음. 다만 **M4 는 확정 답을 못 냈다** — 화면에도 API 에도
  "폼 검증"이라는 이름의 하위 기능이 없어서, import 그래프 근거로 추정한 두 개 후보 파일
  (`field.js`, `validator_registry.js`)을 제시하는 데 그쳤다.

### 2. 화면을 먼저 본 질문 수 / 화면만으로 끝난 수

- 7문제 전부 화면을 먼저 봤다(조사 순서를 화면→API 로 고정했기 때문).
- 그중 **화면만으로 끝난 것**: M1, M2, M3, M5, M6 — 5개.
- **화면만으론 부족해서 API 를 더 본 것**: M4(화면에 세부 기능 이름 자체가 없음), M7(화면엔
  "선언 밖 수정 1"이라는 개수만 있고 파일명이 없음) — 2개.

### 3. 화면이 없었다면 못 했을 질문이 있나

없다 — 정직하게 말하면 **전부 API 만으로도 됐다**. 화면에 나온 숫자·문장은 모두 대응하는
API JSON 필드(`/api/flow` 의 steps, `/api/entry` 의 hub 목록, `/api/watch` 의 claims/modified,
`/api/featuregraph` 의 module/works, `/api/graph` 의 노드 deg)에 그대로, 오히려 더 세밀하게
들어 있었다(M7 의 `.gitignore` 파일명이 대표적 — API 가 화면보다 정보가 더 많았다). 화면은
"어디부터 읽어야 하는지"를 순서대로 짚어줘서 조사가 훨씬 빨랐을 뿐, 화면이 없었어도 API 응답을
끝까지 읽었다면 7문제 모두 답할 수 있었을 것이다.

### 4. 화면과 API 의 숫자가 서로 다른 곳

있다. 화면(01~05, 07의 하단 그래프 영역)은 어디서나 "히스토리 부족 · 커밋이 0개뿐이라 공변경으로
판정할 수 있는 쌍이 없습니다 — import 그래프만 켰습니다"라고 표시하고, "판정 보류 160"·
"숨은 결합 0"으로 나온다. 그런데 **같은 앱의 다른 화면인 06-feature.png(기능 목록)는 실제 커밋
메시지("After yarn update", "Avoid anti-pattern ×2", "Rename ParsleyUtils => Utils" 등)를
그대로 보여주고, 07-watch.png 는 "30초 전에 원격 장부를 확인했다"며 실시간 claim 타임스탬프를
보여준다** — 즉 이 부분은 커밋 이력이 분명히 있다.
API 로 원인을 확인했다: `/api/overlay`·`/api/graph` 의 `stats.noGit` 이 `true` 로 찍혀 있어
(import+공변경 그래프를 만들 때는 git 이력을 아예 안 썼다는 뜻), 반면 `/api/featuregraph` 는
`src` 모듈에 `commits:98`, `bower_components` 에 `commits:2`, `(최상위)` 에 `commits:7`을
실제 커밋 제목과 함께 갖고 있고, `/api/watch` 도 `gitAvailable:true`로 실제 수정 이력
(`.gitignore` M)을 보여준다. 정리하면 **"커밋 0개"는 전체 저장소 얘기가 아니라, import/공변경
그래프 한 기능만 git 을 안 쓰고 계산됐다는 뜻인데, 화면 문구는 그걸 "히스토리 부족"이라고만 써서
마치 저장소 전체에 커밋이 없는 것처럼 읽힌다.** 이게 화면·API 간 가장 헷갈리는 불일치였다.

### 5. 화면이 헷갈리게 한 순간 · 화면·API 둘 다에 없었던 것

- **헷갈린 순간**: 위 4번 그대로 — "커밋이 0개뿐"이라는 문구를 처음 봤을 때 이 저장소에 히스토리가
  거의 없는 새 저장소인 줄 알았다. 그런데 06-feature.png 를 보고 나서야 실제로는 커밋이 꽤
  있다(src 만 98개)는 걸 알았고, API 로 원인(그래프 계산에서만 git 을 안 씀)을 확인하고서야
  모순이 풀렸다.
- **둘 다에 없었던 것**: "폼 검증" 이라는 이름의 기능/모듈이 화면에도 API 에도 없었다(M4).
  이 저장소가 통째로 폼 검증 라이브러리라서 그 안에서 "검증 로직만" 따로 잘라 부르는 이름이
  존재하지 않았다 — README 기반 자동 명명이 `src` 전체를 한 덩어리로만 묶었기 때문으로 보인다.
  또한 02번 질문에서 진입점 근거가 "이름이 그렇게 생겼다"(파일명 관례) 하나뿐이라는 것도 화면과
  API 모두 스스로 인정한 한계였다 — 더 강한 근거(예: package.json 의 `main` 필드 자체)는
  두 군데 어디에도 명시적으로 나오지 않았다.
