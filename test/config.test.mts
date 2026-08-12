import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ConfigStore } from '../src/config.mjs'

test('config accepts every regional coding provider and preserves legacy zai', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-config-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const store = new ConfigStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })

  assert.equal((await store.get()).runtime, 'auto')

  for (const provider of ['openai', 'zhipu-cn', 'zai', 'kimi-cn', 'kimi-global']) {
    assert.equal((await store.update({ mode: 'byok', provider })).provider, provider)
  }
  assert.equal((await store.update({ provider: 'unknown-provider' })).provider, 'openrouter')
})
