# axMap 1.7.0

관련 작업: S15P31E109-207. 사용자 요청으로 로컬 세션 연결·파이프라인 그래프와
작업 경계 받은 편지함을 `axmap-cli`의 다음 minor 버전으로 배포한다.
기존 1.6.0의 명령·실행 요청 인터페이스를 유지한다.

## 변경 범위

- 기존 Codex 대화의 로컬 연결, active 관측과 idle 제출 확인.
- 파이프라인 그래프·loopback 읽기 전용 웹 화면·모델 턴 없는 문맥 안내.
- 일반 알림의 무호출 큐 저장, 명시적 작업 경계 묶음 회수와 선택적 단일 묶음 실행.
- 긴급 사유 분류, 만료·발신자별 갱신·멱등성·불명 전송 비재시도.

상세: [로컬 파이프라인](LOCAL-PIPELINE.md), [받은 편지함](SESSION-MAILBOX.md),
[소스 읽기 안내](LOCAL-PIPELINE-WALKTHROUGH.md).
새 받은 편지함은 `src/session-mailbox.mts`의 postMail → collectMail / flushMail 순서로 읽고,
`tools/bridge.mjs`와 `mcp/server.mjs`에서 CLI·MCP 진입을 확인한다.

## 검증과 게시 절차

전체 `npm test`와 `npm run build:check`, 기본·비교·카오스 데모의 종료 코드를 확인한다.
`npm pack`으로 만든 **같은 tarball**을 격리 prefix에 설치해 버전, bridge 도움말,
MCP 초기화와 받은 편지함 도구 목록을 검사한다. 패키지에는 `.env`·개인 설정·로컬 상태나
개발 의존성·실험 아카이브가 들어가지 않아야 한다. 런타임 의존성의 별도 설치를 사용자에게
요구하지 않는다.

검증한 tarball을 명시적인 npm 공개 registry·latest 태그로 게시하고, 원격 version·dist-tag·
integrity를 tarball과 대조한다. Git main의 릴리스 소스와 `v1.7.0` 태그를 원격에서 확인한다.
실제 실행 결과·실패·인증 장애와 검증 시점의 해시는 Jira 작업에 남긴다.

## 적용 범위와 남은 검증

MCP 클라이언트를 다시 연결해 새 도구를 발견하고 수신 에이전트 작업 루프에서 안전한
경계의 mailbox 회수를 사용해야 한다. 다른 도구의 native queue를 자동으로 변경하지 않는다.
즉시 전달 요청도 작업 중인 세션을 강제로 중단하지 않는다. busy는 deferred이며,
submitted는 완료가 아니다. 실제 턴·요금 절감량, 모든 호스트의 임베디드 화면 렌더링과
실행 중 interrupt는 이 버전의 검증 완료 주장에 포함하지 않는다.
