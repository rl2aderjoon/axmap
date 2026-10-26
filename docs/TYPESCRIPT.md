# TypeScript 개발

로컬 세션 연결의 TypeScript 전환 첫 단계다. Node.js 20+의 CLI·MCP 진입점과 설치 방법은
유지한다. TypeScript와 Node 타입은 개발 의존성이며 설치한 CLI를 실행할 때 필요하지 않다.

```bash
npm ci
npm run typecheck
npm run build
npm test
```

## 작성할 파일

아래 모듈의 원본은 ESM TypeScript인 `.mts`다. 같은 이름의 `.mjs`는 빌드 결과이므로
직접 수정하지 않는다. 원본과 생성 파일을 함께 커밋한다.

| 원본 | 역할 |
|---|---|
| `src/session-types.mts` | 세션·요청·전송·대화 상태, 메시지와 사용량 공통 타입 |
| `src/bridge.mts` | 저장소별 세션 등록, 요청 전달과 완료 조회, 로컬 회신 대기 |
| `src/external-console.mts` | 기존 Windows agy 콘솔 연결과 요청 식별 |
| `src/windows-console.mts` | 네이티브 콘솔 도우미 빌드·캐시 선택 |
| `src/managed-session.mts` | 지속적인 Codex App Server·agy stream-json 연결 |
| `src/terminal-bridge.mts` | PTY·로컬 파이프와 터미널 연결 훅 |
| `src/session-status.mts` | 세션 연결·대기·승인 상태 확인 |
| `src/session-dialogue.mts` | 횟수·길이·토큰 한도가 있는 자동 중계 |
| `src/session-usage.mts` | provider별 누적 사용량 정규화와 차이 계산 |
| `src/agentcli.mts` | CLI 실행 파일 검색 |
| `src/pipeline-mcp.mts` | 공통 파이프라인 상태와 비동기 MCP 진행 알림 |
| `src/pipeline-statusline.mts` | Claude Code·agy의 기존 상태줄 연결과 복원 |
| `src/monitor.mts` | 저장소별 실행 상태 수집과 터미널 파이프라인 렌더링 |
| `src/monitor-cli.mts` | 모니터 갱신·키 입력·원래 터미널 화면 복원 |

`strict` 검사를 적용하며 외부 사용량과 응답을 `unknown`에서 확인한다. 로컬 프로토콜은
action별 메시지 타입으로 구분한다. 타입은 외부 JSON을 검증하는 수단을 대신하지 않으므로
실행 중의 UUID·인증·저장소 경계·화면·예산 검사도 유지한다.

`src/node-pty.d.ts`는 npm alias의 실제 타입 선언을 연결한다. 개발 시에만 사용하며
Windows 콘솔의 C# 도우미와 기존 생산 의존성을 바꾸지 않는다.

## 빌드와 배포

`tools/build.mjs`는 TypeScript의 CLI로 타입 검사와 컴파일을 수행하고, 전환한 모듈의
JavaScript만 기존 경로에 반영한다. 임시 컴파일 결과는 `.axmap/tsbuild`에 둔다.
타입 오류가 있으면 실행용 파일을 교체하지 않는다. 레거시 `.mjs`의 `allowJs`는 단계적
전환을 위한 경계이며 그 파일들까지 strict 검사가 완료됐다는 뜻은 아니다.

`npm run build:check`는 생성 파일이 원본과 일치하는지 검사하며 수정하지 않는다.
`npm test`는 이 검사부터 수행하므로 `.mts`만 바꾸고 빌드를 누락하면 실패한다.
`npm pack`·`npm publish`의 `prepack`은 빌드를 수행해 실행 가능한 JavaScript를 포함한다.

생성 JavaScript를 보관하는 이유는 소스 체크아웃과 팀 저장소의 벤더 사본도 빌드 도구 없이
지금의 `node bin/axmap.mjs` 및 MCP 경로로 실행할 수 있게 하기 위해서다. 전체 CLI·MCP
진입점, Git 장부·거버넌스, 기존 테스트는 아직 JavaScript이며 후속 단계에서 전환할 수 있다.

## 전환 검증 (2026-10-26)

- `npm run typecheck`와 `npm run build:check` 통과.
- `npm test`: 일반 회귀 테스트와 Windows PTY·독립 콘솔 테스트 통과.
- `npm pack`으로 만든 패키지를 별도 폴더에 `--omit=dev`로 설치하고, TypeScript와
  Node 타입 패키지가 없는 상태에서 CLI 버전·기존 agy 연결 상태 확인.
- PC의 CLI·MCP 사본에 생성 파일을 적용한 뒤, 기존 agy 프로세스를 유지하면서
  `ax_dispatch(wait_ms=30000)`의 `AXMAP_TYPESCRIPT_OK` 회신 확인.
- 타입 계약의 음성 검사와 오래된 생성 파일 거절, 타입 오류 발생 시 기존 실행 파일
  보존을 별도로 검사.
