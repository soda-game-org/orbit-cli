import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertAgentTranscriptProtocol,
  createAgentToolBatchJournal,
  prepareAgentMessageCompaction,
  recordAgentToolBatchResult,
} from '@soda_game/orbit-agent-core'
import { OrbitApiError } from '../src/api.mjs'
import { ingestReferenceImages } from '../src/attachments.mjs'
import { RunManager } from '../src/run-manager.mjs'
import { RunStore } from '../src/run-store.mjs'
import { persistentVisionTurnInputMessage, turnInputItems } from '../src/turn-input.mjs'

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

async function linkedInterruptedRun(store, workspace, messages) {
  await fs.mkdir(workspace, { recursive: true })
  const thread = await store.createThread(workspace, 'Compaction session')
  const turnId = 'turn_77777777-7777-4777-8777-777777777777'
  const run = await store.create({
    source: 'cli', operation: 'create', prompt: 'Continue the durable task', workspace,
    mode: 'byok', provider: 'openrouter', model: 'test-model', runtime: 'html',
    threadId: thread.id, turnId,
  })
  await store.linkRunToTurn({
    workspace,
    threadId: thread.id,
    runId: run.id,
    preferredTurnId: turnId,
    baseMessageCount: 0,
    inputItems: [{ schema: 'orbit.agent-input-item.v1', id: 'compaction-input', type: 'text', text: 'Continue the durable task' }],
  })
  run.messages = messages
  run.turnInputProjected = true
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
    config: { get: async () => ({ mode: 'byok', provider: 'openrouter', model: 'test-model', runtime: 'auto', cloudLogs: false }) },
    credentials: { get: async () => 'configured' },
    auth: {}, apiFactory: () => { throw new Error('Official API must not be used in this BYOK test') },
    byok: { complete: async () => {
      calls += 1
      return { role: 'assistant', content: '', reasoning_content: 'provider reasoning', response_items: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }], tool_calls: [
        tool('1', 'update_agent_plan', { summary: 'Build', todos: [{ id: 'build', title: 'Build game', status: 'in_progress', kind: 'code' }] }),
        tool('2', 'select_runtime', { runtime: 'html', dimension: '2d', rationale: 'A direct 2D canvas implementation is the lightest fit for this flat arcade interaction.' }),
        tool('3', 'write_file', { path: 'index.html', content: '<!doctype html><meta name="viewport" content="width=device-width"><button>Leaderboard</button><script src="game.js"></script>' }),
        tool('4', 'write_file', { path: 'game.js', content: 'OrbitArcade.startGame(); function finish(){ OrbitArcade.endGame({score:1}) }' }),
        tool('5', 'validate_project', {}),
        tool('6', 'update_agent_plan', { summary: 'Ready', todos: [{ id: 'build', title: 'Build game', status: 'completed', kind: 'code' }] }),
        tool('7', 'finish', {}),
      ] }
    } },
    threeD: {}, cloudLogs: null,
  })
  const run = await manager.create({
    source: 'cli_gui', workspace, prompt: 'Build a 2D shooter test game', mode: 'byok', provider: 'openrouter', model: 'test-model', runtime: 'auto',
    onProgress: (event) => progress.push(event),
  })
  assert.equal(calls, 1)
  assert.equal(run.source, 'cli_gui')
  assert.equal(run.requestedRuntime, 'auto')
  assert.equal(run.runtime, 'html')
  assert.equal(run.runtimeDecision.dimension, '2d')
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

test('managed text model receives one structured observation per private image, never an aggregate', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-media-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const imageA = path.join(root, 'a.png')
  const imageB = path.join(root, 'b.png')
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  await fs.writeFile(imageA, Buffer.concat([signature, Buffer.alloc(24, 1)]))
  await fs.writeFile(imageB, Buffer.concat([signature, Buffer.alloc(24, 2)]))
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const referenceRequests = []
  let agentMessages
  const api = {
    models: async () => ({ default: 'deepseek-v4-pro', models: [{ id: 'deepseek-v4-pro' }] }),
    beginRun: async () => ({ run_id: 'cloud-media-1' }),
    complete: async (input) => {
      if (input.purpose === 'reference_media') {
        referenceRequests.push(input)
        return { assistant: { role: 'assistant', content: JSON.stringify({
          summary: `observation ${referenceRequests.length}`,
          facts: [{ id: `fact-${referenceRequests.length}`, label: 'composition', text: `visible fact ${referenceRequests.length}`, confidence: 0.9 }],
        }) } }
      }
      agentMessages ||= structuredClone(input.messages)
      return { assistant: { role: 'assistant', content: 'thinking' } }
    },
  }
  const manager = new RunManager({
    store,
    config: { get: async () => ({ mode: 'orbit', provider: 'openrouter', model: '', runtime: 'html', cloudLogs: false }) },
    credentials: { get: async () => null }, auth: { accessToken: async () => 'session' },
    apiFactory: () => api, byok: {}, threeD: {}, image: {}, cloudLogs: null,
  })

  const run = await manager.create({ workspace, prompt: 'Build from both images', mode: 'orbit', referenceImages: [imageA, imageB] })

  assert.equal(referenceRequests.length, 2)
  assert.equal(referenceRequests.every((request) => request.messages[0].content.filter((part) => part.type === 'image_url').length === 1), true)
  assert.deepEqual(run.mediaObservations.map((value) => value.summary), ['observation 1', 'observation 2'])
  assert.equal(run.mediaObservations.every((value) => value.facts.length === 1), true)
  const projectedUser = agentMessages.findLast((message) => message.role === 'user')
  const structured = projectedUser.content.filter((part) => part.type === 'text' && String(part.text).startsWith('{')).map((part) => JSON.parse(part.text))
  assert.equal(structured.length, 2)
  assert.deepEqual(structured.map((value) => value.observation.summary), ['observation 1', 'observation 2'])
  assert.equal(projectedUser.content.some((part) => part.type === 'image_url'), false)
})

test('vision BYOK hydrates private images only for provider requests and never checkpoints data URLs', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-byok-media-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const image = path.join(root, 'reference.png')
  await fs.writeFile(image, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24, 3),
  ]))
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const providerInputs = []
  const manager = new RunManager({
    store,
    config: { get: async () => ({ mode: 'byok', provider: 'openrouter', model: 'vision-model', runtime: 'html', cloudLogs: false }) },
    credentials: { get: async () => 'configured' }, auth: {}, apiFactory: () => ({}),
    byok: {
      capability: async () => ({ vision: true }),
      complete: async (input) => { providerInputs.push(structuredClone(input.messages)); return { role: 'assistant', content: 'thinking' } },
    },
    threeD: {}, cloudLogs: null,
  })

  const run = await manager.create({ workspace, prompt: 'Use this image', mode: 'byok', provider: 'openrouter', referenceImages: [image] })
  const firstUser = providerInputs[0].findLast((message) => message.role === 'user')
  assert.match(firstUser.content.find((part) => part.type === 'image_url').image_url.url, /^data:image\/png;base64,/)
  const checkpoint = await fs.readFile(path.join(store.directory(run.id), 'checkpoint.json'), 'utf8')
  assert.doesNotMatch(checkpoint, /data:image\//)
  assert.match(checkpoint, /orbit\.agent-input-item\.v1/)
})

test('same-provider Thread continuation rehydrates prior private images without persisting bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-byok-media-thread-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const image = path.join(root, 'reference.png')
  await fs.writeFile(image, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24, 4),
  ]))
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const providerInputs = []
  let calls = 0
  const manager = new RunManager({
    store,
    config: { get: async () => ({ mode: 'byok', provider: 'openrouter', model: 'vision-model', runtime: 'html', cloudLogs: false }) },
    credentials: { get: async () => 'configured' }, auth: {}, apiFactory: () => ({}),
    byok: {
      capability: async () => ({ vision: true }),
      complete: async (input) => {
        providerInputs.push(structuredClone(input.messages))
        calls += 1
        if (calls === 1) return { role: 'assistant', content: '', tool_calls: [
          tool('plan-image', 'update_agent_plan', { summary: 'Build', todos: [{ id: 'build', title: 'Build', status: 'in_progress', kind: 'code' }] }),
          tool('html-image', 'write_file', { path: 'index.html', content: '<!doctype html><meta name="viewport" content="width=device-width"><button>Leaderboard</button><script src="game.js"></script>' }),
          tool('js-image', 'write_file', { path: 'game.js', content: 'OrbitArcade.startGame(); OrbitArcade.endGame({score:1})' }),
          tool('validate-image', 'validate_project', {}),
          tool('done-image', 'update_agent_plan', { summary: 'Ready', todos: [{ id: 'build', title: 'Build', status: 'completed', kind: 'code' }] }),
          tool('finish-image', 'finish', {}),
        ] }
        return { role: 'assistant', content: 'thinking' }
      },
    },
    threeD: {}, cloudLogs: null,
  })

  const first = await manager.create({ workspace, prompt: 'Use this image', mode: 'byok', provider: 'openrouter', model: 'vision-model', referenceImages: [image] })
  assert.equal(first.state, 'completed')
  const beforeSwitchRuns = await store.list()
  const beforeSwitchTurns = (await store.listThreads(workspace))[0].turns.length
  await assert.rejects(
    manager.create({ workspace, threadId: first.threadId, prompt: 'Switch provider', mode: 'byok', provider: 'deepseek', model: 'vision-model' }),
    (error) => error?.code === 'VISION_PROVIDER_BOUNDARY',
  )
  assert.equal((await store.list()).length, beforeSwitchRuns.length)
  assert.equal((await store.listThreads(workspace))[0].turns.length, beforeSwitchTurns)
  await assert.rejects(
    manager.create({
      workspace, threadId: first.threadId, prompt: 'Overflow history', mode: 'byok', provider: 'openrouter', model: 'vision-model',
      referenceImages: Array.from({ length: 8 }, () => image),
    }),
    (error) => error?.code === 'VISION_HISTORY_LIMIT',
  )
  assert.equal((await store.list()).length, beforeSwitchRuns.length)
  assert.equal((await store.listThreads(workspace))[0].turns.length, beforeSwitchTurns)
  const second = await manager.create({ workspace, threadId: first.threadId, prompt: 'Keep the same visual language', mode: 'byok', provider: 'openrouter', model: 'vision-model' })
  assert.equal(second.state, 'paused')
  const secondRequest = providerInputs[1]
  const priorImages = secondRequest.flatMap((message) => Array.isArray(message.content)
    ? message.content.filter((part) => part.type === 'image_url')
    : [])
  assert.equal(priorImages.length, 1)
  assert.match(priorImages[0].image_url.url, /^data:image\/png;base64,/)
  assert.doesNotMatch(await fs.readFile(path.join(store.directory(second.id), 'checkpoint.json'), 'utf8'), /data:image\//)
})

test('text-only BYOK media and cross-project Thread mismatch fail before Run, Turn, or workspace attachment writes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-media-preflight-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspaceA = path.join(root, 'workspace-a')
  const workspaceB = path.join(root, 'workspace-b')
  await fs.mkdir(workspaceA)
  await fs.mkdir(workspaceB)
  const image = path.join(root, 'reference.png')
  await fs.writeFile(image, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 5)]))
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const thread = await store.createThread(workspaceA, 'Media preflight')
  const manager = new RunManager({
    store,
    config: { get: async () => ({ mode: 'byok', provider: 'openrouter', model: 'text-model', runtime: 'html', cloudLogs: false }) },
    credentials: { get: async () => 'configured' }, auth: {}, apiFactory: () => ({}),
    byok: { capability: async () => ({ vision: false }), complete: async () => { throw new Error('Provider must not be called') } },
    threeD: {}, cloudLogs: null,
  })

  await assert.rejects(
    manager.create({ workspace: workspaceA, threadId: thread.id, prompt: 'Attach', mode: 'byok', provider: 'openrouter', model: 'text-model', referenceImages: [image] }),
    (error) => error?.code === 'VISION_UNAVAILABLE',
  )
  await assert.rejects(
    manager.create({ workspace: workspaceB, threadId: thread.id, prompt: 'Wrong project', mode: 'byok', provider: 'openrouter', model: 'vision-model', referenceImages: [image] }),
    /Session does not belong/,
  )
  assert.equal((await store.list()).length, 0)
  assert.equal((await store.listThreads(workspaceA))[0].turns.length, 0)
  assert.equal(await fs.stat(path.join(workspaceA, '.orbit')).then(() => true, () => false), false)
  assert.equal(await fs.stat(path.join(workspaceB, '.orbit')).then(() => true, () => false), false)
})

test('semantic compaction uses the model without consuming an agent iteration', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-semantic-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const messages = Array.from({ length: 142 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: index === 0 ? 'Build the durable objective' : `historical decision ${index}`,
  }))
  const run = await linkedInterruptedRun(store, workspace, messages)
  let summaryCalls = 0
  let agentCalls = 0
  const manager = localManager(store, async (input) => {
    if (String(input.system || '').includes('semantic summary')) {
      summaryCalls += 1
      assert.equal(input.tools.length, 0)
      assert.equal(input.maxOutputTokens, 5_000)
      return { role: 'assistant', content: JSON.stringify({ objective: 'Build the durable objective', latestUserIntent: 'Continue', decisions: [{ summary: 'Keep the previous architecture', sourceRefs: [] }] }) }
    }
    agentCalls += 1
    return { role: 'assistant', content: 'thinking' }
  })

  const resumed = await manager.resume(run.id)
  assert.equal(resumed.state, 'paused')
  assert.equal(summaryCalls, 1)
  assert.equal(agentCalls, 3)
  assert.equal(resumed.iteration, 3)
  assert.equal(resumed.messages.some((message) => String(message.content).includes('Keep the previous architecture')), true)
  const events = await store.events(run.id)
  assert.equal(events.filter((event) => event.type === 'context_compaction_started').length, 1)
  assert.equal(events.find((event) => event.type === 'context_compacted')?.mode, 'semantic')
})

test('semantic compaction keeps a middle visual Turn available for same-provider hydration', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-visual-compaction-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const image = path.join(root, 'reference.png')
  await fs.writeFile(image, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24, 6),
  ]))
  const references = await ingestReferenceImages(workspace, [image])
  const visualItems = turnInputItems('Use the visual composition.', references, 'turn-visual')
  const visualTurn = persistentVisionTurnInputMessage(visualItems, 'turn-visual', 'openrouter')
  const currentTurnId = 'turn_77777777-7777-4777-8777-777777777777'
  const currentTurn = {
    role: 'user', content: 'Continue the current implementation.',
    inputItems: [{ schema: 'orbit.agent-input-item.v1', id: 'current-input', type: 'text', text: 'Continue the current implementation.' }],
    orbit_internal: { schema: 'orbit.cli-turn-marker.v1', type: 'turn_input', turnId: currentTurnId },
  }
  const messages = [
    { role: 'user', content: 'Build the visual game.' },
    ...Array.from({ length: 40 }, (_, index) => ({ role: 'assistant', content: `early-${index} ${'x'.repeat(1_000)}` })),
    visualTurn,
    ...Array.from({ length: 80 }, (_, index) => ({ role: index % 2 ? 'user' : 'assistant', content: `history-${index} ${'y'.repeat(1_000)}` })),
    currentTurn,
    ...Array.from({ length: 20 }, (_, index) => ({ role: 'assistant', content: `tail-${index} ${'z'.repeat(1_000)}` })),
  ]
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const run = await linkedInterruptedRun(store, workspace, messages)
  run.visionCapability = { provider: 'openrouter', model: 'test-model', vision: true, confirmedAt: new Date().toISOString() }
  await store.save(run)
  const agentRequests = []
  const manager = localManager(store, async (input) => {
    if (String(input.system || '').includes('semantic summary')) {
      return { role: 'assistant', content: JSON.stringify({ objective: 'Build the visual game.', latestUserIntent: 'Continue.', decisions: [] }) }
    }
    agentRequests.push(structuredClone(input.messages))
    return { role: 'assistant', content: 'thinking' }
  })

  const resumed = await manager.resume(run.id)
  assert.equal(resumed.state, 'paused')
  assert.equal(agentRequests.length, 3)
  assert.equal(agentRequests.every((request) => request.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part.type === 'image_url' && /^data:image\/png;base64,/.test(part.image_url.url)))), true)
  const checkpoint = await fs.readFile(path.join(store.directory(run.id), 'checkpoint.json'), 'utf8')
  assert.match(checkpoint, /turn-visual/)
  assert.doesNotMatch(checkpoint, /data:image\//)
})

test('pending BYOK semantic compaction requires explicit unsafe retry while ready summaries commit locally', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-semantic-recovery-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const baseMessages = Array.from({ length: 142 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `history ${index}` }))

  for (const status of ['pending', 'ready']) {
    const workspace = path.join(root, status)
    const store = new RunStore({ directories: { config: path.join(root, `${status}-config`), data: path.join(root, `${status}-data`) } })
    const run = await linkedInterruptedRun(store, workspace, structuredClone(baseMessages))
    const preparation = prepareAgentMessageCompaction(run.messages, { profile: 'cli-local' })
    run.pendingSemanticCompaction = {
      schema: 'orbit.cli-semantic-compaction.v1',
      sourceFingerprint: preparation.sourceFingerprint,
      generation: preparation.generation,
      requestKey: `persisted-${status}`,
      status,
      ...(status === 'ready' ? { rawSemanticSummary: JSON.stringify({ objective: 'Recovered summary', latestUserIntent: 'Continue safely' }) } : {}),
    }
    await store.save(run)
    let summaryCalls = 0
    const manager = localManager(store, async (input) => {
      if (String(input.system || '').includes('semantic summary')) {
        summaryCalls += 1
        return { role: 'assistant', content: JSON.stringify({ objective: 'Retried summary', latestUserIntent: 'Continue safely' }) }
      }
      return { role: 'assistant', content: 'thinking' }
    })
    const first = await manager.resume(run.id)
    if (status === 'pending') {
      assert.equal(first.lastError.code, 'UNSAFE_RETRY_CONFIRMATION_REQUIRED')
      assert.equal(summaryCalls, 0)
      const retried = await manager.resume(run.id, { retryUnsafe: true })
      assert.equal(retried.state, 'paused')
      assert.equal(summaryCalls, 1)
    } else {
      assert.equal(first.state, 'paused')
      assert.equal(summaryCalls, 0)
      assert.equal(first.messages.some((message) => String(message.content).includes('Recovered summary')), true)
    }
  }
})

test('ambiguous BYOK semantic transport failure keeps its pending request and never auto-replays billing', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-semantic-transport-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const messages = Array.from({ length: 142 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `history ${index}` }))
  const run = await linkedInterruptedRun(store, workspace, messages)
  let summaryCalls = 0
  const manager = localManager(store, async (input) => {
    if (String(input.system || '').includes('semantic summary')) {
      summaryCalls += 1
      if (summaryCalls === 1) throw Object.assign(new Error('connection reset after request'), { code: 'ECONNRESET' })
      return { role: 'assistant', content: JSON.stringify({ objective: 'Recovered after confirmation', latestUserIntent: 'Continue' }) }
    }
    return { role: 'assistant', content: 'thinking' }
  })

  const first = await manager.resume(run.id)
  assert.equal(first.state, 'paused')
  assert.equal(first.unsafeResumeRequired, true)
  assert.equal(first.pendingSemanticCompaction.status, 'pending')
  assert.equal(summaryCalls, 1)

  const held = await manager.resume(run.id)
  assert.equal(held.lastError.code, 'UNSAFE_RETRY_CONFIRMATION_REQUIRED')
  assert.equal(summaryCalls, 1)

  const retried = await manager.resume(run.id, { retryUnsafe: true })
  assert.equal(retried.state, 'paused')
  assert.equal(summaryCalls, 2)
  assert.equal(retried.pendingSemanticCompaction, null)
})

test('failed and cancelled terminal Turns continue their protocol-safe transcript instead of resetting the Thread', async (t) => {
  for (const state of ['failed', 'cancelled']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `orbit-manager-terminal-${state}-`))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(workspace)
    const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
    const thread = await store.createThread(workspace, `${state} continuation`)
    const turnId = 'turn_88888888-8888-4888-8888-888888888888'
    const terminal = await store.create({ workspace, prompt: 'Turn B', mode: 'byok', provider: 'openrouter', model: 'test-model', threadId: thread.id, turnId })
    terminal.messages = [
      { role: 'user', content: 'Turn A intent' },
      { role: 'assistant', content: 'Turn A result' },
      { role: 'user', content: 'Turn B correction' },
      { role: 'assistant', content: `Turn B ${state}` },
    ]
    await store.linkRunToTurn({
      workspace, threadId: thread.id, runId: terminal.id, preferredTurnId: turnId, baseMessageCount: 0,
      inputItems: [{ schema: 'orbit.agent-input-item.v1', id: 'terminal-input', type: 'text', text: 'Turn B correction' }],
    })
    await store.transition(terminal, state)
    let firstRequest
    const manager = localManager(store, async ({ messages }) => {
      firstRequest ||= structuredClone(messages)
      return { role: 'assistant', content: 'thinking' }
    })
    const next = await manager.create({ workspace, threadId: thread.id, prompt: 'Turn C follow-up', mode: 'byok', provider: 'openrouter', model: 'test-model' })
    assert.equal(next.state, 'paused')
    const text = JSON.stringify(firstRequest)
    assert.match(text, /Turn A intent/)
    assert.match(text, /Turn B correction/)
    assert.match(text, /Turn C follow-up/)
  }
})

test('relocated legacy tool results never send old or current absolute workspace roots to the provider', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-relocated-path-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html>')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const thread = await store.createThread(workspace, 'Relocated session')
  const turnId = 'turn_99999999-9999-4999-8999-999999999999'
  const first = await store.create({ workspace, prompt: 'Inspect', mode: 'byok', provider: 'openrouter', model: 'test-model', threadId: thread.id, turnId })
  first.messages = [
    { role: 'user', content: 'Inspect index' },
    { role: 'assistant', content: '', tool_calls: [
      tool('legacy-read', 'read_file', { path: 'index.html' }),
      tool('legacy-list', 'list_files', {}),
      tool('legacy-shell', 'shell', { command: 'pwd' }),
      tool('legacy-asset', 'generate_image', { prompt: 'icon', output_path: 'assets/icon.png' }),
      tool('legacy-error', 'read_file', { path: 'missing.html' }),
    ] },
    { role: 'tool', tool_call_id: 'legacy-read', content: JSON.stringify({ path: path.join(workspace, 'index.html'), content: 'const example = "/opt/example/path"' }) },
    { role: 'tool', tool_call_id: 'legacy-list', content: `${path.join(workspace, 'index.html')}\nindex.html` },
    { role: 'tool', tool_call_id: 'legacy-shell', content: JSON.stringify({ output: `${workspace}\nbuild ok`, code: 0 }) },
    { role: 'tool', tool_call_id: 'legacy-asset', content: JSON.stringify({ path: path.join(workspace, 'assets', 'icon.png'), relativePath: 'assets/icon.png', hash: 'abc123' }) },
    { role: 'tool', tool_call_id: 'legacy-error', content: JSON.stringify({ ok: false, error: `ENOENT ${path.join(workspace, 'missing.html')}` }) },
    { role: 'assistant', content: 'Inspected.' },
  ]
  await store.linkRunToTurn({
    workspace, threadId: thread.id, runId: first.id, preferredTurnId: turnId, baseMessageCount: 0,
    inputItems: [{ schema: 'orbit.agent-input-item.v1', id: 'relocated-input', type: 'text', text: 'Inspect index' }],
  })
  await store.transition(first, 'completed')
  const moved = path.join(root, 'moved')
  await fs.rename(workspace, moved)
  const canonicalMoved = await fs.realpath(moved)
  await store.relocateWorkspace(first.id, canonicalMoved)
  let firstRequest
  const manager = localManager(store, async ({ messages }) => {
    firstRequest ||= structuredClone(messages)
    return { role: 'assistant', content: 'thinking' }
  })

  await manager.create({ workspace: canonicalMoved, threadId: thread.id, prompt: 'Continue', mode: 'byok', provider: 'openrouter', model: 'test-model' })

  const wire = JSON.stringify(firstRequest)
  assert.doesNotMatch(wire, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(wire, new RegExp(canonicalMoved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(wire, /\/opt\/example\/path/)
  assert.match(wire, /assets\/icon\.png/)
})

test('thread creation lease rejects a concurrent active sibling turn', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-thread-lease-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const thread = await store.createThread(workspace, 'One active turn')
  let releaseFirst
  let firstProviderStarted
  const started = new Promise((resolve) => { firstProviderStarted = resolve })
  const gate = new Promise((resolve) => { releaseFirst = resolve })
  let calls = 0
  const manager = localManager(store, async () => {
    calls += 1
    if (calls === 1) { firstProviderStarted(); await gate }
    return { role: 'assistant', content: 'thinking' }
  })
  const first = manager.create({ workspace, threadId: thread.id, prompt: 'First', mode: 'byok', provider: 'openrouter' })
  await started
  await assert.rejects(
    manager.create({ workspace, threadId: thread.id, prompt: 'Second', mode: 'byok', provider: 'openrouter' }),
    /has a resumable run|workspace is already active/,
  )
  releaseFirst()
  await first
  const snapshot = (await store.listThreads(workspace)).find((value) => value.id === thread.id)
  assert.equal(snapshot.turns.length, 1)
  assert.equal(snapshot.runIds.length, 1)
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
