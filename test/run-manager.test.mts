import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertAgentTranscriptProtocol,
  createAgentToolBatchJournal,
  recordAgentToolBatchResult,
} from '@soda_game/orbit-agent-core'
import { OrbitApiError } from '../src/api.mjs'
import { RunManager } from '../src/run-manager.mjs'
import { RunStore } from '../src/run-store.mjs'

const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

const localManager = (store, complete) => new RunManager({
  store,
  config: { get: async () => ({ mode: 'byok', provider: 'openrouter', model: 'test-model', runtime: 'html', cloudLogs: false }) },
  credentials: { get: async () => 'configured' },
  auth: {}, apiFactory: () => { throw new Error('Official API must not be used in this BYOK test') },
  byok: { complete }, threeD: {}, cloudLogs: null,
})

async function checkpointedRun(store, workspace, messages) {
  const run = await store.create({
    source: 'cli', operation: 'create', prompt: 'Resume a checkpoint', workspace,
    mode: 'byok', provider: 'openrouter', model: 'test-model', runtime: 'html',
  })
  run.messages = messages
  await store.transition(run, 'interrupted')
  return run
}

test('CLI GUI and terminal share the checkpointed agent loop through completion', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  let calls = 0
  const progress = []
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
        tool('5', 'update_agent_plan', { summary: 'Ready', todos: [{ id: 'build', title: 'Build game', status: 'completed', kind: 'code' }] }),
        tool('6', 'finish', {}),
      ] }
    } },
    threeD: {}, cloudLogs: null,
  })
  const run = await manager.create({
    source: 'cli_gui', workspace, prompt: 'Build a test arcade game', mode: 'byok', provider: 'openrouter', model: 'test-model', runtime: 'html',
    onProgress: (event) => progress.push(event),
  })
  assert.equal(calls, 1)
  assert.equal(run.source, 'cli_gui')
  assert.equal(run.state, 'completed')
  assert.equal(run.lastValidation.ok, true)
  assert.ok(progress.some((event) => event.type === 'model_started'))
  assert.ok(progress.some((event) => event.type === 'tool_started' && event.toolName === 'validate_project'))
  const checkpoint = await store.load(run.id)
  assert.equal(checkpoint.state, 'completed')
  assert.equal(checkpoint.plan.currentTodoId, null)
  assert.deepEqual(checkpoint.plan.todos.map((todo) => todo.status), ['completed'])
  const assistantCheckpoint = checkpoint.messages.find((message) => message.role === 'assistant')
  assert.equal(assistantCheckpoint.reasoning_content, 'provider reasoning')
  assert.deepEqual(assistantCheckpoint.response_items, [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }])
  assert.match(await fs.readFile(path.join(workspace, 'game.js'), 'utf8'), /endGame/)
})

test('one model batch of repeated tool errors counts once and remains protocol-valid', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-batch-errors-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  let modelCalls = 0
  const manager = localManager(store, async ({ messages }) => {
    assert.equal(assertAgentTranscriptProtocol(messages), true)
    modelCalls += 1
    return modelCalls === 1
      ? { role: 'assistant', content: '', tool_calls: Array.from({ length: 8 }, (_, index) => tool(`error_${index}`, 'read_file', { path: 'missing.txt' })) }
      : { role: 'assistant', content: 'thinking' }
  })
  const run = await manager.create({ workspace, prompt: 'Inspect a missing file', mode: 'byok', provider: 'openrouter', model: 'test-model' })
  assert.equal(run.state, 'paused')
  assert.equal(run.executionState.repeatedToolErrors, 1)
  assert.equal(run.messages.filter((message) => message.role === 'tool' && String(message.tool_call_id).startsWith('error_')).length, 8)
  assert.equal(run.messages.some((message) => message.role === 'user' && /same .* error repeated/i.test(String(message.content))), false)
  assert.equal(assertAgentTranscriptProtocol(run.messages), true)
})

test('a 17-call model batch executes the shared cap and settles overflow synthetically', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-batch-cap-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  let modelCalls = 0
  const manager = localManager(store, async ({ messages }) => {
    assert.equal(assertAgentTranscriptProtocol(messages), true)
    modelCalls += 1
    return modelCalls === 1
      ? { role: 'assistant', content: '', tool_calls: Array.from({ length: 17 }, (_, index) => tool(`cap_${index + 1}`, 'list_files', {})) }
      : { role: 'assistant', content: 'thinking' }
  })
  const run = await manager.create({ workspace, prompt: 'Inspect files', mode: 'byok', provider: 'openrouter', model: 'test-model' })
  const results = run.messages.filter((message) => message.role === 'tool' && String(message.tool_call_id).startsWith('cap_'))
  assert.equal(results.length, 17)
  assert.doesNotMatch(String(results[15].content), /Skipped before execution/)
  assert.match(String(results[16].content), /per-turn execution limit is 16/)
  const events = await store.events(run.id)
  assert.equal(events.filter((event) => event.type === 'tool_started').length, 16)
  assert.equal(assertAgentTranscriptProtocol(run.messages), true)
})

test('finish closes later sibling calls with synthetic results before completing', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-finish-batch-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const manager = localManager(store, async () => ({ role: 'assistant', content: '', tool_calls: [
    tool('plan', 'update_agent_plan', { summary: 'Build', todos: [{ id: 'build', title: 'Build', status: 'in_progress', kind: 'code' }] }),
    tool('html', 'write_file', { path: 'index.html', content: '<!doctype html><meta name="viewport" content="width=device-width"><button>Leaderboard</button><script src="game.js"></script>' }),
    tool('js', 'write_file', { path: 'game.js', content: 'OrbitArcade.startGame(); OrbitArcade.endGame({score:1})' }),
    tool('validate', 'validate_project', {}),
    tool('done-plan', 'update_agent_plan', { summary: 'Ready', todos: [{ id: 'build', title: 'Build', status: 'completed', kind: 'code' }] }),
    tool('finish', 'finish', {}),
    tool('late-write', 'write_file', { path: 'must-not-exist.txt', content: 'late side effect' }),
  ] }))
  const run = await manager.create({ workspace, prompt: 'Build and finish', mode: 'byok', provider: 'openrouter', model: 'test-model' })
  assert.equal(run.state, 'completed')
  assert.equal(await fs.stat(path.join(workspace, 'must-not-exist.txt')).then(() => true, () => false), false)
  const skipped = run.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'late-write')
  assert.match(String(skipped?.content), /finish completed before the remaining sibling calls/)
  assert.equal(assertAgentTranscriptProtocol(run.messages), true)
})

test('repeated-error guidance is deferred until every sibling tool result is written', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-deferred-warning-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  let modelCalls = 0
  const manager = localManager(store, async ({ messages }) => {
    assert.equal(assertAgentTranscriptProtocol(messages), true)
    modelCalls += 1
    if (modelCalls === 1) return { role: 'assistant', content: '', tool_calls: [
      tool('warning_plan', 'update_agent_plan', { summary: 'Inspect', todos: [{ id: 'inspect', title: 'Inspect', status: 'in_progress', kind: 'code' }] }),
      tool('warning_1', 'read_file', { path: 'missing.txt' }),
    ] }
    if (modelCalls === 2) return { role: 'assistant', content: '', tool_calls: [tool('warning_2', 'read_file', { path: 'missing.txt' })] }
    if (modelCalls === 3) return { role: 'assistant', content: '', tool_calls: Array.from({ length: 4 }, (_, index) => tool(`warning_3_${index}`, 'read_file', { path: 'missing.txt' })) }
    return { role: 'assistant', content: 'thinking' }
  })
  const run = await manager.create({ workspace, prompt: 'Inspect', mode: 'byok', provider: 'openrouter', model: 'test-model' })
  const assistantIndex = run.messages.findIndex((message) => message.role === 'assistant'
    && message.tool_calls?.some((call) => call.id === 'warning_3_0'))
  assert.ok(assistantIndex >= 0)
  assert.deepEqual(
    run.messages.slice(assistantIndex + 1, assistantIndex + 5).map((message) => message.role),
    ['tool', 'tool', 'tool', 'tool'],
  )
  assert.match(String(run.messages[assistantIndex + 5]?.content), /same read_file error repeated across 3 model turns/)
  assert.equal(assertAgentTranscriptProtocol(run.messages), true)
})

test('resume drains a journal saved before its first tool and between sibling tools', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-journal-resume-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })

  for (const scenario of ['before-first', 'between-tools']) {
    const workspace = path.join(root, scenario)
    await fs.mkdir(workspace, { recursive: true })
    const assistant = { role: 'assistant', content: '', tool_calls: [
      tool(`${scenario}_write`, 'write_file', { path: 'saved.txt', content: scenario }),
      tool(`${scenario}_list`, 'list_files', {}),
    ] }
    const run = await checkpointedRun(store, workspace, [{ role: 'user', content: 'Resume' }, assistant])
    let journal = createAgentToolBatchJournal(assistant)
    if (scenario === 'between-tools') {
      await fs.writeFile(path.join(workspace, 'saved.txt'), scenario)
      journal = recordAgentToolBatchResult(journal, {
        role: 'tool', tool_call_id: `${scenario}_write`, content: '{"path":"saved.txt"}',
      })
    }
    run.pendingToolBatch = journal
    run.pendingToolBatchControl = { errors: [], validationFailures: [], validationObserved: false, finishRequested: false }
    await store.save(run)
    let providerCalls = 0
    const manager = localManager(store, async ({ messages }) => {
      providerCalls += 1
      assert.equal(assertAgentTranscriptProtocol(messages), true)
      return { role: 'assistant', content: 'thinking' }
    })
    const resumed = await manager.resume(run.id)
    assert.equal(resumed.state, 'paused')
    assert.equal(providerCalls, 3)
    assert.equal(await fs.readFile(path.join(workspace, 'saved.txt'), 'utf8'), scenario)
    const events = await store.events(run.id)
    const resumedTools = events.filter((event) => event.type === 'tool_started').map((event) => event.toolName)
    assert.deepEqual(resumedTools, scenario === 'before-first' ? ['write_file', 'list_files'] : ['list_files'])
    assert.equal(assertAgentTranscriptProtocol(resumed.messages), true)
  }
})

test('an interruption between sibling tools preserves the open journal and resumes before another model call', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-batch-interrupt-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  let interrupt
  t.mock.method(process, 'once', (event, listener) => {
    if (event === 'SIGINT') interrupt = listener
    return process
  })
  t.mock.method(process, 'removeListener', () => process)
  let modelCalls = 0
  const providerInputs = []
  const manager = localManager(store, async ({ messages }) => {
    providerInputs.push(structuredClone(messages))
    assert.equal(assertAgentTranscriptProtocol(messages), true)
    modelCalls += 1
    return modelCalls === 1
      ? { role: 'assistant', content: '', tool_calls: [tool('interrupt_1', 'list_files', {}), tool('interrupt_2', 'list_files', {})] }
      : { role: 'assistant', content: 'thinking' }
  })
  let interrupted = false
  const first = await manager.create({
    workspace, prompt: 'Inspect twice', mode: 'byok', provider: 'openrouter', model: 'test-model',
    onProgress: (event) => {
      if (!interrupted && event.type === 'tool_completed' && event.toolName === 'list_files') {
        interrupted = true
        interrupt()
      }
    },
  })
  assert.equal(first.state, 'interrupted')
  assert.equal(first.pendingToolBatch.results.length, 1)
  assert.equal(first.messages.some((message) => message.role === 'tool'), false)
  assert.equal(providerInputs.length, 1)

  const resumed = await manager.resume(first.id)
  assert.equal(resumed.state, 'paused')
  assert.equal(resumed.pendingToolBatch, null)
  assert.equal(providerInputs.length, 4)
  assert.equal(assertAgentTranscriptProtocol(resumed.messages), true)
  const events = await store.events(first.id)
  assert.equal(events.filter((event) => event.type === 'tool_started').length, 2)
})

test('pending unsafe tools require explicit permission before replay', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-unsafe-journal-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(path.join(workspace, 'game.js'), 'const ok = true\n')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const assistant = { role: 'assistant', content: '', tool_calls: [tool('unsafe_shell', 'shell', { command: 'node --check game.js' })] }
  const run = await checkpointedRun(store, workspace, [{ role: 'user', content: 'Resume' }, assistant])
  run.pendingToolBatch = createAgentToolBatchJournal(assistant)
  run.pendingToolBatchControl = { errors: [], validationFailures: [], validationObserved: false, finishRequested: false }
  run.pendingTool = { id: 'unsafe_shell', name: 'shell', arguments: assistant.tool_calls[0].function.arguments, startedAt: new Date().toISOString() }
  run.unsafeResumeRequired = false
  await store.save(run)
  let providerCalls = 0
  const manager = localManager(store, async ({ messages }) => {
    providerCalls += 1
    assert.equal(assertAgentTranscriptProtocol(messages), true)
    return { role: 'assistant', content: 'thinking' }
  })

  const held = await manager.resume(run.id, { allowShell: true })
  assert.equal(held.lastError.code, 'UNSAFE_RETRY_CONFIRMATION_REQUIRED')
  assert.equal(held.pendingToolBatch.status, 'open')
  assert.equal(providerCalls, 0)
  const resumed = await manager.resume(run.id, { allowShell: true, retryUnsafe: true })
  assert.equal(resumed.state, 'paused')
  assert.equal(providerCalls, 3)
  assert.equal(resumed.pendingToolBatch, null)
  assert.equal(assertAgentTranscriptProtocol(resumed.messages), true)
})

test('legacy interleaved checkpoint repair consumes and reorders the entire assistant tail', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-legacy-batch-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace, { recursive: true })
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const assistant = { role: 'assistant', content: '', tool_calls: [
    tool('legacy_1', 'list_files', {}), tool('legacy_2', 'list_files', {}),
  ] }
  const run = await checkpointedRun(store, workspace, [
    { role: 'user', content: 'Resume legacy' },
    assistant,
    { role: 'tool', tool_call_id: 'legacy_1', content: 'first' },
    { role: 'user', content: 'warning inserted too early' },
    { role: 'tool', tool_call_id: 'legacy_2', content: 'second' },
    { role: 'user', content: 'trailing guidance' },
  ])
  let firstProviderMessages
  const manager = localManager(store, async ({ messages }) => {
    firstProviderMessages ||= structuredClone(messages)
    assert.equal(assertAgentTranscriptProtocol(messages), true)
    return { role: 'assistant', content: 'thinking' }
  })
  const resumed = await manager.resume(run.id)
  const batchIndex = firstProviderMessages.findIndex((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'legacy_1')
  assert.deepEqual(firstProviderMessages.slice(batchIndex + 1, batchIndex + 5).map((message) => message.role), ['tool', 'tool', 'user', 'user'])
  assert.deepEqual(firstProviderMessages.slice(batchIndex + 1, batchIndex + 3).map((message) => message.tool_call_id), ['legacy_1', 'legacy_2'])
  assert.equal(resumed.pendingToolBatch, null)
  assert.equal(assertAgentTranscriptProtocol(resumed.messages), true)
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
