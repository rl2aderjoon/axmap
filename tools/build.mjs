#!/usr/bin/env node
/** TS owns migrated modules; checked-in JS keeps Node 20 source checkouts and npm installs usable without a build step. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const root = fileURLToPath(new URL('../', import.meta.url))
const check = process.argv.includes('--check')
// The stable CLI also works with TS 7's native compiler, without an unstable API.
const compiler = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')
const compiled = spawnSync(process.execPath, [compiler, '--project', path.join(root, 'tsconfig.json'), '--pretty', 'false'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
})
if (compiled.error) throw compiled.error
if (compiled.status !== 0) process.exit(compiled.status ?? 1)
const outputs = []
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const source = path.join(directory, entry.name)
    if (entry.isDirectory()) { collect(source); continue }
    if (!entry.name.endsWith('.mts')) continue
    const relative = path.relative(root, source).replaceAll(path.sep, '/')
    const text = fs.readFileSync(path.join(root, '.axmap', 'tsbuild', relative.replace(/\.mts$/, '.mjs')), 'utf8')
    outputs.push({ target: source.replace(/\.mts$/, '.mjs'),
      content: `// Generated from ${relative}. Edit the .mts source and run npm run build.\n${text}` })
  }
}
collect(path.join(root, 'src'))
if (!outputs.length) throw new Error('TypeScript emitted no migrated modules.')
let stale = false
for (const { target, content } of outputs) {
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n') === content.replaceAll('\r\n', '\n')) continue
  if (check) { console.error(`Stale generated JavaScript: ${path.relative(root, target)} (run npm run build)`); stale = true }
  else fs.writeFileSync(target, content)
}
if (stale) process.exit(1)
console.log(`${check ? 'Checked' : 'Built'} ${outputs.length} TypeScript modules.`)
