#!/usr/bin/env node
/**
 * `fetchRepo` 를 **자식 프로세스에서** 돌린다.
 *
 * 🔴 왜 따로 띄우는가.
 *
 * `fetchrepo.mjs` 는 `execFileSync` 로 git 을 부른다. 그 자체는 옳다 — 클론은
 * 순서가 있는 일이고 동기 코드가 읽기 쉽다. 그런데 **서버 안에서 그대로 부르면
 * 클론이 끝날 때까지 이벤트 루프가 통째로 멈춘다.** 큰 저장소면 몇 분이다.
 *
 * 그 몇 분 동안 화면도 대화도 전부 죽는다. 그건 이 앱이 세션을 서버에 둔 이유
 * ("앱이 느려져도 작업은 계속 돈다", `app/lib/session.mjs`)와 정면으로 어긋난다.
 * 실제로 처음에 서버에서 직접 불렀다가 요청이 타임아웃으로 끊겼다.
 *
 * 그래서 무거운 일만 자식에게 넘긴다. 부모는 진행 상황만 모은다.
 *
 *   $ node app/lib/fetchrepo-run.mjs <git 주소>
 *
 * 진행 로그는 stderr 로, 결과 JSON 은 stdout 으로 낸다. 둘을 섞으면 부모가
 * 결과를 파싱하다 로그를 만나 깨진다.
 */

import { fetchRepo } from './fetchrepo.mjs'

const url = process.argv[2]
if (!url) {
  process.stdout.write(JSON.stringify({ error: '주소가 없습니다' }))
  process.exit(1)
}

try {
  const r = fetchRepo(url, { onLog: (m) => process.stderr.write(`${m}\n`) })
  process.stdout.write(JSON.stringify(r))
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e?.message ?? String(e) }))
  process.exit(1)
}
