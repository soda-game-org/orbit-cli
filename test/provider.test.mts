import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { CODING_PROVIDER_IDS, PROVIDERS } from '../src/constants.mjs'
import { providerCredentialAccount } from '../src/credentials.mjs'
import { ByokProvider, publicGenericSkill } from '../src/provider.mjs'
import {
  DEFAULT_MODEL_OUTPUT_TOKENS,
  MAX_PROVIDER_OUTPUT_TOKENS,
  buildProviderRequest,
  generateReplicateImage,
  generateReplicateModel3d,
  normalizeProviderUsage,
  parseProviderAssistant,
  validateReplicateDeliveryUrl,
} from '@soda_game/orbit-provider-core'
import {
  ORBIT_AGENT_MODEL_OUTPUT_LIMITS,
  assertAgentInputProjectionReady,
  projectAgentInputItemsForProvider,
} from '@soda_game/orbit-agent-core'

class MemoryCredentials {
  constructor(entries = {}) { this.entries = new Map(Object.entries(entries)) }
  async get(account) { return this.entries.get(account) || null }
}

test('generic HTML skill resolves from source and built package layouts', async () => {
  const sourceSkill = await publicGenericSkill()
  const builtProvider = await import('../dist/src/provider.mjs')
  const builtSkill = await builtProvider.publicGenericSkill()
  assert.match(sourceSkill, /Generic HTML game guidance/)
  assert.equal(builtSkill, sourceSkill)
})

test('provider profiles keep regional services and credentials separate', () => {
  assert.deepEqual(CODING_PROVIDER_IDS, [
    'openrouter', 'openai', 'zhipu-cn', 'zai', 'deepseek', 'ark', 'kimi-cn', 'kimi-global',
  ])
  assert.equal(PROVIDERS['zhipu-cn'].baseUrl, 'https://open.bigmodel.cn/api/paas/v4')
  assert.equal(PROVIDERS.zai.baseUrl, 'https://api.z.ai/api/paas/v4')
  assert.equal(PROVIDERS['kimi-cn'].baseUrl, 'https://api.moonshot.cn/v1')
  assert.equal(PROVIDERS['kimi-global'].baseUrl, 'https://api.moonshot.ai/v1')
  assert.equal(PROVIDERS.openai.protocol, 'responses')
  assert.equal(PROVIDERS.deepseek.defaultModel, 'deepseek-v4-pro')
  assert.notEqual(providerCredentialAccount('zhipu-cn'), providerCredentialAccount('zai'))
  assert.notEqual(providerCredentialAccount('kimi-cn'), providerCredentialAccount('kimi-global'))
  assert.equal(DEFAULT_MODEL_OUTPUT_TOKENS, ORBIT_AGENT_MODEL_OUTPUT_LIMITS.agent)
  assert.equal(DEFAULT_MODEL_OUTPUT_TOKENS, 65_536)
})

test('explicit provider output budgets preserve the shared reasoning allowance', () => {
  const chat = buildProviderRequest({
    provider: 'deepseek', model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'Build.' }],
    maxOutputTokens: ORBIT_AGENT_MODEL_OUTPUT_LIMITS.agent,
  })
  assert.equal(chat.body.max_tokens, 65_536)

  const responses = buildProviderRequest({
    provider: 'openai', model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'Build.' }],
    maxOutputTokens: ORBIT_AGENT_MODEL_OUTPUT_LIMITS.agent,
  })
  assert.equal(responses.body.max_output_tokens, 65_536)

  const bounded = buildProviderRequest({
    provider: 'deepseek', model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'Build.' }],
    maxOutputTokens: MAX_PROVIDER_OUTPUT_TOKENS + 1,
  })
  assert.equal(bounded.body.max_tokens, MAX_PROVIDER_OUTPUT_TOKENS)
  assert.throws(() => buildProviderRequest({
    provider: 'deepseek', model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'Build.' }],
    maxOutputTokens: 0,
  }), /output token limit is invalid/)
})

test('normalizes Chat, Responses and DeepSeek token usage without exposing raw cost data', () => {
  assert.deepEqual(normalizeProviderUsage({
    prompt_tokens: 120,
    completion_tokens: 35,
    completion_tokens_details: { reasoning_tokens: 9 },
    prompt_tokens_details: { cached_tokens: 40 },
    total_tokens: 155,
    cost: 123.45,
    raw: { private: true },
  }), {
    promptTokens: 120,
    completionTokens: 35,
    reasoningTokens: 9,
    cachedTokens: 40,
    totalTokens: 155,
  })
  assert.deepEqual(normalizeProviderUsage({
    input_tokens: 80,
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 6 },
    input_tokens_details: { cached_tokens: 24 },
  }), {
    promptTokens: 80,
    completionTokens: 20,
    reasoningTokens: 6,
    cachedTokens: 24,
    totalTokens: 100,
  })
  assert.deepEqual(normalizeProviderUsage({
    prompt_cache_hit_tokens: 30,
    prompt_cache_miss_tokens: 10,
    completion_tokens: 5,
    reasoning_tokens: 2,
  }), {
    promptTokens: 40,
    completionTokens: 5,
    reasoningTokens: 2,
    cachedTokens: 30,
    totalTokens: 45,
  })
})

test('normalizes invalid provider token counts to bounded non-negative integers', () => {
  assert.deepEqual(normalizeProviderUsage({
    prompt_tokens: -10,
    completion_tokens: Number.NaN,
    reasoning_tokens: Number.NEGATIVE_INFINITY,
    cached_tokens: '-3',
    total_tokens: Number.POSITIVE_INFINITY,
  }), {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
  })
  assert.deepEqual(normalizeProviderUsage({
    promptTokens: '12.9', completionTokens: '3.8', totalTokens: String(Number.MAX_VALUE),
  }), {
    promptTokens: 12,
    completionTokens: 3,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: Number.MAX_SAFE_INTEGER,
  })
  assert.deepEqual(normalizeProviderUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }), {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
  })
  assert.equal(normalizeProviderUsage(null), null)
  assert.equal(normalizeProviderUsage([]), null)
  assert.equal(normalizeProviderUsage({ cost: 0.2 }), null)
})

test('Chat and Responses assistant parsers attach only normalized usage', () => {
  const chat = parseProviderAssistant('deepseek', {
    choices: [{ message: { role: 'assistant', content: 'chat-ok' } }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 1 },
  })
  assert.deepEqual(chat.usage, {
    promptTokens: 5,
    completionTokens: 2,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 7,
  })
  assert.equal(Object.hasOwn(chat.usage, 'cost'), false)
  assert.equal(Object.hasOwn(chat.usage, 'raw'), false)

  const responses = parseProviderAssistant('openai', {
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'responses-ok' }] }],
    usage: {
      input_tokens: 8,
      output_tokens: 4,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 12,
      cost_usd: 99,
    },
  })
  assert.deepEqual(responses.usage, {
    promptTokens: 8,
    completionTokens: 4,
    reasoningTokens: 2,
    cachedTokens: 3,
    totalTokens: 12,
  })
  assert.equal(Object.hasOwn(responses.usage, 'costUsd'), false)
  assert.equal(Object.hasOwn(responses.usage, 'raw'), false)
})

test('chat-completions profiles send each key only to its fixed regional host', async () => {
  const expected = new Map([
    ['zhipu-cn', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'],
    ['zai', 'https://api.z.ai/api/paas/v4/chat/completions'],
    ['kimi-cn', 'https://api.moonshot.cn/v1/chat/completions'],
    ['kimi-global', 'https://api.moonshot.ai/v1/chat/completions'],
  ])
  const entries = Object.fromEntries([...expected.keys()].map((provider) => [providerCredentialAccount(provider), `key-${provider}`]))
  const calls = []
  const byok = new ByokProvider(new MemoryCredentials(entries), { fetchImpl: async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 })
  } })

  for (const provider of expected.keys()) await byok.complete({ provider, messages: [{ role: 'user', content: 'hello' }], tools: [] })

  assert.equal(calls.length, expected.size)
  for (const [index, [provider, url]] of [...expected].entries()) {
    assert.equal(calls[index].url, url)
    assert.equal(calls[index].init.headers.Authorization, `Bearer key-${provider}`)
    const body = JSON.parse(calls[index].init.body)
    assert.equal(body.model, PROVIDERS[provider].defaultModel)
    assert.equal(Object.hasOwn(body, 'max_tokens'), false)
  }

  const explicitlyBounded = buildProviderRequest({
    provider: 'deepseek',
    messages: [{ role: 'user', content: 'hello' }],
    maxOutputTokens: 2048,
  })
  assert.equal(explicitlyBounded.body.max_tokens, 2048)
})

test('Chat and Responses provider boundaries strip host-only message metadata without losing native fields', () => {
  const internal = { schema: 'orbit.agent-internal-message.v1', type: 'context_summary', generation: 1 }
  const messages = [
    { role: 'user', content: 'Inspect', orbit_internal: internal, sessionId: 'session_private', localPath: '/private/reference.png' },
    {
      role: 'assistant',
      content: 'Working.',
      reasoning: 'visible reasoning',
      reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }],
      response_items: [{ type: 'reasoning', id: 'reasoning_1', encrypted_content: 'opaque' }],
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      orbit_internal: internal,
      projectId: 'project_private',
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok', orbit_internal: internal, mediaId: 'media_private' },
  ]
  const chat = buildProviderRequest({ provider: 'deepseek', messages })
  assert.equal(JSON.stringify(chat.body).includes('orbit_internal'), false)
  assert.equal(JSON.stringify(chat.body).includes('session_private'), false)
  assert.equal(JSON.stringify(chat.body).includes('project_private'), false)
  assert.equal(JSON.stringify(chat.body).includes('media_private'), false)
  assert.equal(JSON.stringify(chat.body).includes('/private/reference.png'), false)
  assert.equal(chat.body.messages[1].reasoning, 'visible reasoning')
  assert.deepEqual(chat.body.messages[1].reasoning_details, messages[1].reasoning_details)
  assert.equal(Object.hasOwn(chat.body.messages[1], 'response_items'), false)
  assert.deepEqual(chat.body.messages[1].tool_calls, messages[1].tool_calls)

  const responses = buildProviderRequest({ provider: 'openai', messages })
  assert.equal(JSON.stringify(responses.body).includes('orbit_internal'), false)
  assert.equal(JSON.stringify(responses.body).includes('session_private'), false)
  assert.equal(JSON.stringify(responses.body).includes('project_private'), false)
  assert.equal(JSON.stringify(responses.body).includes('media_private'), false)
  assert.equal(JSON.stringify(responses.body).includes('/private/reference.png'), false)
  assert.deepEqual(responses.body.input[1], messages[1].response_items[0])
  assert.deepEqual(responses.body.input[2], { role: 'assistant', content: 'Working.' })
  assert.deepEqual(responses.body.input[3], {
    type: 'function_call',
    call_id: 'call_1',
    name: 'read_file',
    arguments: '{}',
  })
})

test('provider-native reasoning replay recursively strips host metadata while preserving opaque protocol state', () => {
  const developerRoot = path.join(path.parse(process.cwd()).root, 'Users', 'private')
  const referencePath = path.join(developerRoot, 'reference.png')
  const nestedLeak = {
    metadata: {
      privatePath: referencePath,
      nested: { sourceRef: `file://${referencePath}`, deeper: { dataUrl: 'data:image/png;base64,c2VjcmV0' } },
    },
  }
  const chat = buildProviderRequest({
    provider: 'openrouter',
    messages: [
      { role: 'user', content: 'Continue' },
      {
        role: 'assistant', content: '',
        reasoning_details: [{
          type: 'reasoning.encrypted', id: 'reasoning_1', data: 'opaque-chat-state', index: 0,
          ...nestedLeak,
        }, { type: 'reasoning.encrypted', data: path.join(developerRoot, 'opaque-bypass') }],
        reasoning: `unsafe host file://${path.join(developerRoot, 'reasoning.txt')}`,
        reasoning_content: 'C:\\Users\\private\\reasoning.txt',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ],
  })
  const chatWire = JSON.stringify(chat.body)
  assert.equal(chatWire.includes('privatePath'), false)
  assert.equal(chatWire.includes('sourceRef'), false)
  assert.equal(chatWire.includes(developerRoot), false)
  assert.equal(chatWire.includes('file:///'), false)
  assert.equal(chatWire.includes('data:image'), false)
  assert.equal(chatWire.includes('opaque-chat-state'), true)

  const responses = buildProviderRequest({
    provider: 'openai',
    messages: [
      { role: 'user', content: 'Continue' },
      {
        role: 'assistant', content: 'Working.',
        response_items: [{
          type: 'reasoning', id: 'reasoning_2', encrypted_content: 'opaque-responses-state', status: 'completed',
          summary: [{ type: 'summary_text', text: 'Safe summary', ...nestedLeak }],
          ...nestedLeak,
        }, { type: 'reasoning', id: 'reasoning_3', encrypted_content: path.join(developerRoot, 'opaque-bypass') }],
      },
    ],
  })
  const responsesWire = JSON.stringify(responses.body)
  assert.equal(responsesWire.includes('privatePath'), false)
  assert.equal(responsesWire.includes('sourceRef'), false)
  assert.equal(responsesWire.includes(developerRoot), false)
  assert.equal(responsesWire.includes('file:///'), false)
  assert.equal(responsesWire.includes('data:image'), false)
  assert.equal(responsesWire.includes('opaque-responses-state'), true)
  assert.equal(responsesWire.includes('Safe summary'), true)
  assert.equal(chat.body.messages[1].reasoning, undefined)
  assert.equal(chat.body.messages[1].reasoning_content, undefined)
})

test('canonical turn input projection becomes protocol-native image parts without leaking host identity', () => {
  const projection = projectAgentInputItemsForProvider([
    { id: 'input_text_1', type: 'text', text: 'Inspect this image.' },
    {
      id: 'input_image_1',
      type: 'attachment',
      detail: 'high',
      attachment: { id: 'media_1', kind: 'image', mediaType: 'image/png', sourceRef: 'host-asset:media_1' },
    },
  ], {
    capabilities: { vision: true, imageInputs: ['url'], maxImagesPerTurn: 8 },
    mediaCache: {
      schema: 'orbit.agent-media-cache.v1',
      entries: [{
        key: 'media_1', attachmentId: 'media_1', sourceItemId: 'input_image_1', status: 'ready',
        mediaType: 'image/png', resolved: { type: 'url', value: 'https://assets.example.com/reference.png' },
      }],
    },
  })
  assert.equal(projection.blocked, false)
  assert.equal(assertAgentInputProjectionReady(projection), true)
  const messages = [{
    role: 'user',
    content: projection.providerItems,
    inputItems: projection.inputItems,
    mediaObservations: [],
  }]

  const chat = buildProviderRequest({ provider: 'openrouter', messages })
  assert.deepEqual(chat.body.messages[0].content, [
    { type: 'text', text: 'Inspect this image.' },
    { type: 'image_url', image_url: { url: 'https://assets.example.com/reference.png', detail: 'auto' } },
  ])
  assert.equal(JSON.stringify(chat.body).includes('sourceItemId'), false)
  assert.equal(JSON.stringify(chat.body).includes('media_1'), false)

  const responses = buildProviderRequest({ provider: 'openai', messages })
  assert.deepEqual(responses.body.input[0], {
    role: 'user',
    content: [
      { type: 'input_text', text: 'Inspect this image.' },
      { type: 'input_image', image_url: 'https://assets.example.com/reference.png', detail: 'auto' },
    ],
  })
  assert.equal(JSON.stringify(responses.body).includes('sourceItemId'), false)
  assert.equal(JSON.stringify(responses.body).includes('media_1'), false)
})

test('provider boundary rejects unresolved host media and unsafe image sources', () => {
  const base = { role: 'user' }
  for (const provider of ['openrouter', 'openai']) {
    assert.throws(() => buildProviderRequest({
      provider,
      messages: [{ ...base, content: [{ type: 'input_image', sourceItemId: 'input_1', source: { type: 'host_ref', value: 'local-cache:1' }, detail: 'auto' }] }],
    }), /resolved by the host/i)
    assert.throws(() => buildProviderRequest({
      provider,
      messages: [{ ...base, content: [{ type: 'input_image', sourceItemId: 'input_1', source: { type: 'url', value: 'file:///private/reference.png' }, detail: 'auto' }] }],
    }), /image URL is invalid/i)
    assert.throws(() => buildProviderRequest({
      provider,
      messages: [{ ...base, content: [{ type: 'localImage', sourceItemId: 'input_1', path: '/private/reference.png' }] }],
    }), /image content part is invalid/i)
    for (const host of ['127.0.0.1', '0.0.0.0', '100.64.0.1', '198.18.0.1', '[::]', '[::ffff:127.0.0.1]', '[fc00::1]', '[ff02::1]']) {
      assert.throws(() => buildProviderRequest({
        provider,
        messages: [{ ...base, content: [{ type: 'image_url', image_url: { url: `https://${host}/private.png` } }] }],
      }), /image URL is invalid/i)
    }
  }
})

test('provider file image references are Responses-only and never accept host references', () => {
  const providerFile = [{ type: 'input_image', sourceItemId: 'input_1', source: { type: 'provider_file', value: 'file-abc_123' }, detail: 'low' }]
  const responses = buildProviderRequest({ provider: 'openai', messages: [{ role: 'user', content: providerFile }] })
  assert.deepEqual(responses.body.input[0], {
    role: 'user',
    content: [{ type: 'input_image', file_id: 'file-abc_123', detail: 'low' }],
  })
  assert.equal(JSON.stringify(responses.body).includes('sourceItemId'), false)

  assert.throws(() => buildProviderRequest({
    provider: 'openrouter', messages: [{ role: 'user', content: providerFile }],
  }), /does not accept provider file/i)
  assert.throws(() => buildProviderRequest({
    provider: 'openai',
    messages: [{ role: 'user', content: [{ type: 'input_image', source: { type: 'provider_file', value: 'local-cache:1' } }] }],
  }), /resolved by the host/i)
})

test('OpenAI direct uses Responses API and translates the agent tool transcript', async () => {
  const requests = []
  const firstOutput = [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-reasoning', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will inspect it.' }] },
    { type: 'function_call', call_id: 'call_2', name: 'read_file', arguments: '{"path":"index.html"}' },
  ]
  const byok = new ByokProvider(new MemoryCredentials({ [providerCredentialAccount('openai')]: 'openai-key' }), {
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ output: requests.length === 1 ? firstOutput : [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
      ] }), { status: 200 })
    },
  })
  const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]
  const assistant = await byok.complete({
    provider: 'openai',
    system: 'Work locally.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Use this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"files":["index.html"]}' },
    ],
    tools,
    maxOutputTokens: 2048,
  })

  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer openai-key')
  assert.equal(requests[0].body.model, 'gpt-5.6-sol')
  assert.equal(requests[0].body.instructions, 'Work locally.')
  assert.equal(requests[0].body.store, false)
  assert.deepEqual(requests[0].body.reasoning, { effort: 'medium' })
  assert.equal(requests[0].body.max_output_tokens, 2048)
  assert.deepEqual(requests[0].body.tools[0], { type: 'function', name: 'read_file', description: 'Read a file', parameters: tools[0].function.parameters, strict: false })
  assert.deepEqual(requests[0].body.input[0], { role: 'user', content: [{ type: 'input_text', text: 'Use this' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] })
  assert.deepEqual(requests[0].body.input[1], { type: 'function_call', call_id: 'call_1', name: 'list_files', arguments: '{}' })
  assert.deepEqual(requests[0].body.input[2], { type: 'function_call_output', call_id: 'call_1', output: '{"files":["index.html"]}' })
  assert.equal(assistant.content, 'I will inspect it.')
  assert.deepEqual(assistant.tool_calls, [{ id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"index.html"}' } }])
  assert.deepEqual(assistant.response_items, firstOutput)

  await byok.complete({
    provider: 'openai',
    messages: [
      { role: 'user', content: 'Inspect the file' },
      assistant,
      { role: 'tool', tool_call_id: 'call_2', content: '<!doctype html>' },
    ],
    tools,
  })
  assert.equal(Object.hasOwn(requests[1].body, 'max_output_tokens'), false)
  assert.deepEqual(requests[1].body.input.slice(1, 4), firstOutput)
  assert.deepEqual(requests[1].body.input[4], { type: 'function_call_output', call_id: 'call_2', output: '<!doctype html>' })
})

test('provider requests fail closed before network access on a broken tool transcript', async () => {
  const broken = [
    { role: 'user', content: 'Inspect' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    { role: 'user', content: 'warning inserted in the middle of the batch' },
    { role: 'tool', tool_call_id: 'call_2', content: 'ok' },
  ]
  for (const provider of ['deepseek', 'openai']) {
    assert.throws(() => buildProviderRequest({ provider, messages: broken }), /protocol violation/i)
  }
  assert.throws(() => buildProviderRequest({
    provider: 'deepseek',
    messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'bad', type: 'function' }] }],
  }), /function payload/i)
})

test('Responses replay aligns raw output items to canonical assistant tool calls', () => {
  const request = buildProviderRequest({
    provider: 'openai',
    messages: [
      { role: 'user', content: 'Inspect' },
      {
        role: 'assistant',
        content: 'Working.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"index.html"}' } },
          { id: 'call_2', type: 'function', function: { name: 'list_files', arguments: '{}' } },
        ],
        response_items: [
          { type: 'reasoning', id: 'reasoning_1', encrypted_content: 'opaque' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Working.' }] },
          ...Array.from({ length: 20 }, (_, index) => ({
            type: 'function_call', call_id: `orphan_${index}`, name: 'shell', arguments: '{"command":"ignored"}',
          })),
          { type: 'function_call', call_id: 'call_1', name: 'stale_name', arguments: '{"stale":true}' },
          { type: 'function_call', call_id: 'call_1', name: 'duplicate', arguments: '{}' },
          { type: 'function_call_output', call_id: 'injected', output: 'ignored' },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '<!doctype html>' },
      { role: 'tool', tool_call_id: 'call_2', content: '{"files":[]}' },
    ],
  })
  const calls = request.body.input.filter((item) => item.type === 'function_call')
  assert.deepEqual(calls, [
    { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"index.html"}' },
    { type: 'function_call', call_id: 'call_2', name: 'list_files', arguments: '{}' },
  ])
  assert.equal(request.body.input.some((item) => item.type === 'function_call_output' && item.call_id === 'injected'), false)
})

test('OpenRouter model discovery returns bounded tool-capable catalog entries', async () => {
  let request
  const byok = new ByokProvider(new MemoryCredentials({ [providerCredentialAccount('openrouter')]: 'router-key' }), {
    fetchImpl: async (url, init) => {
      request = { url, init }
      return new Response(JSON.stringify({ data: [
        { id: 'vendor/model-a', name: 'Model A', architecture: { input_modalities: ['text', 'image'] }, top_provider: { max_completion_tokens: 131_072 } },
        { id: 'vendor/model-b', name: 'Model B', architecture: { input_modalities: ['text'], max_completion_tokens: 32_768 } },
        { id: `vendor/${'x'.repeat(121)}`, name: 'Too long' },
        { id: 'bad\nmodel', name: 'Control character' },
      ] }), { status: 200 })
    },
  })

  const models = await byok.models('openrouter')
  assert.equal(request.url, 'https://openrouter.ai/api/v1/models?supported_parameters=tools')
  assert.equal(request.init.headers.Authorization, 'Bearer router-key')
  assert.deepEqual(models, [
    { id: 'vendor/model-a', name: 'Model A', vision: true, maxOutputTokens: 131_072 },
    { id: 'vendor/model-b', name: 'Model B', vision: false, maxOutputTokens: 32_768 },
  ])
})

test('OpenRouter preserves structured reasoning across routed model tool calls', async () => {
  const requests = []
  const details = [{ type: 'reasoning.encrypted', data: 'opaque', id: 'reasoning-1', format: 'provider-v1', index: 0 }]
  const byok = new ByokProvider(new MemoryCredentials({ [providerCredentialAccount('openrouter')]: 'router-key' }), {
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ choices: [{ message: requests.length === 1 ? {
        role: 'assistant', content: '', reasoning_details: details,
        tool_calls: [{ id: 'call_or', type: 'function', function: { name: 'list_files', arguments: '{}' } }],
      } : { role: 'assistant', content: 'Done.' } }] }), { status: 200 })
    },
  })
  const tools = [{ type: 'function', function: { name: 'list_files', description: 'List files', parameters: { type: 'object', properties: {} } } }]
  const assistant = await byok.complete({ provider: 'openrouter', model: 'vendor/reasoning-model', messages: [{ role: 'user', content: 'Inspect' }], tools })
  assert.deepEqual(assistant.reasoning_details, details)
  await byok.complete({ provider: 'openrouter', model: 'vendor/reasoning-model', messages: [
    { role: 'user', content: 'Inspect' }, assistant,
    { role: 'tool', tool_call_id: 'call_or', content: '{"files":[]}' },
  ], tools })
  assert.deepEqual(requests[1].messages[1].reasoning_details, details)
})

test('DeepSeek preserves reasoning content and omits unsupported tool controls', async () => {
  const requests = []
  const byok = new ByokProvider(new MemoryCredentials({ [providerCredentialAccount('deepseek')]: 'deepseek-key' }), {
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ choices: [{ message: requests.length === 1 ? {
        role: 'assistant', content: '', reasoning_content: 'I should inspect the files.',
        tool_calls: [{ id: 'call_ds', type: 'function', function: { name: 'list_files', arguments: '{}' } }],
      } : { role: 'assistant', content: 'Done.' } }] }), { status: 200 })
    },
  })
  const tools = [{ type: 'function', function: { name: 'list_files', description: 'List files', parameters: { type: 'object', properties: {} } } }]
  const assistant = await byok.complete({ provider: 'deepseek', messages: [{ role: 'user', content: 'Inspect this project' }], tools })
  assert.equal(Object.hasOwn(requests[0], 'tool_choice'), false)
  assert.equal(Object.hasOwn(requests[0], 'parallel_tool_calls'), false)
  assert.equal(assistant.reasoning_content, 'I should inspect the files.')

  await byok.complete({ provider: 'deepseek', messages: [
    { role: 'user', content: 'Inspect this project' }, assistant,
    { role: 'tool', tool_call_id: 'call_ds', content: '{"files":[]}' },
  ], tools })
  assert.equal(requests[1].messages[1].reasoning_content, 'I should inspect the files.')
})

test('shared Replicate 3D transport resumes a persisted prediction and trusts only delivery hosts', async () => {
  const state = {}
  const persisted = []
  const calls = []
  const result = await generateReplicateModel3d({
    apiKey: 'replicate-key',
    prompt: 'Original low-poly arcade hover car',
    state,
    persist: async (next) => persisted.push({ ...next }),
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('/models/')) return new Response(JSON.stringify({ id: 'prediction-1', status: 'starting' }))
      return new Response(JSON.stringify({ status: 'succeeded', output: { glb: 'https://files.replicate.delivery/model.glb' } }))
    },
  })
  assert.deepEqual(result, { predictionId: 'prediction-1', status: 'succeeded', outputUrl: 'https://files.replicate.delivery/model.glb' })
  assert.equal(calls[0].init.headers.Authorization, 'Bearer replicate-key')
  assert.equal(calls[1].init.headers.Authorization, 'Bearer replicate-key')
  assert.equal(persisted.some((entry) => entry.predictionId === 'prediction-1'), true)
  assert.throws(() => validateReplicateDeliveryUrl('https://example.com/model.glb'), /untrusted/)
})

test('shared Replicate image transport uses a durable prediction and requests a PNG', async () => {
  const state = {}
  const calls = []
  const result = await generateReplicateImage({
    apiKey: 'replicate-key',
    prompt: 'Original neon checkpoint art for an arcade racing game',
    aspectRatio: '16:9',
    state,
    pollIntervalMs: 1,
    persist: async () => {},
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('/models/')) return Response.json({ id: 'image-prediction-1', status: 'starting' })
      return Response.json({ status: 'succeeded', output: 'https://images.replicate.delivery/game.png' })
    },
  })
  assert.deepEqual(result, {
    predictionId: 'image-prediction-1', status: 'succeeded',
    outputUrl: 'https://images.replicate.delivery/game.png', model: 'google/nano-banana',
  })
  assert.equal(calls[0].url, 'https://api.replicate.com/v1/models/google/nano-banana/predictions')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer replicate-key')
  assert.deepEqual(JSON.parse(calls[0].init.body), { input: {
    prompt: 'Original neon checkpoint art for an arcade racing game',
    aspect_ratio: '16:9', output_format: 'png',
  } })
  assert.equal(state.requestPending, false)
  assert.equal(state.predictionId, 'image-prediction-1')
})

test('shared Replicate 3D transport marks a definitive provider rejection safe to retry', async () => {
  const state = {}
  const persisted = []
  await assert.rejects(generateReplicateModel3d({
    apiKey: 'replicate-key',
    prompt: 'Original low-poly arcade hover car',
    state,
    persist: async (next) => persisted.push({ ...next }),
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'invalid input' }), { status: 400 }),
  }), /invalid input/)
  assert.equal(state.requestPending, false)
  assert.equal(persisted.at(-1).requestPending, false)
  assert.equal(Object.hasOwn(state, 'predictionId'), false)
})
