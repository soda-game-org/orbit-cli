import type { OrbitCodingProviderId } from '@soda_game/orbit-provider-core'
import type {
  OrbitAgentExecutionState,
  OrbitAgentInputItem,
  OrbitAgentMediaCache,
  OrbitAgentMediaObservation,
  OrbitAgentToolBatchJournal,
} from '@soda_game/orbit-agent-core'

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

export interface OrbitToolBatchControl {
  errors: Array<{ key: string; name: string }>
  validationFailures: string[]
  validationObserved: boolean
  finishRequested: boolean
}

export interface OrbitRun extends Record<string, any> {
  schema: string
  id: string
  source: OrbitClientSource
  state: OrbitRunState
  operation: OrbitOperation
  prompt: string
  workspace: string
  historicalWorkspaceRoots?: string[]
  mode: OrbitMode
  provider: OrbitCodingProviderId | null
  model: string
  runtime: string
  requestedRuntime?: string
  runtimeDecision?: { schema: 'orbit.agent-runtime-decision.v1'; runtime: string; dimension: string; rationale: string; decidedBy: 'agent' }
  generateImages: boolean
  generate3d: boolean
  cloudLogs: boolean
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  sequence: number
  iteration: number
  threadId?: string
  turnId?: string
  messages: OrbitMessage[]
  turnOutputMessages?: OrbitMessage[]
  inputItems?: OrbitAgentInputItem[]
  mediaObservations?: OrbitAgentMediaObservation[]
  mediaCache?: OrbitAgentMediaCache
  visionCapability?: { provider: OrbitCodingProviderId | 'orbit'; model: string; vision: boolean; maxOutputTokens?: number; confirmedAt: string }
  turnInputProjected?: boolean
  references: OrbitReference[]
  referenceSummary: string | null
  plan: Record<string, any> | null
  cloudRunId: string | null
  pendingSemanticCompaction?: {
    schema: 'orbit.cli-semantic-compaction.v1'
    sourceFingerprint: string
    generation: number
    requestKey: string
    status: 'pending' | 'ready'
    rawSemanticSummary?: string
  } | null
  compactionDeferredFingerprint?: string | null
  pendingModelCall: Record<string, any> | null
  pendingTool: { id: string; name: string; arguments: string; startedAt: string } | null
  pendingToolBatch?: OrbitAgentToolBatchJournal | null
  pendingToolBatchControl?: OrbitToolBatchControl | null
  executionState?: OrbitAgentExecutionState | null
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
  historicalWorkspaceRoots?: string[]
  mode?: OrbitMode
  provider?: OrbitCodingProviderId | null
  model?: string
  runtime?: string
  generateImages?: boolean
  generate3d?: boolean
  cloudLogs?: boolean
  references?: OrbitReference[]
  messages?: OrbitMessage[]
  threadId?: string
  turnId?: string
  inputItems?: OrbitAgentInputItem[]
  mediaObservations?: OrbitAgentMediaObservation[]
  mediaCache?: OrbitAgentMediaCache
  visionCapability?: OrbitRun['visionCapability']
  kind?: 'assetimage' | 'asset3d'
  assetImage?: Record<string, any>
  asset3d?: Record<string, any>
  assetOutput?: string
  assetAspectRatio?: string
}

export function asError(error: unknown): Error & { code?: string; status?: number; details?: unknown } {
  return error instanceof Error
    ? error as Error & { code?: string; status?: number; details?: unknown }
    : Object.assign(new Error(String(error)), { cause: error })
}
