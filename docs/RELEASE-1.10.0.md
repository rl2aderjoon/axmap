# axMap 1.10.0

일반 Windows Claude Code 터미널 자동 연결, 관리형 Claude Code 지속 연결과 실행 요청
FIFO 큐를 배포한다. 기존 MCP 선점·쪽지·받은 편지함 인터페이스를 유지한다.

## 변경

- SessionStart·UserPromptSubmit·Stop·SessionEnd 훅으로 원래 Claude 프로세스와 대화를 등록한다.
- 원래 Windows 콘솔의 신원·화면·커서를 전달 직전에 다시 검사한다. 입력 초안과 승인 대기에는 주입하지 않는다.
- 일반 Claude 콘솔과 관리형 stdio 실행 요청을 큐에 보관하고 idle에서 전달한다. 대기 중 모델 호출은 없다.
- 관리형 Claude stream-json과 누적 사용량, 자동 대화의 fenced JSON·시간 제한·종료 주체 제어를 지원한다.
- 확정 미전달·접수 거절과 전달 불명을 구별하며 불명 요청은 자동 재전송하지 않는다.
- wait 조회가 queued → sending → submitted 전환 중에도 결과를 기다린다.

## 검증과 배포

`npm test`, `npm run build:check`, 기본·비교·카오스 데모의 종료 코드로 검증한다.
`npm pack`의 파일 목록에서 개인 설정·상태·로컬 인수인계·테스트·개발 의존성이 빠졌는지
검사하고, 생성한 동일 tarball을 격리 prefix에 설치해 CLI와 MCP 도구 목록을 확인한다.
검증한 tarball을 npm 공개 registry의 latest로 게시하고 원격 버전·integrity를 대조한다.
Git main과 v1.10.0 태그를 같은 릴리스 커밋으로 게시한다.

## 적용 범위

Windows Claude Code 2.1.316 일반 터미널에서 자동 등록·표식 기억·큐 처리와 실제 Codex
요청·응답을 확인했다. 일반 콘솔의 토큰 사용량은 이 경로에서 계측하지 않는다.
토큰 예산을 검사하는 ax_chat은 관리형 stdio 세션을 사용한다. WSL·Linux·SSH의 일반
터미널 연결과 모든 호스트의 도구 자동 승인은 이 릴리스의 지원 주장이 아니다.

설치 후 `axmap setup`을 실행하고 Claude Code를 다시 열어 훅을 적용한다.
