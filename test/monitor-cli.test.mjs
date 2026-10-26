import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { repoKey, writeJSON } from '../src/bridge.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const tool = path.join(root, 'tools', 'monitor.mjs')
const cli = path.join(root, 'bin', 'axmap.mjs')
async function fixture(run) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-monitor-cli-'))
  spawnSync('git', ['init', '-q'], { cwd, windowsHide: true })
  const env = { ...process.env, AXMAP_STATE_DIR: path.join(cwd, 'state') }
  delete env.AXMAP_REPO
  try { await run(cwd, env) }
  finally {
    assert.equal(path.dirname(path.resolve(cwd)), path.resolve(os.tmpdir()))
    await fs.promises.rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

test('monitor alias supports plain/JSON output and rejects invalid intervals without ledger setup', async () => fixture(async (cwd, env) => {
  const run = args => spawnSync(process.execPath, [cli, 'monitor', ...args], { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 10000 })
  const json = run(['--json'])
  assert.equal(json.status, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout).requests, [])
  const plain = run([])
  assert.equal(plain.status, 0, plain.stderr)
  assert.match(plain.stdout, /axMap LIVE/)
  assert.ok(!plain.stdout.includes('\x1b'))
  assert.equal(fs.existsSync(path.join(cwd, '.axmap')), false)
  for (const args of [['--interval', '10'], ['--interval'], ['--other']]) assert.notEqual(run(args).status, 0)
}))

test('live monitor repaints actual request changes and restores the terminal on q', { timeout: 20000 }, async () => fixture(async (cwd, env) => {
  const job = { id: randomUUID(), to: randomUUID(), from: 'codex', repo: repoKey(cwd),
    prompt: '한글 진행 확인', createdAt: new Date().toISOString(), baseline: 0, state: 'submitted' }
  const record = path.join(env.AXMAP_STATE_DIR, 'bridge', 'requests', `${job.id}.json`)
  writeJSON(record, job)
  // Keep native ConPTY handles in a disposable driver, outside node:test workers.
  const driver = path.join(cwd, 'pty-driver.cjs')
  fs.writeFileSync(driver, `
    const {spawn}=require(${JSON.stringify(createRequire(import.meta.url).resolve('node-pty'))});
    const fs=require('node:fs'), assert=require('node:assert/strict');
    let output='', exited=false;
    const term=spawn(process.execPath,[${JSON.stringify(tool)},'--interval','250','--no-color'],{cwd:process.cwd(),env:{...process.env,TERM:'xterm-256color'},cols:110,rows:36});
    const complete=new Promise(resolve=>term.onExit(event=>{exited=true;resolve(event)}));
    term.onData(data=>output+=data);
    const pause=ms=>new Promise(r=>setTimeout(r,ms));
    const until=async condition=>{const deadline=Date.now()+8000;while(!condition()&&Date.now()<deadline)await pause(30);assert.ok(condition(),output)};
    const timeout=setTimeout(()=>{try{term.kill()}catch{};process.exit(1)},15000);
    (async()=>{
      await until(()=>output.includes('응답 대기'));
      assert.ok(output.includes('\\x1b[?1049h'));output='';
      const file=${JSON.stringify(record)},job=JSON.parse(fs.readFileSync(file,'utf8'));
      fs.writeFileSync(file,JSON.stringify({...job,state:'completed',completedAt:new Date().toISOString(),result:'done'}));
      await until(()=>output.includes('● 완료 확인'));
      term.resize(40,12);await until(()=>output.includes('터미널을 넓히면'));
      term.write('q');const result=await complete;
      assert.equal(result.exitCode,0);assert.ok(output.includes('\\x1b[?25h\\x1b[?1049l'));
      clearTimeout(timeout);process.exit(0);
    })().catch(error=>{console.error(error);if(!exited){try{term.kill()}catch{}};process.exit(1)});
  `)
  const result = spawnSync(process.execPath, [driver], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 18000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).state, 'completed')
}))
