import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { OrbitApiError } from '../src/api.mjs'
import { RunManager } from '../src/run-manager.mjs'
import { RunStore } from '../src/run-store.mjs'

const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

test('CLI GUI and terminal share the checkpointed agent loop through completion', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  let calls = 0
  const manager = new RunManager({
    store,
    config: { get: async () => ({ mode: 'byok', provider: 'openrouter', model: 'test-model', runtime: 'html', cloudLogs: false }) },
    credentials: { get: async () => 'configured' },
    auth: {}, apiFactory: () => { throw new Error('Official API must not be used in this BYOK test') },
    byok: { complete: async () => {
      calls += 1
      return { role: 'assistant', content: '', reasoning_content: 'provider reasoning', response_items: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }], tool_calls: [
        tool('1', 'update_agent_plan', { summary: 'Build', todos: [{ id: 'build', title: 'Build game', status: 'in_progress', kind: 'code' }] }),
        tool('2', 'write_file', { path: 'index.html', content: '<!doctype html><meta name="viewport" content="width=device-width"><button>Leaderboard</button><script src="game.js"></script>' }),
        tool('3', 'write_file', { path: 'game.js', content: 'OrbitArcade.startGame(); function finish(){ OrbitArcade.endGame({score:1}) }' }),
        tool('4', 'validate_project', {}),
        tool('5', 'finish', {}),
      ] }
    } },
    threeD: {}, cloudLogs: null,
  })
  const run = await manager.create({
    source: 'cli_gui', workspace, prompt: 'Build a test arcade game', mode: 'byok', provider: 'openrouter', model: 'test-model', runtime: 'html',
  })
  assert.equal(calls, 1)
  assert.equal(run.source, 'cli_gui')
  assert.equal(run.state, 'completed')
  assert.equal(run.lastValidation.ok, true)
  const checkpoint = await store.load(run.id)
  assert.equal(checkpoint.state, 'completed')
  assert.equal(checkpoint.plan.currentTodoId, undefined)
  assert.deepEqual(checkpoint.plan.todos.map((todo) => todo.status), ['completed'])
  const assistantCheckpoint = checkpoint.messages.find((message) => message.role === 'assistant')
  assert.equal(assistantCheckpoint.reasoning_content, 'provider reasoning')
  assert.deepEqual(assistantCheckpoint.response_items, [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }])
  assert.match(await fs.readFile(path.join(workspace, 'game.js'), 'utf8'), /endGame/)
})

test('repeated no-tool responses pause with a resumable checkpoint instead of failing', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-pause-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const manager = new RunManager({
    store,
    config: { get: async () => ({ mode: 'byok', provider: 'openrouter', model: 'test-model', runtime: 'html', cloudLogs: false }) },
    credentials: { get: async () => 'configured' }, auth: {}, apiFactory: () => ({}),
    byok: { complete: async () => ({ role: 'assistant', content: 'thinking' }) }, threeD: {}, cloudLogs: null,
  })
  const run = await manager.create({ workspace, prompt: 'Build a game', mode: 'byok', provider: 'openrouter', model: 'test-model', runtime: 'html' })
  assert.equal(run.state, 'paused')
  assert.equal(run.lastError.code, 'AGENT_NO_TOOL_PROGRESS')
  assert.equal(run.finishedAt, null)
})

test('an ambiguous BYOK model failure requires explicit retry confirmation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-unsafe-model-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  let calls = 0
  const manager = new RunManager({
    store,
    config: { get: async () => ({ mode: 'byok', provider: 'deepseek', model: 'test-model', runtime: 'html', cloudLogs: false }) },
    credentials: { get: async () => 'configured' }, auth: {}, apiFactory: () => ({}),
    byok: { complete: async () => { calls += 1; throw new Error('connection reset') } }, threeD: {}, cloudLogs: null,
  })
  const run = await manager.create({ workspace, prompt: 'Build a game', mode: 'byok', provider: 'deepseek', model: 'test-model', runtime: 'html' })
  assert.equal(run.state, 'paused')
  assert.equal(run.unsafeResumeRequired, true)
  assert.ok(run.pendingModelCall)
  const held = await manager.resume(run.id)
  assert.equal(held.state, 'paused')
  assert.equal(held.lastError.code, 'UNSAFE_RETRY_CONFIRMATION_REQUIRED')
  assert.equal(calls, 1)
})

test('a definitive Orbit API failure clears the consumed model request key without unsafe replay', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-official-model-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const api = {
    models: async () => ({ default: 'test-model', models: [{ id: 'test-model' }] }),
    beginRun: async () => ({ run_id: 'cloud-run-1' }),
    complete: async () => { throw new OrbitApiError(402, null, 'Orbit Engine authorization was rejected') },
  }
  const manager = new RunManager({
    store,
    config: { get: async () => ({ mode: 'orbit', provider: 'openrouter', model: 'test-model', runtime: 'html', cloudLogs: false }) },
    credentials: { get: async () => null },
    auth: { accessToken: async () => 'session' },
    apiFactory: () => api,
    byok: {}, threeD: {}, image: {}, cloudLogs: null,
  })
  const run = await manager.create({ workspace, prompt: 'Build a game', mode: 'orbit', runtime: 'html' })
  assert.equal(run.state, 'paused')
  assert.equal(run.unsafeResumeRequired, false)
  assert.equal(run.pendingModelCall, null)
})

test('an official provider outage settles that run and selects a different catalog model on resume', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-provider-fallback-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const begunModels = []
  const settlements = []
  let completeCalls = 0
  const api = {
    models: async () => ({ default: 'glm-5.2', models: [{ id: 'glm-5.2' }, { id: 'deepseek-v4-pro' }] }),
    beginRun: async ({ modelId }) => { begunModels.push(modelId); return { run_id: `cloud-run-${begunModels.length}` } },
    heartbeat: async () => ({ state: 'active' }),
    complete: async () => {
      completeCalls += 1
      if (completeCalls === 1) return {
        finish_reason: 'content_filter',
        assistant: { role: 'assistant', content: 'The server withheld this response.' },
      }
      if (completeCalls === 2) throw new OrbitApiError(503, 'ENGINE_MODEL_PROVIDER_UNAVAILABLE', 'Provider unavailable')
      return { assistant: { role: 'assistant', content: 'continuing' } }
    },
    settle: async (...args) => { settlements.push(args); return { state: 'failed' } },
  }
  const manager = new RunManager({
    store,
    config: { get: async () => ({ mode: 'orbit', provider: 'openrouter', model: '', runtime: 'html', cloudLogs: false }) },
    credentials: { get: async () => null }, auth: { accessToken: async () => 'session' },
    apiFactory: () => api, byok: {}, threeD: {}, image: {}, cloudLogs: null,
  })
  const first = await manager.create({ workspace, prompt: 'Build a game', mode: 'orbit', runtime: 'html' })
  assert.equal(first.lastError.code, 'MODEL_PROVIDER_FALLBACK_READY')
  assert.deepEqual(first.failedModels, ['glm-5.2'])
  assert.equal(first.cloudRunId, null)
  assert.equal(first.contentFilterStreak, 0)
  assert.equal(settlements.length, 1)
  const resumed = await manager.resume(first.id)
  assert.deepEqual(begunModels, ['glm-5.2', 'deepseek-v4-pro'])
  assert.equal(resumed.model, 'deepseek-v4-pro')
})

test('repeated protected turns rotate away from that official model family', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-filter-fallback-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const begunModels = []
  let completeCalls = 0
  const api = {
    models: async () => ({
      default: 'gemini-3-flash',
      models: [{ id: 'gemini-3-flash' }, { id: 'gemini-3.5-flash' }, { id: 'deepseek-v4-flash' }],
    }),
    beginRun: async ({ modelId }) => { begunModels.push(modelId); return { run_id: `cloud-filter-${begunModels.length}` } },
    heartbeat: async () => ({ state: 'active' }),
    complete: async () => {
      completeCalls += 1
      return {
        finish_reason: completeCalls <= 3 ? 'content_filter' : 'stop',
        assistant: { role: 'assistant', content: completeCalls <= 3 ? 'The server withheld this response.' : 'Continuing.' },
      }
    },
    settle: async () => ({ state: 'failed' }),
  }
  const manager = new RunManager({
    store,
    config: { get: async () => ({ mode: 'orbit', provider: 'openrouter', model: '', runtime: 'html', cloudLogs: false }) },
    credentials: { get: async () => null }, auth: { accessToken: async () => 'session' },
    apiFactory: () => api, byok: {}, threeD: {}, image: {}, cloudLogs: null,
  })
  const first = await manager.create({ workspace, prompt: 'Build a game', mode: 'orbit', runtime: 'html' })
  assert.equal(first.lastError.code, 'MODEL_CONTENT_FILTER_FALLBACK_READY')
  assert.deepEqual(first.failedModelPrefixes, ['gemini-'])
  assert.equal(first.messages.some((message) => String(message.content || '').includes('server withheld')), false)
  const resumed = await manager.resume(first.id)
  assert.deepEqual(begunModels, ['gemini-3-flash', 'deepseek-v4-flash'])
  assert.equal(resumed.model, 'deepseek-v4-flash')
})
