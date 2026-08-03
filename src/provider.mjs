import fs from 'node:fs/promises'
import path from 'node:path'
import { MODEL_OUTPUT_TOKENS, PROVIDERS } from './constants.mjs'
import { providerCredentialAccount } from './credentials.mjs'
import { referenceDataUrl } from './attachments.mjs'
import { collectStream, publicError, sleep } from './util.mjs'

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

export async function publicGenericSkill() {
  return fs.readFile(new URL('../skills/generic-html-game/SKILL.md', import.meta.url), 'utf8')
}

export class ByokProvider {
  constructor(credentials, { fetchImpl = fetch } = {}) {
    this.credentials = credentials
    this.fetchImpl = fetchImpl
  }

  async capability(provider) {
    const definition = PROVIDERS[provider]
    if (!definition || provider === 'replicate') throw new TypeError('Unsupported coding provider')
    return {
      provider,
      configured: Boolean(await this.credentials.get(providerCredentialAccount(provider))),
      vision: definition.vision,
      defaultModel: definition.defaultModel,
    }
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
    const definition = PROVIDERS[provider]
    if (!definition || provider === 'replicate') throw new TypeError('Unsupported coding provider')
    const token = await this.credentials.get(providerCredentialAccount(provider))
    if (!token) throw new Error(`No ${definition.label} API key is configured`)
    const selectedModel = String(model || definition.defaultModel).trim()
    if (!selectedModel || selectedModel.length > 120) throw new TypeError('Model id is invalid')
    const body = {
      model: selectedModel,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
      ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
      temperature: 1,
      max_tokens: Math.min(MODEL_OUTPUT_TOKENS, Math.max(16, Number(maxOutputTokens) || MODEL_OUTPUT_TOKENS)),
      stream: false,
    }
    let lastError
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${definition.baseUrl}/chat/completions`, {
          method: 'POST',
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(provider === 'openrouter' ? {
              'HTTP-Referer': 'https://github.com/the-super-engine/orbit-cli',
              'X-Title': 'Orbit CLI',
            } : {}),
          },
          body: JSON.stringify(body),
        })
        const text = Buffer.from(await collectStream(response.body, 8 * 1024 * 1024)).toString('utf8')
        let json
        try { json = text ? JSON.parse(text) : null } catch { json = null }
        if (!response.ok) {
          const error = new Error(json?.error?.message || json?.message || `Provider request failed (${response.status})`)
          error.status = response.status
          throw error
        }
        const message = json?.choices?.[0]?.message
        if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) {
          throw new Error('Provider returned no assistant message')
        }
        return {
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : '',
          ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
          ...(typeof message.reasoning_content === 'string' ? { reasoning: message.reasoning_content } : {}),
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
