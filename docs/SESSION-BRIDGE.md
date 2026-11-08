# 로컬 세션 연결과 자동 소통

## 1.6.0 · 로컬 지연 개선 (2026-10-26)

Windows 콘솔 연결은 프레임워크 기본 C# 컴파일러가 있으면 `tools/windows-console.cs`를
처음 한 번 컴파일하고, 소스 해시별 실행 파일을 `~/.axmap/bridge/native`에서 재사용한다.
매 조회마다 PowerShell을 시작하고 `Add-Type`으로 다시 컴파일하던 비용을 줄였다.
추가 SDK나 패키지는 설치하지 않는다. 컴파일러가 없거나 빌드에 실패하면 기존 PowerShell
경로를 사용한다. 비교·진단 시 `AXMAP_CONSOLE_HELPER=powershell`로 기존 경로를 선택한다.

전송 전 빈 입력창 확인 결과를 재사용해 중복 화면 조회도 한 번 줄였다. 실제 입력 직전의
프로세스 시작 시각·화면 일치 검사는 유지하며, 실패한 전송을 자동으로 재시도하지 않는다.

`bridge send`와 `bridge result`는 `--wait-ms 30000`을 지원한다. MCP의 `ax_dispatch`와
`ax_result`에는 같은 의미의 `wait_ms`를 추가했다. 기본값은 기존처럼 즉시 반환하는 0이며,
최대 30초 동안 로컬에서만 결과를 조회한다. 완료 즉시 반환하고, 시간이 지나면 기존 요청
UUID와 현재 상태를 돌려준다. `unknown`에는 추가 전송 없이 즉시 반환한다. 모델에게
상태 조회를 반복시키지 않아도 짧은 요청의 회신을 한 번의 도구 호출에서 받을 수 있다.
이미 실행 중인 MCP 서버는 새 도구 인수를 노출하려면 다시 로드해야 한다.

```text
ax_dispatch(to="<세션 UUID>", prompt="짧은 작업 요청", wait_ms=30000)
ax_result(id="<요청 UUID>", wait_ms=30000)
```

Windows / Node v24.18.0 / agy CLI 1.4.4, Gemini 3.8 Flash Medium의 기존 PID 24904에서
검증했다. 재시작이나 새 모델 프로세스 없이 같은 대화에서 세 요청을 순서대로 전달했다.

| 측정 | 기존 PowerShell | 네이티브 도우미 |
|---|---:|---:|
| 화면 조회 중앙값 (캐시 준비 후 각 7회) | 617.72ms | 127.49ms |
| 실제 요청 접수 (3회) | 이번 비교에서 미측정 | 344.39~402.77ms |
| 모델 응답 포함 왕복 (3회) | 이번 비교에서 미측정 | 5.31~5.78초 |

화면 조회 중앙값은 4.85배 개선됐다. 문맥 기억과 한글 왕복, 바뀐 프로세스 신원 및 화면의
전송 거절을 확인했다. 왕복 시간에는 모델 추론과 훅 실행이 포함되며 Codex 세션 간
대화와 동등한 속도를 입증한 수치는 아니다. 독립 콘솔의 사용량 측정과 자동 대화 제한은
아래 설명대로 유지된다.

PC의 CLI·MCP 실행 사본에 적용한 뒤, 새로 시작한 설치본 MCP의
`ax_dispatch(wait_ms=30000)` 한 번으로 기존 agy의 `AXMAP_INSTALLED_READY` 회신을
4.48초에 회수했다. 전체 `npm test`의 일반 회귀 테스트와 Windows PTY·독립 콘솔
검증이 통과했다. 검증 중 발견한 상태 파일의 일시적 Windows 잠금은
원자적 파일 교체만 최대 50ms 재시도하며, 계속 잠기면 기존 기록을 보존하고 실패한다.

재현 명령은 `node tools/bench-console.mjs --pid <PID> --output <기록.json>`이다.
이 명령은 현재 repo에 기존 콘솔을 연결하고 모델에 세 개의 검증 요청을 실제 전송한다.
원시 측정과 요청 UUID: [검증 기록](validation/session-latency-20261026.json).

## Windows에서 따로 실행한 agy 연결

1.5.0부터 지원한다.

일반 CMD/PowerShell에서 `agy --dangerously-skip-permissions`처럼 직접 실행한 대화창도
연결할 수 있다. axMap의 설치된 터미널 훅은 이제 관리형 환경변수가 없는 Windows agy도
부모 프로세스 PID·시작 시각·대화 UUID·작업 저장소로 자동 등록한다. 권한 옵션은 사용자가
선택한 그대로 사용한다. Named Pipe나 axMap 소유 PTY는 이 연결에 필요하지 않다.

이미 열려 있어 새 훅이 적용되지 않은 창은 **대상 저장소에서** 다음을 한 번 실행한다.

```powershell
cd C:\work\my-repo
axmap bridge attach --pid 35144
axmap bridge sessions
axmap bridge status
```

PID는 예시이며 현재 실행 중인 해당 `agy.exe`의 PID를 사용한다. attach는 현재 저장소에
명시적으로 연결하므로 실제 창의 작업 저장소에서 실행한다. `attach`가 반환한 세션 UUID를
`ax_dispatch(to, prompt)` 또는 `bridge send --to <UUID>`에 사용한다. 모델 프로세스를
새로 만들거나 기존 창을 재시작하지 않는다. 이 기능은 Windows 콘솔 API를 사용한다.

전송 직전에 PID의 시작 시각과 화면을 다시 확인하며, 마지막 입력창이 비어 있고
`? for shortcuts` 대기 표시가 있을 때만 전달한다. 입력 중·작업 중·지원하지 않는 화면은
거절한다. 여러 줄/한글은 bracketed paste로 전달한다. 화면이 바뀌면 입력하지 않으며
전송 오류는 `unknown`으로 기록하고 자동 재전송하지 않는다. CLI UI가 바뀌면 이 화면
검사를 갱신해야 할 수 있다. 전송 직후 사용자가 동시에 타이핑하는 경쟁까지 잠그지는 못한다.

결과는 고유 요청 UUID가 있는 대화 기록과 현재 콘솔의 대기 상태를 함께 확인한다.
기존 창에서 훅을 못 받으면 요청 이후 갱신된 로컬 transcript 중 해당 UUID가 유일하게
발견된 기록만 연결한다(32MiB 이하). 나중에 다른 사용자 입력이 있으면 `superseded`로
판정한다. 토큰 사용량을 측정하지 않으므로 예산을 검사하는 `ax_chat` 자동 대화는 계속
관리형 stdio 세션만 지원한다. macOS/Linux의 독립 터미널 연결은 아직 지원하지 않는다.

2026-10-21 실제 작업 저장소의 기존 PID 35144에서 재시작 없이 메시지를 보내
`AXMAP_EXTERNAL_CONSOLE_OK_35144` 응답과 `completed` 결과를 확인했다.
실제 검증 요청 UUID: `54fd993a-a61f-4c65-bcf7-b9daccdaf869`.

## 1.4.0 관리형 연결

사용자가 `axmap bridge serve codex` 또는 `axmap bridge serve agy`로 명시적으로 시작한
CLI를 로컬 인증 파이프로 연결한다. Codex는 App Server의 thread/turn, agy는 지속적인
stream-json 입력을 사용한다. 매 요청마다 프로세스를 만들거나 대화 기록 전체를 복사하지 않는다.
이미 열린 일반 TUI에 나중에 붙는 기능과는 다르며, 아래 PTY·agentapi 실험을 대신 성공으로 표시하지 않는다.

같은 Git repo의 터미널 두 곳에서 실행한다. 각 명령은 새 관리형 세션을 만들고 UUID를 표시한다.
기존 사용자 설정·인증을 사용하며 전역 훅을 추가하지 않는다. Codex는 읽기 전용 sandbox와
on-request 승인 정책을 사용한다. agy에는 권한 생략 플래그를 전달하지 않는다.

```text
axmap bridge serve codex --role "구현 검토 담당"
axmap bridge serve agy --role "리뷰 담당" --model gemini-3.8-flash-low
```

모델 이름은 `agy models`에서 현재 계정에 제공되는 것을 선택한다. 세 번째 터미널에서
`axmap bridge sessions`로 UUID를 확인하고 작업을 stdin으로 전달한다.

```powershell
'변경 검토 방법을 합의하고 합의가 끝나면 종료하세요.' | axmap bridge chat --left <Codex-UUID> --right <agy-UUID>
```

MCP에서는 `ax_sessions` → `ax_chat(left, right, prompt)` → `ax_dialogue(id)`를 사용한다.
`ax_chat`은 백그라운드 접수 ID를 반환하며 호출한 MCP 클라이언트가 기다리도록 붙잡지 않는다.
`ax_dispatch`와 `ax_result`는 한 번의 작업에도 사용할 수 있다. 세션 시작은 사용자 CLI 명령이며,
MCP 메시지를 받아 임의로 새로운 모델 프로세스를 실행하지 않는다.

### 명령으로 활성 상태 확인 (1.5.0)

같은 저장소에서 `axmap bridge status`를 실행하면 세션별 연결 여부, 시작·작업 중·대기·승인 대기·
종료 상태, 역할과 누적 처리 토큰을 표시한다. `axmap bridge status --json`은 같은 결과를 JSON으로 반환한다.
소스에서 확인할 때는 `node bin/axmap.mjs bridge status`를 사용한다.

관리형 stdio와 실험용 PTY는 인증된 로컬 파이프에 상태만 조회한다. 세션당 응답 대기는 1초이며
동시에 조회한다. 모델 실행·추가 토큰 소비나 작업 전달 없이 확인한다. 응답하지 않는 세션은
`연결 확인 불가 · 상태 미확인`으로 표시하며 마지막 기록을 현재 활성 상태나 작업 완료로 간주하지 않는다.
이전 agentapi 등록은 연결 확인을 지원하지 않아 `확인 미지원`으로 표시한다. `sessions`와 MCP의
`ax_sessions`는 기존 등록 목록 조회를 유지한다. `connected`는 로컬 호스트의 응답이며 모델 서비스의
정상 동작을 보장하지 않는다. 이 명령은 현재 저장소에 등록된 세션만 조회한다.

`bridge serve`·`run` 호스트가 종료 처리 없이 끝나면 기록이 `idle`로 남는다. 그래서 `sessions`·
`ax_sessions`·`bridge status`는 조회 때 관리형 세션의 로컬 파이프가 있는지 본다. Windows는 열린
파이프 이름 목록, 그 밖은 소켓 파일과 기록된 호스트 pid(`hostPid`)로 판단하며 연결 요청은 보내지
않는다. 파이프가 없으면 `state: closed`, `fullyIdle: false`로 기록을 고치고 `liveness: dead`를 붙인다.
확인하지 못하면(목록을 못 읽음, pid 없는 이전 기록) `liveness: unverified`이며 대기로 보고하지 않는다.

요청 전송이 로컬 파이프 연결 단계에서 ENOENT·ECONNREFUSED로 실패하면 아무것도 보내지 않았으므로
요청을 `failed`로 기록하고 다음 요청을 막지 않는다. `tools/run.mjs rpc`는 이 경우만 종료 코드 3으로
알리며, 연결 뒤의 오류와 시간 초과는 지금처럼 `unknown`이다 (D30).

Git 저장소가 아닌 작업 폴더에서 `bridge serve`를 시작해도 D30의 규칙으로 정한 저장소에 등록된다.
세션의 작업 폴더(`workspaces`)는 시작한 폴더 그대로다.

## 비용·종료·사용자 입력

- 기본 대화 한도는 최대 4회 모델 실행, 처리 토큰 50000, 메시지 2000자다. `--max-turns`,
  `--max-tokens`, `--max-message-chars` 또는 MCP 인수로 바꿀 수 있다. 상주 세션은 기본 누적
  100000 처리 토큰에서 다음 요청을 거절한다 (`serve --max-tokens`로 변경).
- 모델은 짧은 `message`와 `done` JSON을 반환한다. `done:true`는 해당 모델의 완료 보고이며
  파일 변경·테스트 성공의 독립적인 증명은 아니다. 별도 검증이 필요한 작업은 수락 조건에 명시한다.
- 대기·결과 조회·빈 큐 확인은 모델을 부르지 않는다. 현재 메시지만 상대에게 전달하고
  전체 대화·코드를 매번 붙이지 않는다. 큰 결과는 파일 경로와 요약으로 참조하도록 요청한다.
- 누적 토큰 차이와 직전 동일 세션의 실행 비용을 확인해 다음 요청을 시작한다. 첫 요청이나
  더 비싼 후속 요청은 예산을 초과할 수 있다. 엄격한 생성 토큰 상한이나 비용 보장은 아니다.
- `totalTokens`는 캐시 입력을 포함한 처리량이며 `cachedInputTokens`는 입력의 부분집합이다.
  `reasoningTokens`도 출력의 부분집합이다. agy의 별도 캐시 카운터를 정규화하고 원래
  `providerTotalTokens`도 보존한다. 모델별 가격을 섞어 금액으로 추정하지 않는다.
- 측정 불가·카운터 감소는 해당 요청의 `usage:null`로 표시하고 자동 중계를 멈춘다.
  메시지 형식·길이 오류나 전송 불명 상태도 모델에게 고쳐 달라고 반복 호출하지 않는다.
- Codex 실행 승인은 `awaiting_user`와 명령 내용을 표시한다. 사용자가
  `bridge answer --to <세션> --request <승인ID> --decision accept|decline|cancel`로 이번 요청을
  결정한다. 지원하지 않는 사용자 입력은 실패로 반환하며 권한을 자동 승인하지 않는다.
  agy headless에서 필요한 승인이 해결되지 않으면 해당 실행은 실패할 수 있다.
- `ax_chat_stop` / `bridge stop <대화ID>`는 추가 중계를 멈춘다. 이미 제출된 모델 요청은
  계속 실행될 수 있다. CLI 호스트 종료는 해당 터미널에서 Ctrl+C로 수행한다.
  `stopping` 동안 이미 보낸 요청의 결과를 기다려 사용량을 기록한다. `usagePending:true`와
  `usage:null`은 아직 전체 비용을 확인하지 못한 상태이며 `knownUsage`는 확인된 부분만 나타낸다.
- 대화 중인 세션은 다른 대화·직접 요청으로부터 예약된다. 컨트롤러가 비정상 종료해 남은
  예약은 자동으로 빼앗지 않는다. 소유 프로세스 종료를 확인한 뒤 새 관리형 세션을 시작한다.

세션·요청·대화·토큰 기록과 백그라운드 로그는 로컬 `~/.axmap/bridge`에 저장한다.
인증 토큰은 세션 공개 목록에 내보내지 않으며 Git으로 공유하지 않는다.

## 2026-10-20 Windows 실제 검증

Windows, Node.js, Codex CLI 0.163.0 및 agy 1.4.2에서 별도 임시 Git repo를 사용했다.
Node.js는 v24.14.0, 모델은 Codex `gpt-6.1-sol` 및 agy `gemini-3.8-flash-low`였다.
관리형 세션을 한 번씩 시작한 후 사용자 중간 입력 없이 요청 → 질문 → 회신 → 완료를
자동 중계했다. 처음 Codex에만 알려준 검증 코드를 Codex가 후속 실행에서 기억했고,
agy가 계산 결과와 나중에 받은 코드를 회신했다. 두 CLI의 프로세스와 대화 ID는 유지됐다.

| 검증 | 모델 실행 | 입력 | 그중 캐시 | 출력 | 총 처리 |
|---|---:|---:|---:|---:|---:|
| CLI 자동 왕복·문맥 유지 | 4 | 67461 | 33792 | 367 | 67828 |
| MCP 백그라운드 접수·회신 | 2 | 34736 | 20608 | 26 | 34762 |
| 두 검증 합계 | 6 | 102197 | 54400 | 393 | 102590 |

추론 토큰은 첫 검증 출력 중 127이며 합계에 다시 더하지 않는다. 짧은 메시지라도 CLI의
기본 지침·도구·세션 문맥이 입력 비용을 차지한다. 이 수치를 메시지 본문만의 비용이나
다른 계정·모델의 예상 비용으로 일반화하지 않는다. 제한된 대화와 불필요한 확인 응답 생략을
권장하며, 실제 사용량을 확인하고 한도를 정한다. 가짜 provider 회귀 검사는 인증·경계·누적 차이·
대기 중 추가 호출 방지·사용자 승인·한도 중단을 별도로 검사한다.

원시 토큰 카운터와 메시지별 증거: [검증 기록](validation/session-dialogue-20261020.json).

공식 프로토콜: [Codex App Server](https://learn.chatgpt.com/docs/app-server),
[agy headless / stream-json](https://www.antigravity.google/docs/cli/headless/).

## 기존 PTY·agentapi 실험 기록

아래 경로는 **개발 중인 프로토타입이며 실제 LLM을 사용한 PTY 연결 검증은 남아 있다.**
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
이 PTY 경로 자체는 일반 CLI로 이미 열린 프로세스를 나중에 연결하지 않는다.
Windows agy의 기존 창은 위의 별도 console 연결 경로를 사용한다.

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
# 일반 협업 알림과 실행 요청

일반 진행·완료 알림은 `ax_message` / `bridge message`로 무호출 큐에 보관한다.
수신자는 작업 경계에서 `ax_mailbox`로 모아 읽는다. `ax_dispatch` / `bridge send`는
명시적인 실행 턴이 필요한 작업용이다. 긴급 사유·만료·중복 방지·묶음 전송 및 강제 중단
미지원 범위는 [SESSION-MAILBOX.md](SESSION-MAILBOX.md)에 정리했다.

## 2026-11-08: 앱 세션 알림 모드 (개발 중, 실제 앱 왕복 확인)

결정은 [D33](DECISIONS.md)이다. 앱이 작업 중으로 묶이지 않고, 메시지가 오면 쉬던 대화가 깨어난다.

1. 각 세션에서 `ax_dialogue_mode(session=<내 ID>, on=true, notify=true)`를 켠다.
2. Claude 세션은 설치된 Stop 훅(`asyncRewake`)이 응답이 끝날 때마다 감시를 시작한다. 훅이 없는 환경이나 Codex끼리의 조합은 `axmap bridge listen --session <내 ID>`를 돌린다(Monitor로 돌리면 30분마다 다시 켠다).
3. 어느 쪽이든 `ax_dispatch(to=<상대 ID>, from_session=<내 ID>, prompt=...)`로 보내고 응답을 끝낸다.

제한:

- 감시나 listen이 하나도 돌지 않으면 쉬는 세션에 전달되지 않는다. Claude가 작업 중이면 그 세션의 감시가 없으므로, Codex로 보낸 요청은 Claude의 응답이 끝난 뒤 넘어간다.
- Codex 앱이 열려 있어야 `codex queue`가 바로 실행된다. 앱이 닫혀 있을 때의 동작은 확인하지 못했다.
- Claude 앱에서 사용자가 중단한 차례는 Stop 훅이 돌지 않으면 작업 중으로 남아 전달이 미뤄질 수 있다.
- 수 시간 대기한 `asyncRewake` 감시와 앱 종료 시 프로세스 정리는 확인하지 못했다. 감시는 세션 종료와 대화 모드 만료에 끝난다.

실측(2026-11-08, Windows 11, Claude 데스크톱 앱 Code 탭 + Codex 데스크톱 앱 GPT-6.1 Sol, axMap 저장소, 소스의 listen):

- Claude → 쉬는 Codex: 요청 `023d57f6…`, 접수 후 약 0.3초에 전달, 약 13초 뒤 답 `1.11.1` 기록. 회신은 Claude의 Stop 훅으로 돌아왔다.
- Codex → 쉬는 Claude: 요청 `a4c2c5e9…`. Codex가 먼저 보냈고 쉬고 있던 Claude 대화가 Monitor 알림으로 깨어나 사람 입력 없이 답했다.
- `codex queue`로 넣은 차례는 Codex 앱 화면의 같은 스레드에 나타났다.
- Stop 훅 감시(`asyncRewake`, Monitor·listen 없이, 소스의 hook-watch를 프로젝트 설정으로 연결): Codex가 보낸 요청 `767a1b18…`이 접수 0.3초 뒤 쉬던 Claude 세션을 깨웠고 약 5초 뒤 답 `watch-ok`가 기록됐다. 회신은 Claude 쪽 감시가 Codex에 넣어 Codex가 사람 입력 없이 `received`로 답했다.

## 2026-11-05: 앱 세션의 대화 모드 (개발 중, 실제 앱 왕복 확인)

Claude 앱(Code 탭)·Codex 앱, axMap 래퍼 없이 연 `codex`처럼 콘솔 창이 없는 세션은
공급자 훅이 대화 ID로 등록한다(`transport: hook`). 결정은 [D32](DECISIONS.md)다.

1. 두 앱이 같은 저장소에서 열려 있어야 한다. axMap을 쓰는 저장소이면 대화 시작(또는 첫 입력) 때
   "이 대화의 세션 ID" 한 줄이 그 대화에 들어간다. `ax_sessions`에서도 확인할 수 있다.
2. 각 앱에 "대화 모드를 켜라"고 말한다. 에이전트가 `ax_dialogue_mode(session=<내 ID>, on=true)`를
   부른다. 명령으로는 `axmap bridge mode --session <ID> --on [--minutes 30] [--max-turns 8]`.
3. 한쪽이 `ax_dispatch(to=<상대 ID>, from_session=<내 ID>, prompt=...)`로 맡기고 응답을 끝낸다.
4. 상대의 응답이 끝날 때 Stop 훅이 요청을 꺼내 같은 대화를 이어 가게 한다. 그 차례의 마지막 답이
   결과(`ax_result`)가 되고, 보낸 쪽이 대화 모드이면 보낸 쪽의 Stop 훅이 그 답을 다시 이어 가게 한다.
5. 더 맡길 일이 없으면 보내지 않는다. 그러면 양쪽 모두 기다림이 끝나고 쉰다.

제한:

- 쉬고 있는 앱은 깨우지 못한다. 기다림(최대 540초)이 끝난 세션은 사용자가 다음에 말을 걸어 응답이
  끝날 때 다시 기다린다. 상대가 540초보다 오래 걸리면 그 회신은 그때 전달된다.
- 기다리는 동안 그 앱은 작업 중으로 보이고 다른 일을 시킬 수 없다. 중지 버튼으로 끊을 수 있다.
- Stop 훅 제한 시간은 600초로 설치한다. 이미 설치한 사용자는 setup을 다시 실행해야 적용된다.
  Codex는 바뀐 훅의 신뢰 확인을 요구할 수 있으며 axMap이 이를 우회하지 않는다.
- 토큰 사용량을 측정하지 않는다. 그래서 `ax_chat` 자동 중계와 예산 한도는 이 세션에 쓰지 않는다.
- Claude Code의 연속 이어 가기 기본 한도는 8회다(`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).
- 다른 세션의 대화 모드를 켜는 것을 기술적으로 막지는 못한다. 도구 설명에서 그 세션 사용자의
  지시로만 켜도록 정했다.

검증 상태: `test/app-session.test.mjs`가 가짜 훅 입력으로 등록·접수·전달·회신·끼어들기·한도·종료를
검사한다.

실측(2026-11-05, Windows 11, Claude 데스크톱 앱 Code 탭 + Codex 데스크톱 앱 GPT-6.1 Sol,
저장소 `robotable_hj_workspace/S15P31E109`):

- Claude 앱 자기 요청: 요청 `9630b548…`이 Stop 훅으로 같은 대화에 들어왔고 답 `pong`이 결과로
  적혔다(`completed`, 전달 후 약 4초).
- Claude → Codex 앱: 요청 `a0e33900…`을 `from_session`과 함께 보냈다. Codex 앱이 Stop 훅
  `decision: block`을 받아 같은 대화에서 이어 갔고(앱에는 "훅 피드백"으로 보임) 답 `5`가 결과가
  됐다(`completed`, 전달 후 약 4초). 그 답은 Claude 앱의 다음 Stop 훅으로 Claude 대화에 돌아왔다.
- 첫 실측에서는 사람 입력 없는 2회차가 아래 첫째 문제로 거절됐다.
- 수정 후 재실측(같은 날, Codex 앱에 axMap 프로젝트를 추가해 같은 저장소에서 진행): Codex 보조 대화는
  등록되지 않았다. 1회차 `e9b35b28…`은 Codex에 한 번 말을 걸어 차례를 만든 뒤 전달됐고 답 `7`이
  Claude로 돌아왔다. 2회차 `8affad54…`은 사람 입력 없이 Claude가 회신을 받은 차례에서 보냈고,
  기다리던 Codex가 접수 0.5초 뒤 꺼내 답 `42`를 냈으며 접수부터 Claude 회신까지 약 7초였다.
- 확인 못 한 것: Claude 앱의 사용자 중단 표시, 540초 기다림이 끝난 뒤의 동작, 8회 한도 도달.

실측에서 드러난 문제와 처리:

- Claude 앱에서 작업 폴더를 옮기면 훅의 `cwd`가 이전 폴더와 새 폴더 사이를 오갔다. 세션 기록이 마지막
  훅의 저장소 하나로 덮여 다음 요청이 "현재 작업 저장소에 등록되지 않았다"로 거절됐다.
  → 앱 세션은 본 적 있는 작업 폴더·저장소를 최근 순으로 최대 8개 쌓는다.
- Codex 앱은 메시지마다 제목 생성용 보조 대화를 띄운다. 이 대화는 기록 파일(`transcript_path`) 없이
  Stop·SessionEnd도 없이 끝나 `running` 기록으로 남았다.
  → Codex는 이름에 대화 ID가 든 rollout 기록 파일이 있는 대화만 등록한다. 다른 대화의 파일이면 거절한다.
  기록 파일 없이 도는 Codex(예: 기록을 남기지 않는 실행)는 앱 세션으로 등록되지 않는다.
- 사용자가 중단한 Codex 차례는 Stop 훅이 돌지 않아 `running`으로 남았다.
  → 상태 화면은 rollout 끝의 마지막 차례 이벤트가 `turn_aborted`이면 대기로 보인다. 못 읽으면 바로잡지 않는다.
  Claude 앱의 중단은 아직 같은 처리를 하지 않았다.
- PowerShell 파이프로 `bridge send`에 넣은 본문에 BOM과 CRLF가 남았다.
  → `bridge send`·`mail`·`chat`·`notice`가 stdin 본문 앞의 BOM을 지우고 CRLF를 LF로 바꾼다.
- 쉬고 있는 앱 세션은 다음 차례가 끝나야 요청을 꺼낸다. 첫 왕복은 사람이 상대 앱에 한 번 말을 걸어야 했다.
  밖에서 앱을 깨우지 않는다는 원칙(D26)이라 바꾸지 않는다. 대화 모드를 켠 뒤 상대 앱에 한마디 걸어 기다림을 시작시킨다.

## 2026-11-02: Claude Code와 관리형 명령 큐

`axmap bridge serve claude`로 Claude Code의 지속 연결을 시작한다. Codex와 동일하게
`ax_dispatch` 또는 `axmap bridge send --to <세션 UUID>`로 서로 실행을 요청한다.
stdin으로 본문을 전달하며 대기 중이면 즉시 실행, 작업·승인 대기 중이면 FIFO에
접수한 뒤 완료 이벤트에서 자동 실행한다. `queued`와 `submitted`는 완료가 아니며
`ax_result`/`bridge result`로 결과를 확인한다. `--no-queue`는 기존 busy 거절 모드다.

위 동작은 관리형 stdio 연결에 적용된다. 이 단계에서는 임의의 Claude Code 터미널을
자동으로 연결하지 않는다. `bridge serve claude`는 독립된 대화로 시작하며 다음 요청은
그 대화와 프로세스를 유지한다. 일반 `ax_message`의 무호출 mailbox 정책은 유지한다.
큐는 최대 100개, 실행 전 예산 재검사, 종료 시 미실행 요청 failed, 불명 결과 재전송 금지다.

로컬 실물 검증: Claude Code 실행 중 두 번째 요청이 `queued`로 접수된 뒤 자동 완료했고,
첫 요청의 표식을 그대로 답해 대화 유지도 확인했다. Codex에서 Claude로 자동 왕복한
대화 `60add9ab-9186-4171-b568-35d22cae8332`도 completed로 끝났다. 이것은
이 Windows PC의 관리형 연결 검증이며 임의의 기존 터미널 연결 검증은 아니다.

### 같은 날 후속: 일반 `claude` 터미널 연결

Windows 일반 Claude Code도 전역 훅으로 자동 등록한다. 설치 후에는 평소처럼
작업 저장소에서 `claude`로 실행하면 된다. 이미 실행 중이던 세션은 새 훅을 읽도록
한 번 다시 열어야 할 수 있다. 별도 관리형 모델로 바꾸지 않으며 원래 PID·대화 ID를 유지한다.
`ax_sessions`의 provider=claude, transport=console 세션에 `ax_dispatch`로 요청한다.
입력 초안과 실행·승인 대기 중에는 큐에 보관하고 빈 입력창에서만 전달한다.
`ax_result`는 원래 대화 기록의 요청 UUID와 완료 응답을 확인한다. 비정상 전송은 재시도하지 않는다.

실물 검증: Claude Code 2.1.316을 axMap 래퍼 없이 일반 대화형 모드로 실행해
자동 등록·명령 주입·FIFO·같은 대화의 표식 기억을 확인했다. 일반 Claude가 ax_dispatch로
Codex에 요청한 왕복도 완료했다(요청 `8a6acd83-b13c-434b-961a-a6004bec956e`).
현재 Codex 세션의 MCP 도구에서 일반 Claude에 직접 요청한 결과도 확인했다
(`1e204dc4-1859-4a2c-a835-76f4c20be6dc`, 응답 `CURRENT-CODEX-PLAIN-CLAUDE-OK`).
전역 훅은 기존 설정을 보존하고 백업한다. SSH/WSL/Linux 터미널은 이 Windows 콘솔 경로의 범위 밖이다.
