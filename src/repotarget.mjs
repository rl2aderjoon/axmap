/**
 * 지금 사람이 보고 있는 저장소가 어디인지를 **프로세스 사이에 전달하는 한 칸.**
 *
 * ── 왜 파일 한 개인가 ────────────────────────────────────────────────────────
 *
 * 데스크톱 앱에서 [폴더 열기] 를 누르면 뷰어는 **프로세스를 갈아끼워서** 대상을
 * 바꾼다(`desktop/main.mjs` 의 `pickAndReopen`). MCP 서버에는 그 수법이 안 통한다 —
 * **MCP 서버를 띄운 것은 우리가 아니라 AI CLI** 이고, 남의 자식 프로세스는
 * 우리가 재시작시킬 수 없다. 그래서 MCP 쪽은 "교체" 가 아니라 "따라가기" 로 푼다:
 * 앱이 여기에 쓰고, MCP 서버가 도구를 부를 때마다 여기를 읽는다.
 *
 * 🔴 이것은 **사람에게 묻는 장치가 아니다.** stdio MCP 서버는 stdout 이 JSON-RPC
 *    전용이라 "저장소를 고르세요" 를 띄울 화면 자체가 없다(거기에 사람이 읽을 글을
 *    쓰면 클라이언트가 파싱에 실패해 서버가 죽는다). 사람의 입력은 앱에서 폴더를
 *    고르는 그 한 번뿐이고, 그 뒤는 이 파일을 다시 읽는 것으로 끝난다.
 *
 * ── 왜 홈 디렉터리인가 ──────────────────────────────────────────────────────
 *
 * 앱은 이미 `app.getPath('userData')` 에 상태를 적지만 그건 **Electron 전용 API** 라
 * 순수 node 로 도는 MCP 서버가 같은 경로를 계산할 방법이 없다. 두 프로세스가 **둘 다
 * 계산할 수 있는 자리**여야 하므로 홈 디렉터리를 쓴다.
 *
 * 저장소 안에 두지 않는 이유: 이 값은 *"지금 이 PC 의 이 사람이 무엇을 보고 있나"* 라
 * 커밋되면 안 된다. 팀원마다 다르고 어제와 오늘이 다르다.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 상태를 두는 폴더.
 *
 * `AXMAP_STATE_DIR` 은 **시험과 이동식 설치를 위한 것**이다. 테스트가 진짜 홈
 * 디렉터리를 건드리면 그 PC 를 쓰는 사람의 실제 대상이 바뀌어 버린다 — 테스트가
 * 사람의 작업 환경을 고치는 것은 어떤 이유로도 정당하지 않다.
 */
export const stateDir = () =>
  process.env.AXMAP_STATE_DIR ? path.resolve(process.env.AXMAP_STATE_DIR) : path.join(os.homedir(), '.axmap')

export const targetFile = () => path.join(stateDir(), 'current.json')

/**
 * 사람이 마지막으로 고른 저장소. 없으면 `null`.
 *
 * 🔴 **폴더가 실제로 있는지 확인하고 낸다.** 지워지거나 옮겨진 경로를 그대로 내면
 *    그 뒤 모든 claim 이 존재하지 않는 저장소를 겨누고, 아무 오류 없이 조용히
 *    아무 일도 일어나지 않는다. 확신 있게 틀린 답이라 없는 답보다 나쁘다.
 *
 * 🔴 **던지지 않는다.** 이 함수는 도구를 부를 때마다 불린다. 여기서 예외가 나가면
 *    상태 파일 하나 때문에 MCP 전체가 죽는다. 못 읽으면 "고른 적 없음" 으로 답하고
 *    부르는 쪽의 다음 순위(git 루트)로 떨어지게 둔다.
 */
export function readTarget() {
  try {
    const raw = fs.readFileSync(targetFile(), 'utf8')
    const dir = JSON.parse(raw)?.target
    if (typeof dir !== 'string' || !dir.trim()) return null
    const abs = path.resolve(dir)
    return fs.statSync(abs).isDirectory() ? abs : null
  } catch {
    return null
  }
}

/**
 * 사람이 고른 저장소를 적는다. 성공했으면 `true`.
 *
 * 실패해도 던지지 않는다 — 이걸 부르는 곳은 앱의 폴더 열기이고, 상태를 못 적었다고
 * 해서 **폴더 열기 자체가 실패해야 할 이유는 없다.** 뷰어는 그대로 열리고
 * MCP 만 따라오지 못한다. 기능이 하나 줄어드는 것과 창이 안 열리는 것은 다르다.
 */
export function writeTarget(dir) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true })
    fs.writeFileSync(targetFile(), JSON.stringify({ target: path.resolve(dir) }, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}
