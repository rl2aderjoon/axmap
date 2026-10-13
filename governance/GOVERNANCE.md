# axMap 거버넌스 도구

`src/governance.mjs`가 정책·투표·기여 이력으로 판정하고, `governance/gate.mjs`가 git에서 재료를 모아 게이트를 실행한다. `governance/vote.mjs`는 git에 투표를 기록한다.

이 기능은 axMap의 협업 기능이며 특정 서비스의 소스나 배포 설정은 포함하지 않는다. 규격은 [SPEC.md](../docs/SPEC.md), 불변식은 [INVARIANTS.md](../docs/INVARIANTS.md), 설계 이유는 [DECISIONS.md](../docs/DECISIONS.md)를 참고한다.

```bash
node governance/gate.mjs --help
node governance/vote.mjs --help
```

CI와 병합 제한은 사용하는 저장소가 설정한다. GitHub로 소스를 옮기는 것만으로 이전 GitLab의 병합 정책·승인·CI 설정이 적용되지는 않는다. 게이트를 적용하려면 해당 호스팅 환경에서 필수 검사를 구성하고 실패 시 병합이 거부되는지 확인한다.

배포 예제는 `policy.example.json`이다. 사용하려는 저장소의 `governance/policy.json`으로 복사한 뒤 예제의 `example.com` 투표자를 실제 기여자와 정책으로 바꾼다. 예제 자체는 활성 정책이 아니다.
