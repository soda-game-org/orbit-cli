import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Asset3DManager } from '../src/asset-3d-manager.mjs'
import { AssetImageManager } from '../src/asset-image-manager.mjs'
import { RunStore } from '../src/run-store.mjs'

function crashAfterInitialCreate(store) {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'create') return async (input) => {
        await target.create(input)
        throw new Error('simulated process crash after initial checkpoint')
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('standalone asset kind and resume configuration are atomic in the first checkpoint', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-asset-init-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  for (const kind of ['assetimage', 'asset3d']) {
    const workspace = path.join(root, kind)
    await fs.mkdir(workspace)
    const store = new RunStore({ directories: { config: path.join(root, `${kind}-config`), data: path.join(root, `${kind}-data`) } })
    const crashingStore = crashAfterInitialCreate(store)
    const manager = kind === 'assetimage'
      ? new AssetImageManager({
          store: crashingStore,
          config: { get: async () => ({ cloudLogs: false }) },
          auth: { accessToken: async () => 'session' }, apiFactory: () => ({}), image: {}, cloudLogs: null,
        })
      : new Asset3DManager({
          store: crashingStore,
          config: { get: async () => ({ cloudLogs: false }) },
          auth: {}, credentials: { get: async () => 'configured' }, apiFactory: () => ({}), threeD: {}, cloudLogs: null,
        })

    await assert.rejects(
      manager.create({
        mode: kind === 'asset3d' ? 'byok' : 'orbit', workspace, prompt: `Create ${kind}`,
        output: kind === 'assetimage' ? 'assets/images/atomic.png' : 'assets/models/atomic.glb',
        aspectRatio: '9:16',
      }),
      /simulated process crash/,
    )

    const [run] = await store.list()
    assert.equal(run.kind, kind)
    assert.equal(run.state, 'queued')
    assert.equal(run.assetOutput, kind === 'assetimage' ? 'assets/images/atomic.png' : 'assets/models/atomic.glb')
    assert.deepEqual(kind === 'assetimage' ? run.assetImage : run.asset3d, {})
    if (kind === 'assetimage') assert.equal(run.assetAspectRatio, '9:16')
    assert.equal((await store.listThreads(workspace)).length, 0)
  }
})
