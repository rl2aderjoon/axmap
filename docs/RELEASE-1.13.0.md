# axMap 1.13.0

Windows에서 알림 모드의 Codex 앱 전달이 `spawnSync codex ENOENT`로 실패하는 문제를 고친다.

## 변경

- 대화 모드의 자동 이어 가기 횟수는 기본 상한이 없다. 시간 만료는 유지한다. Claude는 `/ax-turns 숫자`, Codex는 `$ax-turns 숫자`로 상한을 걸고, 값 없이 부르면 상한을 없앤다. 응답 끝 훅으로 기다리는 일반 모드는 Claude Code 자체 한도에 여전히 걸린다.

- npm으로 설치한 Codex는 Windows에서 셸용 `codex`·`codex.cmd`만 PATH에 있어, 셸 없이 실행하면 `ENOENT`·`EINVAL`로 실패했다.
- `codex queue`를 PATH에서 찾은 npm 패키지의 `codex.js`로 Node가 직접 실행한다. 메시지가 셸을 거치지 않는 조건은 그대로다.
- `AXMAP_CODEX_BIN`을 지정하면 그 값을 먼저 쓴다. npm 설치본을 찾지 못하면 이전처럼 `codex`를 실행한다.

## 검증과 적용 범위

2026-11-09 Windows 11에서 실제 Claude 데스크톱 앱과 Codex 데스크톱 앱 사이에서 Claude → Codex 전달과 회신을 확인했다. 이때는 설치본에 같은 변경을 적용해 실행했다.
Codex를 npm이 아닌 방식으로만 설치한 Windows 환경의 전달은 실측하지 않았다.

설치 후 `axmap setup`을 실행하고 세션을 새로 열어 적용한다.
