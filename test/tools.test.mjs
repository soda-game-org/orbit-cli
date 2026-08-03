import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RunStore } from '../src/run-store.mjs'
import { ToolExecutor } from '../src/tools.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-tools-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const run = await store.create({ workspace, prompt: 'test', mode: 'byok' })
  return { workspace, store, run, executor: new ToolExecutor({ workspace, store, run, allowShell: true }) }
}

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } })

test('blocks empty edits, workspace escapes and symlink writes', async (t) => {
  const { workspace, executor } = await fixture(t)
  await fs.writeFile(path.join(workspace, 'index.html'), 'hello')
  await assert.rejects(executor.execute(call('edit_file', { path: 'index.html', old_string: '', new_string: 'x' })), /cannot be empty/)
  await assert.rejects(executor.execute(call('write_file', { path: '../outside.txt', content: 'x' })), /safe workspace-relative/)
  const outside = path.join(path.dirname(workspace), 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(workspace, 'linked'))
  await assert.rejects(executor.execute(call('write_file', { path: 'linked/file.txt', content: 'x' })), /unsafe directory/)
})

test('validates lifecycle implemented in local JavaScript, not only index HTML', async (t) => {
  const { workspace, executor } = await fixture(t)
  await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width"><script src="game.js"></script><button>Leaderboard</button>')
  await fs.writeFile(path.join(workspace, 'game.js'), 'OrbitArcade.startGame(); function end(){ OrbitArcade.endGame({score:1}) }')
  const result = JSON.parse(await executor.execute(call('validate_project', {})))
  assert.equal(result.ok, true)
})

test('does not allow npm install lifecycle scripts through the shell tool', async (t) => {
  const { executor } = await fixture(t)
  await assert.rejects(executor.execute(call('shell', { command: 'npm install' })), /allowlist/)
})
