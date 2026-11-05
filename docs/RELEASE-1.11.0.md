# axMap 1.11.0

Claude 데스크톱 앱(Code 탭)과 Codex 앱처럼 콘솔 창이 없는 앱 세션을 공급자 훅으로 등록하고,
대화 모드(D32)로 서로 실행 요청과 회신을 주고받게 한다. 기존 선점·쪽지·받은 편지함·관리형 연결
인터페이스를 유지한다.

## 변경

- Claude·Codex의 SessionStart·UserPromptSubmit·Stop·SessionEnd 훅이 대화 ID로 앱 세션을 등록한다(`transport: hook`).
- `ax_dialogue_mode`(명령: `axmap bridge mode`)로 켠 세션만 요청을 받는다. Stop 훅이 최대 540초 동안
  로컬에서 기다렸다가 `decision: block`으로 같은 대화를 이어 간다. 기다리는 동안 모델을 부르지 않는다.
- `ax_dispatch`·`bridge send`에 `from_session`을 더해 회신이 보낸 앱 세션의 다음 Stop으로 돌아가게 한다.
- 사람의 입력은 진행 중 요청을 superseded로, 모드 끄기·세션 종료는 미전달 요청을 failed로 기록한다.
- 작업 폴더를 오가는 대화는 본 적 있는 저장소를 최대 8개까지 기억한다.
- Codex는 대화 ID가 이름에 든 rollout 기록 파일이 있는 대화만 등록한다. 제목 생성용 보조 대화는 남지 않는다.
- 사용자가 중단한 Codex 차례는 rollout의 `turn_aborted`로 상태 화면에서 대기로 보인다.
- `bridge send`·`mail`·`chat`·`notice`가 stdin 본문의 BOM을 지우고 CRLF를 LF로 바꾼다.
- setup이 Stop 훅 제한 시간을 600초로 설치한다. 다른 훅은 10초를 유지한다.

## 검증과 배포

`npm test`, `npm run build:check`, 기본·비교·카오스 데모의 종료 코드로 검증한다.
`npm pack`의 파일 목록에서 개인 설정·상태·로컬 인수인계·테스트·개발 의존성이 빠졌는지
검사하고, 생성한 tarball을 격리 prefix에 설치해 CLI와 MCP 도구 목록을 확인한다.
검증한 tarball을 npm 공개 registry의 latest로 게시하고 원격 버전·integrity를 대조한다.
Git main과 v1.11.0 태그를 같은 릴리스 커밋으로 게시한다.

## 적용 범위

2026-11-05 Windows 11에서 실제 Claude 데스크톱 앱과 Codex 데스크톱 앱 사이의 요청·회신 왕복과,
사람 입력 없는 2회차 왕복을 확인했다. 세부 기록은 [SESSION-BRIDGE.md](SESSION-BRIDGE.md)에 있다.
앱 세션의 토큰 사용량은 계측하지 않아 `ax_chat` 예산 한도를 적용하지 않는다. 쉬고 있는 앱을 밖에서
깨우지 않는다. Claude 앱의 사용자 중단 표시, 기다림 시간 초과와 이어 가기 한도 도달은 실측하지 않았다.

설치 후 `axmap setup`을 실행하고 앱을 다시 열어 훅을 적용한다.
