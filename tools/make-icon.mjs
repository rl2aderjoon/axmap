#!/usr/bin/env node
/**
 * 앱 아이콘(`desktop/build/icon.ico`)을 코드로 그린다.
 *
 * 🔴 왜 그림 파일을 안 싣는가.
 *
 * 저장소에 바이너리를 넣지 않으면 리뷰에서 내용이 보이고, 크기나 색을 고치는 데
 * 이미지 편집기가 필요 없다. 모양도 이 앱의 은유 그대로다 — 가운데 시작점과
 * 그것을 두르는 궤도(`graph.js` 의 `SHELL_GAP` 이 그리는 고리).
 * 트레이 아이콘(`desktop/main.mjs` 의 `trayIcon`)과 같은 도형이다.
 *
 * 🔴 ICO 포맷에서 두 번 밟는 곳.
 *
 *   ① 픽셀은 **BGRA** 이고 행은 **아래에서 위로** 쌓인다. RGBA 로 채우면 빨강과
 *      파랑이 바뀌고, 위에서 아래로 쌓으면 상하가 뒤집힌 채 조용히 뜬다
 *   ② 헤더의 `biHeight` 는 **높이의 두 배**다. XOR 비트맵과 AND 마스크를 함께
 *      담기 때문이다. 32비트라 마스크는 안 쓰지만 **자리는 반드시 있어야** 한다
 *
 *   $ node tools/make-icon.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'desktop', 'build', 'icon.ico')

/** 여러 크기를 담는다. 작업 표시줄은 작은 것을, 바탕화면은 큰 것을 고른다. */
const SIZES = [16, 32, 48, 64, 128, 256]

/** shell.css 의 `--accent` 와 같은 값. 한쪽만 고치면 아이콘과 화면이 어긋난다. */
const INK = [217, 119, 87]

/** 반지름 `at` 에 두께 `half` 로 부드러운 획을 놓는다. */
const band = (d, at, half) => Math.max(0, Math.min(1, 1 - Math.abs(d - at) / half))

/** 한 크기의 XOR 비트맵(BGRA · 아래에서 위로). */
function pixels(s) {
  const buf = Buffer.alloc(s * s * 4)
  const c = (s - 1) / 2
  const ring = s * 0.36
  const stroke = Math.max(1, s * 0.055)
  const dot = Math.max(0.8, s * 0.055)

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const d = Math.hypot(x - c, y - c)
      const a = Math.min(1, band(d, ring, stroke) + band(d, 0, dot))
      if (a <= 0.004) continue
      // 아래에서 위로 쌓는다 — 안 그러면 상하가 뒤집힌 채 조용히 뜬다
      const i = ((s - 1 - y) * s + x) * 4
      buf[i] = INK[2]      // B
      buf[i + 1] = INK[1]  // G
      buf[i + 2] = INK[0]  // R
      buf[i + 3] = Math.round(255 * a)
    }
  }
  return buf
}

/** BITMAPINFOHEADER + XOR + AND 마스크. */
function image(s) {
  const head = Buffer.alloc(40)
  head.writeUInt32LE(40, 0)      // biSize
  head.writeInt32LE(s, 4)        // biWidth
  head.writeInt32LE(s * 2, 8)    // 🔴 biHeight — XOR 과 AND 를 합친 높이다
  head.writeUInt16LE(1, 12)      // biPlanes
  head.writeUInt16LE(32, 14)     // biBitCount
  head.writeUInt32LE(0, 16)      // biCompression = BI_RGB

  // 32비트는 알파를 쓰므로 마스크는 0(불투명)으로 두되 자리는 있어야 한다.
  const maskRow = Math.ceil(s / 32) * 4
  const mask = Buffer.alloc(maskRow * s)

  return Buffer.concat([head, pixels(s), mask])
}

function ico(sizes) {
  const imgs = sizes.map(image)
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0)              // reserved
  dir.writeUInt16LE(1, 2)              // type = icon
  dir.writeUInt16LE(sizes.length, 4)

  let offset = 6 + sizes.length * 16
  const entries = sizes.map((s, i) => {
    const e = Buffer.alloc(16)
    // 256 은 0 으로 적는다 — 한 바이트에 안 들어간다
    e.writeUInt8(s >= 256 ? 0 : s, 0)
    e.writeUInt8(s >= 256 ? 0 : s, 1)
    e.writeUInt8(0, 2)                 // 팔레트 없음
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)              // planes
    e.writeUInt16LE(32, 6)             // bitCount
    e.writeUInt32LE(imgs[i].length, 8)
    e.writeUInt32LE(offset, 12)
    offset += imgs[i].length
    return e
  })

  return Buffer.concat([dir, ...entries, ...imgs])
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
const buf = ico(SIZES)
fs.writeFileSync(OUT, buf)
console.log(`아이콘 ${path.relative(ROOT, OUT)} · ${SIZES.join('·')}px · ${buf.length.toLocaleString()} bytes`)
