import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readProfile, writeProfile, displayNameError, emailError } from '../src/identity.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-profile-'))
after(() => fs.rmSync(home, { recursive: true, force: true }))

test('display profiles retain international names and never save a repo email', () => {
  assert.equal(readProfile(home), null)
  for (const name of ['장효준', 'John Smith', 'Élodie', '山田 太郎']) {
    writeProfile(name, home)
    const saved = readProfile(home)
    assert.equal(saved.version, 1)
    assert.equal(saved.name, name)
    assert.ok(Number.isFinite(Date.parse(saved.updatedAt)))
    assert.equal('email' in saved, false)
  }
  for (const name of ['', 'all', 'ALL', '../alice', 'alice,bob', 'a@b', ' name', 'name\n']) assert.ok(displayNameError(name), name)
})

test('malformed existing settings are reported and never silently overwritten', () => {
  const file = path.join(home, '.axmap', 'profile.json')
  fs.writeFileSync(file, '{broken')
  assert.throws(() => writeProfile('Alice', home), /읽지 못했습니다/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
})

test('email keys reject unsafe filenames rather than conflating addresses', () => {
  assert.equal(emailError('alice+work@example.com'), null)
  for (const email of [null, '', 'alice', '../a@b', 'a\\b@c', 'a@b:c', 'a@b\n']) assert.ok(emailError(email))
})
