import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RunStore } from '../src/run-store.mjs'

async function storeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-runs-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  return { store: new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } }), workspace }
}

test('recovers an abandoned run and requires confirmation for a pending unsafe tool', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const run = await store.create({ workspace, prompt: 'test', mode: 'byok' })
  run.pendingTool = { id: 'call-1', name: 'generate_3d_model', arguments: '{}' }
  await store.transition(run, 'running')
  const [recovered] = await store.recoverInterrupted()
  assert.equal(recovered.id, run.id)
  assert.equal(recovered.state, 'interrupted')
  assert.equal(recovered.unsafeResumeRequired, true)
})

test('does not recover a run whose process lock is live', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const run = await store.create({ workspace, prompt: 'test', mode: 'orbit' })
  await store.transition(run, 'running')
  const release = await store.acquire(run.id)
  t.after(release)
  assert.deepEqual(await store.recoverInterrupted(), [])
  assert.equal((await store.load(run.id)).state, 'running')
})

test('writes checkpoints atomically with private permissions', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const run = await store.create({ workspace, prompt: 'test', mode: 'orbit' })
  const checkpoint = path.join(store.directory(run.id), 'checkpoint.json')
  const mode = (await fs.stat(checkpoint)).mode & 0o777
  if (process.platform !== 'win32') assert.equal(mode, 0o600)
  assert.equal((await store.load(run.id)).schema, 'orbit.cli-run.v1')
})
