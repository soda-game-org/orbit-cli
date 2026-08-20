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
  agent: 65_536
  referenceMedia: 4_096
}>

export interface OrbitAgentInputItemBase {
  schema: 'orbit.agent-input-item.v1'
  id: string
  createdAt?: string
  metadata?: Record<string, unknown>
}

export type OrbitAgentInputItem =
  | (OrbitAgentInputItemBase & { type: 'text'; text: string })
  | (OrbitAgentInputItemBase & {
      type: 'image'
      /** Inline raster data URL. Remote Web media is represented as an attachment and resolved through MediaCache. */
      url: string
      mediaId?: string
      attachmentId?: string
      mediaType?: string
      detail?: 'auto' | 'low' | 'high'
    })
  | (OrbitAgentInputItemBase & {
      type: 'localImage'
      path: string
      mediaId: string
      attachmentId?: string
      mediaType?: string
      detail?: 'auto' | 'low' | 'high'
    })
  | (OrbitAgentInputItemBase & {
      type: 'attachment'
      attachment: {
        id: string
        kind: 'image' | 'document' | 'audio' | 'video' | 'archive' | 'other'
        name?: string
        mediaType?: string
        sizeBytes?: number
        digest?: string
        sourceRef?: string
      }
      observationId?: string
    })
  | (OrbitAgentInputItemBase & {
      type: 'ref'
      ref: {
        id: string
        kind: 'attachment' | 'media' | 'turn' | 'project' | 'external'
        targetId: string
        label?: string
      }
      observationId?: string
    })

export interface OrbitAgentMediaObservationFact {
  id: string
  text: string
  label?: string
  confidence?: number
  sourceRef?: string
}

export interface OrbitAgentMediaObservation {
  schema: 'orbit.agent-media-observation.v1'
  id: string
  attachmentId?: string
  mediaId?: string
  kind: 'image' | 'document' | 'audio' | 'video' | 'archive' | 'other'
  status: 'ready' | 'partial' | 'unavailable' | 'failed'
  summary: string
  facts: OrbitAgentMediaObservationFact[]
  mediaType?: string
  digest?: string
  createdAt?: string
}

export interface OrbitAgentMediaCacheEntry {
  key: string
  mediaId?: string
  attachmentId?: string
  sourceItemId?: string
  status: 'ready' | 'missing' | 'failed'
  resolved: null | {
    type: 'url' | 'data_url' | 'provider_file' | 'host_ref'
    value: string
  }
  observationId?: string
  mediaType?: string
  digest?: string
  updatedAt?: string
}

export interface OrbitAgentMediaCache {
  schema: 'orbit.agent-media-cache.v1'
  entries: OrbitAgentMediaCacheEntry[]
}

export interface OrbitAgentProject {
  schema: 'orbit.agent-project.v1'
  id: string
  name?: string
  rootRef?: string
  threadIds: string[]
  createdAt?: string
  updatedAt?: string
  metadata?: Record<string, unknown>
}

export interface OrbitAgentTurn {
  schema: 'orbit.agent-turn.v1'
  id: string
  threadId?: string
  sequence?: number
  state: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  inputItems: OrbitAgentInputItem[]
  outputMessages: OrbitAgentMessage[]
  createdAt?: string
  completedAt?: string
  metadata?: Record<string, unknown>
}

export interface OrbitAgentThread {
  schema: 'orbit.agent-thread.v1'
  id: string
  projectId?: string
  title?: string
  turns: OrbitAgentTurn[]
  createdAt?: string
  updatedAt?: string
  metadata?: Record<string, unknown>
}

export type OrbitAgentSession = OrbitAgentThread

export interface OrbitAgentProviderCapabilities {
  schema: 'orbit.agent-provider-capability.v1'
  vision: boolean
  imageInputs: Array<'url' | 'data_url' | 'provider_file' | 'host_ref'>
  nativeAttachments: boolean
  maxImagesPerTurn: number
}

export type OrbitAgentProviderInputItem =
  | { type: 'input_text'; sourceItemId: string; text: string; structured?: boolean; attachmentId?: string; mediaId?: string; refId?: string }
  | {
      type: 'input_image'
      sourceItemId: string
      attachmentId?: string
      mediaId?: string
      refId?: string
      source: { type: 'url' | 'data_url' | 'provider_file' | 'host_ref'; value: string }
      detail: 'auto' | 'low' | 'high'
    }

export interface OrbitAgentInputProjectionIssue {
  code: 'invalid_input_item' | 'image_limit' | 'media_unresolved' | 'media_source_unsupported' | 'media_observation_missing' | 'media_observation_error'
  severity: 'warning' | 'error'
  sourceItemId: string
  attachmentId?: string
  message: string
}

export interface OrbitAgentInputProjection {
  schema: 'orbit.agent-input-projection.v1'
  capabilities: OrbitAgentProviderCapabilities
  inputItems: OrbitAgentInputItem[]
  providerItems: OrbitAgentProviderInputItem[]
  issues: OrbitAgentInputProjectionIssue[]
  blocked: boolean
}

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
  latestTurnUser?: OrbitAgentMessage | null
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

export const ORBIT_AGENT_CORE_VERSION: 'orbit-agent-core/0.6.0'
/** @deprecated Use ORBIT_AGENT_CORE_VERSION. */
export const ORBIT_PRO_AGENT_CORE_VERSION: typeof ORBIT_AGENT_CORE_VERSION
export const ORBIT_AGENT_EXECUTION_POLICY: Readonly<OrbitAgentExecutionPolicy>
export const ORBIT_AGENT_PROJECT_SCHEMA: 'orbit.agent-project.v1'
export const ORBIT_AGENT_THREAD_SCHEMA: 'orbit.agent-thread.v1'
export const ORBIT_AGENT_TURN_SCHEMA: 'orbit.agent-turn.v1'
export const ORBIT_AGENT_INPUT_ITEM_SCHEMA: 'orbit.agent-input-item.v1'
export const ORBIT_AGENT_MEDIA_OBSERVATION_SCHEMA: 'orbit.agent-media-observation.v1'
export const ORBIT_AGENT_MEDIA_CACHE_SCHEMA: 'orbit.agent-media-cache.v1'
export const ORBIT_AGENT_PROVIDER_CAPABILITY_SCHEMA: 'orbit.agent-provider-capability.v1'
export const ORBIT_AGENT_INPUT_PROJECTION_SCHEMA: 'orbit.agent-input-projection.v1'
export const ORBIT_AGENT_TOOL_CAPABILITY_SCHEMA: 'orbit.agent-tool-capability.v1'
export const ORBIT_AGENT_TOOL_CAPABILITY: unique symbol
export const ORBIT_AGENT_RENDER_SURFACE_CONTRACT: string
export const ORBIT_AGENT_RENDER_SURFACE_POLICY: Readonly<OrbitAgentRenderSurfacePolicy>
export const ORBIT_ARCADE_SDK_CONTRACT_SCHEMA: 'orbit.arcade-sdk-contract.v1'
export const ORBIT_ARCADE_SDK_CONTRACT: Readonly<{
  schema: typeof ORBIT_ARCADE_SDK_CONTRACT_SCHEMA
  lifecycle: Readonly<{
    start: Readonly<{ method: 'OrbitArcade.startGame'; event: 'orbit:game:start' }>
    end: Readonly<{ method: 'OrbitArcade.endGame'; event: 'orbit:game:end' }>
  }>
  required: readonly string[]
  optional: readonly string[]
  forbiddenDirectCapabilities: readonly string[]
}>
export const ORBIT_AGENT_STORE_MEDIA_SCHEMA: 'orbit.agent-store-media.v1'
export const ORBIT_AGENT_STORE_MEDIA_ROLES: Readonly<{
  listingCover: Readonly<{ role: 'listing_cover'; aspectRatio: '3:4'; preferredWidth: 768; preferredHeight: 1024; requiredForPlayable: false }>
  appIcon: Readonly<{ role: 'app_icon'; aspectRatio: '1:1'; preferredWidth: 512; preferredHeight: 512; requiredForPlayable: false }>
}>
export const ORBIT_AGENT_IMAGE_SCHEMA: 'orbit.agent-image.v1'
export const ORBIT_AGENT_IMAGE_CAPABILITY_SCHEMA: 'orbit.agent-image-capability.v1'
export const ORBIT_AGENT_IMAGE_KINDS: readonly ['sprite', 'background', 'tile', 'ui_icon', 'cover', 'texture', 'other']
export const ORBIT_AGENT_IMAGE_ASPECT_RATIOS: readonly ['1:1', '3:4', '4:3', '9:16', '16:9']
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

export function normalizeAgentInputItem(
  raw: unknown,
  options?: { fallbackId?: string; index?: number },
): OrbitAgentInputItem | null
export function orbitArcadeSdkContractText(options?: { detail?: 'minimal' | 'compact' }): string
export function orbitArcadeSdkSourceIssues(source: unknown): string[]
export interface OrbitAgentStoreMediaAsset {
  role: 'listing_cover' | 'app_icon'
  state: 'provided' | 'generated' | 'fallback' | 'skipped' | 'missing' | 'failed'
  requiredForPlayable: false
  location?: string
  mediaType?: string
  reason?: string
  digest?: string
  width?: number
  height?: number
}
export interface OrbitAgentStoreMediaManifest {
  schema: 'orbit.agent-store-media.v1'
  projectId: string
  updatedAt?: string
  assets: Readonly<{ listing_cover: OrbitAgentStoreMediaAsset; app_icon: OrbitAgentStoreMediaAsset }>
}
export function normalizeAgentStoreMediaManifest(
  raw: unknown,
  options?: { projectId?: string; updatedAt?: string },
): OrbitAgentStoreMediaManifest
export type OrbitAgentImageKind = typeof ORBIT_AGENT_IMAGE_KINDS[number]
export type OrbitAgentImageAspectRatio = typeof ORBIT_AGENT_IMAGE_ASPECT_RATIOS[number]
export interface OrbitAgentImageCapabilities {
  schema: 'orbit.agent-image-capability.v1'
  route: 'none' | 'managed' | 'byok'
  generate: boolean
  backgroundRemoval: boolean
  controlImage: boolean
  spritesheet: boolean
  gameMap: boolean
  visionReview: boolean
  localMaterialization: boolean
}
export interface OrbitAgentImageIntent {
  schema: 'orbit.agent-image.v1'
  prompt: string
  kind: OrbitAgentImageKind
  outputPath?: string
  aspectRatio?: OrbitAgentImageAspectRatio
  width?: number
  height?: number
  transparentBackground: boolean
}
export interface OrbitAgentImageArtifact {
  schema: 'orbit.agent-image.v1'
  artifactId: string
  projectPath?: string
  artifactRef?: string
  mediaType: string
  sha256?: string
  width?: number
  height?: number
  bytes?: number
  transparentBackground?: true
  backgroundRemovalFailed?: true
  recovered?: true
  reused?: true
}
export function normalizeAgentImageCapabilities(raw?: unknown): Readonly<OrbitAgentImageCapabilities>
export function normalizeAgentImageIntent(
  raw: unknown,
  options?: { outputPath?: string; kind?: OrbitAgentImageKind; aspectRatio?: OrbitAgentImageAspectRatio },
): Readonly<OrbitAgentImageIntent> | null
export function evaluateAgentImageIntent(
  raw: unknown,
  capabilities?: unknown,
): Readonly<{
  allowed: boolean
  reason: 'available' | 'invalid_intent' | 'image_generation_unavailable' | 'background_removal_unavailable'
  intent: Readonly<OrbitAgentImageIntent> | null
  capabilities: Readonly<OrbitAgentImageCapabilities>
}>
export function projectAgentImageArtifact(
  raw: unknown,
  options?: { artifactId?: string; projectPath?: string; artifactRef?: string; mediaType?: string },
): Readonly<OrbitAgentImageArtifact> | null
export function createGenerateImageToolSpec(options?: {
  destination?: 'workspace' | 'host'
  description?: string
  dimensions?: boolean
  backgroundRemoval?: boolean
}): Record<string, unknown>
export function createGenerateSpritesheetToolSpec(options?: {
  destination?: 'workspace' | 'host'
  description?: string
}): Record<string, unknown>
export function createGenerateGameMapToolSpec(options?: {
  destination?: 'workspace' | 'host'
  description?: string
}): Record<string, unknown>
export function normalizeAgentInputItems(
  raw: unknown,
  options?: { fallbackId?: string },
): OrbitAgentInputItem[]
export function normalizeAgentMediaObservation(
  raw: unknown,
  options?: { attachmentId?: string; mediaId?: string },
): OrbitAgentMediaObservation | null
export function normalizeAgentMediaCache(raw: unknown): OrbitAgentMediaCache
export function normalizeAgentProject(raw: unknown): OrbitAgentProject | null
export function normalizeAgentTurn(raw: unknown, options?: { threadId?: string }): OrbitAgentTurn | null
export function normalizeAgentThread(raw: unknown): OrbitAgentThread | null
/** Session is a compatibility name for the canonical Thread entity. */
export function normalizeAgentSession(raw: unknown): OrbitAgentSession | null
export function normalizeAgentProviderCapabilities(raw?: unknown): OrbitAgentProviderCapabilities
export function projectAgentInputItemsForProvider(
  rawItems: unknown,
  options?: {
    capabilities?: unknown
    providerCapabilities?: unknown
    observations?: unknown
    mediaCache?: unknown
  },
): OrbitAgentInputProjection
export function assertAgentInputProjectionReady(projection: OrbitAgentInputProjection): true
export function projectAgentTurnForProvider(
  rawTurn: unknown,
  options?: {
    threadId?: string
    capabilities?: unknown
    providerCapabilities?: unknown
    observations?: unknown
    mediaCache?: unknown
  },
): OrbitAgentInputProjection & { turn: OrbitAgentTurn }

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

export function buildOrbitAgentCoreModuleSource(): string
/** @deprecated Use buildOrbitAgentCoreModuleSource. */
export function buildOrbitProAgentCoreModuleSource(): string
