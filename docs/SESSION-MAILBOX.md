# 작업 경계에서 협업 메시지 처리

일반 협업 메시지는 실행 요청과 구분한다. 진행·완료·계약 확인마다 수신자의 모델 턴을
시작하지 않고 로컬 받은 편지함에 저장한다. 수신자는 테스트 완료·실험 한 회 종료 등
안전한 작업 경계에서 한 번에 회수하고 필요한 결정만 처리한다.
등록된 로컬 세션 사이에 적용되며 Git 버스·Codex native queue를 가로채지는 않는다.

## 전달 종류

| 종류 | 사용 상황 | 동작 |
| --- | --- | --- |
| `boundary` (기본) | 진행·결과·계약 확인·참고 자료 | 로컬 저장만. 모델 호출·새 턴 없음 |
| `immediate` | `stop`: 중단 요청, `data-loss`: 데이터 손상 위험, `work-invalidated`: 현재 작업을 무효화하는 변경 | 대기 중인 수신자에 즉시 단일 요청 시도 |

긴급 여부는 발신자가 명시한다. 본문을 LLM으로 분류하거나 단어만으로 긴급도를 올리지 않는다.
메시지는 `source: agent`이며 새로운 사람 지시나 권한 부여가 아니다.
최신 실제 사람 지시가 우선한다. 단순 정보 알림에는 ACK를 보내지 않는다.

## CLI와 MCP

```sh
# 본문은 stdin. 실제 목록의 수신 UUID를 사용한다.
axmap bridge message --to <UUID> --topic run-1-progress --key run-1-complete
axmap bridge message --to <UUID> --priority immediate --reason stop --key stop-1

# 기본 조회는 소비하지 않는다. --take는 회수 표시이며 실행 완료가 아니다.
axmap bridge mailbox --to <UUID>
axmap bridge mailbox --to <UUID> --take --at experiment-complete
axmap bridge mailbox --to <UUID> --all

# 꼭 상대 턴을 시작해야 할 때만 명시적으로 한 묶음을 전달한다.
axmap bridge flush --to <UUID> --at checkpoint
```

MCP는 `ax_message(to,text,priority?,reason?,topic?,key?,ttl_seconds?)`,
`ax_mailbox(to,take?,at?,all?)`, `ax_mailbox_flush(to,at)`를 제공한다.
`at`은 `task-complete`, `test-complete`, `experiment-complete`, `checkpoint` 중 하나다.
수신자가 자기 작업 경계에서 `ax_mailbox(take=true)`를 호출하는 흐름을 우선한다.
이를 실제로 호출하도록 에이전트 작업 루프에서 연결해야 한다. OS idle이나 임의의 턴 완료가
업무상 안전한 경계라는 추정으로 자동 flush하지 않는다. 백그라운드 폴러도 만들지 않는다.

기존 `bridge send`/`ax_dispatch`는 실행용 저수준 인터페이스로 유지한다.
자동 대화·기존 호출의 호환성을 보존하며 일반 협업 알림에는 사용하지 않는다.

## 중복·지연·손실 처리

- 기본 유효기간은 접수 후 1시간, `ttl-seconds`는 1~86400초다. 만료된 대기 메시지는
  실행 대상에서 제외하되 이력은 보존한다. 외부 큐에서 오기 전 지연은 이 TTL로 감지하지 못한다.
- `key`는 저장소·수신자·발신자별 멱등 키다. 같은 내용 재접수는 원래 영수증을 반환하고
  만료 시각을 갱신하거나 긴급 전달을 다시 시도하지 않는다. 다른 내용은 거절한다.
- 명시적인 `topic`이 같고 **발신자도 같은 대기 중 일반 알림**만 최신 것으로 대체한다.
  다른 발신자, 긴급 메시지, 회수·전달한 기록은 합치지 않는다. 대체된 원본과 연결을 보존한다.
- 한 회수는 최대 100건·직렬화 본문 약 32KiB, 한 전송은 최대 100건·전체 32768바이트다.
  남은 메시지는 큐에 둔다. 대기 메시지 1000건 이후는 명시적으로 거절한다.
- 조회·회수는 모델을 호출하지 않는다. flush는 비어 있으면 아무것도 실행하지 않고,
  묶음을 하나의 요청으로 전달한다. `submitted`는 실행·처리 완료 증명이 아니다.
- busy/idle 미확인 세션은 `deferred`로 남기고 새 턴을 시작하지 않는다. 긴급도 예외가 아니다.
  **현재 provider 연결에서는 실행 중 작업의 강제 interrupt/steer를 구현하지 않았다.**
  긴급 즉시 전송이 불가능했다는 결과는 CLI 종료 코드 2/MCP 오류로 알린다.
- 전송 의도를 파일에 먼저 기록한다. 전송불명 또는 도중 프로세스 종료의 `sending` 묶음은
  재전송하지 않는다. `ax_mailbox`의 `unresolvedBatches`, 원래 request ID와 `ax_result`로
  조사한다. 자동 재시도·자동 복구는 없으며 수동 확인 없이 잠금/기록을 지우지 않는다.
- 확실히 전달되지 않은 묶음(파이프 연결 실패, 보내기 전 거절)은 `failed`로 남기고 쪽지를
  `queued`로 되돌린다. 응답의 `requeued`가 되돌린 수다. 다음 작업 경계의 flush가 다시 보낸다.

받은 편지함은 `AXMAP_STATE_DIR` 또는 `~/.axmap` 아래 `bridge/mailboxes/<UUID>.json`이다.
수신자별 프로세스 간 잠금과 원자적 파일 교체로 기록을 보존한다. 같은 Git 저장소의 linked
worktree는 같은 repo key를 쓴다. 읽지 못한 파일을 빈 큐로 초기화하지 않는다.

## 검증 범위

`test/session-mailbox.test.mjs`는 격리 Git 저장소·가짜 agentapi 프로세스로 모델 호출 없는
회수, 묶음 전송, 긴급/일반 분리, 발신자별 대체, 만료, 멱등성, 전송불명·중단 후 비재전송,
payload 제한과 실제 자식 프로세스 동시 접수를 검사한다. 실제 Codex/agy의 interrupt,
턴 절감량이나 유료 사용량을 측정한 결과로 해석하지 않는다.
