# 열린 세션 연결 실험

현재 상태는 **개발 중인 프로토타입이며 실제 LLM을 사용한 PTY 연결 검증은 남아 있다.**
아래 agentapi 실패 경로는 `bridge install --experimental`로만 설치한다.
새 PTY 경로는 `axmap run agy|codex`로 사용자가 직접 CLI를 열며, setup과 run이
전용 연결 훅을 병합한다. 새 세션이나 headless 호출로 연결 실패를 대신하지 않는다.

## 요구

사용자가 세션을 연다. axMap은 그 세션의 기존 맥락을 유지하면서 작업을 전달하고
결과를 확인해야 한다. 세션 재개 자체와 이미 실행 중인 세션에 대한 입력은 구분한다.
쪽지 전달 성공, 요청 접수, 실제 작업 완료도 서로 다른 상태다.

## 2026-10-18 Windows 실측

- Remote Control로 기존 CLI 대화에 후속 요청을 보내고 이전 기억 문구와 계산 결과를
  얻었다. 이는 수동 브라우저 연결 검증이다.
- 설치된 `agy agentapi`는 기존 대화 메시지 전달과 메타데이터 조회를 제공하지만
  `ANTIGRAVITY_LS_ADDRESS`가 필요하다.
- CLI 1.4.0의 PreInvocation/Stop 훅은 실행됐으나 해당 주소를 제공하지 않았다.
  로컬 HTTP 서버에 대한 메타데이터 조회도 CSRF 인증 누락으로 거부됐다.
  인증을 우회하거나 내부 인증 정보를 추출하지 않았다.
- Sidecar 문서는 App을 대상으로 한다. 같은 API를 CLI 훅에서도 사용할 수 있다고
  가정하지 않는다. 이번에 설치한 axMap 실험 훅은 해제했다.

근거: [Remote Control](https://www.antigravity.google/docs/remote-control?tab=cli),
[Sidecars](https://www.antigravity.google/docs/sidecars/),
[Hooks](https://www.antigravity.google/docs/hooks/).

## 작성한 코드의 범위

`src/bridge.mjs`는 로컬 세션 등록, repo 경계 검사, agentapi 호출과 요청 상태를 구현한다.
`tools/bridge.mjs`와 `axmap bridge`에서 같은 코드를 사용한다.
MCP에는 `ax_sessions`, `ax_dispatch`, `ax_result`가 추가된다.
연결 정보를 가진 수신 세션이 없으면 실패한다.

- 연결 정보와 요청 기록은 로컬 `~/.axmap/bridge`에 저장하며 Git으로 공유하지 않는다.
- `sessions`는 등록 기록이며 살아 있는 연결이나 전송 성공을 보장하지 않는다.
- `submitted`는 전달 명령의 접수만 뜻한다. 전송 오류는 중복 실행 가능성 때문에
  `unknown`으로 남기며 자동 재시도하지 않는다.
- 요청 표시 이후의 응답과 Stop/fullyIdle 훅이 함께 있어야 `completed`로 판정한다.
  다른 사용자 입력이 끼면 `superseded`로 남긴다.
- 기존 커밋 훅·선점·권한 규칙을 변경하지 않는다.

가짜 provider 프로세스의 회귀 테스트는 인수 보존, 범위 격리, 완료 오판 방지,
중복 전송 거부, 기존 훅 보존과 Windows 실행 경로를 검증한다.
이 결과를 실제 Antigravity 연결 성공으로 소개하지 않는다.

## 다음 검증 후보

사용자가 `axmap run agy|codex`로 직접 여는 터미널을 axMap이 관리하는 코드를 추가했다.
`src/terminal-bridge.mjs`가 PTY와 인증된 로컬 파이프를 유지한다. 입력 중에는 전송을 거부하고
해당 요청의 종료 훅을 확인해 결과를 돌려준다. `--cwd`로 작업 repo를 지정할 수 있다.
일반 CLI로 이미 열린 프로세스를 나중에 임의 연결하는 기능은 구현하지 않았다.

추가 의존성은 사용자가 승인했다. npm의 `node-pty` 모듈은
`npm:@lydell/node-pty@1.1.0`으로 고정했다. 지원 플랫폼의 prebuilt 바이너리가 따라오며,
setup의 실행 사본에도 필요한 생산 의존성을 복사·로딩 검증한다. 별도 컴파일러 설치를
사용자 절차로 요구하지 않는다. [배포판 설명](https://github.com/lydell/node-pty)

실제 Windows PTY와 가짜 대화형 provider의 회귀 테스트에서 기억·프로세스 유지,
외부 입력·결과 회수, 인증, 사용자 입력 보호와 설치 사본의 로딩을 확인했다.
**이는 실제 Antigravity/Codex의 성공 증거가 아니다.** 실제 CLI 검증, 양방향 작업,
파일 수정·명령 실행, 깨끗한 npm tarball 설치 검증은 남아 있다.

Codex가 새 훅의 신뢰 검토를 요구하면 사용자가 검토해야 한다. 이를 자동으로 우회하지 않는다.
[Codex Hooks](https://developers.openai.com/codex/hooks)
Windows 홈 경로에 공백이 있는 경우의 훅 실행도 현재 제한 사항이다.
