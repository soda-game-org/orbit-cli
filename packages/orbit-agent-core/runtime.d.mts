export interface OrbitProAgentTodo {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled'
  kind: 'plan' | 'asset' | 'code' | 'sdk' | 'qa' | 'publish' | 'repair'
  detail?: string
  evidence?: string
  updatedAt?: number | string
}

export const ORBIT_AGENT_MODEL_OUTPUT_LIMITS: Readonly<{
  agent: 16_000
  referenceMedia: 4_096
}>

export interface OrbitAgentExecutionPolicy {
  maxIterations: number
  fallbackMaxIterations: number
  maxToolCallsPerTurn: number
  consecutiveNoToolLimit: number
  consecutiveModelFailureLimit: number
  repeatedToolErrorWarning: number
  repeatedToolErrorLimit: number
  repeatedValidationFailureLimit: number
  maxToolOutputChars: number
}

export interface OrbitAgentExecutionState {
  consecutiveNoTools: number
  consecutiveModelFailures: number
  lastToolErrorKey: string
  repeatedToolErrors: number
  lastValidationFailure: string
  repeatedValidationFailures: number
}

export interface OrbitAgentToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

export type OrbitAgentToolPrePlanPolicy = 'establish' | 'observe' | 'deny'
export type OrbitAgentToolObservationScope = 'input' | 'source'
export type OrbitAgentToolEffect = 'read' | 'write' | 'execute' | 'control'
export type OrbitAgentToolParallelPolicy = 'safe' | 'serial'
export type OrbitAgentToolRetryPolicy = 'safe' | 'idempotent' | 'unsafe'

export interface OrbitAgentToolCapability {
  schema: 'orbit.agent-tool-capability.v1'
  prePlan: OrbitAgentToolPrePlanPolicy
  observationScope: OrbitAgentToolObservationScope | null
  effect: OrbitAgentToolEffect
  parallel: OrbitAgentToolParallelPolicy
  retry: OrbitAgentToolRetryPolicy
  budget: Readonly<{ maxPrePlanCalls: number }>
}

export type OrbitAgentToolCapabilityRegistry = Readonly<Record<string, Readonly<OrbitAgentToolCapability>>>

export interface OrbitAgentToolPrePlanEvaluation {
  allowed: boolean
  decision: 'planned' | 'establish' | 'observe' | 'denied' | 'source_not_authorized' | 'budget_exhausted'
  consumesObservation: boolean
  capability: Readonly<OrbitAgentToolCapability>
  scope?: OrbitAgentToolObservationScope
  observed?: number
  limit?: number
}

export interface OrbitAgentToolBatch {
  allCalls: OrbitAgentToolCall[]
  executableCalls: OrbitAgentToolCall[]
  skippedCalls: OrbitAgentToolCall[]
  limit: number
}

export interface OrbitAgentToolResult extends Record<string, unknown> {
  role: 'tool'
  tool_call_id: string
  content: string
}

export interface OrbitAgentToolBatchJournal {
  schema: 'orbit.agent-tool-batch.v1'
  status: 'open' | 'closed'
  calls: OrbitAgentToolCall[]
  limit: number
  results: OrbitAgentToolResult[]
  deferredMessages: OrbitAgentMessage[]
}

export interface OrbitAgentRenderSurfacePolicy {
  minViewportAreaCoverage: number
  minBackingScale: number
  maxSuspiciousActivityCoverage: number
  logicalRatioTolerance: number
  minDetailSamples: number
}

export interface OrbitAgentRenderSurfaceReport {
  probeId?: string
  label?: string
  viewport?: { width?: number; height?: number }
  renderSurfaces?: Array<{
    css?: { width?: number; height?: number }
    backing?: { width?: number; height?: number }
    activity?: {
      detailSamples?: number
      detailBounds?: { left?: number; top?: number; right?: number; bottom?: number }
    }
  }>
}

export type OrbitAgentExecutionEvent =
  | { type: 'model_success' }
  | { type: 'model_failure' }
  | { type: 'tool_batch'; count: number }
  | { type: 'tool_result'; ok: boolean; key?: string }
  | { type: 'tool_batch_result'; ok: boolean; key?: string }
  | { type: 'validation_result'; ok: boolean; signature?: string }

export type OrbitAgentExecutionStopReason =
  | 'model_failure_limit'
  | 'no_tool_limit'
  | 'repeated_tool_error_limit'
  | 'repeated_validation_failure_limit'

export interface OrbitProAgentPlan {
  version: 1
  summary: string
  currentTodoId: string | null
  todos: OrbitProAgentTodo[]
  blockers: string[]
  updatedAt: number | string
}

export interface OrbitVisualPlanCandidate {
  id: string
  label: string
  rationale: string
  imagePrompt: string
}

export interface OrbitVisualPlan {
  version: 1
  summary: string
  candidates: OrbitVisualPlanCandidate[]
}

export interface OrbitLoopIterationPolicy {
  create: number
  edit: number
  maxExecutionWindows: number
}

export interface OrbitProContextPolicy {
  effectiveWindowTokens: number
  softTokenRatio: number
  targetTokenRatio: number
  hardTokenRatio: number
  softChars: number
  targetChars: number
  hardChars: number
  keepRecentMessages: number
  keepRecentUserMessages: number
  recentUserTokenBudget: number
  compactMessageCount: number
}

export type OrbitAgentExecutorProfile = 'local-desktop' | 'cli-local' | 'container-local' | 'e2b-cloud' | 'worker-standard' | 'test'

export interface OrbitAgentCapabilityProfile {
  schema: 'orbit.agent-capability-profile.v1'
  executorProfile: OrbitAgentExecutorProfile
  semanticCompaction: 'none' | 'model'
  checkpointPersistence: 'none' | 'run' | 'project'
  workspaceSnapshot: 'none' | 'revision' | 'digest'
  pendingToolRecovery: 'none' | 'inspect' | 'idempotent'
  maxSemanticInputTokens: number
  maxSemanticOutputTokens: number
}

export interface OrbitAgentSemanticSummary {
  schema: 'orbit.agent-semantic-summary.v1'
  objective: string
  latestUserIntent: string
  userConstraints: string[]
  userCorrections: string[]
  decisions: Array<{ summary: string; sourceRefs: string[] }>
  workspaceChanges: Array<{ path: string; summary: string }>
  validation: Array<{ status: 'passed' | 'failed' | 'unknown'; summary: string }>
  failedApproaches: Array<{ summary: string; nextAction?: string }>
  openWork: string[]
  sourcesToRefresh: Array<{ kind: 'file' | 'tool' | 'external' | 'skill'; ref: string; reason: string }>
  notes: string[]
}

export type OrbitAgentMessage = Record<string, any>

export interface OrbitAgentCompactionPreparation {
  schema: 'orbit.agent-compaction-preparation.v1'
  needed: boolean
  before: ReturnType<typeof agentMessageBudget>
  policy: ReturnType<typeof agentMessageBudget>['limits']
  capabilityProfile: OrbitAgentCapabilityProfile
  sourceRevision: string | number | null
  sourceFingerprint: string
  generation: number
  hardLimitExceeded: boolean
  request: null | {
    schema: 'orbit.agent-semantic-compaction-request.v1'
    messages: Array<{ role: 'user'; content: string }>
    maxOutputTokens: number
  }
  canonicalMessages: OrbitAgentMessage[]
  firstUser: OrbitAgentMessage | null
  previousSummary?: OrbitAgentSemanticSummary | null
  recentUserMessages: OrbitAgentMessage[]
  tailBlocks: OrbitAgentMessage[][]
  droppedMessages: OrbitAgentMessage[]
  durableFacts?: string[]
  plan?: OrbitProAgentPlan | null
  summaryLabel?: string
}

export interface OrbitAgentCompactionResult {
  compacted: boolean
  reason?: 'not_needed' | 'stale_source' | 'semantic_summary_invalid'
  before: ReturnType<typeof agentMessageBudget>
  after: ReturnType<typeof agentMessageBudget>
  mode?: 'semantic' | 'deterministic'
  generation?: number
  semanticSummary?: OrbitAgentSemanticSummary
}

export interface OrbitAgentCheckpoint {
  schema: 'orbit.agent-checkpoint.v1'
  version: 1
  checkpointId: string
  createdAt: string
  coreVersion: string
  adapterVersion: string
  capabilityProfile: OrbitAgentCapabilityProfile
  runtime: { releaseId?: string; digest?: string }
  run: { runId: string; attemptEpoch: number; compactionGeneration: number }
  context: {
    semanticSummary: OrbitAgentSemanticSummary | null
    source: {
      revision?: string | number
      firstMessageId?: string
      lastMessageId?: string
      messageCount: number
      approxTokens: number
    }
    recentUserMessages: Array<{ id?: string; content: string }>
    legacyIncomplete?: boolean
  }
  plan: OrbitProAgentPlan | null
  workspace: {
    kind: 'none' | 'revision' | 'digest'
    revision?: string
    digest?: string
    digestComplete?: boolean
    digestScope?: string
    changedPaths: string[]
  }
  pendingToolOperation: null | {
    operationId: string
    toolName: string
    phase: 'prepared' | 'dispatched' | 'result_pending'
    recovery: 'inspect' | 'retry_idempotent' | 'abandon'
    idempotencyKey?: string
    targetPaths: string[]
  }
  pendingToolBatch: OrbitAgentToolBatchJournal | null
}

export interface OrbitProAgentConversationPolicy {
  maxInputChars: number
  maxPendingInputs: number
  maxPendingSteers: number
  maxClientMessageIdChars: number
  maxRunIdChars: number
}

export interface OrbitAgentConversationInput {
  clientMessageId: string
  content: string
}

export interface OrbitAgentConversationRun {
  runId: string
  input: OrbitAgentConversationInput
  attemptEpoch: number
  interruptRequested: boolean
}

export interface OrbitAgentConversationLifecycle {
  version: 1
  policy: OrbitProAgentConversationPolicy
  activeRun: OrbitAgentConversationRun | null
  pendingSteers: OrbitAgentConversationInput[]
  queue: OrbitAgentConversationInput[]
  queuePaused: boolean
  acceptedClientMessageIds: string[]
}

export type OrbitAgentConversationAction =
  | 'started'
  | 'steered'
  | 'queued'
  | 'steer_drained'
  | 'interrupt_requested'
  | 'queue_paused'
  | 'queue_resumed'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'duplicate'
  | 'rejected'
  | 'noop'

export type OrbitAgentConversationRejectReason =
  | 'duplicate_client_message_id'
  | 'invalid_client_message_id'
  | 'client_message_id_too_long'
  | 'empty_input'
  | 'input_too_long'
  | 'invalid_run_id'
  | 'run_id_too_long'
  | 'stale_run'
  | 'stale_attempt'
  | 'interrupt_pending'
  | 'pending_input_limit'
  | 'pending_steer_limit'
  | 'pending_steer'
  | 'invalid_outcome'
  | 'run_active'
  | 'queue_paused'

export interface OrbitAgentConversationTransition {
  state: OrbitAgentConversationLifecycle
  accepted: boolean
  action: OrbitAgentConversationAction
  reason?: OrbitAgentConversationRejectReason
  input?: OrbitAgentConversationInput
  run?: OrbitAgentConversationRun
  attemptEpoch?: number
  queuePosition?: number
  recoveredSteers?: OrbitAgentConversationInput[]
}

export const ORBIT_PRO_AGENT_CORE_VERSION: string
export const ORBIT_AGENT_EXECUTION_POLICY: Readonly<OrbitAgentExecutionPolicy>
export const ORBIT_AGENT_TOOL_CAPABILITY_SCHEMA: 'orbit.agent-tool-capability.v1'
export const ORBIT_AGENT_TOOL_CAPABILITY: unique symbol
export const ORBIT_AGENT_RENDER_SURFACE_CONTRACT: string
export const ORBIT_AGENT_RENDER_SURFACE_POLICY: Readonly<OrbitAgentRenderSurfacePolicy>
export const ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA: 'orbit.agent-capability-profile.v1'
export const ORBIT_AGENT_SEMANTIC_SUMMARY_SCHEMA: 'orbit.agent-semantic-summary.v1'
export const ORBIT_AGENT_CHECKPOINT_SCHEMA: 'orbit.agent-checkpoint.v1'
export const ORBIT_AGENT_INTERNAL_MESSAGE_SCHEMA: 'orbit.agent-internal-message.v1'
export const ORBIT_AGENT_TOOL_BATCH_SCHEMA: 'orbit.agent-tool-batch.v1'
export const ORBIT_AGENT_CAPABILITY_PROFILES: Readonly<Record<OrbitAgentExecutorProfile, Readonly<OrbitAgentCapabilityProfile>>>
export const ORBIT_VISUAL_PLAN_MAX_CANDIDATES: 3
export const ORBIT_LOOP_ITERATION_POLICY: Readonly<OrbitLoopIterationPolicy>
export const ORBIT_PRO_AGENT_CONTEXT_POLICY: Readonly<OrbitProContextPolicy>
export const ORBIT_PRO_AGENT_CONVERSATION_POLICY: Readonly<OrbitProAgentConversationPolicy>

export function normalizeAgentToolCapability(raw?: unknown): Readonly<OrbitAgentToolCapability>
export function defineAgentToolCapability<T extends Record<string, unknown>>(
  toolSpec: T,
  capability: Partial<OrbitAgentToolCapability> & {
    budget?: Partial<OrbitAgentToolCapability['budget']>
  },
): T
export function createAgentToolCapabilityRegistry(
  entries?: Record<string, unknown> | Array<Record<string, unknown> | readonly [string, unknown]>,
): OrbitAgentToolCapabilityRegistry
export function getAgentToolCapability(
  tool: string | Record<string, unknown>,
  registry?: OrbitAgentToolCapabilityRegistry,
): Readonly<OrbitAgentToolCapability>
export function evaluateAgentToolPrePlan(
  tool: string | Record<string, unknown>,
  options?: {
    registry?: OrbitAgentToolCapabilityRegistry
    hasPlan?: boolean
    allowSourceObservation?: boolean
    observationCounts?: Partial<Record<OrbitAgentToolObservationScope, number>>
  },
): Readonly<OrbitAgentToolPrePlanEvaluation>
export function selectAgentToolBatchErrorKey(errorKeys: unknown[], previousKey?: unknown): string
export function projectAgentMessagesForProvider(messages: OrbitAgentMessage[]): OrbitAgentMessage[]

export function createAgentExecutionState(raw?: Partial<OrbitAgentExecutionState>): OrbitAgentExecutionState
export function transitionAgentExecutionState(
  state: OrbitAgentExecutionState,
  event: OrbitAgentExecutionEvent,
  policy?: Partial<OrbitAgentExecutionPolicy>,
): {
  state: OrbitAgentExecutionState
  warning: 'repeated_tool_error' | null
  stopReason: OrbitAgentExecutionStopReason | null
}

export function splitAgentToolCallBatch(
  assistant: { tool_calls?: OrbitAgentToolCall[] } | null | undefined,
  policy?: Partial<OrbitAgentExecutionPolicy>,
): OrbitAgentToolBatch

export function createAgentSyntheticToolResults(
  toolCalls: OrbitAgentToolCall[],
  reason?: string,
): Array<{ role: 'tool'; tool_call_id: string; content: string }>

export function normalizeAgentToolBatchJournal(raw: unknown): OrbitAgentToolBatchJournal | null

export function createAgentToolBatchJournal(
  assistant: { tool_calls?: OrbitAgentToolCall[] } | null | undefined,
  policy?: Partial<OrbitAgentExecutionPolicy>,
): OrbitAgentToolBatchJournal

export function recordAgentToolBatchResult(
  journal: OrbitAgentToolBatchJournal,
  result: OrbitAgentToolResult,
): OrbitAgentToolBatchJournal

export function deferAgentToolBatchMessage(
  journal: OrbitAgentToolBatchJournal,
  message: OrbitAgentMessage,
): OrbitAgentToolBatchJournal

export function closeAgentToolBatchJournal(
  journal: OrbitAgentToolBatchJournal,
  reason?: string,
): {
  journal: OrbitAgentToolBatchJournal
  toolMessages: OrbitAgentToolResult[]
  deferredMessages: OrbitAgentMessage[]
  messages: OrbitAgentMessage[]
  syntheticCount: number
}

export function agentTranscriptProtocolIssues(
  messages: unknown[],
  options?: { allowIncompleteTail?: boolean },
): string[]

export function assertAgentTranscriptProtocol(
  messages: unknown[],
  options?: { allowIncompleteTail?: boolean },
): true

export function renderSurfaceActivityIssues(
  reports: OrbitAgentRenderSurfaceReport[],
  policy?: Partial<OrbitAgentRenderSurfacePolicy>,
): string[]

export function createAgentConversationLifecycle(options?: {
  policy?: Partial<OrbitProAgentConversationPolicy>
}): OrbitAgentConversationLifecycle

export function normalizeOrbitVisualPlan(raw: unknown): OrbitVisualPlan | null
export function parseOrbitVisualPlanAssistant(value: unknown): OrbitVisualPlan | null
export function buildOrbitVisualPlanImagePrompt(input: {
  originalRequest: string
  candidate: OrbitVisualPlanCandidate
}): string
export function buildOrbitLoopObjectivePrompt(prompt: string): string

export function submitAgentConversationInput(
  state: OrbitAgentConversationLifecycle,
  input: OrbitAgentConversationInput,
  options?: { runId?: string; attemptEpoch?: number },
): OrbitAgentConversationTransition

export function steerAgentConversationRun(
  state: OrbitAgentConversationLifecycle,
  input: OrbitAgentConversationInput,
  options: { runId: string; attemptEpoch: number },
): OrbitAgentConversationTransition

export function queueAgentConversationInput(
  state: OrbitAgentConversationLifecycle,
  input: OrbitAgentConversationInput,
): OrbitAgentConversationTransition

export function drainAgentConversationSafePoint(
  state: OrbitAgentConversationLifecycle,
  options: { runId: string; attemptEpoch: number },
): OrbitAgentConversationTransition

export function isAgentConversationAttemptCurrent(
  state: OrbitAgentConversationLifecycle,
  options: { runId: string; attemptEpoch: number },
): boolean

export function stopAgentConversationRun(
  state: OrbitAgentConversationLifecycle,
  options?: { runId?: string; attemptEpoch?: number },
): OrbitAgentConversationTransition

export function finishAgentConversationRun(
  state: OrbitAgentConversationLifecycle,
  options: { runId: string; attemptEpoch: number; outcome?: 'completed' | 'failed' | 'interrupted' },
): OrbitAgentConversationTransition

export function startNextQueuedAgentConversationRun(
  state: OrbitAgentConversationLifecycle,
  options: { runId: string },
): OrbitAgentConversationTransition

export function resumeAgentConversationQueue(
  state: OrbitAgentConversationLifecycle,
): OrbitAgentConversationTransition

export function normalizeAgentPlan(
  raw: unknown,
  current?: unknown,
  options?: { timestamp?: 'epoch' | 'iso'; defaultSummary?: string; updatedAt?: number | string },
): OrbitProAgentPlan | null

export function isPublishTodo(todo: unknown): boolean
export function agentPlanOpenTodos(plan?: unknown): OrbitProAgentTodo[]
export function agentPlanOpenBlockingTodosForFinish(plan?: unknown): OrbitProAgentTodo[]
export function agentPlanOpenTodosBeforeValidation(plan?: unknown): OrbitProAgentTodo[]
export function agentPlanReadyForFinish(plan?: unknown): boolean
export function completePublishTodosForFinish(
  plan?: unknown,
  options?: { timestamp?: 'epoch' | 'iso'; detail?: string; evidence?: string },
): OrbitProAgentPlan | null | undefined

export function createUpdateAgentPlanToolSpec(options?: { allowInspectionBeforePlan?: boolean }): Record<string, unknown>
export function estimateAgentTextTokens(text: unknown): number
export function agentMessageBudget(messages: unknown[], policy?: Partial<OrbitProContextPolicy>): {
  approxChars: number
  approxTokens: number
  messageCount: number
  limits: OrbitProContextPolicy & { softTokens: number; targetTokens: number; hardTokens: number }
}

export function redactAgentSensitiveText(value: unknown): string
export function redactAgentSensitiveValue(value: unknown, depth?: number): unknown

export function normalizeAgentCapabilityProfile(
  raw?: unknown,
  fallbackProfile?: OrbitAgentExecutorProfile,
): OrbitAgentCapabilityProfile

export function normalizeAgentSemanticSummary(raw: unknown): OrbitAgentSemanticSummary | null

export function buildAgentSemanticCompactionPrompt(input?: {
  messages?: OrbitAgentMessage[]
  previousSummary?: OrbitAgentSemanticSummary | null
  plan?: unknown
  durableFacts?: string[]
  maxInputTokens?: number
  messageId?(message: OrbitAgentMessage, index: number): string
}): string

export function prepareAgentMessageCompaction(
  messages: OrbitAgentMessage[],
  options?: {
    policy?: Partial<OrbitProContextPolicy>
    profile?: OrbitAgentExecutorProfile | Partial<OrbitAgentCapabilityProfile>
    capabilityProfile?: OrbitAgentExecutorProfile | Partial<OrbitAgentCapabilityProfile>
    sourceRevision?: string | number | null
    plan?: unknown
    invariant?: string
    durableFacts?: string[]
    summaryLabel?: string
    messageId?(message: OrbitAgentMessage, index: number): string
    projectMessage?(
      message: OrbitAgentMessage,
      metadata: { index: number; sourceRef: string },
    ): OrbitAgentMessage | null
  },
): OrbitAgentCompactionPreparation

export function commitAgentMessageCompaction(
  messages: OrbitAgentMessage[],
  preparation: OrbitAgentCompactionPreparation,
  rawSemanticSummary: unknown,
  options?: {
    sourceRevision?: string | number | null
    allowDeterministicFallback?: boolean
    legacyMarker?: boolean
  },
): OrbitAgentCompactionResult

export function normalizeAgentCheckpoint(raw: unknown): OrbitAgentCheckpoint | null
export function createAgentCheckpoint(input: {
  checkpointId?: string
  createdAt?: string
  coreVersion?: string
  adapterVersion?: string
  capabilityProfile?: OrbitAgentExecutorProfile | Partial<OrbitAgentCapabilityProfile>
  runtime?: { releaseId?: string; digest?: string }
  run: { runId: string; attemptEpoch?: number; compactionGeneration?: number }
  context?: {
    semanticSummary?: OrbitAgentSemanticSummary | null
    source?: Partial<OrbitAgentCheckpoint['context']['source']>
    recentUserMessages?: Array<{ id?: string; content: string } | string>
    legacyIncomplete?: boolean
  }
  plan?: OrbitProAgentPlan | null
  workspace?: Partial<OrbitAgentCheckpoint['workspace']>
  pendingToolOperation?: OrbitAgentCheckpoint['pendingToolOperation']
  pendingToolBatch?: OrbitAgentToolBatchJournal | null
}): OrbitAgentCheckpoint

export function compactAgentMessagesIfNeeded(
  messages: OrbitAgentMessage[],
  options?: {
    policy?: Partial<OrbitProContextPolicy>
    profile?: OrbitAgentExecutorProfile | Partial<OrbitAgentCapabilityProfile>
    capabilityProfile?: OrbitAgentExecutorProfile | Partial<OrbitAgentCapabilityProfile>
    plan?: unknown
    invariant?: string
    durableFacts?: string[]
    summaryLabel?: string
    sourceRevision?: string | number | null
    semanticSummary?: unknown
  },
): OrbitAgentCompactionResult

export function buildOrbitProAgentCoreModuleSource(): string
