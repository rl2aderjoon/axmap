import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { sendTerminal, installTerminalRuntime } from '../src/terminal-bridge.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await wait(50) }
  throw new Error('fixture did not reach expected state')
}
function bridge(cwd, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'bridge.mjs'), ...args], { cwd, env: process.env, windowsHide: true })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || out)))
    child.stdin.end(input)
  })
}

for (const provider of ['agy', 'codex']) test(`${provider}: real PTY keeps one process and memory, authenticates the pipe and returns only matching completion`, { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-pty-'))
  const saved = { AXMAP_STATE_DIR: process.env.AXMAP_STATE_DIR, AXMAP_AGY_HOME: process.env.AXMAP_AGY_HOME }
  process.env.AXMAP_STATE_DIR = path.join(dir, 'state')
  process.env.AXMAP_AGY_HOME = path.join(dir, 'agy')
  spawnSync('git', ['init', '-q'], { cwd: dir })
  const fixture = path.join(dir, 'interactive.cjs')
  fs.writeFileSync(fixture, `
    const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
    const cid='11111111-2222-4333-8444-555555555555';
    const log=path.join(process.env.AXMAP_AGY_HOME,'brain',cid,'.system_generated','logs','transcript.jsonl');
    fs.mkdirSync(path.dirname(log),{recursive:true}); fs.writeFileSync(log,'');
    const hook=${JSON.stringify(path.join(ROOT, 'tools', 'run.mjs'))};
    const provider=${JSON.stringify(provider)};
    let memory=null, pending='';
    process.stdin.setRawMode(true); process.stdin.resume(); console.log('READY');
    process.stdin.on('data', d=>{
      pending+=d.toString();
      if(!pending.includes('\\r')) return;
      const prompt=pending.slice(0,pending.indexOf('\\r')).replace(/\\x1b\\[(?:200|201)~/g,''); pending='';
      if(prompt.endsWith('EXIT')) process.exit(0);
      const found=prompt.match(/remember (\\d+)/); if(found) memory=Number(found[1]);
      if(provider==='codex') cp.spawnSync(process.execPath,[hook,'hook','UserPromptSubmit'],{input:JSON.stringify({session_id:cid,prompt}),encoding:'utf8',env:process.env});
      fs.appendFileSync(log,JSON.stringify({type:'USER_INPUT',content:prompt})+'\\n');
      const answer=found?'remembered':String(memory+19);
      fs.appendFileSync(log,JSON.stringify({source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',content:answer})+'\\n');
      const r=cp.spawnSync(process.execPath,[hook,'hook','Stop'],{input:JSON.stringify({conversationId:cid,session_id:cid,transcriptPath:log,fullyIdle:true,last_assistant_message:answer}),encoding:'utf8',env:process.env});
      console.log(r.stderr||'TURN_DONE');
    });
  `)
  let host, session, originalPid, ready = false, exitPromise
  const hostScript = path.join(dir, 'host.mjs')
  fs.writeFileSync(hostScript, `
    import {startTerminal} from ${JSON.stringify(new URL('../src/terminal-bridge.mjs', import.meta.url).href)};
    import readline from 'node:readline';
    const terminal=await startTerminal({executable:process.execPath,args:[${JSON.stringify(fixture)}],provider:${JSON.stringify(provider)},cwd:${JSON.stringify(dir)},onData:d=>{if(d.includes('READY')) console.log(JSON.stringify({ready:true}))}});
    console.log(JSON.stringify({id:terminal.id,pid:terminal.pid}));
    const rl=readline.createInterface({input:process.stdin});
    rl.on('line',line=>terminal.input(JSON.parse(line).input));
    const ev=await terminal.exited;
    rl.close(); process.exit(ev.exitCode||0);
  `)
  try {
    host = spawn(process.execPath, [hostScript], { cwd: dir, env: process.env, windowsHide: true })
    exitPromise = new Promise(resolve => host.on('exit', code => resolve(code)))
    let buffer = '', stderr = ''
    host.stderr.on('data', d => { stderr += d })
    host.stdout.on('data', d => {
      buffer += d
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), record = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1)
        if (record.ready) ready = true
        if (record.id) { session = record.id; originalPid = record.pid }
      }
    })
    await until(() => session && ready)
    await assert.rejects(sendTerminal(session, { action: 'status' }, 'bad-token'), /인증 실패/)
    host.stdin.write(JSON.stringify({ input: 'remember 731\r' }) + '\n')
    await until(async () => (await sendTerminal(session, { action: 'status' })).state === 'idle')
    const request = await bridge(dir, ['send', '--to', session], 'Use the number you remember and add 19.')
    assert.equal(request.state, 'submitted')
    const result = await until(async () => {
      const r = await bridge(dir, ['result', request.id]); return r.state === 'completed' ? r : null
    })
    assert.equal(result.result, '750')
    assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.AXMAP_STATE_DIR, 'bridge', 'sessions', `${session}.json`), 'utf8')).conversationId, '11111111-2222-4333-8444-555555555555')
    assert.ok(originalPid > 0)
    await until(async () => (await sendTerminal(session, { action: 'status' })).state === 'idle')
    host.stdin.write(JSON.stringify({ input: 'unfinished draft' }) + '\n')
    await wait(100)
    await assert.rejects(bridge(dir, ['send', '--to', session], 'must not replace user draft'), /대기 중이 아니거나 입력 중/)
    assert.equal(stderr, '')
  } finally {
    if (host) {
      host.stdin.write(JSON.stringify({ input: 'EXIT\r' }) + '\n')
      const timeout = setTimeout(() => host.kill(), 5000)
      const exitCode = await exitPromise
      clearTimeout(timeout)
      assert.equal(exitCode, 0, 'terminal host must exit cleanly')
    }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('setup copy contains usable production PTY dependencies without source node_modules', () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-pty-install-'))
  try {
    const installed = installTerminalRuntime(ROOT, dest)
    assert.ok(installed.packages.includes('node-pty'))
    const require = createRequire(path.join(dest, 'package.json'))
    assert.equal(typeof require('node-pty').spawn, 'function')
  } finally { fs.rmSync(dest, { recursive: true, force: true }) }
})
