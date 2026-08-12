import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transform } from 'esbuild'
import {
  ORBIT_AGENT_CORE_VERSION,
  ORBIT_AGENT_MODEL_OUTPUT_LIMITS,
  ORBIT_PRO_AGENT_CORE_VERSION,
  agentMessageBudget,
  assertAgentInputProjectionReady,
  assertAgentTranscriptProtocol,
  buildOrbitAgentCoreModuleSource,
  buildOrbitProAgentCoreModuleSource,
  closeAgentToolBatchJournal,
  commitAgentMessageCompaction,
  createAgentToolBatchJournal,
  normalizeAgentInputItems,
  normalizeAgentMediaCache,
  normalizeAgentMediaObservation,
  normalizeAgentProject,
  normalizeAgentSession,
  normalizeAgentThread,
  prepareAgentMessageCompaction,
  projectAgentInputItemsForProvider,
  projectAgentMessagesForProvider,
  projectAgentTurnForProvider,
  recordAgentToolBatchResult,
} from './runtime.mjs'

test('storage-neutral project, session/thread, turn and input items round-trip legacy shapes', () => {
  const project = normalizeAgentProject({
    project_id: 'project-1', title: 'Arcade', workspace_ref: 'workspace:demo', thread_ids: ['thread-1'],
  })
  assert.deepEqual(normalizeAgentProject(JSON.parse(JSON.stringify(project))), project)

  const session = normalizeAgentSession({
    session_id: 'thread-1',
    project_id: 'project-1',
    turns: [{
      turn_id: 'turn-1',
      status: 'completed',
      input_items: [
        'Build a game.',
        { id: 'inline', type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        { id: 'local', type: 'local_image', local_path: 'references/local.png' },
        { id: 'brief', type: 'attachment', attachment_id: 'attachment-brief', name: 'brief.pdf', kind: 'document' },
        { id: 'brief-ref', type: 'reference', attachment_id: 'attachment-brief', label: 'Original brief' },
      ],
      output: [{ role: 'assistant', content: 'Done.' }],
    }],
  })
  assert.ok(session)
  assert.equal(session.schema, 'orbit.agent-thread.v1')
  const turn = session.turns[0]
  assert.ok(turn)
  assert.deepEqual(turn.inputItems.map((item) => item.type), ['text', 'image', 'localImage', 'attachment', 'ref'])
  const [, inline, local, attachment, reference] = turn.inputItems
  assert.ok(inline && inline.type === 'image')
  assert.equal(inline.url, 'data:image/png;base64,AA==')
  assert.ok(local && local.type === 'localImage')
  assert.equal(local.path, 'references/local.png')
  assert.ok(attachment && attachment.type === 'attachment')
  assert.equal(attachment.attachment.id, 'attachment-brief')
  assert.ok(reference && reference.type === 'ref')
  assert.equal(reference.ref.targetId, 'attachment-brief')
  assert.deepEqual(normalizeAgentThread(JSON.parse(JSON.stringify(session))), session)
})

test('media observations and cache stay bounded, structured and JSON-safe', () => {
  const observation = normalizeAgentMediaObservation({
    id: 'observation-1',
    attachmentId: 'attachment-1',
    kind: 'image',
    summary: 'A gameplay reference.',
    facts: Array.from({ length: 70 }, (_, index) => ({
      id: `fact-${index}`,
      label: 'layout',
      text: `Fact ${index}`,
      confidence: index === 0 ? 3 : 0.75,
    })),
  })
  assert.ok(observation)
  assert.equal(observation.facts.length, 64)
  assert.equal(observation.facts[0]?.confidence, 1)
  assert.deepEqual(normalizeAgentMediaObservation(JSON.parse(JSON.stringify(observation))), observation)

  const cache = normalizeAgentMediaCache({ entries: {
    primary: {
      mediaId: 'media-1', attachmentId: 'attachment-1', status: 'ready',
      resolved: { type: 'host_ref', value: 'host-media:1' }, observationId: observation.id,
    },
    remote: {
      attachmentId: 'attachment-remote', status: 'ready',
      resolved: { type: 'url', value: 'https://assets.example.test/reference.png' },
    },
    unsafe: {
      attachmentId: 'attachment-unsafe', status: 'ready',
      resolved: { type: 'url', value: 'https://127.0.0.1/reference.png' },
    },
  } })
  assert.equal(cache.entries[0]?.key, 'primary')
  assert.equal(cache.entries.find((entry) => entry.key === 'remote')?.resolved?.value, 'https://assets.example.test/reference.png')
  assert.equal(cache.entries.find((entry) => entry.key === 'unsafe')?.resolved, null)
  assert.equal(cache.entries.find((entry) => entry.key === 'unsafe')?.status, 'failed')
  assert.deepEqual(normalizeAgentMediaCache(JSON.parse(JSON.stringify(cache))), cache)
})

test('vision projection emits one identity-bearing image per visual input and does not misclassify document refs', () => {
  const items = normalizeAgentInputItems([
    { id: 'text', type: 'text', text: 'Use every reference.' },
    { id: 'inline', type: 'image', url: 'data:image/png;base64,AA==', mediaId: 'media-inline' },
    { id: 'local', type: 'localImage', path: 'reference/local.png', mediaId: 'media-local' },
    { id: 'image-attachment', type: 'attachment', attachment: { id: 'attachment-image', kind: 'image', name: 'image.png' } },
    { id: 'document-ref', type: 'ref', ref: { id: 'ref-document', kind: 'attachment', targetId: 'attachment-document' } },
  ])
  const projection = projectAgentInputItemsForProvider(items, {
    capabilities: { vision: true, imageInputs: ['url', 'data_url', 'host_ref'], maxImagesPerTurn: 8 },
    mediaCache: { entries: [
      { key: 'local', sourceItemId: 'local', mediaId: 'media-local', status: 'ready', resolved: { type: 'data_url', value: 'data:image/png;base64,AA==' }, mediaType: 'image/png' },
      { key: 'attachment-image', attachmentId: 'attachment-image', status: 'ready', resolved: { type: 'host_ref', value: 'host:image' }, mediaType: 'image/png' },
      { key: 'attachment-document', attachmentId: 'attachment-document', status: 'ready', resolved: { type: 'host_ref', value: 'host:document' }, mediaType: 'application/pdf', observationId: 'observation-document' },
    ] },
    observations: [{
      id: 'observation-document', attachmentId: 'attachment-document', kind: 'document', status: 'ready',
      summary: 'A two-page design brief.', facts: [{ id: 'objective', text: 'Preserve the core loop.' }],
    }],
  })
  assert.deepEqual(projection.inputItems, items)
  const images = projection.providerItems.filter((item) => item.type === 'input_image')
  assert.deepEqual(images.map((item) => item.sourceItemId), ['inline', 'local', 'image-attachment'])
  assert.equal(images.find((item) => item.sourceItemId === 'image-attachment')?.attachmentId, 'attachment-image')
  const document = projection.providerItems.find((item) => item.sourceItemId === 'document-ref')
  assert.equal(document?.type, 'input_text')
  assert.equal(JSON.parse(document!.text).attachmentId, 'attachment-document')
  assert.equal(projection.issues.length, 0)
})

test('vision projection selects a supported transport when observation and transport cache entries share an identity', () => {
  const projection = projectAgentInputItemsForProvider([
    { id: 'reference', type: 'attachment', attachment: { id: 'attachment-reference', kind: 'image' } },
  ], {
    capabilities: { vision: true, imageInputs: ['data_url'], maxImagesPerTurn: 8 },
    mediaCache: { entries: [
      {
        key: 'observation-handle', sourceItemId: 'reference', attachmentId: 'attachment-reference',
        status: 'ready', resolved: { type: 'host_ref', value: 'observation:reference' },
        observationId: 'observation-reference', mediaType: 'image/png',
      },
      {
        key: 'provider-transport', sourceItemId: 'reference', attachmentId: 'attachment-reference',
        status: 'ready', resolved: { type: 'data_url', value: 'data:image/png;base64,AA==' },
        mediaType: 'image/png',
      },
    ] },
    observations: [{
      id: 'observation-reference', attachmentId: 'attachment-reference', kind: 'image', status: 'ready',
      summary: 'A reference image.', facts: [{ id: 'fact-reference', text: 'A centered board.' }],
    }],
  })
  assert.equal(projection.blocked, false)
  assert.deepEqual(projection.issues, [])
  assert.deepEqual(projection.providerItems, [{
    type: 'input_image', sourceItemId: 'reference', attachmentId: 'attachment-reference',
    source: { type: 'data_url', value: 'data:image/png;base64,AA==' }, detail: 'auto',
  }])
})

test('vision image overflow requires a per-item observation before fallback', () => {
  const items = [
    { id: 'first', type: 'image', url: 'data:image/png;base64,AA==' },
    { id: 'second', type: 'image', url: 'data:image/png;base64,AQ==' },
  ]
  const missing = projectAgentInputItemsForProvider(items, {
    capabilities: { vision: true, imageInputs: ['data_url'], maxImagesPerTurn: 1 },
  })
  assert.equal(missing.providerItems[0]?.type, 'input_image')
  assert.equal(missing.providerItems[1]?.type, 'input_text')
  assert.equal(missing.blocked, true)
  assert.deepEqual(missing.issues.map((issue) => [issue.code, issue.severity]), [
    ['image_limit', 'warning'],
    ['media_observation_missing', 'error'],
  ])

  const observed = projectAgentInputItemsForProvider(items, {
    capabilities: { vision: true, imageInputs: ['data_url'], maxImagesPerTurn: 1 },
    observations: [{
      id: 'second-observation', mediaId: 'second', kind: 'image', status: 'ready',
      summary: 'The second reference.', facts: [{ id: 'second-layout', text: 'Two columns.' }],
    }],
  })
  assert.equal(observed.blocked, false)
  assert.deepEqual(observed.issues.map((issue) => [issue.code, issue.severity]), [['image_limit', 'warning']])
  assert.equal(JSON.parse((observed.providerItems[1] as { text: string }).text).observation.id, 'second-observation')
  assert.equal(assertAgentInputProjectionReady(observed), true)
})

test('text projection keeps each attachment identity and facts separate and fails closed when observation is missing', () => {
  const projection = projectAgentInputItemsForProvider([
    { id: 'a', type: 'attachment', attachment: { id: 'attachment-a', kind: 'image' } },
    { id: 'b', type: 'attachment', attachment: { id: 'attachment-b', kind: 'document' } },
    { id: 'missing', type: 'local_image', path: 'missing.png', attachment_id: 'attachment-missing' },
  ], {
    capabilities: { vision: false },
    observations: [
      { id: 'oa', attachmentId: 'attachment-a', kind: 'image', status: 'ready', summary: 'A board.', facts: [{ id: 'fa', text: 'Three lanes.' }] },
      { id: 'ob', attachmentId: 'attachment-b', kind: 'document', status: 'ready', summary: 'Rules.', facts: [{ id: 'fb', text: 'Five rounds.' }] },
    ],
  })
  assert.equal(projection.providerItems.length, 3)
  assert.ok(projection.providerItems.every((item) => item.type === 'input_text'))
  const envelopes = projection.providerItems.map((item) => JSON.parse((item as { text: string }).text))
  assert.deepEqual(envelopes.slice(0, 2).map((entry) => entry.attachmentId), ['attachment-a', 'attachment-b'])
  assert.deepEqual(envelopes.slice(0, 2).map((entry) => entry.observation.facts[0].id), ['fa', 'fb'])
  assert.deepEqual(projection.issues, [{
    code: 'media_observation_missing',
    severity: 'error',
    sourceItemId: 'missing',
    attachmentId: 'attachment-missing',
    message: 'A structured media observation is required before this input can be sent to the provider.',
  }])
  assert.equal(projection.blocked, true)
  assert.throws(() => assertAgentInputProjectionReady(projection), (error: any) => error?.code === 'ORBIT_AGENT_INPUT_PROJECTION_BLOCKED')
  assert.equal(JSON.stringify(projection.providerItems).includes('missing.png'), false)
})

test('text projection fails closed for failed, unavailable, or empty observations', () => {
  for (const observation of [
    { id: 'failed-observation', attachmentId: 'attachment-a', kind: 'image', status: 'failed', summary: 'Interpreter failed.', facts: [] },
    { id: 'unavailable-observation', attachmentId: 'attachment-a', kind: 'image', status: 'unavailable', summary: 'No pixels available.', facts: [] },
    { id: 'empty-observation', attachmentId: 'attachment-a', kind: 'image', status: 'ready', summary: '', facts: [] },
  ]) {
    const projection = projectAgentInputItemsForProvider([
      { id: 'a', type: 'attachment', attachment: { id: 'attachment-a', kind: 'image' } },
    ], {
      capabilities: { vision: false },
      observations: [observation],
    })
    assert.equal(projection.blocked, true)
    assert.deepEqual(projection.issues.map((issue) => [issue.code, issue.severity]), [
      ['media_observation_error', 'error'],
    ])
    assert.throws(
      () => assertAgentInputProjectionReady(projection),
      (error: any) => error?.code === 'ORBIT_AGENT_INPUT_PROJECTION_BLOCKED',
    )
  }
})

test('provider boundaries strip input sidecars and reject unsafe image URLs', () => {
  const message = {
    role: 'user',
    content: 'The host already projected the turn.',
    inputItems: [{ id: 'local', type: 'localImage', path: '/private/reference.png' }],
    input_items: [{ id: 'legacy', type: 'local_image', path: '/private/legacy.png' }],
    mediaObservations: [{ attachmentId: 'a', summary: 'private host state' }],
    media_observations: [{ attachmentId: 'b', summary: 'legacy host state' }],
    orbit_internal: { schema: 'orbit.agent-internal-message.v1' },
  }
  assert.deepEqual(projectAgentMessagesForProvider([message]), [{ role: 'user', content: message.content }])

  for (const url of [
    'file:///private/reference.png',
    'javascript:alert(1)',
    'http://example.test/reference.png',
    'https://example.test/reference.png',
    ['https', '://', 'user', ':', 'password', '@example.test/reference.png'].join(''),
    'https://localhost/reference.png',
    'https://127.0.0.1/reference.png',
    'https://0.0.0.0/reference.png',
    'https://100.64.0.1/reference.png',
    'https://198.18.0.1/reference.png',
    'https://224.0.0.1/reference.png',
    'https://[::ffff:127.0.0.1]/reference.png',
    'data:text/html;base64,PGgxPmJhZDwvaDE+',
    'data:image/svg+xml;base64,PHN2Zy8+',
  ]) {
    const projection = projectAgentInputItemsForProvider([{ id: 'unsafe', type: 'image', url }], {
      capabilities: { vision: true, imageInputs: ['url', 'data_url'] },
    })
    assert.equal(projection.providerItems.length, 0)
    assert.deepEqual(projection.issues.map((issue) => [issue.code, issue.severity]), [['invalid_input_item', 'error']])
  }
})

test('turn projection is a thin storage-neutral wrapper', () => {
  const projection = projectAgentTurnForProvider({
    turn_id: 'turn-project',
    session_id: 'thread-project',
    input: [{ id: 'prompt', type: 'text', text: 'Build it.' }],
  }, { capabilities: { vision: false } })
  assert.equal(projection.turn.id, 'turn-project')
  assert.equal(projection.turn.threadId, 'thread-project')
  assert.deepEqual(projection.providerItems, [{ type: 'input_text', sourceItemId: 'prompt', text: 'Build it.' }])
})

test('compaction fingerprints and projects attachment identity plus bounded observations', () => {
  const messages: any[] = [
    { role: 'user', content: 'Build the requested game.' },
    {
      role: 'user',
      content: 'Use the attached board.',
      input_items: [{ id: 'board-item', type: 'attachment', attachment: { id: 'attachment-board', kind: 'image' }, observationId: 'observation-board' }],
      media_observations: [{
        id: 'observation-board', attachmentId: 'attachment-board', kind: 'image', status: 'ready',
        summary: 'A board with three lanes.', facts: [{ id: 'lane-count', text: 'Three lanes.' }],
      }],
    },
    ...Array.from({ length: 24 }, (_, index) => ({ role: 'assistant', content: `step-${index} ${'x'.repeat(1_000)}` })),
  ]
  const preparation = prepareAgentMessageCompaction(messages, {
    profile: 'local-desktop',
    policy: { softChars: 20_000, compactMessageCount: 20, keepRecentMessages: 6 },
  })
  assert.equal(preparation.needed, true)
  assert.match(preparation.request!.messages[0]!.content, /attachment-board/)
  assert.match(preparation.request!.messages[0]!.content, /lane-count/)

  messages[1].input_items[0].attachment.id = 'attachment-mutated'
  const result = commitAgentMessageCompaction(messages, preparation, {
    schema: 'orbit.agent-semantic-summary.v1',
    objective: 'Build the requested game.', latestUserIntent: 'Use the board.',
    userConstraints: [], userCorrections: [], decisions: [], workspaceChanges: [], validation: [],
    failedApproaches: [], openWork: ['Build'], sourcesToRefresh: [], notes: [],
  })
  assert.equal(result.reason, 'stale_source')
})

test('structured Turn content is budgeted and preserved by deterministic compaction', () => {
  const objective = '实现一个保留三条道路和昼夜循环的完整游戏。'
  const messages: any[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: objective.repeat(900) },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      ],
      inputItems: [{ id: 'objective', type: 'text', text: objective }],
    },
    ...Array.from({ length: 30 }, (_, index) => ({ role: 'assistant', content: `work-${index} ${'x'.repeat(1_000)}` })),
  ]
  const budget = agentMessageBudget(messages, { effectiveWindowTokens: 200_000 })
  assert.ok(budget.approxTokens > 20_000)
  const preparation = prepareAgentMessageCompaction(messages, {
    profile: 'cli-local',
    policy: { softChars: 20_000, targetChars: 16_000, hardChars: 24_000, compactMessageCount: 20, keepRecentMessages: 6 },
  })
  assert.equal(preparation.needed, true)
  assert.match(preparation.request!.messages[0]!.content, /三条道路和昼夜循环/)
  assert.doesNotMatch(preparation.request!.messages[0]!.content, /\[object Object\]/)
  const committed = commitAgentMessageCompaction(messages, preparation, null, { allowDeterministicFallback: true })
  assert.equal(committed.compacted, true)
  assert.match(JSON.stringify(committed.semanticSummary), /三条道路和昼夜循环/)
})

test('compaction pins the latest canonical Turn intent ahead of later host nudges', () => {
  const latestIntent = 'CURRENT_TURN_INTENT preserve three roads and the day-night loop. '
  const messages: any[] = [
    { role: 'user', content: 'old objective' },
    ...Array.from({ length: 100 }, (_, index) => ({ role: 'assistant', content: `old-work-${index} ${'x'.repeat(1_000)}` })),
    {
      role: 'user',
      content: [{ type: 'text', text: latestIntent.repeat(700) }],
      inputItems: [{ id: 'current-turn-text', type: 'text', text: latestIntent.repeat(700) }],
      orbit_internal: { schema: 'orbit.cli-turn-marker.v1', type: 'turn_input', turnId: 'turn-current' },
    },
    { role: 'user', content: 'Continue the task using the available tools.' },
    ...Array.from({ length: 50 }, (_, index) => ({ role: 'assistant', content: `current-work-${index} ${'y'.repeat(1_000)}` })),
  ]
  const preparation = prepareAgentMessageCompaction(messages, { profile: 'cli-local' })
  assert.equal(preparation.needed, true)
  const result = commitAgentMessageCompaction(messages, preparation, null, { allowDeterministicFallback: true })
  assert.equal(result.compacted, true)
  assert.equal(result.semanticSummary?.latestUserIntent.includes('CURRENT_TURN_INTENT'), true)
  assert.equal(messages.some((message) => message?.orbit_internal?.turnId === 'turn-current'), true)
  assert.equal(JSON.stringify(messages).includes('CURRENT_TURN_INTENT'), true)
})

test('compaction keeps bounded canonical visual Turn identities for later provider hydration', () => {
  const visualTurn = {
    role: 'user',
    content: [{ type: 'text', text: 'Use the visual composition.' }],
    inputItems: [
      { id: 'visual-text', type: 'text', text: 'Use the visual composition.' },
      { id: 'visual-occurrence', type: 'attachment', attachment: { id: 'attachment-visual', kind: 'image', name: 'visual.png', sizeBytes: 32 } },
    ],
    orbit_internal: { schema: 'orbit.cli-turn-marker.v1', type: 'turn_input', turnId: 'turn-visual', mediaProjection: 'direct', mediaOriginProvider: 'openrouter' },
  }
  const currentTurn = {
    role: 'user', content: 'Continue implementation.',
    inputItems: [{ id: 'current-text', type: 'text', text: 'Continue implementation.' }],
    orbit_internal: { schema: 'orbit.cli-turn-marker.v1', type: 'turn_input', turnId: 'turn-current' },
  }
  const messages: any[] = [
    { role: 'user', content: 'Build the game.' },
    ...Array.from({ length: 40 }, (_, index) => ({ role: 'assistant', content: `early-${index} ${'x'.repeat(1_000)}` })),
    visualTurn,
    ...Array.from({ length: 80 }, (_, index) => ({ role: index % 2 ? 'user' : 'assistant', content: `history-${index} ${'y'.repeat(1_000)}` })),
    currentTurn,
    ...Array.from({ length: 20 }, (_, index) => ({ role: 'assistant', content: `tail-${index} ${'z'.repeat(1_000)}` })),
  ]
  const preparation = prepareAgentMessageCompaction(messages, { profile: 'cli-local' })
  assert.equal(preparation.droppedMessages.includes(visualTurn), true)
  const result = commitAgentMessageCompaction(messages, preparation, null, { allowDeterministicFallback: true })
  assert.equal(result.compacted, true)
  const pinned = messages.find((message) => message?.orbit_internal?.turnId === 'turn-visual')
  assert.ok(pinned)
  assert.equal(pinned.inputItems.filter((item: any) => item.type === 'attachment').length, 1)
  assert.equal(JSON.stringify(pinned).includes('data:image'), false)
})

test('0.5.1 generated core keeps canonical/deprecated parity and atomic batch behavior', async () => {
  assert.equal(ORBIT_AGENT_CORE_VERSION, 'orbit-agent-core/0.5.1')
  assert.equal(ORBIT_PRO_AGENT_CORE_VERSION, ORBIT_AGENT_CORE_VERSION)
  assert.equal(ORBIT_AGENT_MODEL_OUTPUT_LIMITS.agent, 65_536)
  assert.equal(buildOrbitAgentCoreModuleSource(), buildOrbitProAgentCoreModuleSource())

  const direct: any = await import('./runtime.mjs')
  const generated: any = await import(`data:text/javascript;base64,${Buffer.from(buildOrbitAgentCoreModuleSource()).toString('base64')}`)
  assert.match(buildOrbitAgentCoreModuleSource(), /const __name =/)
  assert.deepEqual(
    Object.keys(generated).sort(),
    Object.keys(direct).filter((key) => !['buildOrbitAgentCoreModuleSource', 'buildOrbitProAgentCoreModuleSource'].includes(key)).sort(),
  )
  assert.equal(generated.ORBIT_AGENT_CORE_VERSION, ORBIT_AGENT_CORE_VERSION)
  assert.equal(generated.ORBIT_PRO_AGENT_CORE_VERSION, ORBIT_AGENT_CORE_VERSION)
  assert.equal(generated.ORBIT_AGENT_MODEL_OUTPUT_LIMITS.agent, 65_536)
  assert.equal(typeof generated.projectAgentTurnForProvider, 'function')
  assert.doesNotThrow(() => generated.createAgentToolCapabilityRegistry({
    inspect_input: {
      prePlan: 'observe', observationScope: 'input', effect: 'read', parallel: 'safe', retry: 'safe',
      budget: { maxPrePlanCalls: 1 },
    },
  }))
  const projectionInput = [{ id: 'generated-image', type: 'image', url: 'data:image/png;base64,AA==' }]
  const projectionOptions = { capabilities: { vision: true, imageInputs: ['data_url'] } }
  assert.deepEqual(
    generated.projectAgentInputItemsForProvider(projectionInput, projectionOptions),
    projectAgentInputItemsForProvider(projectionInput, projectionOptions),
  )

  const assistant = { role: 'assistant', tool_calls: [
    { id: 'one', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    { id: 'two', type: 'function', function: { name: 'read_file', arguments: '{}' } },
  ] }
  let journal = createAgentToolBatchJournal(assistant)
  journal = recordAgentToolBatchResult(journal, { role: 'tool', tool_call_id: 'one', content: 'ok' })
  const closed = closeAgentToolBatchJournal(journal, 'test stop')
  assert.equal(closed.syntheticCount, 1)
  assert.equal(assertAgentTranscriptProtocol([assistant, ...closed.messages]), true)
})

test('generated core remains executable after a production keep-names transform', async () => {
  const runtimeSource = await readFile(new URL('./runtime.mjs', import.meta.url), 'utf8')
  const transformed = await transform(runtimeSource, {
    format: 'esm',
    keepNames: true,
    platform: 'neutral',
    target: 'es2022',
  })
  const bundledHost: any = await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`)
  const generatedSource = bundledHost.buildOrbitAgentCoreModuleSource()
  assert.match(generatedSource, /const __name =/)
  const generated: any = await import(`data:text/javascript;base64,${Buffer.from(generatedSource).toString('base64')}`)
  const registry = generated.createAgentToolCapabilityRegistry({
    inspect_input: {
      prePlan: 'observe', observationScope: 'input', effect: 'read', parallel: 'safe', retry: 'safe',
      budget: { maxPrePlanCalls: 1 },
    },
  })
  assert.equal(registry.inspect_input.prePlan, 'observe')
})
