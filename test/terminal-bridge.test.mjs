import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { sendTerminal, installTerminalRuntime } from '../src/terminal-bridge.mjs'
import { attachConsole, consoleCall } from '../src/external-console.mjs'
import { dispatchRequest, requestResult, sessions, bridgeHome, readJSON, writeJSON } from '../src/bridge.mjs'
import { sessionStatus } from '../src/session-status.mjs'

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
  let host, session, originalPid, ready = false, exitPromise, stderr = ''
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
    let buffer = ''
    host.stdin.on('error', () => {})
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
  } catch (e) {
    let status
    try {
      const s = JSON.parse(fs.readFileSync(path.join(process.env.AXMAP_STATE_DIR, 'bridge', 'sessions', `${session}.json`), 'utf8'))
      status = { state: s.state, event: s.event, fullyIdle: s.fullyIdle }
    } catch { status = { ready, session } }
    throw new Error(`${e.message}\n${JSON.stringify(status)}\n${stderr}`, { cause: e })
  } finally {
    if (host) {
      if (host.exitCode === null && host.signalCode === null && !host.stdin.destroyed) host.stdin.write(JSON.stringify({ input: 'EXIT\r' }) + '\n')
      const timeout = setTimeout(() => host.kill(), 5000)
      const exitCode = await exitPromise
      clearTimeout(timeout)
      assert.equal(exitCode, 0, `terminal host must exit cleanly: ${stderr}`)
    }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
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

test('independent Windows console: automatic hook registration, attach, Unicode dispatch and transcript completion', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-independent-'))
  const saved = { AXMAP_STATE_DIR: process.env.AXMAP_STATE_DIR, AXMAP_AGY_HOME: process.env.AXMAP_AGY_HOME }
  process.env.AXMAP_STATE_DIR = path.join(dir, 'state')
  process.env.AXMAP_AGY_HOME = path.join(dir, 'agy-home')
  spawnSync('git', ['init', '-q'], { cwd: dir })
  // A real console process named agy.exe, launched directly by node-pty, with no
  // axMap environment, listener, token or terminal wrapper.
  const binary = path.join(dir, 'agy.exe')
  try { fs.linkSync(process.execPath, binary) } catch { fs.copyFileSync(process.execPath, binary) }
  const fixture = path.join(dir, 'independent.cjs')
  const hookScript = path.join(ROOT, 'tools', 'run.mjs')
  fs.writeFileSync(fixture, `
    const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
    const cid='11111111-2222-4333-8444-555555555555';
    const log=path.join(process.env.AXMAP_AGY_HOME,'brain',cid,'.system_generated/logs/transcript.jsonl');
    fs.mkdirSync(path.dirname(log),{recursive:true});fs.writeFileSync(log,'');
    const hook=cp.spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(hookScript)},'hook','Stop'],{
      input:JSON.stringify({conversationId:cid,workspacePaths:[process.cwd()],transcriptPath:log,fullyIdle:true}),encoding:'utf8'});
    if(hook.stderr) console.error(hook.stderr);
    const rule='─'.repeat(50);let pending='';
    const draw=()=>process.stdout.write('\\x1b[2J\\x1b[HREADY\\r\\n'+rule+'\\r\\n> '+pending+'\\r\\n'+rule+'\\r\\n? for shortcuts\\r\\n');
    process.stdin.setRawMode(true);process.stdin.resume();draw();
    process.stdin.on('data',data=>{
      pending+=data.toString();
      if(pending.includes('\\x15')) {pending='';draw();return;}
      if(!pending.includes('\\r')) {draw();return;}
      const prompt=pending.slice(0,pending.indexOf('\\r')).replace(/\\x1b\\[(?:200|201)~/g,'');pending='';
      if(prompt==='EXIT') process.exit(0);
      fs.appendFileSync(log,JSON.stringify({type:'USER_INPUT',content:prompt})+'\\n');
      fs.appendFileSync(log,JSON.stringify({source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',content:'독립 응답: '+prompt.split('\\n').slice(2).join('\\n')})+'\\n');
      draw();
    });
  `)
  const hostScript = path.join(dir, 'host.mjs')
  fs.writeFileSync(hostScript, `
    import {createRequire} from 'node:module';import readline from 'node:readline';
    const {spawn}=createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))})('node-pty');
    const env={...process.env};delete env.AXMAP_TERMINAL_SESSION;delete env.AXMAP_TERMINAL_TOKEN;
    const term=spawn(${JSON.stringify(binary)},[${JSON.stringify(fixture)}],{cwd:${JSON.stringify(dir)},env,cols:100,rows:30,useConpty:true,useConptyDll:false});
    console.log(JSON.stringify({pid:term.pid}));
    term.onData(d=>console.log(JSON.stringify({data:d})));
    const rl=readline.createInterface({input:process.stdin});rl.on('line',l=>term.write(JSON.parse(l).input));
    term.onExit(e=>{try{term.kill()}catch{};rl.close();process.exit(e.exitCode||0)});
  `)
  let host, exited, pid, ready = false, errors = ''
  try {
    host = spawn(process.execPath, [hostScript], { cwd: dir, env: process.env, windowsHide: true })
    exited = new Promise(resolve => host.once('exit', resolve))
    let output = ''
    host.stderr.on('data', d => { errors += d })
    host.stdout.on('data', d => {
      output += d
      for (let end; (end = output.indexOf('\n')) >= 0;) {
        const entry = JSON.parse(output.slice(0, end)); output = output.slice(end + 1)
        if (entry.pid) pid = entry.pid
        if (entry.data?.includes('READY')) ready = true
      }
    })
    await until(() => ready)
    const automatic = sessions(dir).find(s => s.transport === 'console')
    assert.ok(automatic, errors)
    assert.equal(automatic.pid, pid)
    assert.equal(attachConsole({ pid, cwd: dir }).id, automatic.id)
    const stateFile = path.join(bridgeHome(), 'sessions', `${automatic.id}.json`)
    const state = readJSON(stateFile)
    assert.throws(() => consoleCall(pid, 'snapshot', { startedAt: 'wrong-process-start' }), /identity changed/)
    const other = path.join(dir, 'other'); fs.mkdirSync(other); spawnSync('git', ['init', '-q'], { cwd: other })
    assert.throws(() => dispatchRequest({ to: automatic.id, prompt: 'wrong repo', cwd: other }), /현재 작업 저장소/)
    assert.throws(() => dispatchRequest({ to: automatic.id, prompt: '\x1b[201~', cwd: dir }), /제어 문자/)
    host.stdin.write(JSON.stringify({ input: 'draft' }) + '\n'); await wait(150)
    assert.throws(() => dispatchRequest({ to: automatic.id, prompt: 'do not interrupt', cwd: dir }), /빈 입력창/)
    host.stdin.write(JSON.stringify({ input: '\x15' }) + '\n'); await wait(150)
    // Emulate a session launched before it knew about the installed hook.
    delete state.transcript; delete state.conversationId; writeJSON(stateFile, state)
    const prompt = '한글 "quote" & $literal\r\n두 번째 줄'
    let request
    try { request = dispatchRequest({ to: automatic.id, prompt, cwd: dir }) }
    catch (e) { throw new Error(`${e.message}\n${JSON.stringify(consoleCall(pid))}`, { cause: e }) }
    assert.equal(request.state, 'submitted')
    const result = await until(() => { const r = requestResult(request.id, dir); return r.state === 'completed' && r })
    assert.equal(result.result, '독립 응답: ' + prompt.replace(/\r\n/g, '\n'))
    assert.equal((await sessionStatus(dir))[0].state, 'idle')
    assert.equal(readJSON(stateFile).pid, pid)
    assert.ok(!JSON.stringify(sessions(dir)).includes('startedAt'))
    host.stdin.write(JSON.stringify({ input: 'EXIT\r' }) + '\n')
    await exited
    assert.equal((await sessionStatus(dir))[0].connection, 'unreachable')
  } finally {
    if (host && host.exitCode === null) {
      host.stdin.write(JSON.stringify({ input: 'EXIT\r' }) + '\n')
      const timer = setTimeout(() => host.kill(), 5000)
      await exited; clearTimeout(timer)
    }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
