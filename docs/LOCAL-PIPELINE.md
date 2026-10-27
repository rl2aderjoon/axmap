# 기존 대화의 로컬 연결과 /pipeline

2026-10-26 · S15P31E109-207 · 구현/검증 중. 참고 영상은 사용자 로컬 BIio34PgIbXUmfSL.mp4이다.

## 원하는 동작

세션 역할 카드와 axMap 라우터, 요청/응답의 실제 연결, 상태·사용량·최근 이벤트를 함께 표시한다. 모델 내부 작업률이나 토큰을 추정하지 않는다. 터미널은 `axmap pipeline`, MCP Apps 호스트는 `ax_pipeline`을 사용한다. `.claude/commands/pipeline.md`는 Claude의 `/pipeline`, `skills/pipeline/SKILL.md`는 Codex의 활성 스킬 메뉴/`$pipeline` 진입점이다. 클라이언트가 제공하지 않는 임의 slash UI를 axMap이 강제로 주입하지 않는다.

MCP Apps를 표시할 수 없는 클라이언트는 `axmap pipeline --web --cwd <repo>`로 같은 그래프를 loopback에서 연다. 이 서버는 GET 전용이고 다른 origin/host와 교차 사이트 요청을 거절하며 임의 파일·실행 API를 제공하지 않는다. MCP에 배포하는 HTML 자체는 HTTP 요청을 하지 않고, 로컬 웹 서버가 제공하는 변형에만 읽기 어댑터가 주입된다. `--observe` 연결은 active 대화도 관측할 수 있으나 idle 전에는 제출을 거절한다.

## 로컬 통신

기존 bridge도 요청/결과를 `~/.axmap/bridge`와 인증된 Named Pipe/Unix socket에 기록한다. Git bus는 다른 PC와 비동기 공유할 때 쓰며 로컬 모델 요청 경로와 분리한다. claim의 원격 CAS 프로토콜은 변경하지 않는다.

새 `bridge connect codex --thread <기존 UUID> --socket <공식 control socket>`는 이미 실행 중인 Codex daemon의 `app-server proxy`에 연결한다. 이 proxy는 JSONL이 아니라 로컬 WebSocket 바이트를 전달하므로 Upgrade 응답과 accept nonce를 검증하고 masked frame/fragment/control frame을 처리한다. 새 모델 프로세스나 thread/start를 만들지 않으며 원본 thread ID로 thread/read → idle/작업경로 확인 → thread/resume을 수행한다. 모델/샌드박스/승인 설정을 덮어쓰지 않는다. 연결 프로세스를 종료해도 기존 daemon은 종료하지 않는다.

현재 PC에서 `codex app-server daemon version`이 반환한 control socket을 사용한다. socket 경로는 예시를 다른 PC에 복사하지 말고 해당 PC에서 확인한다. loopback TCP를 공개하거나 인증을 해제할 필요가 없다.

## 비용과 완료의 의미

`bridge notice --to <UUID>`는 stdin 안내를 이미 로드된 Codex 대화의 user-role 문맥에 기록하고 새 모델 턴을 시작하지 않는다. 원래 사용자의 승인 범위 안에서 협업 안내에 사용한다. 문맥 기록 성공과 작업 실행/이해 확인은 다르다. 안내 UUID·대상 원본 thread·시각을 로컬 notices에 남기고 화면에도 안내 이벤트로 표시한다. 이번 사용자 요청의 향후 bridge 송신 규칙을 research/coordination/spring-db에 이 경로로 전달했다. 모델 응답이나 사람 승인을 받은 것으로 표시하지 않는다.

관측/전달/빈 큐 확인은 모델을 부르지 않는다. 수신 세션이 실제 작업을 시작할 때 그 모델의 추론 시간이 발생한다. 기존 문맥을 유지해도 provider가 처리하는 입력·캐시·출력은 남는다. 로컬 IPC 지연과 모델 포함 왕복 시간을 따로 측정한다. 첫 기존 대화 요청의 이전 누적 baseline을 알 수 없으면 요청 토큰은 null로 기록하고 전체 누적을 새 요청 비용으로 계산하지 않는다.

전달 성공은 완료가 아니다. 기존 요청 UUID와 provider turn ID를 대조하고 turn/completed를 관측해야 완료한다. 연결 단절/타임아웃은 unknown이며 자동 재전송하지 않는다. 사용자의 동시 입력·active thread·승인 대기를 덮어쓰지 않는다. 다른 클라이언트의 native 메시지를 전역 가로채는 기능은 아니다. 모든 협업 호출이 axMap을 거치려면 각 클라이언트/에이전트의 전송 진입점을 bridge 도구로 맞춰야 한다.

## 검증 근거

이 PC의 실제 daemon 0.164.0에 read-only 연결해 2026-10-26 기존 스레드 목록과 idle/active를 읽었다. 기존 axMap 검토 thread local-id-7c93ec244990에 새 thread 생성 없이 연결했고 conversationId가 유지되었다. 새 요청의 실제 응답·맥락 유지·토큰·지연과 UI 검증 결과는 검증 파일로 추가한다. 계약 테스트를 실제 모델 검증으로 표시하지 않는다.

실제 후속 검증: 기존 검토 세션이 이전의 선점 유실·표 작성자 귀속 문제 두 가지를 기억해 답했다. 첫 영어 요청은 접수 435.44ms/왕복 5210.86ms, 다음 요청은 307.69ms/6185.65ms였다. 다음 요청의 누적 차이는 처리237163, 캐시입력236928, 입력237153, 출력10 토큰이다. 금액이 아니라 provider 처리량이며 캐시·입력·출력을 중복 합산하지 않는다. 첫 요청은 이전 baseline 미확인으로 요청 usage=null이다. 앞선 한글 검증 요청은 Windows stdin 인코딩으로 문장이 손상되어 전송/응답 확인으로만 보존하고 맥락 검증 근거에서 제외했다.

우리 repo의 storage/research/coordination/spring-db 기존4thread는 관측/전송용 연결을 설치했다. 원래 대화/daemon은 유지하며 추가 모델 요청을 자동 발행하지 않는다. 이 연결은 이 PC와 현재 실행 세션 범위이며 재부팅 후 자동 서비스 설치를 수행한 것은 아니다. 각 에이전트의 전송 규칙을 bridge로 통일해야 협업 요청 전체가 axMap 기록에 남는다. native 전송 버튼/외부 프로그램의 모든 메시지를 강제로 가로채는 기능은 아니다.

전체 npm 회귀와 기본·비교·경합 데모가 통과했고, 이후 추가한 로컬 웹 어댑터/UI 검사도 통과했다. 설치본 명령과 패키지 목록88개에서 connector/UI/skill/web 포함을 확인했다. 브라우저의 127.0.0.1:8786 접근이 승인 정책에 거절되어 실제 화면 육안 검증은 미실행이며 우회하지 않았다. 검증 당시 소스는 로컬 미커밋 상태였다. 후속 Git 공유는 S15P31E109-207 게시 기록으로 확인하며 공개 npm 배포는 수행하지 않았다.

공식 근거: https://learn.chatgpt.com/docs/app-server · https://learn.chatgpt.com/docs/reference/slash-commands
