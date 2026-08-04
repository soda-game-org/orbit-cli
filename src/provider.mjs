import fs from 'node:fs/promises'
import { MODEL_OUTPUT_TOKENS, PROVIDERS } from './constants.mjs'
import { providerCredentialAccount } from './credentials.mjs'
import { referenceDataUrl } from './attachments.mjs'
import {
  codingProvider,
  completeWithProvider,
  discoverProviderModels,
} from '../packages/orbit-provider-core/index.mjs'
import { publicError } from './util.mjs'

const CLI_OPENROUTER_HEADERS = Object.freeze({
  'HTTP-Referer': 'https://github.com/soda-game-org/orbit-cli',
  'X-Title': 'Orbit CLI',
})

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
    return discoverProviderModels({
      provider, apiKey: token, signal, fetchImpl: this.fetchImpl,
      clientHeaders: provider === 'openrouter' ? CLI_OPENROUTER_HEADERS : {},
    })
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
    return completeWithProvider({
      provider, apiKey: token, model, messages, tools, system, maxOutputTokens, signal,
      fetchImpl: this.fetchImpl,
      clientHeaders: provider === 'openrouter' ? CLI_OPENROUTER_HEADERS : {},
      onRetry: onRetry ? ({ attempt, error }) => onRetry({ attempt, error: publicError(error) }) : undefined,
    })
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
