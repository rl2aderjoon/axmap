# 신입 개발자 벤치마크 — 텍스트(API) 전용

대상: `http://127.0.0.1:7850` 의 blastmap API 만 사용. 소스코드·스크린샷·다른 문서는 보지 않았다.

---

## M1. 이 저장소는 무엇을 하는 물건인가

**답**: Alluxio Open Source (예전 이름 Tachyon). 대용량 데이터를 위한 분산 캐싱 플랫폼이다.
연산 프레임워크(Spark, Presto 등)와 저장 시스템(S3, HDFS, GCS 등) 사이를 이어주는 공통 인터페이스를 제공한다.
매니페스트는 `pom.xml` (Maven, JVM 프로젝트, 아티팩트 이름 `alluxio-parent`)이고, 코드의 대부분(2829개 파일)이 Java 다.

- 어느 응답의 무엇을 보고: `/api/flow` → `steps[0]` (key=`what`) → `answer.summary` (출처 `README.md`), `answer.manifests`, `answer.langs`
- 도구 호출 수: 1

---

## M2. 실행은 어디서 시작하나 — 파일 하나

**답**: 가장 근접한 후보는 `integration/kubernetes/operator/alluxio/cmd/controller/main.go` 다.
`func main()` 이 있고, 파일명이 Go 관례(`cmd/<이름>/main.go`)를 따르며, 아무도 이 파일을 import 하지 않으면서 이 파일은 18개를 import 한다(전형적인 "시작점" 신호).

**단, 확신도는 낮다.** `/api/flow` 자체가 이 후보를 `rank:2` 로만 표시했고 (`rank:1` 짜리 후보는 하나도 없었다), 전체 863개 후보 중 상위 8개를 보여줬는데 전부 부수적인 도구들이다 — k8s 오퍼레이터 컨트롤러/웹훅, CSI 드라이버, Vagrant 스크립트, 마이크로벤치. Alluxio 의 핵심이라 할 `AlluxioMaster`/`AlluxioWorker` 같은 Java 프로세스 시작점은 이 목록에 전혀 안 보인다. `/api/flow` 는 이 부정확성을 스스로 인정한다: "정적 파싱이 못 푼 연결(동적 로딩·리플렉션·설정 기반 등록)이 있거나, 진입점이 더 있다."

- 어느 응답의 무엇을 보고: `/api/flow` → `steps[1]` (key=`enter`) → `answer.groups[0].rows[0]`, `evidence`, `total`/`shown`; `gaps[]`
- 도구 호출 수: 1 (flow, M1 과 같은 응답 재사용)

---

## M3. 이 저장소의 큰 덩어리 셋

**답**: 파일 수/코드 줄 수 기준 최상위 셋은

1. **core** — 1738개 파일, 325,516줄. 대부분 Java. 다시 `core/server`(1010개), `core/common`(914개, README 로 이름 붙음: "What is Alluxio Open Source"), `core/client`(244개) 로 나뉜다.
2. **tests** — 254개 파일, 48,753줄. 통합 테스트.
3. **integration** — 200~221개 파일, 약 33,563줄. k8s 오퍼레이터(Go), Docker CSI, FUSE, Vagrant 등 배포/연동 도구 모음.

(그다음은 job, webui, shell, underfs, docs, table, stress 순.)

- 어느 응답의 무엇을 보고: `/api/flow` → `steps[0].answer.shape`(디렉토리별 files/lines/langs); `/api/graph` → `groups`(디렉토리별 count, 15개); `/api/featuregraph` → `nodes`(37개 모듈, 이름·경로수) 로 교차 확인
- 도구 호출 수: 3

---

## M4. "저장소(스토리지) 연결" 관련 기능을 고치려면 어느 파일을 여나

**답**: `core/common/src/main/java/alluxio/underfs/UnderFileSystem.java` 가 모든 스토리지 백엔드가 구현하는 기반 인터페이스다("UFS" = Under File System, Alluxio 가 외부 저장소에 연결하는 지점). 오브젝트 스토리지 계열의 공통 로직은 `core/common/src/main/java/alluxio/underfs/ObjectUnderFileSystem.java` 에 있다.

특정 스토리지를 고칠 때는 그 스토리지 전용 커넥터를 연다. 예:
`underfs/s3a/.../S3AUnderFileSystem.java`, `underfs/hdfs/.../HdfsUnderFileSystem.java`, `underfs/swift/.../SwiftUnderFileSystem.java`, `underfs/gcs/.../GCSUnderFileSystem.java`.

`/api/featuregraph` 의 모듈 목록이 이걸 뒷받침한다 — hdfs, s3a, gcs, oss, obs, swift, tos, kodo, cephfs, cos, local, cosn, abfs, adl, ozone, wasb 등 **16개의 개별 저장소 커넥터 모듈**이 각각 별도로 잡혀 있다. 그리고 위 파일들은 전부 `/api/flow`·`/api/entry` 의 "가장 자주 바뀌는 곳" 목록 상위에 올라 있다 (S3A 221회, Swift 199회, HDFS 193회, UnderFileSystem.java 191회, GCS 154회 커밋) — 실제로 활발히 손대는 자리라는 뜻이다.

- 어느 응답의 무엇을 보고: `/api/flow` → `steps[3]`(key=`risk`) → `answer.hot.rows`; `/api/entry` → `lists[key="churn"].rows`; `/api/featuregraph` → `nodes[].name`(hdfs/s3a/gcs/oss/obs/swift/tos/kodo/cephfs/cos/local/cosn/abfs/adl/ozone/wasb)
- 도구 호출 수: 3

---

## M5. 건드리면 파급이 큰 파일 하나와 근거

**답**: `core/common/src/main/java/alluxio/conf/PropertyKey.java`.

`/api/entry` 의 "가장 많이 연결된 곳"(질문: "고치면 파급이 큰 곳은 어디인가") 목록에서 **`deg=769`** 로 전체 1위다 — import 로 이 파일을 참조하는 파일이 769개라는 뜻이다. 2위인 `Configuration.java`(669)보다도 100 이상 높다. 게다가 커밋 빈도도 460회로 전체 2위(활발히 바뀜)이고, 파일 길이도 10,440줄로 이례적으로 크다. 즉 "많이 쓰이면서 자주 바뀌는" 조합이라 건드리면 확인해야 할 곳이 가장 많다.

참고로 "숨은 결합"(import 없이 같이 바뀌는 이웃) 기준 1위는 `core/server/master/.../DefaultFileSystemMaster.java`(`hidden=190`, 커밋 586회로 전체 1위)다 — 리뷰에서 사고가 날 확률이란 관점에서는 이쪽이 더 위험할 수 있다. 질문이 "파급"(고치면 영향받는 범위)을 물었으므로 import 팬아웃이 가장 큰 `PropertyKey.java` 를 1차 답으로 제시한다.

- 어느 응답의 무엇을 보고: `/api/entry` → `lists[key="hub"].rows[0]` (deg=769); `/api/flow` → `steps[3].answer.risk.rows[0]`(DefaultFileSystemMaster, hidden=190) 로 대안 근거 병기
- 도구 호출 수: 2

---

## M6. 지금 다른 사람이 잡고 있는 곳이 있나

**답**: 없다. `/api/watch` 응답이 `claims: []`, `summary.agents: 0` 이고 `ledgerAvailable: false` 다 (아직 이 저장소에 claim 장부 자체가 없다). `gitAvailable: true` 는 git 저장소로는 인식된다는 뜻.

- 어느 응답의 무엇을 보고: `/api/watch` → `claims`, `summary`, `ledgerAvailable`
- 도구 호출 수: 1

---

## M7. 내가 지금 어떤 파일을 고치면 누구와 부딪히나

**답**: 지금 이 순간은 **아무와도 부딪히지 않는다.** M6 과 동일한 근거로 활성 claim 이 0건이라, 어떤 파일을 골라도 현재 겹치는 점유자가 없다.

다만 이건 "지금 스냅샷"일 뿐이고, `/api/watch` 는 미래에 다른 에이전트가 들어올 가능성까지 예측해주지는 않는다. 실제로 부딪힐지 알려면 claim 을 실행한 다음 그 결과(성공/충돌 메시지)를 봐야 하는데, 그건 API 조회만으로는 안 되고 `blastmap claim` 명령 실행이 필요하다 — 이 벤치마크의 범위(API 읽기 전용) 밖이라 실행하지 않았다.

- 어느 응답의 무엇을 보고: `/api/watch` → `claims`, `summary`, `adjacency`(pairs: [])
- 도구 호출 수: 1 (M6 과 같은 응답 재사용)

---

## 마지막 정리

### 1. 도구 호출 합계

**API 호출 6회** (엔드포인트별 1회씩): `/api/flow`, `/api/entry`, `/api/watch`, `/api/featuregraph`, `/api/graph`, `/api/overlay`.
질문별로 같은 응답을 여러 번 재사용했다(예: `/api/flow` 는 M1/M2/M3/M4/M5 에서, `/api/watch` 는 M6/M7 에서 재사용). 위 각 질문의 "도구 호출 수"는 그 답을 뒷받침하는 데 참조한 서로 다른 엔드포인트 개수를 센 것이다.

### 2. "못 함"으로 남긴 질문

없음 — 일곱 질문 모두 API 응답만으로 답을 냈다. 다만 **M2 는 확신도가 낮은 답**이다: `/api/flow` 자체가 "진입점이 더 있을 수 있다"고 명시했고, 눈에 보이는 후보들이 모두 주변부 도구(Go 오퍼레이터, CSI, Vagrant)일 뿐 Alluxio 의 핵심 Java 프로세스(마스터/워커) 시작점은 후보 목록에 없었다.

### 3. 막혔던 자리 — API 에 없었던 것

- **키워드/태그 검색이 없다.** "저장소 연결"(M4) 같은 개념을 찾으려면 고정된 목록(churn/hub/risk/isolated, featuregraph 의 37개 모듈명)을 사람이 눈으로 훑으며 이름이 그럴듯한 것을 골라야 했다. `GET /api/search?q=storage` 같은 것이 있었으면 한 번에 끝났을 일이다.
- **M2 의 확신도를 검증할 방법이 없었다.** `/api/flow` 가 "rank 1 후보 없음, rank 2 만 8개"라고 알려주긴 했지만, Alluxio 마스터/워커의 실제 Java 시작 클래스(`AlluxioMaster.java`, `AlluxioWorker.java` 류로 추정)가 왜 후보에 안 잡혔는지, 혹은 그런 파일이 존재하는지조차 API 로는 확인할 길이 없었다. (소스를 열어보지 말라는 규칙 때문에 직접 확인도 못 했다.)
- **M7 을 실측할 방법이 없었다.** `blastmap claim` 을 실행해봐야 진짜 충돌 여부를 알 수 있는데, 이 벤치마크는 읽기 전용 API 호출만 허용해서 스냅샷(`claims: []`)만 보고 "지금은 없다"고 답할 수밖에 없었다.

### 4. 화면(그림)이 있었다면 더 빨랐을 질문

- **M3 / M4**: `/api/featuregraph` 의 20개 클러스터 이름이 커밋 메시지에서 뽑은 문장이라 뜻이 애매한 게 많다(예: "termination conditions for LRFU", "master·handling"). 노드-엣지 그래프를 시각화해서 클러스터끼리 어떻게 붙어있는지 봤다면, "저장소 연결"처럼 흩어진 16개 underfs 모듈이 한 그룹으로 묶여있는지 즉시 눈에 들어왔을 것이다. 텍스트로는 모듈명 37개를 하나하나 읽고 유추해야 했다.
- **M5**: `deg=769` 같은 숫자보다, 그 파일을 중심으로 한 허브-스포크 그림 한 장이 "파급이 크다"는 걸 훨씬 빨리 납득시켰을 것이다.
- 나머지(M1, M2, M6, M7)는 텍스트로 충분했다 — 특히 M6/M7 은 단순히 빈 배열 여부만 확인하면 되는 질문이라 그림의 이점이 없었다.

### 5. 읽기 힘들었던 응답

- **`/api/graph` (약 5.0MB, 노드 3124 / 엣지 15676)** 와 **`/api/overlay` (약 7.2MB, 노드 3272 / 엣지 22067)** 는 그대로 사람이 읽을 수 있는 크기가 아니었다. 사전 요약이 전혀 없는 원본 그래프 덤프라, 로컬에서 스크립트로 걸러내지 않으면 열어보는 것 자체가 의미가 없었다. `/api/flow`, `/api/entry`, `/api/featuregraph` 는 이미 "질문 → 답" 형태로 다듬어져 있어 바로 읽혔던 것과 대조적이다. 이 둘은 사람이 직접 읽는 API 라기보다 화면(그래프 뷰) 렌더링용 원자재로 보인다.
- `/api/featuregraph` 의 클러스터 `id` 필드(예: `core-common-src-main-java-alluxio-cli-validationconfig-java`)는 파일 경로를 이어붙인 슬러그라 그 자체로는 의미를 읽기 어려웠고, `name` 필드(커밋 메시지 한 줄)에 의존해야 했는데 그마저 일부는 맥락 없이는 뜻이 분명치 않았다(예: "master·handling").
