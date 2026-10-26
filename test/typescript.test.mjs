import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const repo = fileURLToPath(new URL('../', import.meta.url))
const compiler = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')
const parent = path.join(repo, '.axmap')
function fixture(run) {
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'ts-fixture-'))
  try { run(root) }
  finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(parent)) throw new Error('Fixture cleanup escaped its parent')
    fs.rmSync(root, { recursive: true, force: true })
  }
}
const node = (args, cwd) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 })

test('strict session contracts reject invalid states, incomplete messages and unchecked nullable usage', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'contracts.mts'), `
    import type { Provider, SessionState, LocalMessage, Usage } from '../../src/session-types.mjs'
    import { normalizeUsage } from '../../src/session-usage.mjs'
    const provider: Provider = 'agy'
    const state: SessionState = 'awaiting_user'
    const message: LocalMessage = { action: 'result', id: 'request-id' }
    const usage = normalizeUsage(provider, { input_tokens: 1 })
    if (usage) { const total: number = usage.totalTokens }
    // @ts-expect-error Unsupported providers must not enter a local session.
    const badProvider: Provider = 'other'
    // @ts-expect-error Completion is a request state, not a session state.
    const badState: SessionState = 'completed'
    // @ts-expect-error Submission requires an actual request.
    const badMessage: LocalMessage = { action: 'submit' }
    // @ts-expect-error Unknown usage must be checked before accessing its fields.
    const badTotal: number = usage.totalTokens
    // @ts-expect-error A total alone cannot stand in for measured usage.
    const badUsage: Usage = { totalTokens: 0 }
  `)
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.json', include: [], files: ['contracts.mts'] }))
  const result = node([compiler, '--project', path.join(root, 'tsconfig.json'), '--noEmit', '--pretty', 'false'], root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
}))

test('build checks detect stale JavaScript and type errors never replace runnable artifacts', () => fixture(root => {
  fs.mkdirSync(path.join(root, 'tools'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.copyFileSync(path.join(repo, 'tools', 'build.mjs'), path.join(root, 'tools', 'build.mjs'))
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', strict: true, noEmitOnError: true, rootDir: '.', outDir: '.axmap/tsbuild', types: [],
  }, include: ['src/**/*.mts'] }))
  const source = path.join(root, 'src', 'state.mts'), generated = path.join(root, 'src', 'state.mjs')
  fs.writeFileSync(source, "export const state: 'idle' | 'running' = 'idle'\n")
  let result = node(['tools/build.mjs'], root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(fs.readFileSync(generated, 'utf8'), /Generated from src\/state.mts/)
  result = node(['tools/build.mjs', '--check'], root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  fs.writeFileSync(generated, '// stale runnable artifact\n')
  result = node(['tools/build.mjs', '--check'], root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Stale generated JavaScript/)
  assert.equal(fs.readFileSync(generated, 'utf8'), '// stale runnable artifact\n')
  fs.writeFileSync(source, "export const state: 'idle' | 'running' = 'invalid'\n")
  result = node(['tools/build.mjs'], root)
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /TS2322/)
  assert.equal(fs.readFileSync(generated, 'utf8'), '// stale runnable artifact\n')
}))
