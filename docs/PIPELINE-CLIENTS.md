# 대화 안의 파이프라인 표시

ChatGPT, Claude, agy는 같은 요청·세션 상태를 읽으며, 클라이언트가 제공하는 화면에 표시한다.
별도 모니터 창을 열 필요는 없다. 연결되지 않은 상태를 진행 중으로 꾸미거나 완료 비율을 추정하지 않는다.

| 클라이언트 | 현재 대화에서의 표시 |
|---|---|
| ChatGPT의 MCP Apps 지원 호스트 | 도구 결과 안의 파이프라인 패널 |
| Claude의 MCP Apps 지원 호스트 | 도구 결과 안의 파이프라인 패널 |
| Claude Code | 기존 상태줄에 axMap 상태를 추가하고 MCP 진행 알림 사용 |
| agy CLI | 기존 상태줄에 axMap 상태를 추가하고 MCP 진행 알림 사용 |
| UI 확장이 없는 MCP 호스트 | 텍스트 스냅샷과 지원되는 진행 알림 |

앱 패널과 CLI 상태줄은 같은 데이터를 표시하지만 렌더링 방식은 다르다. CLI 안에 HTML 패널이 생기는 것은 아니다.

## MCP 도구

- `ax_pipeline`: 스냅샷을 반환한다. 호스트가 MCP Apps를 지원하면 UI 리소스를 함께 연결한다.
- `ax_pipeline_state`: 패널이 호출하는 읽기 도구다. UI 확장을 지원하는 호스트에서만 노출한다.
- `ax_pipeline_watch`: `duration_ms` 0–25000, `interval_ms` 500–5000 범위로 상태를 관찰한다.
- `ax_dispatch`와 `ax_result`: 요청별 `wait_ms`와 표준 MCP 진행 알림을 지원한다.

클라이언트 이름으로 기능을 추측하지 않는다. 초기화 시 `io.modelcontextprotocol/ui` 확장의
`text/html;profile=mcp-app` 지원을 확인한다. 리소스는 `ui://axmap/pipeline/v1.html`이다.
기존 MCP 연결은 서버를 다시 연결해야 새 도구와 리소스를 발견한다.

패널은 `ui/initialize` 이후 호스트의 `tools/call`로 상태를 읽는다. 직접 HTTP나 WebSocket에
접속하지 않는다. 읽기가 끝난 뒤 약 1.2초 후 다시 읽고, 숨김·일시 정지·종료 시 갱신을 멈춘다.
오류가 나면 실시간 표시를 해제한다. 첫 응답의 저장소 경로를 고정해 다른 저장소로 바뀌지 않게 한다.
Pretendard 글꼴만 CDN에서 불러오며 폰트 로딩 실패 시 시스템 글꼴을 사용한다.

진행 알림은 호출자가 `_meta.progressToken`을 제공한 경우에만 보낸다. `progress`는 증가하는
관찰 순번이며 전체 작업량이나 백분율이 아니다. 결과 이후에는 알림을 보내지 않는다.
토큰 없는 watch는 기다리지 않고 스냅샷을 반환한다. 취소는 관찰 대기를 끝내며 이미 제출한
작업을 취소하거나 다시 제출하지 않는다. 제출 중에는 원자적 기록이 끝날 때까지 기다린다.
관찰 요청은 최대 네 개까지 병렬 처리하며 선점 반납이나 저장소 전환을 수행하지 않는다.

## Claude Code와 agy 상태줄

```sh
axmap pipeline install-statusline --provider claude
axmap pipeline install-statusline --provider agy
```

설치기는 설정 백업을 만들고 다른 설정과 기존 상태줄 명령을 보존한다. 기존 명령에도 원래 입력을
전달하고 출력 뒤에 axMap 상태를 붙인다. Claude 설정은 `~/.claude/settings.json`, agy 설정은
`~/.gemini/antigravity-cli/settings.json`에 둔다. agy는 기본 상태줄과 함께 표시한다.
Claude는 별도 값이 없으면 갱신 간격을 2초로 설정한다. 실제 화면 갱신 시점은 각 CLI가 결정한다.
실행 중인 agy가 설정을 다시 읽지 않는 경우 현재 대화에서 `/statusline enable`을 사용한다.

상태줄은 로컬 기록을 읽기만 한다. 모델 호출, 세션 탐색, 작업 전달을 하지 않는다.
agy가 제공하는 작업 중·대기·승인 대기 상태와 axMap 요청 단계를 함께 표시한다.
최근 완료 기록은 현재 작업과 혼동하지 않도록 최근 요청으로 표시한다.
Windows 설치 경로에 지원하지 않는 공백·특수문자가 있으면 설정을 덮어쓰지 않고 실패한다.

```sh
axmap pipeline uninstall-statusline --provider claude
axmap pipeline uninstall-statusline --provider agy
```

제거는 axMap이 설치한 명령일 때만 이전 상태줄을 복원한다. 설치 후 사용자가 바꾼 명령은 유지한다.

## 검증 범위

공통 MCP 계약, UI 기능 협상, 패널 메시지·갱신·숨김·오류 처리, 기존 상태줄 보존·복원,
진행 알림과 취소 중 중복 제출 방지를 자동 테스트한다. 클라이언트별 계약 테스트는 실제 제품 화면
검증과 구별한다. 실제 ChatGPT·Claude 앱의 임베디드 화면 검증은 아직 수행하지 않았다.
이 Codex 세션에서도 새 `ax_pipeline` 도구가 노출되지 않았다. 세션 재시작만으로 패널 표시를
보장하지 않으며, 실제 MCP 서버 경로·재연결·호스트의 UI 확장 지원을 함께 확인해야 한다.

이 PC의 기존 agy 프로세스에서 상태줄을 활성화하고, 요청
`c6f71ecc-6c15-4754-a0b9-bf9f2ece7f50`의 전달·진행 알림·`AXMAP_INLINE_CLIENTS_OK` 응답과
완료 상태줄을 확인했다. 이때 원래 모델 프로세스는 유지했다.

현재 서버는 로컬 stdio 방식이다. ChatGPT 웹에서 쓰는 인증된 원격 MCP 연결과 배포는 별도로
필요하며, 이번 변경은 공개 포트를 열거나 원격 엔드포인트를 배포하지 않는다.

표준과 클라이언트 근거:

- [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)
- [ChatGPT UI](https://developers.openai.com/plugins/build/chatgpt-ui)
- [Claude interactive connectors](https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude)
- [Claude Code statusline](https://code.claude.com/docs/en/statusline)
- [agy statusline](https://www.antigravity.google/docs/cli/statusline/)
- [MCP progress](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress)
