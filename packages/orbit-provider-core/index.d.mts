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

export interface OrbitProviderAssistant {
  role: 'assistant'
  content: string
  reasoning?: string
  reasoning_content?: string
  reasoning_details?: Array<Record<string, unknown>>
  response_items?: Array<Record<string, unknown>>
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  usage?: OrbitProviderUsage
}

export interface OrbitProviderUsage {
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  cachedTokens: number
  totalTokens: number
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
  messages: Array<Record<string, unknown>>
  tools?: Array<Record<string, unknown>>
  system?: string
  maxOutputTokens?: number
  signal?: AbortSignal | null
  onRetry?: (input: { attempt: number; error: unknown }) => void | Promise<void>
  fetchImpl?: typeof fetch
  clientHeaders?: Record<string, string>
}

export const DEFAULT_MODEL_OUTPUT_TOKENS: number
export const MAX_PROVIDER_RESPONSE_BYTES: number
export const MAX_MODEL_ID_CHARS: number
export const PROVIDERS: Readonly<Record<OrbitProviderId, OrbitProviderDefinition>>
export const PROVIDER_IDS: readonly OrbitProviderId[]
export const CODING_PROVIDER_IDS: readonly OrbitCodingProviderId[]

export function codingProvider(provider: string): OrbitProviderDefinition
export function selectedProviderModel(model: unknown, definition: OrbitProviderDefinition): string
export function providerRequestHeaders(provider: OrbitCodingProviderId, token: string, clientHeaders?: Record<string, string>): Record<string, string>
export function responsesInput(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>>
export function responsesTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>>
export function buildProviderRequest(input: Omit<OrbitProviderCompletionInput, 'apiKey' | 'fetchImpl' | 'clientHeaders' | 'signal' | 'onRetry'>): {
  definition: OrbitProviderDefinition
  modelId: string
  url: string
  body: Record<string, unknown>
}
export function normalizeProviderUsage(raw: unknown): OrbitProviderUsage | null
export function parseProviderAssistant(provider: OrbitCodingProviderId, json: unknown): OrbitProviderAssistant
export function parseProviderModels(json: unknown): OrbitProviderModel[]
export function completeWithProvider(input: OrbitProviderCompletionInput): Promise<OrbitProviderAssistant>
export function discoverProviderModels(input: {
  provider: OrbitCodingProviderId
  apiKey: string
  signal?: AbortSignal | null
  fetchImpl?: typeof fetch
  clientHeaders?: Record<string, string>
}): Promise<OrbitProviderModel[]>

export interface OrbitReplicate3dState {
  predictionId?: string
  status?: string
  requestPending?: boolean
  outputUrl?: string
  [key: string]: unknown
}

export function validateReplicateDeliveryUrl(value: unknown): string
export function generateReplicateModel3d(input: {
  apiKey: string
  prompt: string
  faceCount?: number
  enablePbr?: boolean
  state?: OrbitReplicate3dState
  signal?: AbortSignal | null
  fetchImpl?: typeof fetch
  persist?: (state: OrbitReplicate3dState) => void | Promise<void>
  onProgress?: (prediction: Record<string, unknown>) => void | Promise<void>
  pollIntervalMs?: number
}): Promise<{ predictionId: string; status: string; outputUrl: string }>
