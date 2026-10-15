import { test } from 'node:test'
import assert from 'node:assert/strict'
import { doCodex } from '../tools/mcp-register.mjs'

function client(initial = [], broken = false) {
  let servers = structuredClone(initial)
  const calls = []
  const run = (args) => {
    calls.push(args)
    if (args[1] === '--help') return { status: 0, stdout: 'get list add remove', stderr: '' }
    if (args[1] === 'list') return { status: 0, stdout: broken ? 'unreadable' : JSON.stringify(servers) }
    if (args[1] === 'add') {
      const env = {}
      for (let i = 3; i < args.indexOf('--'); i += 2) {
        const value = args[i + 1], eq = value.indexOf('=')
        env[value.slice(0, eq)] = value.slice(eq + 1)
      }
      const end = args.indexOf('--')
      servers = servers.filter((s) => s.name !== 'axmap')
      servers.push({ name: 'axmap', enabled: true, transport: { type: 'stdio', command: args[end + 1], args: args.slice(end + 2), env, cwd: null } })
      return { status: 0, stdout: 'added' }
    }
    throw new Error(`Unexpected command: ${args}`)
  }
  return { run, calls, servers: () => servers }
}

test('registration repairs an obsolete path and repo pin, preserving personal env and other servers', () => {
  const other = { name: 'other', transport: { type: 'stdio', command: 'custom' } }
  const c = client([other, { name: 'axmap', enabled: true, transport: { type: 'stdio', command: 'node', args: ['/old/server.mjs'], cwd: '/201', env: { AXMAP_REPO: '/201', AXMAP_AGENT: 'personal', CUSTOM: 'kept=value' } } }])
  assert.equal(doCodex('unused', { run: c.run }), true)
  const saved = c.servers().find((s) => s.name === 'axmap')
  assert.equal(saved.transport.cwd, null)
  assert.equal(Object.hasOwn(saved.transport.env, 'AXMAP_REPO'), false)
  assert.equal(saved.transport.env.AXMAP_AGENT, 'personal')
  assert.equal(saved.transport.env.CUSTOM, 'kept=value')
  assert.notEqual(saved.transport.args[0], '/old/server.mjs')
  assert.deepEqual(c.servers().find((s) => s.name === 'other'), other)
  assert.equal(doCodex('unused', { run: c.run }), true)
  assert.equal(c.calls.filter((a) => a[1] === 'add').length, 1, 'current registration should be idempotent')
})

test('unreadable configuration is not overwritten', () => {
  const c = client([], true)
  assert.equal(doCodex('unused', { run: c.run }), false)
  assert.equal(c.calls.some((a) => a[1] === 'add'), false)
})

test('dry-run does not modify registrations', () => {
  const c = client()
  assert.equal(doCodex('unused', { run: c.run, dry: true }), true)
  assert.equal(c.calls.some((a) => a[1] === 'add'), false)
})
