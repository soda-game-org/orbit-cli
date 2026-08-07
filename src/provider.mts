import fs from 'node:fs/promises'
import { MODEL_OUTPUT_TOKENS, PROVIDERS } from './constants.mjs'
import { providerCredentialAccount } from './credentials.mjs'
import { referenceDataUrl, type ReferenceImageMetadata } from './attachments.mjs'
import {
  codingProvider,
  completeWithProvider,
  discoverProviderModels,
} from '../packages/orbit-provider-core/index.mjs'
import { publicError } from './util.mjs'
import type { OrbitCodingProviderId, OrbitProviderAssistant, OrbitProviderCompletionInput, OrbitProviderModel } from '../packages/orbit-provider-core/index.mjs'

const CLI_OPENROUTER_HEADERS = Object.freeze({
  'HTTP-Referer': 'https://github.com/soda-game-org/orbit-cli',
  'X-Title': 'Orbit CLI',
})

export async function publicGenericSkill(): Promise<string> {
  return fs.readFile(new URL('../skills/generic-html-game/SKILL.md', import.meta.url), 'utf8')
}

export class ByokProvider {
  readonly credentials: { get(account: string): Promise<string | null> }
  readonly fetchImpl: typeof fetch

  constructor(credentials: { get(account: string): Promise<string | null> }, { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}) {
    this.credentials = credentials
    this.fetchImpl = fetchImpl
  }

  async capability(provider: OrbitCodingProviderId): Promise<Record<string, unknown>> {
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

  async models(provider: OrbitCodingProviderId, { signal }: { signal?: AbortSignal | null } = {}): Promise<OrbitProviderModel[]> {
    const definition = codingProvider(provider)
    if (!definition.modelsPath) throw new Error(`${definition.label} does not expose a model catalog through Orbit CLI`)
    const token = await this.credentials.get(providerCredentialAccount(provider))
    if (!token) throw new Error(`No ${definition.label} API key is configured`)
    return discoverProviderModels({
      provider, apiKey: token, signal, fetchImpl: this.fetchImpl,
      clientHeaders: provider === 'openrouter' ? CLI_OPENROUTER_HEADERS : {},
    })
  }

  async test(provider: OrbitCodingProviderId, model?: string): Promise<boolean> {
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

  async complete({ provider, model, messages, tools = [], system = '', maxOutputTokens = MODEL_OUTPUT_TOKENS, signal, onRetry }: Omit<OrbitProviderCompletionInput, 'apiKey' | 'fetchImpl' | 'clientHeaders'>): Promise<OrbitProviderAssistant> {
    const definition = codingProvider(provider)
    const token = await this.credentials.get(providerCredentialAccount(provider))
    if (!token) throw new Error(`No ${definition.label} API key is configured`)
    return completeWithProvider({
      provider, apiKey: token, model, messages, tools, system, maxOutputTokens, signal,
      fetchImpl: this.fetchImpl,
      clientHeaders: provider === 'openrouter' ? CLI_OPENROUTER_HEADERS : {},
      onRetry: onRetry ? ({ attempt, error }: { attempt: number; error: unknown }) => onRetry({ attempt, error: publicError(error) }) : undefined,
    })
  }

  async analyzeReferences({ provider, model, references, workspace, signal }: { provider: OrbitCodingProviderId; model?: string; references: ReferenceImageMetadata[]; workspace: string; signal?: AbortSignal | null }): Promise<string> {
    const capability = await this.capability(provider)
    if (!capability.vision) {
      const error = Object.assign(new Error(`${PROVIDERS[provider].label} is not declared as a vision-capable CLI provider`), { code: 'VISION_UNAVAILABLE' })
      throw error
    }
    const content: Record<string, any>[] = [{
      type: 'text',
      text: 'Analyze these private reference images for game implementation. Summarize composition, palette, characters, environment, camera, UI, and interaction cues. Do not claim the files will be copied into the game.',
    }]
    for (const reference of references) content.push({ type: 'image_url', image_url: { url: await referenceDataUrl(reference, workspace) } })
    const result = await this.complete({ provider, model, messages: [{ role: 'user', content }], tools: [], maxOutputTokens: 4096, signal })
    return result.content
  }
}

export class OrbitProvider {
  readonly api: any

  constructor(api: any) { this.api = api }

  async complete({ cloudRunId, requestKey, messages, tools, runtime, operation, maxOutputTokens, signal }: Record<string, any>): Promise<OrbitProviderAssistant> {
    const result = await this.api.complete({ cloudRunId, requestKey, purpose: 'agent', messages, tools, runtime, operation, maxOutputTokens, signal })
    const assistant = result?.assistant
    if (!assistant || typeof assistant !== 'object') throw new Error('Orbit returned no assistant message')
    return assistant
  }

  async analyzeReferences({ cloudRunId, requestKey, references, workspace, signal }: Record<string, any>): Promise<string> {
    const content: Record<string, any>[] = [{
      type: 'text',
      text: 'Analyze these private reference images for game implementation. Summarize composition, palette, characters, environment, camera, UI, and interaction cues. The original files stay private and must not be copied into game source.',
    }]
    for (const reference of references) content.push({ type: 'image_url', image_url: { url: await referenceDataUrl(reference, workspace) } })
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
