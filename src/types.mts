import type { OrbitCodingProviderId } from '@soda_game/orbit-provider-core'

export type OrbitClientSource = 'cli' | 'cli_gui'
export type OrbitMode = 'orbit' | 'byok'
export type OrbitOperation = 'create' | 'edit'
export type OrbitRunState = 'queued' | 'running' | 'recovering' | 'interrupted' | 'paused' | 'completed' | 'failed' | 'cancelled'

export interface OrbitCliConfig {
  version: 1
  mode: OrbitMode
  provider: OrbitCodingProviderId
  model: string
  runtime: string
  cloudLogs: boolean
}

export interface OrbitToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface OrbitMessage extends Record<string, any> {
  role: 'user' | 'assistant' | 'tool'
  content: any
  tool_calls?: OrbitToolCall[]
  tool_call_id?: string
}

export interface OrbitReference extends Record<string, any> {
  id?: string
  path?: string
}

export interface OrbitRun extends Record<string, any> {
  schema: string
  id: string
  source: OrbitClientSource
  state: OrbitRunState
  operation: OrbitOperation
  prompt: string
  workspace: string
  mode: OrbitMode
  provider: OrbitCodingProviderId | null
  model: string
  runtime: string
  generateImages: boolean
  generate3d: boolean
  cloudLogs: boolean
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  sequence: number
  iteration: number
  messages: OrbitMessage[]
  references: OrbitReference[]
  referenceSummary: string | null
  plan: Record<string, any> | null
  cloudRunId: string | null
  pendingModelCall: Record<string, any> | null
  pendingTool: { id: string; name: string; arguments: string; startedAt: string } | null
  unsafeResumeRequired: boolean
  lastError: { code: string; message: string } | null
  result: Record<string, any> | null
}

export interface OrbitRunCreateInput extends Record<string, any> {
  id?: string
  source?: OrbitClientSource
  operation?: OrbitOperation
  prompt?: string
  workspace: string
  mode?: OrbitMode
  provider?: OrbitCodingProviderId | null
  model?: string
  runtime?: string
  generateImages?: boolean
  generate3d?: boolean
  cloudLogs?: boolean
  references?: OrbitReference[]
}

export function asError(error: unknown): Error & { code?: string; status?: number; details?: unknown } {
  return error instanceof Error
    ? error as Error & { code?: string; status?: number; details?: unknown }
    : Object.assign(new Error(String(error)), { cause: error })
}
