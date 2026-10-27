# S15P31E109-207 코드 따라 읽기

기준 HEAD: `86076d98154d693b5bdb57ecc759078f1a28ef2b`. 아래 SHA256은 이 변경의 원본 전체 바이트를 고정한다. Git 공유 후 이 문서와 같은 커밋의 파일을 읽는다.

| 순서 | 원본 | 읽을 내용 | 전체 바이트 SHA256 |
|---|---|---|---|
| 1. 사용자 진입점 | [tools/pipeline.mjs:1](../tools/pipeline.mjs#L1) · 1–34행 | CLI가 terminal/web/MCP 관측 경로를 고른다. | `32b45fe5375b19f7c409f98699566269e6724dfd2cc1aea5f5a65d08c63a15dc` |
| 2. 공식 로컬 소켓 | [src/codex-connection.mts:1](../src/codex-connection.mts#L1) · 1–83행 | 기존 daemon proxy를 WebSocket으로 연결하고 프레임·응답 크기를 검사한다. | `46be8c0b7bbf0807c3e680945acefb5691be2cc2c2523148890f1ad060903405` |
| 3. 기존 대화와 요청 | [src/managed-session.mts:1](../src/managed-session.mts#L1) · 1–242행 | 원본 thread ID·idle 확인·resume·turn 완료·문맥 안내를 처리한다. | `774276e6292d3be798cd85a001feea6f80604db3c21e7cc54ec87b8483c874f6` |
| 4. 읽기 전용 화면 | [src/pipeline-web.mts:1](../src/pipeline-web.mts#L1) · 1–31행 | loopback 관측만 제공하고 외부 origin·mutation을 거절한다. | `19167c04210bba01d8f3db7fee894369a6986056cd4854e31d9b298e8a96ae7e` |
| 5. 공통 그래프 표시 | [mcp/pipeline.html:1](../mcp/pipeline.html#L1) · 1–184행 | 실제 세션·요청·누적 사용량을 표시하고 추정 진행률을 만들지 않는다. | `dcddef6de26b6d7663d3703797d3562299fb1ca9566d9a083f73ade3b89de2a4` |

실행 흐름: pipeline CLI → monitor/pipelineView → terminal renderer 또는 local web/MCP Apps. 세션 전송은 bridge → 로컬 인증 파이프 → 기존 Codex proxy → 동일 thread의 turn/start → 요청/turn ID 대조 → 결과 저장이다. 안내는 thread/inject_items로 문맥에만 기록한다.

검증은 docs/validation/local-pipeline-20261026.json과 docs/LOCAL-PIPELINE.md를 따른다. 실제 기존 대화의 맥락 유지와 계약 fixture 테스트를 구분한다. 브라우저 승인이 거절되어 실제 화면 육안 확인은 미실행이다. 원격 서비스 공개·자동 승인·공개 npm 배포는 이 변경에 포함하지 않는다.
