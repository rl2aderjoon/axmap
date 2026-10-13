# 신입 온보딩 답안 — B · 텍스트만 (기준선)

- 조건: `http://127.0.0.1:7902/api/*` 응답만. 화면 없음. 소스·git·웹검색 없음.
- 대상: `github.com/openziti/ziti/v2` (파일 2019개, Go 1924개)
- 총 도구 호출: **28회** (1회 = 지시문 읽기, 2~27 = API 조사, 28 = 이 파일 저장)

호출 번호는 지시문 읽기를 1번으로 놓고 센 절대 번호다.

---

## M1. 이 저장소는 무엇을 하는 물건인가

- **답:** OpenZiti — 네트워크 서비스를 인가되지 않은 사용자에게 아예 보이지 않게 만드는
  오픈소스 제로트러스트 네트워킹 플랫폼이다. 모든 연결(사용자·서비스·디바이스·워크로드)을
  암호학적 신원으로 인증하고, 정책으로 인가하고, 종단간 암호화한다.
  구현체는 **controller(제어 평면) + router(데이터 평면) + ziti(CLI/에이전트)** 세 덩어리다.

- **무엇을 보고:**
  `/api/flow` step 1 (`key:"what"`) 의 `answer` 객체. 글자 그대로 들어 있었다 —
  `name: "github.com/openziti/ziti/v2"`, `summary: "OpenZiti is an open-source zero-trust
  networking platform..."`, `source: "README.md"`, `manifests: [{file:"go.mod", kind:"go"}]`.
  추론이 아니라 인용이다.
  같은 응답의 `shape` 배열이 세 덩어리를 숫자로 확인해줬다 —
  `controller` 925파일/211,271줄, `ziti` 300파일/50,284줄, `router` 182파일/41,670줄,
  `tests` 168, `zititest` 164, `common` 147, `tunnel` 45.
  `langs`: go 1924 · data 93 · js 2 → 사실상 순수 Go 저장소.

- **도달한 도구 호출 번호: 5** (호출 3에서 `controller/…`, `zititest/go.mod` 같은 경로를 보고
  "Go 저장소" 까지는 갔지만, 무엇을 하는 물건인지는 5번에서야 알았다)

---

## M2. 실행은 어디서 시작하나

- **답:** **`ziti/main.go`** (51줄).
  단, 이건 내가 고른 것이지 도구가 골라준 것이 아니다 — 아래 caveat 을 반드시 함께 읽어라.

- **무엇을 보고:**
  `/api/flow` step 2 (`key:"enter"`) 의 `answer.groups[0].rows`.
  각 행에 `evidence` 배열이 붙어 있다. `ziti/main.go` 의 근거는
  `["func main() (package main)", "관례적인 파일명"]`, `rank:2`, `out:8`, `in:1`.

  내가 `ziti/main.go` 를 고른 이유 (도구가 준 숫자만으로):
  1. 저장소 이름이 `.../ziti/v2` 인데 이 파일만 그 이름을 딴 최상위 디렉터리에 있다.
  2. 후보 8개 중 **`in > 0` 인 유일한 파일**이다 (나머지는 전부 `in:0`).
     `/api/entry` 의 `core` 배열(핵심 90개)에도 `ziti/main.go` 는 들어 있고
     다른 7개 후보는 하나도 없다.
  3. 호출 20에서 `/api/graph` 엣지로 확인: `ziti/main.go` → `ziti/cmd/cmd.go` →
     (out-degree 80) → 실제 제품 경로로 내려간다. 나머지 후보는 테스트 하네스
     (`zititest/…`) 이거나 곁다리 도구(`db-explorer`, `eventdoc`) 로 흩어진다.

- 🔴 **caveat — 도구는 하나를 짚어주지 않았다.**
  `answer.total: 383`, `shown: 8`. `func main()` 을 가진 파일이 383개인데 8개만 보여줬고,
  그 8개는 **전부 `rank: 2` 로 동점**이다. 순위로는 `ziti/db-explorer/cmd/ziti-db-explorer/main.go`
  가 첫 줄에 왔다 (근거가 4개로 가장 많았다: `Go 관례: cmd/<이름>/main.go` 가 추가로 붙어서).
  그리고 step 3 의 `chain` 은 실제로 그 db-explorer 를 `start` 로 골라서 따라갔다 —
  즉 **도구의 기본 선택은 곁다리 바이너리였다.** 위 1~3은 내가 다른 필드를 교차해서
  뒤집은 것이지, 도구가 말해준 것이 아니다.

- **도달한 도구 호출 번호: 5** (후보 목록) / **20** (`ziti/main.go` 로 확정)

---

## M3. 진입점에서 핵심 기능까지 어떻게 이어지나

- **답:** (import 엣지를 순서대로 따라간 경로)

```
ziti/main.go                          (51줄, func main)
  └→ ziti/cmd/cmd.go                  (952줄, out-degree 80 — CLI 서브커맨드 등록 허브)
      └→ ziti/run/run_controller.go   (out-degree 11 — `ziti run controller` 서브커맨드)
          ├→ controller/config/config.go        (+ config_edge / config_network / config_raft)
          └→ controller/server/controller.go    (335줄)
              ├→ controller/env/appenv.go       (1112줄 — 공유 앱 컨텍스트, 아래 M5)
              ├→ controller/env/{broker,sync,security_ctx,helpers,routers,producers,trace}.go
              ├→ controller/sync_strats/sync_instant.go   (2381줄 — 라우터 상태 동기화)
              └→ controller/internal/policy/*_enforcer.go (정책 집행기)
```

  갈라지는 두 번째 축 (제어 평면 본체):
  `controller/controller.go` (1016줄, out-degree 79) → `controller/raft/raft.go` (1229줄, HA 합의)
  → `controller/raft/mesh/mesh.go` (1231줄) / `controller/network/network.go` (1759줄).

  요약: **CLI 파싱 → 설정 로드 → 컨트롤러 부팅 → 공유 env(appenv) 조립 →
  raft 로 상태 합의 → network 로 라우터·서비스·토폴로지 관리.**

- **무엇을 보고:**
  - `/api/flow` step 3 (`key:"layers"`) 의 `layers` 배열 — 진입점 8개에서 BFS 로
    depth 0~5 를 매긴 것. depth1 85개 / depth2 118개 / depth3 145개 / depth4 100개 / depth5 18개.
    depth2 에 `controller/env/appenv.go`, depth3 에 `controller/raft/raft.go`,
    depth4 에 `controller/sync_strats/sync_instant.go` 가 있다 — 겹 번호가 곧 읽는 순서다.
  - 위의 구체적 화살표는 `/api/graph` 의 `edges` 배열
    (`{"source":…,"target":…,"kind":"import","origin":"static"}`, 총 9480개)에서
    `source` 로 직접 걸러 만들었다 (호출 20~22).

- 🔴 **caveat — 도구가 스스로 신고한 구멍.** step 3 의 `gaps` 에 이렇게 적혀 있다:
  > 예제·테스트를 뺀 코드 1631개 중 시작점에서 닿는 것이 474개 (29%) 뿐이다.
  > 계층을 전부 믿지 말 것 — 정적 파싱이 못 푼 연결(동적 로딩·리플렉션·설정 기반 등록)이
  > 있거나, 진입점이 더 있다.

  `coveragePct: 23`, `unreached: 1545`. 안 닿은 1545개의 분류도 줬다 —
  테스트 331 · 예제 23 · 문서 12 · 빌드 22 · **나머지 1157개는 분류 불가**.
  또 `toCenter` 는 `found: false` 였다 — 기본 시작점(db-explorer)에서 `appenv.go` 까지
  **12단계 안에 경로가 없다**고 명시했고, 대신 `appenv.go` 로 들어오는 137개
  (`calledBy: 137`) 를 주면서 "거기서 거꾸로 올라가라"고 했다. 이건 좋은 정직함이다.

- **도달한 도구 호출 번호: 6** (계층) / **20~22** (파일 단위 화살표 확정)

---

## M4. 새 기능을 하나 넣으려면 어디를 고쳐야 하나

- 🔴 **먼저: 도구는 이 질문에 "모른다"고 답했다.**
  `/api/flow` step 5 (`key:"add"`) 의 `answer.answered: **false**`.
  ```
  n: 150, considered: 2066, points: [],
  why: "150건을 봤지만 30% 이상 함께 바뀐 파일이 없습니다
        — 추가할 때 정해진 등록 지점이 없는 구조일 수 있습니다"
  scope: "controller"
  sentence: "controller 에 새로 만들 때 어디를 고치는지 아직 말할 수 없습니다…"
  ```
  즉 **"controller 에 뭔가 추가할 때 반드시 같이 고치는 단일 등록 파일" 은 없다**는 게
  도구의 답이다. 나는 이걸 뒤집지 않는다.

- **답 (우회해서 얻은 것):** 등록 지점이 *하나* 는 아니지만, **무엇을 추가하느냐에 따라
  정해진 파일 묶음이 있다.** `/api/featuregraph` 의 `clusters` 배열이 그걸 준다 —
  과거에 실제로 함께 바뀐 파일 집합에 그때의 커밋 메시지가 이름으로 붙어 있다
  (`evidence: "repeat"` = 반복 관측). 새 기능 종류별로:

  | 넣으려는 것 | 고칠 파일 묶음 | 그 묶음의 이름(과거 커밋) |
  |---|---|---|
  | **새 라우팅/터미네이터 전략** | `controller/xt/xt.go` + `controller/xt_common/cost_visitor.go` + `controller/xt_smartrouting/impl.go` + `controller/xt_sticky/impl.go` + `controller/xt_weighted/impl.go` | "Change terminator failure cost crediting to be exponential…" |
  | **새 엔티티(예: ext-jwt-signer)** | `controller/db/<X>_store.go` + `controller/internal/routes/<X>_api_model.go` + `controller/model/<X>_manager.go` + `controller/model/<X>_model.go` + `tests/<X>_test.go` | "fixes #2681 adds targetToken support for ext jwt signers" |
  | **새 CLI 하위명령** | `ziti/cmd/edge/create.go` + `create_<X>.go` + `list.go` + `update.go` + `update_<X>.go` | "fixes #945 adds ext jwt signer support" |
  | **새 등록(enrollment) 방식** | `controller/internal/routes/enroll_router.go` + `controller/model/enrollment_mod_{erott,ott,trott}.go` + `tests/enrollment_router_test.go` | "Fill in client cert chains when enrolling" |
  | **새 xlink 전송** | `router/xlink/xlink.go` + `router/xlink_transport/xlink.go` + `xlink_split.go` | "Allow fixing stuck links. Fixes #1741" |
  | **새 설정 항목** | `ziti/cmd/create/create_config*.go` 8개 묶음 | "add Linux packages and container bootstrapping…" |

  **가장 또렷한 패턴은 `xt` 묶음**이다. `controller/xt/xt.go` 라는 인터페이스 파일 하나에
  `xt_smartrouting` / `xt_sticky` / `xt_weighted` 세 구현이 매번 함께 바뀐다 —
  전형적인 전략(plugin) 등록 패턴이고, 네 번째 전략을 넣으려면
  **`controller/xt/xt.go` 를 고치고 `controller/xt_<새이름>/impl.go` 를 새로 만든다.**
  이건 "추측" 이 아니라 "같은 일을 한 과거 커밋의 관측" 이다.

- **무엇을 보고:** `/api/featuregraph` 의 `clusters` 배열.
  각 원소가 `{id, name, paths[], evidence:"repeat"}` 형태고, `name` 이 그 묶음을 만든
  실제 커밋 제목이다. 20개 클러스터를 읽었다.
  `nodes` 배열은 덩어리 이름도 README 에서 끌어왔다 —
  `controller` = `"Network state"` (`nameSource:"docs"`,
  docLine: "tracks routers, services, and topology; provides a REST API and web-based
  admin console for management"), `ziti` = `"Agent on service host"`,
  `setup-cli` = `"Setup"`. 나머지 9개(`router`, `common`, `tunnel`…)는
  `nameSource:"path"` — **README 가 이름을 안 붙여줘서 디렉터리명 그대로**다.

- **도달한 도구 호출 번호: 7** (도구의 "못 함" 확인) / **19** (클러스터로 우회)

---

## M5. 건드리면 파급이 큰 파일 하나와 그 근거

- **답:** **`controller/env/appenv.go`** (1112줄).

- **무엇을 보고:** 세 군데가 같은 곳을 가리켰다.

  1. `/api/entry` 의 `lists` 중 `key:"hub"` — 제목이 **"가장 많이 연결된 곳"**,
     질문이 그대로 **"고치면 파급이 큰 곳은 어디인가"** 다. 그 목록 **1위**가 appenv.go,
     `deg: 176` (import 로 이어진 이웃 수). 2위 `controller/env/helpers.go` 143,
     3~5위 `controller/env/{sync,broker,context}.go` 142 — **상위 9개가 전부
     `controller/env/` 한 디렉터리**다. 이 디렉터리 전체가 허브다.
  2. `/api/graph` 엣지 직접 집계 (호출 22): appenv.go 를 import 하는 파일 **137개**,
     그것도 한 구석이 아니라 12개 디렉터리에 퍼져 있다 —
     `controller/internal/routes` 75, `controller/handler_edge_ctrl` 26,
     **`router/state` 11 (제어 평면 밖!)**, `controller/webapis` 5,
     `controller/sync_strats` 5, `tests` 4, `controller/handler_mgmt` 4, 그 외.
     `router/` 까지 넘어간다는 게 핵심이다 — controller 안에서 끝나지 않는다.
  3. `/api/flow` step 4 의 `band` — appenv.go 는 `freq: 160` 이고
     `band: "top1"` (`label: "상위 1%"`), `vsMedian: 52.8`.
     Go 중형 저장소 360개 · 파일 39만개 코퍼스 기준 **중앙값의 52배로 자주 바뀐다.**
     → **많이 이어져 있는데 동시에 자주 바뀐다.** 둘 다인 파일이 사고가 나는 파일이다.

- **경쟁 후보와 왜 제쳤나:** `/api/entry` 의 `key:"risk"` 목록("숨은 결합이 많은 곳")
  1위는 `go.mod` (`hidden: 321`, `freq: 1891`, top1, 중앙값의 **624배**) 다.
  숫자만 보면 압도적이지만 `deg: 0` 인 매니페스트 파일이라 "고쳐서 로직이 깨지는" 종류가
  아니다. 같은 이유로 `CHANGELOG.md`(freq 678) 도 제쳤다. 도구는 이 둘을
  구분해주지 않았다 — **`go.mod`/`CHANGELOG.md` 가 churn·risk 목록 최상단을 차지해서
  진짜 코드 허브를 가린다.** 내가 손으로 걸러야 했다.
  코드 파일 중 최상위는 `controller/network/network.go` (freq 197, deg 57, hidden 140) 과
  `router/router.go` (freq 187, deg 93, hidden 130) 인데,
  둘 다 appenv.go 의 `deg 176` 에는 못 미친다.

- **도달한 도구 호출 번호: 3** (hub 목록 1위) / **22** (137개 importer 로 검증)

---

## M6. 지금 다른 사람이 잡고 있는 곳이 있나

- **답: 있다. 3명, 전부 유효(만료 전).**

  | 에이전트 | 작업ID | 의도 | 잡은 경로 | 시작 | 만료 |
  |---|---|---|---|---|---|
  | `agent-raft` | T-401 | raft 리더 선출 타임아웃 조정 | `controller/raft` (디렉터리) | 06:26:43Z | 12:26:43Z |
  | `agent-edge` | T-402 | edge 리스너 재연결 처리 | `router/xgress_edge` (디렉터리) | 06:26:44Z | 12:26:44Z |
  | `agent-cfg` | T-403 | 설정 스키마에 필드 추가 | `controller/config/config.go` (파일 1개) | 06:26:44Z | 12:26:44Z |

  셋 다 `actor: "team"`, `state: "declared"`. 나는 `me: "bench3"` 이고 잡은 것이 없다.
  작업트리 변경은 `.gitignore` (`code:"M"`) 하나뿐 — 아직 아무도 실제로 코드를 안 고쳤다.
  즉 **세 사람 모두 "선언만 하고 아직 안 건드린" 상태**다.

- **무엇을 보고:**
  `/api/flow` step 6 (`key:"yours"`) 의 `answer.active` 배열에서 처음 봤고,
  `/api/watch` 가 같은 3건을 `claims` 로 주면서 **`overlay` 맵으로 파일 단위까지 펼쳐줬다.**
  이게 결정적이다 — `agent-raft` 는 `controller/raft` 라는 디렉터리 하나만 선언했는데
  overlay 에는 `controller/raft/fsm.go`, `.../hclog_adapter.go`, `.../index_tracker.go`,
  `.../member.go`, `.../mesh/mesh.go`, `.../raft.go` … 가 전부
  `{"state":"declared","agent":"agent-raft","claimed":"controller/raft"}` 로 펼쳐져 있다.
  `claimed` 필드가 **"어느 선언 때문에 이 파일이 잠겼는지"** 를 되짚어준다.
  `/api/watch` 는 `ledgerAvailable: true`, `gitAvailable: true` 도 함께 준다 —
  장부를 실제로 읽었다는 뜻.

- **도달한 도구 호출 번호: 8** (3건 확인) / **9** (파일 단위 확장 확인)

---

## M7. 내가 지금 `controller/raft/raft.go` 를 고치면 누구와 부딪히나

- **답: 정면충돌 1명 + 간접충돌 2명.**

  **① 정면 — `agent-raft` (T-401, "raft 리더 선출 타임아웃 조정").**
  `controller/raft/raft.go` 는 이미 잠겨 있다. 내 것이 아니다.
  `/api/watch` 의 overlay 에 글자 그대로:
  ```json
  "controller/raft/raft.go": {"state":"declared","agent":"agent-raft",
    "actor":"team","intent":"raft 리더 선출 타임아웃 조정",
    "task":"T-401","claimed":"controller/raft"}
  ```
  `claimed:"controller/raft"` → **디렉터리 선언에 딸려 잠긴 것**이지 이 파일을
  콕 집어 잡은 게 아니다. 그래도 결과는 같다. 12:26:43Z 까지 유효.
  게다가 의도가 "리더 선출 타임아웃 조정" 이라 **raft.go 의 한복판**을 만질 작업이다.
  파일이 겹칠 뿐 아니라 **고칠 줄까지 겹칠 확률이 높다.**
  → 규칙대로면 종료코드 2. 재시도 말고 방향을 틀어야 한다.

  **② 간접 — `agent-cfg` (T-403, "설정 스키마에 필드 추가"). import 로 이어져 있다.**
  `/api/graph` 엣지 기준 `raft.go` 가 import 하는 35개 파일 안에
  **`controller/config/config.go` 가 들어 있다** — 그리고 그게 정확히 agent-cfg 가
  잡은 그 파일 하나다. `controller/config/config_raft.go` 도 함께 import 한다.
  agent-cfg 가 설정 스키마에 필드를 더하는 중이면 **내가 읽는 구조체가 발밑에서 바뀐다.**
  파일은 안 겹치는데 컴파일이 깨질 수 있는 조합이다.

  **③ 간접 — `agent-edge` (T-402, "edge 리스너 재연결 처리"). 숨은 결합으로 이어져 있다.**
  `/api/overlay` 의 cochange 엣지:
  ```json
  {"source":"controller/raft/raft.go","target":"router/xgress_edge/hosted.go",
   "origin":"cochange","support":5,"lift":8.1,"confA":0.063,"confB":0.135}
  ```
  import 은 없는데 **과거 5개 커밋에서 함께 바뀌었고 lift 8.1** 이다.
  `router/xgress_edge/` 는 agent-edge 가 통째로 잡았다.
  **코드를 읽어서는 안 보이는 연결**이라 이건 도구 없이는 못 찾는다.

- **부딪히진 않지만 내가 확인해야 할 것 (raft.go 의 파급 범위):**
  - **import 으로 raft.go 에 의존하는 11개** — `controller/controller.go`,
    `controller/handler_peer_ctrl/{add_peer,bind,command,remove_peer,transfer_leadership}.go`,
    `controller/internal/routes/cluster_router.go`, `controller/network/inspect.go`,
    `controller/settings.go`, `ziti/cmd/ops/cluster/recover{,_test}.go`.
  - **숨은 결합(cochange) 49개.** 상위: `controller/raft/fsm.go` (support 20, lift 34.4),
    `controller/agent.go` (12, 22.6), `controller/raft/member.go` (10, 22.3),
    `doc/ha/ctrl1.yml` (6, 22.6 — **설정 예제 yml 까지 같이 바뀐다**),
    `controller/model/controller_manager.go` (6, 17.2),
    `controller/event/cluster.go` (support 5, **lift 43 — 최고**),
    `router/handler_ctrl/update_ctrl_addresses.go` (4, 20.1),
    `common/pb/cmd_pb/cmd.proto` (3, 20.1 — **proto 를 같이 고쳐야 한다는 신호**).
    분포는 `router/handler_ctrl` 3 · `router/env` 3 · `controller/network` 3 ·
    `controller/model` 3 · `controller/db` 3 · `common/pb/mgmt_pb` 3 · `etc/` 2 …
    → **raft 를 고치면 router 쪽과 proto 정의까지 번진다.**
  - raft.go 자체 `freq: 80` (커밋 80회), 1229줄.

- **결론:** 지금 `controller/raft/raft.go` 는 **손대면 안 된다.** agent-raft 와 정면으로
  겹치고, 우회해서 `controller/config` 나 `router/xgress_edge` 로 가도 나머지 둘과 겹친다.
  비어 있는 영역(예: `controller/xt/` 나 `controller/network/`)으로 옮기는 게 맞다.

- **도달한 도구 호출 번호: 8** (agent-raft 충돌) / **11** (raft.go 파일 단위 확정) /
  **15** (config.go import → agent-cfg) / **27** (xgress_edge/hosted.go cochange → agent-edge)

---

# 마지막 보고

## 1. 총 도구 호출 수

**28회.**
- 1 = 지시문 읽기
- 2 = 엔드포인트 6개 존재·크기 확인
- 3~4 = `/api/entry`
- 5~8 = `/api/flow` (20KB 를 4조각으로 잘라 읽음)
- 9~11 = `/api/watch`
- 12~15 = `/api/graph`
- 16 = `/api/overlay` 구조
- 17~19 = `/api/featuregraph`
- 20~22 = `/api/graph` 엣지로 직접 BFS (M3)
- 23~27 = `/api/overlay` cochange 엣지 파기 (M7)
- 28 = 이 파일 저장

M1~M7 **전부 답했다.** 7개 답에 도달하는 데 실질적으로 필요했던 것은
**호출 3·5·8 세 번** 이었다 (M1·M2·M5·M6·M7 의 1차 답이 여기서 다 나왔다).
나머지 20여 번은 **검증과 우회**에 썼다.

## 2. 못 한 질문

**완전히 못 한 질문은 없다.** 다만 하나는 도구가 스스로 포기했다:

- **M4** — `/api/flow` step 5 가 `answered: false` 를 반환했다.
  `"150건을 봤지만 30% 이상 함께 바뀐 파일이 없습니다"`.
  `considered: 2066` 인데 `capped: 150` 으로 잘렸다 — **2066건 중 150건만 보고 포기했다.**
  임계값(30%)과 표본 상한(150) 둘 다 도구가 정한 값이고 내가 조절할 수 없었다.
  `/api/featuregraph` 의 `clusters` 로 우회해서 답을 만들었지만,
  **flow 만 따라갔으면 M4 는 "못 함" 으로 끝났을 것이다.**
  두 엔드포인트가 같은 co-change 데이터를 보면서 한쪽은 "없다", 한쪽은
  "20개 묶음이 있다" 고 말한다. 이건 도구 내부의 불일치다.

## 3. 🔴 막힌 지점 전부

**(A) `jq` 가 없다**
- (a) 3.8MB(`overlay`)·2.2MB(`graph`) JSON 을 구조적으로 자르려 했다.
- (b) `which jq` → 없음. `head -c` / `sed 's/},{/}\n{/g'` / `grep -o` 조합으로
  손수 파싱해야 했다. 줄바꿈 없는 단일 라인 JSON 이라 `head -c` 가 **UTF-8 한글을
  글자 중간에서 잘라** 깨진 문자(`�`)가 여러 번 나왔다 (호출 5·6 경계).
- (c) **돌아갔다.** 답에는 영향 없었지만 호출 3~4번을 더 썼다.

**(B) `/api/flow` 가 20KB 한 덩어리다 — 잘라 읽을 방법이 없다**
- (a) step 5·6 만 보고 싶었다.
- (b) 페이지네이션도, `?step=` 같은 파라미터도 없다. 매번 20KB 를 전부 받아
  `head -c N | tail -c M` 으로 창을 밀며 4번에 나눠 읽었다.
  창 경계가 step 경계와 안 맞아서 step 4 의 `risk` 목록을 두 번 읽었다.
- (c) **돌아갔다.** 호출 4번 소모.

**(C) step 3 의 `chain` 시작점을 내가 못 고른다**
- (a) `ziti/main.go` 에서 시작하는 호출 사슬을 보고 싶었다 (M3).
- (b) 도구가 8개 후보 중 **`ziti/db-explorer/cmd/ziti-db-explorer/main.go`** 를
  멋대로 `start` 로 골랐다. 그 결과 `chain.rows` 8줄이 전부
  `ziti/db-explorer/**` 안에서만 맴돌았다 — **곁다리 DB 탐색 도구의 내부 구조**다.
  제품 본체와 무관하다. `chain.reached: 8`, `why: null`.
  게다가 `toCenter` 는 그 시작점에서 `controller/env/appenv.go` 까지
  `found: false` (12단계 내 경로 없음) 라고 나왔다 — **도구가 고른 시작점이
  저장소의 중심에 닿지도 못한다.**
- (c) **우회했다.** `/api/graph` 의 `edges` 9480개를 받아
  `grep '"source":"ziti/main.go"'` 로 손수 BFS 했다 (호출 20~22).
  **이게 이번 판에서 가장 크게 돌아간 지점이다.** 호출 3번 소모.
  API 에 `?start=` 파라미터가 하나만 있었으면 0번이었다.

**(D) `/api/overlay` 의 co-change 엣지를 하마터면 통째로 놓칠 뻔했다**
- (a) 호출 16 에서 overlay 의 엣지 종류를 세려고
  `grep -o '"kind":"[a-z-]*"' | sort | uniq -c` 를 돌렸다.
- (b) 결과가 `9480 "kind":"import"` — **"이 도구에 co-change 엣지는 없다"** 고
  결론 내렸다. 실제로는 있었다. co-change 엣지는 `kind` 필드가 **아예 없고**
  `{"origin":"cochange","support":N,"lift":N}` 형태라 내 grep 에 안 걸렸다.
  같은 `edges` 배열 안에 **필드 스키마가 다른 두 종류가 섞여 있다.**
  7133개를 못 보고 지나갈 뻔했다.
- (c) **우연히 돌아왔다.** 호출 23 에서 다른 걸 찾다가 응답 꼬리의
  `"quadrant":{"both":552,"cochange":7133,"stable":6292,"unknown":2636}` 를
  눈으로 보고 알아챘다. **의도해서 찾은 게 아니다.**
  이걸 못 봤으면 M7 의 ②③(간접충돌 2명)은 통째로 없는 답이 됐다.
  🔴 이번 판에서 **가장 위험했던 순간**이다 — 도구가 거짓말한 건 아니지만,
  일관되지 않은 스키마가 나를 틀린 결론으로 데려갔다.

**(E) 거대한 마지막 한 줄이 grep 을 오염시켰다**
- (a) 호출 25 에서 raft.go 의 co-change 이웃을 claim 3건과 대조하려 했다.
- (b) `/api/overlay` 응답 끝에 `freq` 맵(파일 2019개의 커밋수)이
  **줄바꿈 없는 한 줄**로 들어 있다. 그 한 줄이 `controller/raft/raft.go` 도,
  `controller/config` 도 전부 포함해서 **모든 grep 에 걸렸다.**
  "controller/config 와 co-change 가 있다" 는 **오답이 나올 뻔했다.**
- (c) **돌아갔다.** `awk 'length($0)<250'` 으로 거대 라인을 걸러 재실행(호출 26).
  정답은 `controller/config` co-change **0건** (import 은 있음).

**(F) `/api/entry` 의 churn·risk 목록 최상단을 `go.mod` 와 `CHANGELOG.md` 가 차지한다**
- (a) "고치면 위험한 코드 파일" 을 찾으려 했다 (M5).
- (b) churn 1·2·3위가 `go.mod`(freq 1891) · `CHANGELOG.md`(678) · `zititest/go.mod`(258),
  risk 1위도 `go.mod`(hidden 321). 넷 다 `deg: 0` 인 **비-코드 파일**이다.
  12칸짜리 목록에서 3~4칸을 잡아먹어 진짜 허브를 밀어냈다.
  도구는 이들을 따로 표시하거나 걸러주지 않았다.
- (c) **막히진 않았다.** `deg: 0` 을 보고 내가 손으로 걸렀다.
  하지만 **신입이 이걸 그대로 믿으면 "이 저장소에서 제일 위험한 파일은 go.mod" 라는
  쓸모없는 답을 낸다.**

**(G) M2 에서 도구가 하나를 안 짚어준다** — 위 M2 caveat 참조.
- (c) 다른 필드(`in`/`out`, `core` 배열 포함 여부)를 교차해서 내가 뒤집었다. 돌아갔다.

## 4. 클릭했는데 엉뚱한 것이 눌리거나 아무 일도 안 일어난 횟수

**해당 없음 (0회) — 나는 화면이 없다.** 클릭이라는 행위 자체가 없었다.

대응되는 실패를 굳이 세면 **잘못된 결론에 도달한 조회 2회**:
- 호출 16 — co-change 엣지가 없다고 결론 (틀림, 위 D)
- 호출 25 — grep 이 거대 라인에 오염 (위 E)

그리고 **의도한 값을 못 뽑은 조회 1회**:
- 호출 27 후반 — `sed` 정규식의 greedy 매칭 때문에 degree 정렬이
  전부 `0` 으로 나왔다. `/api/entry` 의 hub 목록에 이미 답이 있어서 재시도 안 했다.

## 5. 🔴 글 없이 그림(점·선·크기·색·위치)만으로 알아낸 것

**0개. 하나도 없다.**

나는 화면을 보지 않았다. 내가 읽은 것은 전부 **JSON 필드의 글자와 숫자**다 —
`deg: 176`, `hidden: 321`, `support: 5`, `lift: 8.1`, `"origin":"cochange"`,
`"state":"declared"`. 점도 선도 색도 위치도 없었다.

### "그림 없이 글자만 있었어도 답이 같았을 질문" — **7개 전부 (M1~M7)**

이건 자명하다. 나는 **정의상 글자만 가진 조건**이고, 그 조건으로 7개를 다 답했다.
그러므로 이 판이 증명하는 것은 이것이다:

> 🔴 **이 도구의 답은 전부 텍스트 API 안에 이미 들어 있다.**
> M1~M7 중 어느 것도 그림이 있어야만 답할 수 있는 질문이 아니었다.

다만 **정답률이 같다는 것과 비용이 같다는 것은 다르다.** 내가 실제로 치른 비용:

| 항목 | 텍스트만 (나) |
|---|---|
| 총 호출 | 28 |
| 1차 답에 필요했던 호출 | 3 (호출 3·5·8) |
| **검증·우회에 쓴 호출** | **~20** |
| 틀린 결론에 도달했다 되돌아온 횟수 | 2 (D, E) |
| 놓칠 뻔한 데이터 | co-change 엣지 7133개 (우연히 발견) |

그림이 값을 하는 지점이 있다면 정답 여부가 아니라 **이 표의 3~5행**일 것이다.
특히 **(D)** — "엣지가 두 종류 섞여 있다" 는 사실은 그림에서는 선 색이 두 가지인 것으로
한눈에 보였을 성질이고, 텍스트에서는 스키마를 직접 파봐야만 드러났다.
그리고 **(F)** — `go.mod` 가 목록 1위인 것은 텍스트에서는 그냥 1위지만,
그림에서는 "선이 하나도 안 붙은 큰 점" 으로 보여 즉시 걸러졌을 것이다.
**나는 그 두 가지를 숫자(`deg: 0`, 필드 부재)로 알아냈지만, 알아채는 데 실패할 뻔했다.**

반대로 텍스트가 명백히 우세했던 것도 적어둔다:
`intent` 문자열("raft 리더 선출 타임아웃 조정"), `expiresAt` 타임스탬프,
`evidence` 배열, `why` 설명문, cluster 의 커밋 제목 —
**이것들은 그림으로 그릴 수 없다.** M6·M7 의 핵심은 전부 이런 문자열이었다.

## 6. 이 도구에서 가장 쓸모없었던 것 하나

### 🔴 `/api/graph` — `/api/overlay` 의 진부분집합이다.

두 엔드포인트를 나란히 열어보면(호출 12) **`nodes` 배열의 첫 바이트부터 동일**하고,
`edges` 의 import 엣지 9480개도 동일하다. 차이는 overlay 에만 있는 것들뿐이다:
`parsing`(파싱 통계) · `quadrant` · `freq`(파일별 커밋수) · `hubs` ·
그리고 **co-change 엣지 7133개**.

즉 `/api/graph` 는 **2.2MB 를 받아서 overlay 가 주는 것의 일부만** 준다.
`/api/overlay` 를 한 번 받으면 `/api/graph` 는 존재 이유가 없다.
내가 `/api/graph` 를 쓴 유일한 이유는 **overlay 에 co-change 가 있다는 걸 몰라서**였다
(위 막힌 지점 D). 그걸 처음부터 알았다면 `/api/graph` 호출 4번(12·13·14·15)은
전부 불필요했다.

**차점자: `/api/flow` step 3 의 `chain`.**
8줄을 반환했는데 전부 곁다리 바이너리 내부였고, 시작점을 바꿀 수단이 없었다.
`layers` 는 유용했지만 `chain` 은 단 한 글자도 답에 쓰지 못했다.
`toCenter` 마저 `found: false` 였으니, **step 3 에서 실제로 쓸모 있던 건
`layers` 와 정직한 `gaps` 문구뿐**이다.
