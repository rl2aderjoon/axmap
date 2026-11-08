# axMap 1.12.0

쉬고 있는 Claude 앱·Codex 앱 세션이 메시지가 오면 깨어나 서로 주고받는 알림 모드(D33)를 더한다.
기존 대화 모드(D32)와 선점·쪽지·관리형 연결 인터페이스를 유지한다.

## 변경

- `ax_dialogue_mode(notify=true)`(명령: `axmap bridge mode --notify`)로 세션마다 켠다. 기본 60분·20회가 상한이다.
- setup이 Claude Stop 훅에 `asyncRewake` 감시(`hook-watch`)를 더한다. 메시지가 오면 쉬던 대화가 깨어난다.
- 알림 모드의 Codex 앱 세션에는 `codex queue`로 넣고, 차례의 끝과 답은 rollout 기록으로 판정한다.
- 훅이 없는 환경을 위해 `axmap bridge listen`을 둔다.
- `codex queue` 실패는 `unknown`으로 적고 재전송하지 않는다.

## 검증과 배포

`npm test`, `npm run build:check`, 기본·비교·카오스 데모의 종료 코드로 검증한다.
`npm pack`의 tarball을 격리된 사용자 환경에 설치하고 `axmap setup`을 실행해 훅 등록을 확인한다.

## 적용 범위

2026-11-08 Windows 11에서 실제 Claude 데스크톱 앱과 Codex 데스크톱 앱 사이의 왕복을 확인했다.
이때 감시는 이 저장소의 소스를 프로젝트 설정으로 연결해 실행했다. 세부 기록은 [SESSION-BRIDGE.md](SESSION-BRIDGE.md)에 있다.
수 시간 대기한 감시, 앱 종료 시 프로세스 정리, Codex 앱이 닫혀 있을 때의 전달은 실측하지 않았다.
앱 세션의 토큰 사용량은 계측하지 않는다. 메시지마다 받는 쪽의 일반 차례 하나만큼 토큰을 쓴다.

설치 후 `axmap setup`을 실행하고 세션을 새로 열어 훅을 적용한다.
