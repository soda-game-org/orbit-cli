import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Asset3DManager } from '../src/asset-3d-manager.mjs'
import { RunStore } from '../src/run-store.mjs'

test('a failed 3D provider job requires explicit confirmation before a new paid attempt', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-asset3d-manager-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  let attempts = 0
  const manager = new Asset3DManager({
    store,
    config: { get: async () => ({ cloudLogs: false }) },
    auth: {}, credentials: { get: async () => 'configured' }, apiFactory: () => ({}), cloudLogs: null,
    threeD: { generate: async (input) => {
      attempts += 1
      if (attempts === 1) {
        Object.assign(input.state, { predictionId: 'failed-prediction', status: 'failed', requestPending: false })
        await input.persist()
        throw new Error('provider job failed')
      }
      assert.equal(input.state.retryAttempt, 1)
      return { relativePath: 'assets/models/retried.glb' }
    } },
  })
  const first = await manager.create({ mode: 'byok', workspace, prompt: 'An original low-poly arcade drone' })
  assert.equal(first.state, 'paused')
  assert.equal(attempts, 1)
  const held = await manager.resume(first.id)
  assert.equal(held.state, 'paused')
  assert.equal(held.unsafeResumeRequired, true)
  assert.equal(attempts, 1)
  const retried = await manager.resume(first.id, { retryUnsafe: true })
  assert.equal(retried.state, 'completed')
  assert.equal(attempts, 2)
  assert.equal(retried.lastError, null)
  assert.equal(retried.result.relativePath, 'assets/models/retried.glb')
})
