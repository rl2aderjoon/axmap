# 코퍼스 수집과 기준 서버

코퍼스는 공개 코드베이스의 구조와 변경 이력을 측정해 언어·규모별 분포를 만든다. 기준의 의미와 한계는 [WHY-CORPUS.md](WHY-CORPUS.md), [SSOT.md](SSOT.md)를 참고한다.

수집 명령과 옵션은 `corpus/worker.mjs` 머리말을 따른다. 출력 폴더의 `baseline.json`을 기준 서버가 읽는다.

```bash
node corpus/worker.mjs --data <출력-폴더> --hours 1
node corpus/serve.mjs --data <출력-폴더> --port 7902
```

서버는 `127.0.0.1`에만 바인딩한다. `/status`는 상태, `/baseline`은 기계가 읽는 기준이다. 웹 앱의 기본 기준 주소는 `http://127.0.0.1:7902/baseline`이고 `AXMAP_SSOT_URL`로 바꿀 수 있다.

`corpus-data/rescued-baseline-v31556.json`은 보관된 측정 스냅샷이다. 새 수집이 없을 때 사용할 수 있지만 최신 측정으로 표시하지 않는다. 수집 결과·로그·캐시는 커밋하지 않는다.
