/**
 * Runtime-neutral provider transport shared by Orbit CLI and Orbit Engine.
 *
 * This module intentionally owns no credentials, UI, OAuth, billing or skill
 * content. Hosts inject a credential lookup and may add public client headers.
 */

type JsonRecord = Record<string, any>

export type OrbitCodingProviderId =
  | 'openrouter'
  | 'openai'
  | 'zhipu-cn'
  | 'zai'
  | 'deepseek'
  | 'ark'
  | 'kimi-cn'
  | 'kimi-global'

export type OrbitProviderId = OrbitCodingProviderId | 'replicate'

export interface OrbitProviderDefinition {
  label: string
  baseUrl: string
  defaultModel: string
  vision: boolean
  protocol: 'chat-completions' | 'responses' | 'replicate'
  purpose: 'coding' | '3d'
  modelsPath?: string
  reasoningEffort?: string
}

export interface OrbitProviderUsage {
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  cachedTokens: number
  totalTokens: number
}

export interface OrbitProviderAssistant extends JsonRecord {
  role: 'assistant'
  content: string
  usage?: OrbitProviderUsage
}

export interface OrbitProviderModel {
  id: string
  name: string
  vision: boolean
}

export interface OrbitProviderCompletionInput {
  provider: OrbitCodingProviderId
  apiKey: string
  model?: string
  messages: JsonRecord[]
  tools?: JsonRecord[]
  system?: string
  maxOutputTokens?: number
  signal?: AbortSignal | null
  onRetry?: (input: { attempt: number; error: unknown }) => void | Promise<void>
  fetchImpl?: typeof fetch
  clientHeaders?: Record<string, string>
}

export interface OrbitReplicate3dState extends JsonRecord {
  predictionId?: string
  status?: string
  requestPending?: boolean
  outputUrl?: string
  model?: string
}

export interface OrbitReplicateImageState extends OrbitReplicate3dState {}

export const DEFAULT_MODEL_OUTPUT_TOKENS = 16_000
export const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024
export const MAX_MODEL_ID_CHARS = 120
export const REPLICATE_IMAGE_MODEL = 'google/nano-banana'

export const PROVIDERS: Readonly<Record<OrbitProviderId, OrbitProviderDefinition>> = Object.freeze({
  openrouter: {
    label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/free',
    vision: true, protocol: 'chat-completions', purpose: 'coding', modelsPath: '/models?supported_parameters=tools',
  },
  openai: {
    label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.6-sol',
    vision: true, protocol: 'responses', purpose: 'coding', reasoningEffort: 'medium',
  },
  'zhipu-cn': {
    label: 'Zhipu BigModel (China)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5.2',
    vision: false, protocol: 'chat-completions', purpose: 'coding',
  },
  zai: {
    label: 'Z.AI (Global)', baseUrl: 'https://api.z.ai/api/paas/v4', defaultModel: 'glm-5.2',
    vision: false, protocol: 'chat-completions', purpose: 'coding',
  },
  deepseek: {
    label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-flash',
    vision: false, protocol: 'chat-completions', purpose: 'coding',
  },
  ark: {
    label: 'Volcengine Ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-seed-2-1-pro-260628',
    vision: false, protocol: 'chat-completions', purpose: 'coding',
  },
  'kimi-cn': {
    label: 'Kimi (China)', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k3',
    vision: true, protocol: 'chat-completions', purpose: 'coding',
  },
  'kimi-global': {
    label: 'Kimi (Global)', baseUrl: 'https://api.moonshot.ai/v1', defaultModel: 'kimi-k3',
    vision: true, protocol: 'chat-completions', purpose: 'coding',
  },
  replicate: {
    label: 'Replicate', baseUrl: 'https://api.replicate.com/v1', defaultModel: 'tencent/hunyuan-3d-3.1',
    vision: false, protocol: 'replicate', purpose: '3d',
  },
})

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS) as OrbitProviderId[])
export const CODING_PROVIDER_IDS = Object.freeze(PROVIDER_IDS.filter((id): id is OrbitCodingProviderId => PROVIDERS[id].purpose === 'coding'))

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

export function codingProvider(provider: string): OrbitProviderDefinition {
  const definition = PROVIDERS[provider as OrbitProviderId]
  if (!definition || definition.purpose !== 'coding') throw new TypeError('Unsupported coding provider')
  return definition
}

export function selectedProviderModel(model: unknown, definition: OrbitProviderDefinition): string {
  const value = String(model || definition.defaultModel).trim()
  if (!value || value.length > MAX_MODEL_ID_CHARS || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('Model id is invalid')
  }
  return value
}

export function providerRequestHeaders(provider: OrbitCodingProviderId, token: string, clientHeaders: Record<string, string> = {}): Record<string, string> {
  const apiKey = String(token || '').trim()
  if (!apiKey) throw new Error(`No ${codingProvider(provider).label} API key is configured`)
  const safeClientHeaders = Object.fromEntries(Object.entries(clientHeaders).filter(([name, value]) => (
    typeof value === 'string'
    && value.length <= 512
    && !['authorization', 'proxy-authorization', 'cookie', 'set-cookie'].includes(name.toLowerCase())
  )))
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...safeClientHeaders }
}

function outputLimit(value: unknown, maximum = DEFAULT_MODEL_OUTPUT_TOKENS): number {
  return Math.min(maximum, Math.max(16, Number(value) || maximum))
}

function usageObject(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function usageNumber(source: JsonRecord | null, keys: string[]): { found: boolean; value: number } {
  if (!source) return { found: false, value: 0 }
  let found = false
  for (const key of keys) {
    if (!Object.hasOwn(source, key)) continue
    found = true
    const raw = source[key]
    const number = typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? Number(raw)
        : Number.NaN
    if (Number.isFinite(number) && number >= 0) {
      return { found: true, value: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number)) }
    }
  }
  return { found, value: 0 }
}

/**
 * Normalize token counts emitted by OpenAI-compatible Chat Completions and
 * Responses APIs. Pricing, cost estimates and the provider's raw usage object
 * deliberately remain host concerns and are never returned from this helper.
 */
export function normalizeProviderUsage(raw: unknown): OrbitProviderUsage | null {
  const usage = usageObject(raw)
  if (!usage) return null
  const promptDetails = usageObject(usage.promptTokensDetails)
    || usageObject(usage.prompt_tokens_details)
    || usageObject(usage.input_tokens_details)
  const completionDetails = usageObject(usage.completionTokensDetails)
    || usageObject(usage.completion_tokens_details)
    || usageObject(usage.output_tokens_details)

  const prompt = usageNumber(usage, ['promptTokens', 'prompt_tokens', 'inputTokens', 'input_tokens'])
  const completion = usageNumber(usage, ['completionTokens', 'completion_tokens', 'outputTokens', 'output_tokens'])
  const reasoningDetail = usageNumber(completionDetails, ['reasoningTokens', 'reasoning_tokens'])
  const reasoningTopLevel = usageNumber(usage, ['reasoningTokens', 'reasoning_tokens'])
  const cachedDetail = usageNumber(promptDetails, ['cachedTokens', 'cached_tokens', 'cacheReadTokens', 'cache_read_tokens'])
  const cachedTopLevel = usageNumber(usage, [
    'cachedTokens', 'cached_tokens', 'cacheReadTokens', 'cache_read_tokens',
    'promptCacheHitTokens', 'prompt_cache_hit_tokens',
  ])
  const cacheMiss = usageNumber(usage, ['promptCacheMissTokens', 'prompt_cache_miss_tokens'])
  const total = usageNumber(usage, ['totalTokens', 'total_tokens'])
  const recognized = prompt.found || completion.found || reasoningDetail.found || reasoningTopLevel.found
    || cachedDetail.found || cachedTopLevel.found || cacheMiss.found || total.found
  if (!recognized) return null

  const cachedTokens = cachedDetail.found ? cachedDetail.value : cachedTopLevel.value
  const promptTokens = prompt.found
    ? prompt.value
    : Math.min(Number.MAX_SAFE_INTEGER, cachedTopLevel.value + cacheMiss.value)
  const completionTokens = completion.value
  return {
    promptTokens,
    completionTokens,
    reasoningTokens: reasoningDetail.found ? reasoningDetail.value : reasoningTopLevel.value,
    cachedTokens,
    totalTokens: total.found
      ? total.value
      : Math.min(Number.MAX_SAFE_INTEGER, promptTokens + completionTokens),
  }
}

function responsesContent(content: unknown): string | JsonRecord[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const items: JsonRecord[] = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') items.push({ type: 'input_text', text: part.text })
    else if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') items.push({ type: 'input_image', image_url: part.image_url.url })
  }
  return items
}

export function responsesInput(messages: JsonRecord[]): JsonRecord[] {
  const input: JsonRecord[] = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'tool') {
      if (typeof message.tool_call_id === 'string') input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: String(message.content || '') })
      continue
    }
    if (message.role === 'assistant') {
      if (Array.isArray(message.response_items)) {
        for (const item of message.response_items) if (item && typeof item === 'object' && typeof item.type === 'string') input.push(item)
        continue
      }
      if (typeof message.content === 'string' && message.content) input.push({ role: 'assistant', content: message.content })
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (typeof call?.id === 'string' && typeof call.function?.name === 'string' && typeof call.function.arguments === 'string') {
          input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })
        }
      }
      continue
    }
    if (['user', 'system', 'developer'].includes(message.role)) {
      const content = responsesContent(message.content)
      if (typeof content === 'string' || content.length) input.push({ role: message.role, content })
    }
  }
  return input
}

export function responsesTools(tools: JsonRecord[]): JsonRecord[] {
  return (Array.isArray(tools) ? tools : []).flatMap((tool) => tool?.type === 'function' && typeof tool.function?.name === 'string'
    ? [{ type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters, strict: tool.function.strict === true }]
    : [])
}

export function buildProviderRequest({ provider, model, messages, tools = [], system = '', maxOutputTokens = DEFAULT_MODEL_OUTPUT_TOKENS }: Omit<OrbitProviderCompletionInput, 'apiKey' | 'fetchImpl' | 'clientHeaders' | 'signal' | 'onRetry'>): { definition: OrbitProviderDefinition; modelId: string; url: string; body: JsonRecord } {
  const definition = codingProvider(provider)
  const modelId = selectedProviderModel(model, definition)
  const isResponses = definition.protocol === 'responses'
  const body = isResponses ? {
    model: modelId,
    instructions: system || undefined,
    input: responsesInput(messages),
    ...(tools.length ? { tools: responsesTools(tools), tool_choice: 'auto', parallel_tool_calls: false } : {}),
    ...(definition.reasoningEffort ? { reasoning: { effort: definition.reasoningEffort } } : {}),
    max_output_tokens: outputLimit(maxOutputTokens),
    store: false,
  } : {
    model: modelId,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...(Array.isArray(messages) ? messages : [])],
    ...(tools.length ? { tools } : {}),
    max_tokens: outputLimit(maxOutputTokens),
    stream: false,
  }
  return {
    definition,
    modelId,
    url: `${definition.baseUrl}/${isResponses ? 'responses' : 'chat/completions'}`,
    body,
  }
}

function responseAssistant(json: JsonRecord): OrbitProviderAssistant {
  const responseItems = Array.isArray(json?.output) ? json.output : []
  const content: string[] = []
  const toolCalls: JsonRecord[] = []
  const reasoning: string[] = []
  for (const item of responseItems) {
    if (item?.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === 'output_text' && typeof part.text === 'string') content.push(part.text)
      }
    } else if (item?.type === 'function_call' && typeof item.name === 'string' && typeof item.arguments === 'string') {
      const id = typeof item.call_id === 'string' ? item.call_id : item.id
      if (typeof id === 'string') toolCalls.push({ id, type: 'function', function: { name: item.name, arguments: item.arguments } })
    } else if (item?.type === 'reasoning') {
      for (const part of Array.isArray(item.summary) ? item.summary : []) if (typeof part?.text === 'string') reasoning.push(part.text)
    }
  }
  if (!content.length && typeof json?.output_text === 'string') content.push(json.output_text)
  if (!content.length && !toolCalls.length) {
    const detail = json?.incomplete_details?.reason ? ` (${json.incomplete_details.reason})` : ''
    throw new Error(`Provider returned no assistant message${detail}`)
  }
  const usage = normalizeProviderUsage(json?.usage)
  return {
    role: 'assistant', content: content.join('\n'),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(reasoning.length ? { reasoning: reasoning.join('\n') } : {}),
    response_items: responseItems,
    ...(usage ? { usage } : {}),
  }
}

export function parseProviderAssistant(provider: OrbitCodingProviderId, json: unknown): OrbitProviderAssistant {
  const body = usageObject(json) || {}
  const definition = codingProvider(provider)
  if (definition.protocol === 'responses') return responseAssistant(body)
  const choice = body.choices?.[0]
  if (choice?.error) throw Object.assign(new Error(choice.error.message || 'The routed model failed'), { status: Number(choice.error.code) || 502 })
  const message = choice?.message
  if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) {
    throw new Error('Provider returned no assistant message')
  }
  const usage = normalizeProviderUsage(body.usage)
  return {
    role: 'assistant', content: typeof message.content === 'string' ? message.content : '',
    ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
    ...(typeof message.reasoning_content === 'string' ? { reasoning_content: message.reasoning_content } : {}),
    ...(typeof message.reasoning === 'string' ? { reasoning: message.reasoning } : {}),
    ...(Array.isArray(message.reasoning_details) ? { reasoning_details: message.reasoning_details } : {}),
    ...(usage ? { usage } : {}),
  }
}

export function parseProviderModels(json: unknown): OrbitProviderModel[] {
  const body = usageObject(json) || {}
  const models: OrbitProviderModel[] = []
  for (const item of Array.isArray(body.data) ? body.data : []) {
    const id = typeof item?.id === 'string' ? item.id.trim() : ''
    if (!id || id.length > MAX_MODEL_ID_CHARS || /[\u0000-\u001f\u007f]/.test(id)) continue
    models.push({
      id,
      name: typeof item.name === 'string' ? item.name.slice(0, 160) : id,
      vision: Array.isArray(item.architecture?.input_modalities) && item.architecture.input_modalities.includes('image'),
    })
    if (models.length >= 2_000) break
  }
  return models
}

async function responseJson(response: Response): Promise<JsonRecord | null> {
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('Provider response is too large')
    const text = new TextDecoder().decode(bytes)
    try { return text ? JSON.parse(text) : null } catch { return null }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error('Provider response is too large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const text = new TextDecoder().decode(bytes)
  try { return text ? JSON.parse(text) : null } catch { return null }
}

function providerError(json: JsonRecord | null, status: number): Error & { status: number } {
  return Object.assign(new Error(json?.error?.message || json?.message || `Provider request failed (${status})`), { status })
}

async function retryDelay(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Provider request aborted'))
    const timer = setTimeout(resolve, milliseconds)
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason || new Error('Provider request aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function completeWithProvider({
  provider, apiKey, model, messages, tools = [], system = '',
  maxOutputTokens = DEFAULT_MODEL_OUTPUT_TOKENS, signal, onRetry,
  fetchImpl = fetch, clientHeaders = {},
}: OrbitProviderCompletionInput): Promise<OrbitProviderAssistant> {
  const request = buildProviderRequest({ provider, model, messages, tools, system, maxOutputTokens })
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(request.url, {
        method: 'POST', signal,
        headers: providerRequestHeaders(provider, apiKey, clientHeaders),
        body: JSON.stringify(request.body),
      })
      const json = await responseJson(response)
      if (!response.ok) throw providerError(json, response.status)
      return parseProviderAssistant(provider, json)
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error
      lastError = error
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0
      if (!RETRYABLE.has(status) || attempt === 3) throw error
      await onRetry?.({ attempt, error })
      await retryDelay(750 * 2 ** (attempt - 1), signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Provider request failed')
}

export async function discoverProviderModels({ provider, apiKey, signal, fetchImpl = fetch, clientHeaders = {} }: Pick<OrbitProviderCompletionInput, 'provider' | 'apiKey' | 'signal' | 'fetchImpl' | 'clientHeaders'>): Promise<OrbitProviderModel[]> {
  const definition = codingProvider(provider)
  if (!definition.modelsPath) throw new Error(`${definition.label} does not expose a model catalog`)
  const response = await fetchImpl(`${definition.baseUrl}${definition.modelsPath}`, {
    method: 'GET', signal, headers: providerRequestHeaders(provider, apiKey, clientHeaders),
  })
  const json = await responseJson(response)
  if (!response.ok) throw providerError(json, response.status)
  return parseProviderModels(json)
}

function replicateOutputUrl(value: unknown): string | null {
  if (typeof value === 'string' && value.startsWith('https://')) return value
  if (Array.isArray(value)) {
    for (const item of value) { const found = replicateOutputUrl(item); if (found) return found }
  }
  if (value && typeof value === 'object') {
    for (const key of ['glb', 'mesh', 'model', 'image', 'images', 'url', 'output']) {
      const found = replicateOutputUrl((value as JsonRecord)[key]); if (found) return found
    }
  }
  return null
}

export function validateReplicateDeliveryUrl(value: unknown): string {
  if (!value) throw new Error('Replicate returned no asset download URL')
  const url = new URL(String(value))
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || (host !== 'replicate.delivery' && !host.endsWith('.replicate.delivery'))) {
    throw new Error('Replicate returned an untrusted asset download URL')
  }
  return url.href
}

interface ReplicatePredictionInput<TState extends OrbitReplicate3dState> {
  apiKey: string
  model: string
  input: JsonRecord
  label: string
  state: TState
  signal?: AbortSignal | null
  fetchImpl: typeof fetch
  persist?: (state: TState) => void | Promise<void>
  onProgress?: (prediction: JsonRecord) => void | Promise<void>
  pollIntervalMs: number
}

async function runReplicatePrediction<TState extends OrbitReplicate3dState>({
  apiKey, model, input, label, state, signal, fetchImpl, persist, onProgress, pollIntervalMs,
}: ReplicatePredictionInput<TState>): Promise<{ predictionId: string; status: string; outputUrl: string; model: string }> {
  const token = String(apiKey || '').trim()
  if (!token) throw new Error('No Replicate API key is configured')
  if (!state.predictionId) {
    state.requestPending = true
    state.model = model
    await persist?.(state)
    let response
    try {
      response = await fetchImpl(`https://api.replicate.com/v1/models/${model}/predictions`, {
        method: 'POST', signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      })
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        code: 'REPLICATE_SUBMISSION_UNCERTAIN',
      })
    }
    const body = await responseJson(response)
    if (!response.ok) {
      // A structured provider rejection proves that no ambiguous client-side
      // replay is needed. Transport failures intentionally leave the pending
      // marker set so the host can require an explicit paid retry.
      state.requestPending = false
      await persist?.(state)
      throw Object.assign(new Error(body?.detail || `Replicate ${label} request failed (${response.status})`), { status: response.status })
    }
    if (typeof body?.id !== 'string' || !body.id) {
      throw Object.assign(new Error(body?.detail || `Replicate ${label} request returned no prediction id`), {
        status: response.status,
        code: 'REPLICATE_SUBMISSION_UNCERTAIN',
      })
    }
    state.predictionId = body.id
    state.status = body.status
    state.requestPending = false
    await persist?.(state)
  }
  while (true) {
    const response = await fetchImpl(`https://api.replicate.com/v1/predictions/${encodeURIComponent(state.predictionId!)}`, {
      signal, headers: { Authorization: `Bearer ${token}` },
    })
    const prediction = await responseJson(response)
    if (!response.ok || !prediction) throw Object.assign(new Error(`Replicate ${label} polling failed (${response.status})`), { status: response.status })
    state.status = prediction.status
    await persist?.(state)
    await onProgress?.(prediction)
    if (['succeeded', 'failed', 'canceled'].includes(prediction.status)) {
      if (prediction.status !== 'succeeded') throw new Error(`Replicate ${label} generation ${prediction.status}: ${prediction.error || 'unknown error'}`)
      const outputUrl = validateReplicateDeliveryUrl(replicateOutputUrl(prediction.output))
      state.outputUrl = outputUrl
      await persist?.(state)
      return { predictionId: state.predictionId!, status: prediction.status, outputUrl, model }
    }
    await retryDelay(Math.min(30_000, Math.max(250, Number(pollIntervalMs) || 5_000)), signal)
  }
}

export async function generateReplicateImage({
  apiKey, prompt, aspectRatio = '1:1', model = REPLICATE_IMAGE_MODEL, state = {},
  signal, fetchImpl = fetch, persist, onProgress, pollIntervalMs = 5_000,
}: {
  apiKey: string; prompt: string; aspectRatio?: '1:1' | '9:16' | '16:9'; model?: string
  state?: OrbitReplicateImageState; signal?: AbortSignal | null; fetchImpl?: typeof fetch
  persist?: (state: OrbitReplicateImageState) => void | Promise<void>
  onProgress?: (prediction: JsonRecord) => void | Promise<void>; pollIntervalMs?: number
}): Promise<{ predictionId: string; status: string; outputUrl: string; model: string }> {
  const ratio = ['1:1', '9:16', '16:9'].includes(aspectRatio) ? aspectRatio : '1:1'
  const selectedModel = String(model || REPLICATE_IMAGE_MODEL).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(selectedModel)) {
    throw new TypeError('Replicate image model id is invalid')
  }
  return runReplicatePrediction({
    apiKey,
    model: selectedModel,
    input: {
      prompt: String(prompt || '').slice(0, 8_000),
      aspect_ratio: ratio,
      output_format: 'png',
    },
    label: 'image', state, signal, fetchImpl, persist, onProgress, pollIntervalMs,
  })
}

export async function generateReplicateModel3d({
  apiKey, prompt, faceCount = 100_000, enablePbr = true, state = {},
  signal, fetchImpl = fetch, persist, onProgress, pollIntervalMs = 5_000,
}: {
  apiKey: string; prompt: string; faceCount?: number; enablePbr?: boolean
  state?: OrbitReplicate3dState; signal?: AbortSignal | null; fetchImpl?: typeof fetch
  persist?: (state: OrbitReplicate3dState) => void | Promise<void>
  onProgress?: (prediction: JsonRecord) => void | Promise<void>; pollIntervalMs?: number
}): Promise<{ predictionId: string; status: string; outputUrl: string }> {
  const model = PROVIDERS.replicate.defaultModel
  return runReplicatePrediction({
    apiKey,
    model,
    input: {
        prompt: String(prompt || '').slice(0, 8_000),
        face_count: Math.min(1_500_000, Math.max(40_000, Number(faceCount) || 100_000)),
        generate_type: 'Normal',
        enable_pbr: enablePbr !== false,
    },
    label: '3D', state, signal, fetchImpl, persist, onProgress, pollIntervalMs,
  }).then(({ predictionId, status, outputUrl }) => ({ predictionId, status, outputUrl }))
}
