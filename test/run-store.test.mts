import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RunStore } from '../src/run-store.mjs'
import { withRecoveryView } from '../src/recovery-view.mjs'

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

test('recovers a pending BYOK image by polling its saved Replicate prediction without unsafe replay', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const run = await store.create({ workspace, prompt: 'test', mode: 'byok' })
  run.pendingTool = { id: 'image-call-1', name: 'generate_image', arguments: '{}' }
  run.assetImages = { 'image-call-1': { predictionId: 'prediction-1', status: 'processing', requestPending: false } }
  await store.transition(run, 'running')
  const [recovered] = await store.recoverInterrupted()
  assert.equal(recovered.state, 'interrupted')
  assert.equal(recovered.unsafeResumeRequired, false)
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

test('create never overwrites an existing run id', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const run = await store.create({ workspace, prompt: 'original' })
  const checkpoint = path.join(store.directory(run.id), 'checkpoint.json')
  const before = await fs.readFile(checkpoint, 'utf8')

  await assert.rejects(
    store.create({ id: run.id, workspace, prompt: 'replacement' }),
    (error) => error?.code === 'EEXIST',
  )
  assert.equal(await fs.readFile(checkpoint, 'utf8'), before)
  assert.equal((await store.load(run.id)).prompt, 'original')
})

test('reads the bounded local event timeline for on-demand run details', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const run = await store.create({ workspace, prompt: 'test', mode: 'orbit' })
  await store.appendEvent(run.id, 'tool_completed', { toolName: 'validate_project', success: true, durationMs: 250 })

  const events = await store.events(run.id)
  assert.equal(events.at(-1).type, 'tool_completed')
  assert.equal(events.at(-1).toolName, 'validate_project')
  assert.equal(events.at(-1).durationMs, 250)
})

test('does not persist the derived recovery view into v1 checkpoints', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const run = await store.create({ workspace, prompt: 'test', mode: 'orbit' })
  run.lastError = { code: 'AGENT_NO_TOOL_PROGRESS', message: 'paused' }
  await store.transition(run, 'paused')

  const view = withRecoveryView(await store.load(run.id))
  const checkpoint = JSON.parse(await fs.readFile(path.join(store.directory(run.id), 'checkpoint.json'), 'utf8'))

  assert.equal(view.failureCategory, 'no_progress')
  assert.equal(view.recoveryDisposition, 'available')
  assert.equal(Object.hasOwn(checkpoint, 'failureCategory'), false)
  assert.equal(Object.hasOwn(checkpoint, 'recoveryDisposition'), false)
  assert.equal(checkpoint.schema, 'orbit.cli-run.v1')
})

test('relocates every checkpoint that points at a moved workspace', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const first = await store.create({ workspace, prompt: 'first', mode: 'orbit' })
  first.result = { workspace, relativePath: 'dist/index.html' }
  first.references = [{ path: path.join(workspace, '.orbit', 'references', 'cover.png'), privatePath: '.orbit/references/cover.png' }]
  await store.save(first)
  const second = await store.create({ workspace, prompt: 'second', mode: 'orbit' })
  const otherWorkspace = path.join(path.dirname(workspace), 'other-workspace')
  await fs.mkdir(otherWorkspace)
  const unrelated = await store.create({ workspace: otherWorkspace, prompt: 'other', mode: 'orbit' })
  const moved = path.join(path.dirname(workspace), 'moved-workspace')
  await fs.rename(workspace, moved)

  const result = await store.relocateWorkspace(first.id, moved)

  assert.deepEqual(new Set(result.updatedRunIds), new Set([first.id, second.id]))
  assert.equal((await store.load(first.id)).workspace, await fs.realpath(moved))
  assert.equal((await store.load(first.id)).result.workspace, await fs.realpath(moved))
  assert.equal((await store.load(first.id)).references[0].path, path.join(await fs.realpath(moved), '.orbit', 'references', 'cover.png'))
  assert.equal((await store.load(second.id)).workspace, await fs.realpath(moved))
  assert.equal((await store.load(unrelated.id)).workspace, otherWorkspace)
})

test('list automatically resumes a durable pending workspace relocation after restart', async (t) => {
  const { store, workspace } = await storeFixture(t)
  await store.createThread(workspace, 'Relocation project')
  const first = await store.create({ workspace, prompt: 'first', mode: 'orbit' })
  const second = await store.create({ workspace, prompt: 'second', mode: 'orbit' })
  const moved = path.join(path.dirname(workspace), 'moved-after-crash')
  await fs.rename(workspace, moved)
  const canonicalMoved = await fs.realpath(moved)
  first.workspace = canonicalMoved
  await store.save(first)
  const project = (await store.conversations.projects())[0]
  const relocationDirectory = path.join(store.directories.data, 'relocations')
  await fs.mkdir(relocationDirectory, { recursive: true })
  await fs.writeFile(path.join(relocationDirectory, `${first.id}.json`), `${JSON.stringify({
    schema: 'orbit.cli-workspace-relocation.v1',
    anchorRunId: first.id,
    previousWorkspace: workspace,
    workspace: canonicalMoved,
    projectId: project.id,
    runIds: [first.id, second.id],
    completedRunIds: [first.id],
    state: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })}\n`)

  const restarted = new RunStore({ directories: store.directories })
  await restarted.list()

  assert.equal((await restarted.load(first.id)).workspace, canonicalMoved)
  assert.equal((await restarted.load(second.id)).workspace, canonicalMoved)
  assert.equal((await restarted.conversations.projects())[0].rootRef, canonicalMoved)
  const intent = JSON.parse(await fs.readFile(path.join(relocationDirectory, `${first.id}.json`), 'utf8'))
  assert.equal(intent.state, 'completed')
})

test('completed relocation history does not require the old target to exist or block a later move', async (t) => {
  const { store, workspace } = await storeFixture(t)
  await store.createThread(workspace, 'Repeated move')
  const run = await store.create({ workspace, prompt: 'move twice', mode: 'orbit' })
  const movedOnce = path.join(path.dirname(workspace), 'moved-once')
  await fs.rename(workspace, movedOnce)
  await store.relocateWorkspace(run.id, movedOnce)
  const movedTwice = path.join(path.dirname(workspace), 'moved-twice')
  await fs.rename(movedOnce, movedTwice)

  const restarted = new RunStore({ directories: store.directories })
  assert.equal((await restarted.list()).some((candidate) => candidate.id === run.id), true)
  const relocated = await restarted.relocateWorkspace(run.id, movedTwice)
  assert.equal((await restarted.load(run.id)).workspace, await fs.realpath(movedTwice))
  assert.equal((await restarted.conversations.projects())[0].rootRef, await fs.realpath(movedTwice))
  assert.deepEqual(relocated.updatedRunIds, [run.id])
})

test('corrupt relocation journals fail closed instead of being treated as absent', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const run = await store.create({ workspace, prompt: 'journal', mode: 'orbit' })
  const relocationDirectory = path.join(store.directories.data, 'relocations')
  await fs.mkdir(relocationDirectory, { recursive: true })
  await fs.writeFile(path.join(relocationDirectory, `${run.id}.json`), '{"schema":')

  await assert.rejects(store.list(), /JSON|Unexpected|position|end of JSON/i)
  assert.equal((await store.load(run.id)).workspace, workspace)
})

test('relocation journals reject duplicate ids and cursor/checkpoint mismatches before any write', async (t) => {
  for (const variant of ['duplicate', 'cursor-mismatch']) {
    const { store, workspace } = await storeFixture(t)
    await store.createThread(workspace, `Relocation ${variant}`)
    const run = await store.create({ workspace, prompt: variant, mode: 'orbit' })
    const target = path.join(path.dirname(workspace), `moved-${variant}`)
    await fs.mkdir(target)
    const canonicalTarget = await fs.realpath(target)
    const project = (await store.conversations.projects()).at(-1)
    const relocationDirectory = path.join(store.directories.data, 'relocations')
    await fs.mkdir(relocationDirectory, { recursive: true })
    const journal = {
      schema: 'orbit.cli-workspace-relocation.v1',
      anchorRunId: run.id,
      previousWorkspace: workspace,
      workspace: canonicalTarget,
      projectId: project.id,
      runIds: variant === 'duplicate' ? [run.id, run.id] : [run.id],
      completedRunIds: variant === 'cursor-mismatch' ? [run.id] : [],
      state: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const journalFile = path.join(relocationDirectory, `${run.id}.json`)
    await fs.writeFile(journalFile, `${JSON.stringify(journal)}\n`)
    const beforeCheckpoint = await fs.readFile(path.join(store.directory(run.id), 'checkpoint.json'))
    const beforeJournal = await fs.readFile(journalFile)
    const beforeProject = await fs.readFile(path.join(store.directories.data, 'conversations', 'projects', `${project.id}.json`))

    await assert.rejects(store.list(), /relocation (?:journal is invalid|cursor does not match)/i)
    assert.deepEqual(await fs.readFile(path.join(store.directory(run.id), 'checkpoint.json')), beforeCheckpoint)
    assert.deepEqual(await fs.readFile(journalFile), beforeJournal)
    assert.deepEqual(await fs.readFile(path.join(store.directories.data, 'conversations', 'projects', `${project.id}.json`)), beforeProject)
  }
})

test('workspace relocation collision is rejected before any checkpoint changes', async (t) => {
  const { store, workspace } = await storeFixture(t)
  await store.createThread(workspace, 'Source project')
  const source = await store.create({ workspace, prompt: 'source', mode: 'orbit' })
  const target = path.join(path.dirname(workspace), 'target-project')
  await fs.mkdir(target)
  await store.createThread(target, 'Target project')
  const beforeCheckpoint = await fs.readFile(path.join(store.directory(source.id), 'checkpoint.json'))
  const beforeProjects = await Promise.all((await store.conversations.projects()).map(async (project) => ({
    id: project.id,
    bytes: await fs.readFile(path.join(store.directories.data, 'conversations', 'projects', `${project.id}.json`)),
  })))

  await assert.rejects(store.relocateWorkspace(source.id, target), /already belongs to another canonical project/)

  assert.deepEqual(await fs.readFile(path.join(store.directory(source.id), 'checkpoint.json')), beforeCheckpoint)
  for (const project of beforeProjects) {
    assert.deepEqual(await fs.readFile(path.join(store.directories.data, 'conversations', 'projects', `${project.id}.json`)), project.bytes)
  }
})

test('lazy conversation indexing reads legacy runs in place without rewriting checkpoints or events', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const first = await store.create({ workspace, prompt: 'first legacy turn', mode: 'orbit' })
  first.messages = [{ role: 'user', content: 'first legacy turn' }, { role: 'assistant', content: 'done' }]
  await store.transition(first, 'completed')
  const second = await store.create({ workspace, prompt: 'second legacy turn', mode: 'orbit' })
  second.messages = [{ role: 'user', content: 'second legacy turn' }, { role: 'assistant', content: 'done again' }]
  await store.transition(second, 'completed')
  const files = [first, second].flatMap((run) => [
    path.join(store.directory(run.id), 'checkpoint.json'),
    path.join(store.directory(run.id), 'events.jsonl'),
  ])
  const before = await Promise.all(files.map((file) => fs.readFile(file)))

  const threads = await store.listThreads(workspace)
  assert.equal(threads.length, 2)
  assert.equal(threads.every((thread) => thread.schema === 'orbit.agent-thread.v1'), true)
  assert.equal(threads.every((thread) => thread.projectId?.startsWith('project_')), true)
  assert.deepEqual(new Set(threads.flatMap((thread) => thread.runIds)), new Set([first.id, second.id]))
  assert.equal(threads.every((thread) => thread.turns.length === 1), true)
  assert.equal(threads.every((thread) => thread.turns[0].schema === 'orbit.agent-turn.v1'), true)
  assert.deepEqual(new Set((await store.listThreads(workspace)).map((value) => value.id)), new Set(threads.map((thread) => thread.id)))
  const after = await Promise.all(files.map((file) => fs.readFile(file)))
  assert.deepEqual(after, before)
})

test('legacy deterministic Thread creation crash is reused on lazy migration', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const run = await store.create({ workspace, prompt: 'legacy crash', mode: 'orbit' })
  run.messages = [{ role: 'user', content: 'legacy crash' }, { role: 'assistant', content: 'recovered' }]
  await store.transition(run, 'completed')
  const preferredThreadId = `thread_${run.id.slice('run_'.length)}`
  const stranded = await store.conversations.createThread(workspace, {
    title: 'legacy crash', legacy: true, preferredId: preferredThreadId,
  })

  const [thread] = await new RunStore({ directories: store.directories }).listThreads(workspace)

  assert.equal(thread.id, stranded.id)
  assert.deepEqual(thread.runIds, [run.id])
  assert.equal(thread.turns.length, 1)
})

test('legacy same-Thread output boundaries require an exact cumulative transcript prefix', async (t) => {
  for (const variant of ['exact', 'non-prefix', 'shorter']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `orbit-prefix-${variant}-`))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(workspace)
    const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
    const thread = await store.createThread(workspace, 'Legacy cumulative session')
    const first = await store.create({ workspace, prompt: 'A', mode: 'orbit', threadId: thread.id })
    first.messages = [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'A-result' }]
    await store.transition(first, 'completed')
    const second = await store.create({ workspace, prompt: 'B', mode: 'orbit', threadId: thread.id })
    second.messages = variant === 'exact'
      ? [...structuredClone(first.messages), { role: 'user', content: 'B' }, { role: 'assistant', content: 'B-result' }]
      : variant === 'shorter'
        ? [{ role: 'user', content: 'B' }]
        : [{ role: 'user', content: 'different history' }, { role: 'assistant', content: 'B-result' }]
    await store.transition(second, 'completed')

    if (variant !== 'exact') {
      await assert.rejects(store.listThreads(workspace), (error) => error?.code === 'LEGACY_TRANSCRIPT_BOUNDARY_UNSAFE')
      continue
    }
    const [snapshot] = await store.listThreads(workspace)
    assert.deepEqual(snapshot.runIds, [first.id, second.id])
    assert.deepEqual(snapshot.turns.map((turn) => turn.outputMessages.map((message) => message.content)), [['A-result'], ['B-result']])
  }
})

test('one canonical project supports multiple threads, turns, run links, and attempts', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const left = await store.createThread(workspace, 'Left session')
  const right = await store.createThread(workspace, 'Right session')
  assert.notEqual(left.id, right.id)
  const run = await store.create({ workspace, prompt: 'left turn' })
  await store.linkRunToTurn({
    workspace,
    threadId: left.id,
    runId: run.id,
    inputItems: [{ schema: 'orbit.agent-input-item.v1', id: 'left-text', type: 'text', text: 'left turn' }],
    baseMessageCount: 0,
  })
  const first = await store.startAttempt(run.id)
  const second = await store.startAttempt(run.id)
  assert.equal((await store.attemptsForRun(run.id))[0].state, 'interrupted')
  assert.equal(second.ordinal, 2)
  await store.finishAttempt(second.id, 'completed')
  const threads = await store.listThreads(workspace)
  assert.deepEqual(new Set(threads.map((thread) => thread.id)), new Set([left.id, right.id]))
  assert.deepEqual(threads.find((thread) => thread.id === left.id)?.runIds, [run.id])
  assert.deepEqual(threads.find((thread) => thread.id === right.id)?.runIds, [])
  assert.equal(first.turnId, (await store.linkForRun(run.id))?.turnId)
})

test('repairs a crash between canonical turn persistence and run-link persistence idempotently', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const thread = await store.createThread(workspace, 'Crash recovery')
  const turnId = 'turn_33333333-3333-4333-8333-333333333333'
  const run = await store.create({ workspace, prompt: 'repair me', threadId: thread.id, turnId })
  const inputItems = [{ schema: 'orbit.agent-input-item.v1', id: 'repair-text', type: 'text', text: 'repair me' }]
  const original = await store.linkRunToTurn({ workspace, threadId: thread.id, runId: run.id, inputItems, baseMessageCount: 0, preferredTurnId: turnId })
  await fs.unlink(path.join(store.directories.data, 'conversations', 'run-links', `${run.id}.json`))

  const restarted = new RunStore({ directories: store.directories })
  const [recoveredThread] = await restarted.listThreads(workspace)
  const repaired = await restarted.linkForRun(run.id)

  assert.equal(recoveredThread.id, thread.id)
  assert.equal(recoveredThread.turns.length, 1)
  assert.equal(recoveredThread.runIds[0], run.id)
  assert.equal(repaired?.turnId, original.id)
})

test('concurrent thread creation retains every canonical project thread id', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const threads = await Promise.all(Array.from({ length: 8 }, (_, index) => store.createThread(workspace, `Thread ${index + 1}`)))
  const projects = await store.conversations.projects()
  assert.equal(projects.length, 1)
  assert.deepEqual(new Set(projects[0].threadIds), new Set(threads.map((thread) => thread.id)))
})

test('startup reconciliation attributes compacted output by stable turn marker instead of message index', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const thread = await store.createThread(workspace, 'Compaction recovery')
  const turnId = 'turn_44444444-4444-4444-8444-444444444444'
  const run = await store.create({ workspace, prompt: 'current turn', threadId: thread.id, turnId })
  await store.linkRunToTurn({
    workspace,
    threadId: thread.id,
    runId: run.id,
    inputItems: [{ schema: 'orbit.agent-input-item.v1', id: 'current-text', type: 'text', text: 'current turn' }],
    baseMessageCount: 48,
    preferredTurnId: turnId,
  })
  run.messages = [
    { role: 'user', content: 'Older context was compacted.' },
    { role: 'user', content: 'current turn', orbit_internal: { schema: 'orbit.cli-turn-marker.v1', type: 'turn_input', turnId } },
    { role: 'assistant', content: 'CURRENT_OUTPUT' },
  ]
  await store.transition(run, 'completed')

  const restarted = new RunStore({ directories: store.directories })
  const recovered = (await restarted.listThreads(workspace))[0].turns[0]
  assert.equal(recovered.state, 'completed')
  assert.equal(recovered.outputMessages.some((message) => message.content === 'CURRENT_OUTPUT'), true)
})

test('concurrent canonical turn completion updates do not lose sibling turns', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const thread = await store.createThread(workspace, 'Completion serialization')
  const runs = []
  for (const [index, turnId] of [
    'turn_55555555-5555-4555-8555-555555555555',
    'turn_66666666-6666-4666-8666-666666666666',
  ].entries()) {
    const run = await store.create({ workspace, prompt: `turn ${index}`, threadId: thread.id, turnId })
    await store.linkRunToTurn({
      workspace, threadId: thread.id, runId: run.id, preferredTurnId: turnId, baseMessageCount: 0,
      inputItems: [{ schema: 'orbit.agent-input-item.v1', id: `text-${index}`, type: 'text', text: `turn ${index}` }],
    })
    run.messages = [
      { role: 'user', content: `turn ${index}`, orbit_internal: { schema: 'orbit.cli-turn-marker.v1', type: 'turn_input', turnId } },
      { role: 'assistant', content: `output ${index}` },
    ]
    await store.transition(run, 'completed')
    runs.push(run)
  }

  await Promise.all(runs.map((run) => store.updateTurnFromRun(run)))

  const recovered = await store.conversations.thread(thread.id)
  assert.equal(recovered.turns.length, 2)
  assert.deepEqual(recovered.turns.map((turn) => turn.outputMessages[0]?.content), ['output 0', 'output 1'])
})

test('canonical Turn display output is hard bounded and strips provider-native sidecars', async (t) => {
  const { store, workspace } = await storeFixture(t)
  const thread = await store.createThread(workspace, 'Bounded output')
  const turnId = 'turn_77777777-7777-4777-8777-777777777777'
  const run = await store.create({ workspace, prompt: 'large output', threadId: thread.id, turnId })
  await store.linkRunToTurn({
    workspace, threadId: thread.id, runId: run.id, preferredTurnId: turnId, baseMessageCount: 0,
    inputItems: [{ schema: 'orbit.agent-input-item.v1', id: 'large-output-input', type: 'text', text: 'large output' }],
  })
  const developerPath = path.join(path.parse(process.cwd()).root, 'Users', 'private')
  run.turnOutputMessages = [{
    role: 'assistant', content: 'done',
    response_items: [{ type: 'reasoning', encrypted_content: 'x'.repeat(1024 * 1024), metadata: { privatePath: developerPath } }],
    reasoning_details: [{ type: 'reasoning.encrypted', data: 'y'.repeat(1024 * 1024) }],
    orbit_internal: { secret: true },
  }]
  await store.transition(run, 'completed')
  await store.updateTurnFromRun(run)

  const canonical = await store.conversations.thread(thread.id)
  const serialized = JSON.stringify(canonical)
  assert.equal(Buffer.byteLength(serialized) < 300 * 1024, true)
  assert.equal(serialized.includes('response_items'), false)
  assert.equal(serialized.includes('reasoning_details'), false)
  assert.equal(serialized.includes('privatePath'), false)
  assert.equal(serialized.includes('orbit_internal'), false)
  assert.deepEqual(canonical.turns[0].outputMessages, [{ role: 'assistant', content: 'done' }])
})

test('same-timestamp canonical Turns preserve persisted sequence instead of random run-id order', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-run-timestamp-tie-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const timestamp = new Date('2026-08-12T00:00:00.000Z')
  const store = new RunStore({
    directories: { config: path.join(root, 'config'), data: path.join(root, 'data') },
    now: () => timestamp,
  })
  const thread = await store.createThread(workspace, 'Timestamp tie')
  const runs = [
    ['run_ffffffff-ffff-4fff-8fff-ffffffffffff', 'turn_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['run_11111111-1111-4111-8111-111111111111', 'turn_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
  ]
  for (const [runId, turnId] of runs) {
    const run = await store.create({ id: runId, workspace, prompt: runId, mode: 'orbit', threadId: thread.id, turnId })
    await store.linkRunToTurn({
      workspace, threadId: thread.id, runId, preferredTurnId: turnId, baseMessageCount: 0,
      inputItems: [{ schema: 'orbit.agent-input-item.v1', id: `input-${turnId}`, type: 'text', text: runId }],
    })
    run.messages = [{ role: 'user', content: runId, orbit_internal: { schema: 'orbit.cli-turn-marker.v1', type: 'turn_input', turnId } }]
    await store.transition(run, 'completed')
  }

  const [snapshot] = await store.listThreads(workspace)
  assert.deepEqual(snapshot.runIds, runs.map(([runId]) => runId))
  assert.equal(snapshot.latestRunId, runs[1][0])
})
