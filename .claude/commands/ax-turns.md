---
description: axMap — 대화 모드의 자동 이어 가기 횟수 상한을 정하거나 없앤다
---

이 세션의 axMap 대화 모드 이어 가기 상한을 바꿔줘. 값: $ARGUMENTS

`ax_dialogue_mode`를 부른다. `session`은 이 대화에 안내된 axMap 세션 ID, `on`은 true다. 지금 알림 모드이면 `notify`도 true로 그대로 둔다.

- 값이 숫자 N이면 `max_turns`를 N으로 준다.
- 값이 비어 있거나 `없음`·`off`이면 `max_turns`를 주지 않는다. 상한이 없어진다.

다시 켜면 사용한 횟수가 0으로 돌아간다. 결과의 상한과 만료 시각을 한국어로 알려 줘.
응답 끝 훅으로 기다리는 일반 대화 모드는 Claude Code 자체 한도(기본 8회)에 걸릴 수 있다. 이것은 axMap 설정으로 바꾸지 않는다.
