# alluxio 저장소 — 신입 개발자 관점 답변 (화면 + API 둘 다 사용)

조사 대상: `C:\Users\SSAFY\AppData\Local\Temp\blastmap-eval\alluxio` (소스는 직접 열지 않음)
사용한 자료: 스크린샷 7장(`shots/01~07`), API `http://127.0.0.1:7850` (`/api/flow`, `/api/entry`, `/api/watch`, `/api/featuregraph`, `/api/overlay`, `/api/graph`)

---

## M1. 이 저장소는 무엇을 하는 물건인가

**답**: Alluxio(옛 이름 Tachyon) — 대규모 데이터를 위한 분산 캐싱 플랫폼. 컴퓨팅 프레임워크(Spark 등)와 다양한 저장 시스템(HDFS, S3, GCS, Swift 등) 사이를 하나의 공통 인터페이스로 이어주는 다리 역할을 한다.

**근거**: `/api/flow`의 1단계 답변이 README.md를 그대로 인용함 —
> "Alluxio Open Source (formerly known as Tachyon) is a Distributed Caching Platform for large-scale data. It bridges the gap between computation frameworks and storage systems..."

매니페스트는 `pom.xml` (jvm, 이름 `alluxio-parent`) 하나. 화면 01번 좌측 카드(`alluxio-parent`)에도 동일 문구가 그대로 보인다.

- 먼저 본 것: API (`/api/flow`를 화면보다 먼저 호출함)
- 그것으로 답이 됐나: 예
- 도구 호출 수: 2 (`/api/flow` 1회, 화면 01번 판독 1회)

---

## M2. 실행은 어디서 시작하나 — 파일 하나

**답**: blastmap이 정적으로 찾아낸 진입점 후보(총 863개) 중 가장 근거가 센 그룹(8개, rank2) 1위는
`integration/kubernetes/operator/alluxio/cmd/controller/main.go` (Go, `func main()`, 관례적 파일명 `cmd/<이름>/main.go`, out-degree 18로 이 그룹에서 가장 많은 것을 부름).

**근거**: `/api/entry`(정확히는 `/api/flow` 2단계) 응답의 `groups[0].rows[0]` — evidence: `["func main() (package main)", "관례적인 파일명", "아무도 import 하지 않는데 남을 import 한다", "Go 관례: cmd/<이름>/main.go"]`, `out:18`.

**단서(못 함에 가까움)**: 이건 쿠버네티스 오퍼레이터 컨트롤러의 진입점이지, Alluxio 코어 서버(master/worker)의 "진짜" 시작점(예: `AlluxioMaster`/`AlluxioWorker`의 `main`)은 아닐 가능성이 높다. 도구 스스로 3단계에서 "예제·테스트를 뺀 코드 2202개 중 시작점에서 닿는 것이 164개(7%) 뿐"이라며 "정적 파싱이 못 푼 연결이 있거나, 진입점이 더 있다"고 경고한다. 셸 스크립트로 기동되는 서버 프로세스의 진짜 main 클래스는 화면·API 어디서도 rank1로 잡히지 않았다 — **이 부분은 확신 없음, 정직하게 적는다.**

- 먼저 본 것: API (`/api/flow` step2, 화면 02·03 열기 전)
- 그것으로 답이 됐나: 예 (파일 하나는 짚을 수 있었음, 다만 "진짜 서버 시작점"이라는 확신까진 아님)
- 도구 호출 수: 3 (화면 02·03·04 판독 — API는 M1에서 이미 확보한 응답 재사용, 신규 호출 0)

---

## M3. 이 저장소의 큰 덩어리 셋

**답**: 파일 수 기준 최상위 3개 — **core**(1747개, 실제 엔진: server/master/worker/client 등), **tests**(254개), **integration**(221개, k8s/docker/vagrant 배포 연동). 그 다음이 job(197)·webui(191)·shell(148)·underfs(134)·docs(113)·table(105)·stress(90) 순.

**근거**: `/api/flow` 1단계 `answer.shape` 배열 + 화면 01번 왼쪽 "무엇으로 이뤄져 있나" 막대 목록(core 1747 → stress 90까지 동일 수치로 표시됨).

- 먼저 본 것: API (`/api/flow`의 `shape` 필드, M1 때 이미 받아둔 응답)
- 그것으로 답이 됐나: 예
- 도구 호출 수: 0 (M1·M2에서 이미 확보한 화면·API 재사용, 신규 호출 없음)

---

## M4. "저장소(스토리지) 연결" 기능을 고치려면 어느 파일

**답**:
- 모든 스토리지 백엔드가 구현하는 공통 인터페이스: `core/common/src/main/java/alluxio/underfs/UnderFileSystem.java`
- 오브젝트 스토리지 계열의 공통 베이스: `core/common/src/main/java/alluxio/underfs/ObjectUnderFileSystem.java`
- 특정 백엔드(예: S3)를 고치려면 `underfs/s3a/src/main/java/alluxio/underfs/s3a/S3AUnderFileSystem.java` 같은 백엔드별 모듈. blastmap은 `/api/featuregraph`에서 스토리지 백엔드마다 **별도 "기능"**으로 묶어 놓았다: `underfs/hdfs`(19파일) · `underfs/s3a`(13) · `underfs/oss`(13) · `underfs/gcs`(11) · `underfs/obs`(11) · `underfs/swift`(11) · `underfs/tos`(11) · `underfs/kodo`(8) · `underfs/cos`(5) · `underfs/cephfs`(5) · `underfs/local`(5) · `underfs/cosn`(4) · `underfs/abfs`(3) · `underfs/adl`(3) · `underfs/ozone`(3) · `underfs/wasb`(3).

**근거**: `/api/featuregraph`의 `nodes[].paths`를 직접 열어봄 — 예를 들어 `core/hdfs`라는 기능 노드의 경로들이 실제로는 `underfs/hdfs/src/main/java/alluxio/underfs/hdfs/HdfsUnderFileSystem.java` 등이었음. 공통 인터페이스 파일은 `/api/flow` 4단계 "risk" 목록에도 등장 (`UnderFileSystem.java` freq 191·deg 155·hidden 49, 상위 1%).

- 먼저 본 것: 화면 (06-feature.png, "기능" 탭)
- 그것으로 답이 됐나: **아니오 — 그래서 API도 봤다.** 화면 06번에 실제로 찍힌 상위 항목은 `server`, `What is Alluxio Open Source`(core/common), `Artifact alluxio-core-client-hdfs provides`(core/client), `src`뿐이었고 "저장소 연결"이라고 바로 알아볼 수 있는 기능 이름이 화면 캡처 범위 안에는 없었다. 전체 37개 기능 목록을 `/api/featuregraph`로 받아 이름·경로를 하나씩 뒤진 뒤에야 `core/hdfs`, `core/s3a` 같은 기능들이 실은 `underfs/*` 커넥터라는 걸 확인할 수 있었다.
- 도구 호출 수: 7 (화면 06번 판독 1 + `/api/featuregraph` 호출 1 + 이를 파일로 저장/분석하는 스크립트 5회 — 그중 2회는 제 실수로 인한 재시도: bash 전용 `/tmp` 경로를 windows `node.exe`가 못 읽어서 스크래치패드 경로로 재저장)

---

## M5. 건드리면 파급이 큰 파일 하나와 근거

**답(1순위, 화면에서 바로 보임)**: `core/server/master/src/main/java/alluxio/master/file/DefaultFileSystemMaster.java` — 저장소 전체(72개 동급 저장소, 21만 4401개 파일 코퍼스) 기준 **커밋 수 상위 1%**(586회, 중앙값의 134배)이면서 동시에 **숨은 결합(import 없이 같이 바뀌는 이웃) 1위**(190개). 커밋 빈도와 숨은 결합 둘 다 리포 전체 1위인 유일한 파일.

**답(2순위, API에서만 보임)**: `core/common/src/main/java/alluxio/conf/PropertyKey.java` — import로 이어진 이웃 수(hub degree) 리포 전체 1위(769개, 2위 Configuration.java는 669개), freq 460(2위), hidden 111(2위).

**근거**: `/api/entry` 응답의 `lists` 중 `hub`(가장 많이 연결된 곳, PropertyKey.java deg 769) · `risk`(숨은 결합, DefaultFileSystemMaster.java hidden 190) 두 목록. 화면 05번에는 "가장 자주 바뀌는 곳"과 "숨은 결합이 많은 곳" 두 목록만 보이고(둘 다 DefaultFileSystemMaster.java·PropertyKey.java가 상위), "가장 많이 연결된 곳"(import hub) 랭킹 자체는 화면 05번에는 없었다 — API에만 있는 정보였다.

- 먼저 본 것: API (`/api/entry`, 화면 05번을 열기 전에 이미 받아둔 응답)
- 그것으로 답이 됐나: 예
- 도구 호출 수: 3 (화면 05번 판독 1 + `/api/overlay` 확인용 호출 1 — 사실 `/api/entry`에 이미 hub 목록이 있어서 이 6.8MB짜리 `/api/overlay` 호출은 돌아보니 불필요했음. `/api/entry`는 M1에서 함께 받아둔 응답을 재사용해 신규 호출 0회)

---

## M6. 지금 다른 사람이 잡고 있는 곳이 있나

**답**: **판단 불가.** `/api/watch` 응답이 `ledgerAvailable:false, claims:[], sync.why:"장부가 없습니다"`. 화면 07번(감시 탭)도 굵은 글씨로 못박아 놓았다 — "원격 장부를 못 봤습니다(장부가 없습니다). 이 화면은 이 컴퓨터가 아는 것만 보여줍니다" / "장부를 읽지 못해 지금 상태를 판단할 수 없습니다 — **0이라는 뜻이 아닙니다.**" 즉 `claims:[]`라는 숫자만 보고 "아무도 안 잡고 있다"고 단정하면 안 된다.

**근거**: `/api/watch` JSON 전체, 화면 07번 상단 경고 문구.

- 먼저 본 것: 화면 (07-감시.png)
- 그것으로 답이 됐나: 예 (화면 문구가 "모른다"는 결론 자체를 명확히 알려줌 — API 숫자만 봤으면 "0개=아무도 없음"으로 잘못 읽었을 수 있음)
- 도구 호출 수: 2 (화면 07번 판독 1 + `/api/watch` 1)

---

## M7. 내가 지금 어떤 파일을 고치면 누구와 부딪히나

**답**: **못 함.** M6과 같은 이유 — claim 장부 자체가 이 환경에 없어서, 특정 파일을 고칠 때 누구와 겹칠지 계산할 방법이 화면에도 API에도 없다. `blastmap claim` 을 실제로 실행해 exit code(0/2/3)를 받아보기 전에는 알 수 없는 정보이고, 이 세션에서는 claim을 실행하지 않았다(대상 저장소를 건드리지 말라는 지시이기도 함).

**근거**: `/api/watch`의 `available:false`, `adjacency:{pairs:[],checked:0}` — 인접 파일 충돌 계산 자체가 "확인한 것 0건"으로 비어 있음.

- 먼저 본 것: 화면 (07번, M6에서 이미 봄)
- 그것으로 답이 됐나: 예 (화면·API 모두 "모른다"고 일관되게 말하고 있어 추가로 볼 곳이 없었다는 뜻에서는 "됐다")
- 도구 호출 수: 0 (M6에서 이미 확보한 화면·API 재사용)

---

## 마지막 정리

**1. 도구 호출 합계 및 "못 함" 질문**
- 총 도구 호출: **19회** (화면 판독 7 + API/분석 호출 12, 그중 2회는 제 실수로 인한 재시도 — ① 최초 스크린샷 디렉터리 `ls` 명령의 따옴표 실수, ② `featuregraph.json`을 bash 전용 `/tmp` 경로에 저장해 windows `node.exe`가 못 읽어서 스크래치패드 경로로 재저장)
- "못 함" 질문: **M7** (누구와 부딪히는지는 장부가 없어 계산 불가). M6도 사실상 "모름"이 정답이며, 숫자(`claims:[]`)만 보면 "아무도 없음"으로 오독하기 쉬운 함정이 있었다.

**2. 화면을 먼저 본 질문 개수 / 화면만으로 끝난 것**
- 화면을 먼저 본 질문: **M4, M6, M7** (3개). 나머지 M1·M2·M3·M5는 API를 먼저 봤다.
- 그중 화면만으로 끝난 것: **M6, M7** (2개). M4는 화면만으로는 부족해서 API까지 봐야 했다.

**3. 화면이 없었다면 못 했을 질문이 있었나**
- **없다. 정직하게 말하면 전부 API만으로도 됐다.** API JSON은 화면이 보여주는 것보다 더 많은 원본 필드(`ledgerAvailable`, `why`, `hub`/`risk`/`churn` 전체 목록, `featuregraph`의 37개 기능 전체)를 담고 있어서, 화면 캡처가 잘라낸 부분(예: M4의 스토리지 기능, M5의 hub 목록)도 API를 끝까지 읽으면 나왔다. 다만 화면의 **문장 설명**(예: M6/M7의 "0이라는 뜻이 아닙니다")은 API의 원시 필드만 보고 스스로 재구성하기엔 뉘앙스를 놓치기 쉬웠다는 점에서 화면이 실질적으로 도움이 됐다.

**4. 화면이 오히려 헷갈리게 한 순간**
- 06번(기능 탭) 스크린샷. 화면에 찍힌 상위 4~5개 기능 이름(`server`, `What is Alluxio Open Source`, `Artifact alluxio-core-client-hdfs provides`, `src`)만 보면 "저장소 연결" 관련 기능이 아예 없는 것처럼 보였다. 실제로는 스크롤 아래쪽(또는 API 응답의 나머지 33개 항목)에 `hdfs`·`s3a`·`gcs`·`swift`·`obs`·`tos`·`cos`·`cephfs` 등 스토리지 커넥터별 기능이 줄줄이 있었다 — 화면이 "일부만 보여준다"는 사실 자체가 판단을 그르칠 뻔했다.

**5. 막혔던 자리**
- **M2**: Alluxio 코어 서버(master/worker)의 "진짜" 프로세스 시작점(예: `AlluxioMaster`의 `main`)을 화면에서도 API에서도 rank1로 찾지 못했다. 도구 스스로 "정적 파싱이 못 푼 연결이 있거나 진입점이 더 있다"(도달률 7%)고 인정한 지점이라, 이 저장소가 셸 스크립트로 JVM을 띄우는 방식이라서 정적 진입점 탐지 범위 밖에 있는 것으로 추정되지만 확인은 못 했다.
- **M6/M7**: claim 장부가 이 환경에 아예 없어서 "지금 비어 있다"와 "장부를 볼 수 없어 모른다"를 구별할 방법이 화면에도 API에도 없었다. 이건 도구가 스스로 명시한 한계라 정직하게 "못 함"으로 남긴다.
