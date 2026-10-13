/**
 * axMap 셸 preload.
 *
 * 🔴 왜 `.cjs` 인가.
 *
 * `desktop/package.json` 이 `"type": "module"` 이라 `.js` 는 ESM 으로 읽힌다.
 * 그런데 Electron 의 **ESM preload 는 샌드박스를 꺼야만** 동작한다.
 * 샌드박스를 끄는 것보다 이 파일 하나를 CommonJS 로 두는 쪽이 훨씬 싸다.
 * 확장자를 `.js` 로 바꾸면 조용히 안 뜨므로 다음 사람이 반드시 밟는다.
 *
 * 🔴 여기서 노출하는 것은 화면이 **없어도 되는** 것뿐이다.
 *
 * `app/web/` 은 브라우저에서도 그대로 돌아야 한다(D16 의 import 단방향).
 * 따라서 이 API 에 **의존하는** 코드를 화면에 넣지 않는다.
 * 있으면 쓰고 없으면 마는 것만 여기 둔다 — 예를 들어 "다른 저장소 열기"
 * 버튼은 데스크톱에서만 보이면 되고, 브라우저에서는 없어도 그만이다.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('axmapShell', {
  isDesktop: true,
  electron: process.versions.electron,
  /** 지금 보고 있는 저장소 경로 */
  target: () => ipcRenderer.invoke('shell:target'),
  /** 폴더 고르는 창을 띄우고, 고르면 서버를 갈아끼운다 */
  openRepo: () => ipcRenderer.invoke('shell:open-repo'),
  /** 고르는 창만 띄우고 경로를 돌려준다 — 여는 것은 화면이 정한다 */
  pickFolder: () => ipcRenderer.invoke('shell:pick-folder'),
  /** 이미 받아 둔 경로로 갈아끼운다 (`/api/open` 이 돌려준 것) */
  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  /**
   * 창 단추. `frame: false` 라 제목표시줄이 없어서 화면이 직접 불러야 한다.
   * 'min' · 'max' · 'close' — 이름은 `main.mjs` 의 `shell:window` 와 짝이다.
   */
  window: (action) => ipcRenderer.invoke('shell:window', action),
})
