#!/usr/bin/env node
/**
 * 바탕화면에 실행 바로가기를 만든다. 빌드할 때마다 **같은 자리를 덮어쓴다.**
 *
 *   $ node tools/shortcut.mjs            빌드 결과(dist)를 가리킨다
 *   $ node tools/shortcut.mjs --dev      소스에서 바로 띄우는 바로가기
 *
 * 🔴 왜 이름을 버전으로 안 나누는가.
 *
 * `axMap 0.0.2.lnk` 처럼 만들면 바탕화면에 낡은 아이콘이 쌓이고, 사람은 그중
 * 아무거나 누른다. **어제 고친 버그가 살아 있는 화면**을 보면서 도구를 탓하게
 * 된다는 뜻이다. 이름을 고정하고 덮어써서 "바탕화면의 그 아이콘 = 마지막 빌드"
 * 가 항상 참이게 한다.
 *
 * 🔴 바탕화면 경로를 `%USERPROFILE%\Desktop` 으로 짐작하지 않는다.
 *
 * OneDrive 를 쓰면 바탕화면이 `...\OneDrive\바탕 화면` 으로 옮겨 가 있고, 한국어
 * 윈도우는 폴더 이름도 다르다. 짐작하면 아무도 안 보는 자리에 파일을 만들어 놓고
 * 성공했다고 말하게 된다. 윈도우에게 직접 묻는다.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEV = process.argv.includes('--dev')
const NAME = 'axMap'

if (process.platform !== 'win32') {
  console.log('바로가기 만들기는 윈도우에서만 합니다 — 건너뜁니다.')
  process.exit(0)
}

/** 윈도우가 아는 진짜 바탕화면 경로. 짐작하지 않는다. */
function desktopDir() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"],
    { encoding: 'utf8', windowsHide: true })
  const p = r.stdout?.trim()
  return p && fs.existsSync(p) ? p : null
}

/**
 * 무엇을 가리킬 것인가.
 *
 * 기본은 빌드 결과다. `--dev` 면 소스에서 띄운다 — 빌드하지 않고도 최신 코드를
 * 바로 볼 수 있어야 팀원이 매번 몇 분씩 기다리지 않는다.
 */
function target() {
  if (DEV) {
    const electron = path.join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
    if (!fs.existsSync(electron)) {
      console.error('electron 이 없습니다. desktop 에서 `npm install` 을 먼저 하세요.')
      process.exit(1)
    }
    return { exe: electron, args: `"${path.join(ROOT, 'desktop')}"`, cwd: path.join(ROOT, 'desktop') }
  }

  const dist = path.join(ROOT, 'desktop', 'dist', 'win-unpacked', `${NAME}.exe`)
  if (!fs.existsSync(dist)) {
    console.error(`빌드 결과가 없습니다: ${dist}`)
    console.error('`npm run dist` 를 먼저 돌리거나, 소스로 띄우려면 --dev 를 주세요.')
    process.exit(1)
  }
  return { exe: dist, args: '', cwd: path.dirname(dist) }
}

/**
 * 바탕화면에서 쓸 이름 — 언제나 `axMap 실행` 이다.
 *
 * 🔴 저장소가 바탕화면에 있으면 `axmap` 폴더와 `axmap` 바로가기가 나란히
 * 뜬다. 윈도우는 `.lnk` 확장자를 감추므로 **둘 다 "axmap" 으로 보인다.**
 * 실제로 그렇게 됐고, 그러면 사람은 아무거나 누른다 — 폴더를 눌러 놓고
 * "앱이 안 켜진다" 고 말하게 된다.
 *
 * 🔴 그런데 **겹칠 때만 비키게** 하면 이름이 기계마다 달라진다.
 * 저장소를 바탕화면에 둔 사람은 `axMap 실행`, 다른 데 둔 사람은 `axMap` 이
 * 생기고, 저장소를 옮기는 순간 같은 기계에서도 이름이 바뀐다. 그러면
 * README 도, 셋업 안내도, 옆자리에 하는 말("바탕화면의 axMap 실행 을 누르세요")도
 * 누군가에게는 틀린 말이 된다. 이름은 어디에 무엇이 있든 하나여야 한다.
 *
 * "실행" 을 붙여 두면 동사로 읽혀서 옆의 폴더와도 저절로 구별된다.
 */
function linkPath(dir) {
  return path.join(dir, `${NAME} 실행.lnk`)
}

const dir = desktopDir()
if (!dir) { console.error('바탕화면 경로를 찾지 못했습니다.'); process.exit(1) }

const { exe, args, cwd } = target()
const link = linkPath(dir)
const icon = path.join(ROOT, 'desktop', 'build', 'icon.ico')

/**
 * `.lnk` 는 COM(WScript.Shell)으로만 만들 수 있다. 순수 Node 로는 못 만든다.
 * `$s.Save()` 는 같은 경로가 있으면 **묻지 않고 덮어쓴다** — 우리가 원하는 동작이다.
 */
const ps = [
  '$ErrorActionPreference = "Stop"',
  '$w = New-Object -ComObject WScript.Shell',
  `$s = $w.CreateShortcut("${link}")`,
  `$s.TargetPath = "${exe}"`,
  args ? `$s.Arguments = '${args}'` : '$s.Arguments = ""',
  `$s.WorkingDirectory = "${cwd}"`,
  fs.existsSync(icon) ? `$s.IconLocation = "${icon}"` : `$s.IconLocation = "${exe},0"`,
  '$s.Description = "axMap — 코드의 변화를 사람이 이해하고 통제하는 도구"',
  '$s.Save()',
].join('; ')

const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true })
if (r.status !== 0 || !fs.existsSync(link)) {
  console.error('바로가기를 만들지 못했습니다.')
  console.error(r.stderr || r.stdout || '(출력 없음)')
  process.exit(1)
}

console.log(`바로가기 ${link}`)
console.log(`  →  ${exe}${args ? ` ${args}` : ''}`)
console.log(`  ${DEV ? '소스에서 실행 (--dev)' : '빌드 결과'} · 다음 빌드가 이 파일을 덮어씁니다`)
