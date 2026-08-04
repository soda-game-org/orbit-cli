import fs from 'node:fs/promises'
import path from 'node:path'
import { MODEL_OUTPUT_TOKENS, PROVIDERS } from './constants.mjs'
import { providerCredentialAccount } from './credentials.mjs'
import { referenceDataUrl } from './attachments.mjs'
import { collectStream, publicError, sleep } from './util.mjs'

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_MODEL_ID_CHARS = 120

function codingProvider(provider) {
  const definition = PROVIDERS[provider]
  if (!definition || definition.purpose !== 'coding') throw new TypeError('Unsupported coding provider')
  return definition
}

function selectedModel(model, definition) {
  const value = String(model || definition.defaultModel).trim()
  if (!value || value.length > MAX_MODEL_ID_CHARS || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('Model id is invalid')
  return value
}

function providerHeaders(provider, token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(provider === 'openrouter' ? {
      'HTTP-Referer': 'https://github.com/soda-game-org/orbit-cli',
      'X-Title': 'Orbit CLI',
    } : {}),
  }
}

async function responseJson(response) {
  const text = Buffer.from(await collectStream(response.body, MAX_PROVIDER_RESPONSE_BYTES)).toString('utf8')
  try { return text ? JSON.parse(text) : null } catch { return null }
}

function outputLimit(value) {
  return Math.min(MODEL_OUTPUT_TOKENS, Math.max(16, Number(value) || MODEL_OUTPUT_TOKENS))
}

function responsesContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const items = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') items.push({ type: 'input_text', text: part.text })
    else if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') items.push({ type: 'input_image', image_url: part.image_url.url })
  }
  return items
}

function responsesInput(messages) {
  const input = []
  for (const message of messages) {
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

function responsesTools(tools) {
  return tools.flatMap((tool) => tool?.type === 'function' && typeof tool.function?.name === 'string'
    ? [{ type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters, strict: tool.function.strict === true }]
    : [])
}

function responseAssistant(json) {
  const responseItems = Array.isArray(json?.output) ? json.output : []
  const content = []
  const toolCalls = []
  const reasoning = []
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
  return {
    role: 'assistant',
    content: content.join('\n'),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(reasoning.length ? { reasoning: reasoning.join('\n') } : {}),
    response_items: responseItems,
  }
}

export async function publicGenericSkill() {
  return fs.readFile(new URL('../skills/generic-html-game/SKILL.md', import.meta.url), 'utf8')
}

export class ByokProvider {
  constructor(credentials, { fetchImpl = fetch } = {}) {
    this.credentials = credentials
    this.fetchImpl = fetchImpl
  }

  async capability(provider) {
    const definition = codingProvider(provider)
    return {
      provider,
      configured: Boolean(await this.credentials.get(providerCredentialAccount(provider))),
      vision: definition.vision,
      defaultModel: definition.defaultModel,
      protocol: definition.protocol,
      modelDiscovery: Boolean(definition.modelsPath),
    }
  }

  async models(provider, { signal } = {}) {
    const definition = codingProvider(provider)
    if (!definition.modelsPath) throw new Error(`${definition.label} does not expose a model catalog through Orbit CLI`)
    const token = await this.credentials.get(providerCredentialAccount(provider))
    if (!token) throw new Error(`No ${definition.label} API key is configured`)
    const response = await this.fetchImpl(`${definition.baseUrl}${definition.modelsPath}`, {
      method: 'GET', signal, headers: providerHeaders(provider, token),
    })
    const json = await responseJson(response)
    if (!response.ok) throw Object.assign(new Error(json?.error?.message || json?.message || `Provider request failed (${response.status})`), { status: response.status })
    const models = []
    for (const item of Array.isArray(json?.data) ? json.data : []) {
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

  async test(provider, model) {
    const response = await this.complete({
      provider,
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: orbit-ok' }],
      tools: [],
      system: 'Return only the requested short text.',
      maxOutputTokens: 32,
    })
    return String(response.content || '').toLowerCase().includes('orbit-ok')
  }

  async complete({ provider, model, messages, tools, system = '', maxOutputTokens = MODEL_OUTPUT_TOKENS, signal, onRetry }) {
    const definition = codingProvider(provider)
    const token = await this.credentials.get(providerCredentialAccount(provider))
    if (!token) throw new Error(`No ${definition.label} API key is configured`)
    const modelId = selectedModel(model, definition)
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
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
      ...(tools.length ? { tools } : {}),
      max_tokens: outputLimit(maxOutputTokens),
      stream: false,
    }
    let lastError
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${definition.baseUrl}/${isResponses ? 'responses' : 'chat/completions'}`, {
          method: 'POST',
          signal,
          headers: providerHeaders(provider, token),
          body: JSON.stringify(body),
        })
        const json = await responseJson(response)
        if (!response.ok) {
          const error = new Error(json?.error?.message || json?.message || `Provider request failed (${response.status})`)
          error.status = response.status
          throw error
        }
        if (isResponses) return responseAssistant(json)
        const choice = json?.choices?.[0]
        if (choice?.error) throw Object.assign(new Error(choice.error.message || 'The routed model failed'), { status: Number(choice.error.code) || 502 })
        const message = choice?.message
        if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) {
          throw new Error('Provider returned no assistant message')
        }
        return {
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : '',
          ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
          ...(typeof message.reasoning_content === 'string' ? { reasoning_content: message.reasoning_content } : {}),
          ...(typeof message.reasoning === 'string' ? { reasoning: message.reasoning } : {}),
          ...(Array.isArray(message.reasoning_details) ? { reasoning_details: message.reasoning_details } : {}),
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error
        lastError = error
        if (!RETRYABLE.has(Number(error?.status)) || attempt === 3) throw error
        await onRetry?.({ attempt, error: publicError(error) })
        await sleep(750 * 2 ** (attempt - 1), signal)
      }
    }
    throw lastError
  }

  async analyzeReferences({ provider, model, references, signal }) {
    const capability = await this.capability(provider)
    if (!capability.vision) {
      const error = new Error(`${PROVIDERS[provider].label} is not declared as a vision-capable CLI provider`)
      error.code = 'VISION_UNAVAILABLE'
      throw error
    }
    const content = [{
      type: 'text',
      text: 'Analyze these private reference images for game implementation. Summarize composition, palette, characters, environment, camera, UI, and interaction cues. Do not claim the files will be copied into the game.',
    }]
    for (const reference of references) content.push({ type: 'image_url', image_url: { url: await referenceDataUrl(reference) } })
    const result = await this.complete({ provider, model, messages: [{ role: 'user', content }], tools: [], maxOutputTokens: 4096, signal })
    return result.content
  }
}

export class OrbitProvider {
  constructor(api) { this.api = api }

  async complete({ cloudRunId, requestKey, messages, tools, runtime, operation, maxOutputTokens, signal }) {
    const result = await this.api.complete({ cloudRunId, requestKey, purpose: 'agent', messages, tools, runtime, operation, maxOutputTokens, signal })
    const assistant = result?.assistant
    if (!assistant || typeof assistant !== 'object') throw new Error('Orbit returned no assistant message')
    return assistant
  }

  async analyzeReferences({ cloudRunId, requestKey, references, signal }) {
    const content = [{
      type: 'text',
      text: 'Analyze these private reference images for game implementation. Summarize composition, palette, characters, environment, camera, UI, and interaction cues. The original files stay private and must not be copied into game source.',
    }]
    for (const reference of references) content.push({ type: 'image_url', image_url: { url: await referenceDataUrl(reference) } })
    const result = await this.api.complete({
      cloudRunId,
      requestKey,
      purpose: 'reference_media',
      messages: [{ role: 'user', content }],
      tools: [],
      maxOutputTokens: 4096,
      signal,
    })
    return typeof result?.assistant?.content === 'string' ? result.assistant.content : ''
  }
}
