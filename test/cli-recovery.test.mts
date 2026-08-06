import assert from 'node:assert/strict'
import test from 'node:test'
import { main } from '../src/cli.mjs'

test('runs output appends the derived recovery view while retaining legacy columns', async (t) => {
  const output = []
  t.mock.method(console, 'log', (...values) => output.push(values.join(' ')))
  const checkpoint = {
    id: 'run_11111111-1111-4111-8111-111111111111',
    state: 'paused',
    mode: 'orbit',
    updatedAt: '2026-08-05T00:00:00.000Z',
    workspace: '/tmp/orbit-workspace',
    unsafeResumeRequired: false,
    lastError: { code: 'MODEL_PROVIDER_FALLBACK_READY' },
  }
  const app = {
    store: {
      recoverInterrupted: async () => [],
      list: async () => [checkpoint],
    },
  }

  assert.equal(await main(['runs'], { app }), 0)
  assert.deepEqual(output, [
    `${checkpoint.id}\tpaused\torbit\t${checkpoint.updatedAt}\t${checkpoint.workspace}\tprovider_unavailable\tavailable`,
  ])
})

test('runs relocate explicitly rebinds a moved workspace', async (t) => {
  const output = []
  t.mock.method(console, 'log', (...values) => output.push(values.join(' ')))
  let received
  const app = {
    store: {
      recoverInterrupted: async () => [],
      relocateWorkspace: async (runId, workspace) => {
        received = { runId, workspace }
        return { previousWorkspace: '/old/game', workspace, updatedRunIds: [runId] }
      },
    },
  }
  const runId = 'run_11111111-1111-4111-8111-111111111111'
  assert.equal(await main(['runs', 'relocate', runId, '--workspace', '/new/game'], { app }), 0)
  assert.deepEqual(received, { runId, workspace: '/new/game' })
  assert.match(output[0], /"updatedRunIds"/)
})
