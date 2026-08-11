/**
 * Portable Orbit agent policy shared by CLI, desktop, and cloud hosts.
 *
 * Keep this module free of filesystem, process, network, Worker, Electron, and
 * E2B imports. Those capabilities belong to host adapters.
 */

export const ORBIT_PRO_AGENT_CORE_VERSION = 'orbit-pro-agent-core/0.4.1'

/**
 * Portable execution policy. Hosts may provide capabilities, credentials and
 * delivery adapters, but they must not invent different loop safety budgets.
 */
export const ORBIT_AGENT_EXECUTION_POLICY = Object.freeze({
  maxIterations: 1_500,
  fallbackMaxIterations: 800,
  maxToolCallsPerTurn: 16,
  consecutiveNoToolLimit: 3,
  consecutiveModelFailureLimit: 4,
  repeatedToolErrorWarning: 3,
  repeatedToolErrorLimit: 5,
  repeatedValidationFailureLimit: 8,
  maxToolOutputChars: 48_000,
})

/**
 * Host-only tool capability metadata. The Symbol sidecar is deliberately
 * non-enumerable so provider tool JSON remains limited to the wire schema.
 */
export const ORBIT_AGENT_TOOL_CAPABILITY_SCHEMA = 'orbit.agent-tool-capability.v1'
export const ORBIT_AGENT_TOOL_CAPABILITY = Symbol.for(ORBIT_AGENT_TOOL_CAPABILITY_SCHEMA)

function agentToolSpecName(tool) {
  if (typeof tool === 'string') return tool.trim()
  return String(tool?.function?.name || '').trim()
}

export function normalizeAgentToolCapability(raw = {}) {
  const source = executionObject(raw)
  const prePlan = ['establish', 'observe', 'deny'].includes(source.prePlan) ? source.prePlan : 'deny'
  const observationScope = prePlan === 'observe' && ['input', 'source'].includes(source.observationScope)
    ? source.observationScope
    : null
  const effect = ['read', 'write', 'execute', 'control'].includes(source.effect) ? source.effect : 'control'
  const parallel = ['safe', 'serial'].includes(source.parallel) ? source.parallel : 'serial'
  const retry = ['safe', 'idempotent', 'unsafe'].includes(source.retry) ? source.retry : 'unsafe'
  const rawBudget = executionObject(source.budget)
  const maxPrePlanCalls = prePlan === 'observe'
    ? Math.min(1_000, executionCount(rawBudget.maxPrePlanCalls))
    : 0
  return Object.freeze({
    schema: ORBIT_AGENT_TOOL_CAPABILITY_SCHEMA,
    prePlan,
    observationScope,
    effect,
    parallel,
    retry,
    budget: Object.freeze({ maxPrePlanCalls }),
  })
}

/** Attach host-only capability metadata without changing provider JSON. */
export function defineAgentToolCapability(toolSpec, capability) {
  if (!toolSpec || typeof toolSpec !== 'object') throw new TypeError('Agent tool spec must be an object')
  if (!agentToolSpecName(toolSpec)) throw new TypeError('Agent tool spec requires function.name')
  const annotated = { ...toolSpec }
  Object.defineProperty(annotated, ORBIT_AGENT_TOOL_CAPABILITY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: normalizeAgentToolCapability(capability),
  })
  return annotated
}

/** Build a serializable host registry from declarations or annotated specs. */
export function createAgentToolCapabilityRegistry(entries = {}) {
  const registry = {}
  const add = (name, capability) => {
    const key = agentToolSpecName(name)
    if (!key || !capability) return
    registry[key] = normalizeAgentToolCapability(capability)
  }
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (Array.isArray(entry)) add(entry[0], entry[1])
      else add(entry, entry?.[ORBIT_AGENT_TOOL_CAPABILITY])
    }
  } else {
    for (const [name, capability] of Object.entries(executionObject(entries))) add(name, capability)
  }
  return Object.freeze(registry)
}

export function getAgentToolCapability(tool, registry = {}) {
  if (tool && typeof tool === 'object' && tool[ORBIT_AGENT_TOOL_CAPABILITY]) {
    return normalizeAgentToolCapability(tool[ORBIT_AGENT_TOOL_CAPABILITY])
  }
  const name = agentToolSpecName(tool)
  const declared = name ? executionObject(registry)[name] : null
  return normalizeAgentToolCapability(declared || {})
}

/**
 * Decide whether a tool may run before an execution plan exists. Input
 * observations are task-mode independent; source observations additionally
 * require the host to confirm that existing source is authoritative.
 */
export function evaluateAgentToolPrePlan(tool, options = {}) {
  const input = executionObject(options)
  const capability = getAgentToolCapability(tool, input.registry)
  if (input.hasPlan === true) {
    return Object.freeze({ allowed: true, decision: 'planned', consumesObservation: false, capability })
  }
  if (capability.prePlan === 'establish') {
    return Object.freeze({ allowed: true, decision: 'establish', consumesObservation: false, capability })
  }
  if (capability.prePlan !== 'observe' || !capability.observationScope) {
    return Object.freeze({ allowed: false, decision: 'denied', consumesObservation: false, capability })
  }
  const scope = capability.observationScope
  if (scope === 'source' && input.allowSourceObservation !== true) {
    return Object.freeze({ allowed: false, decision: 'source_not_authorized', consumesObservation: false, capability })
  }
  const counts = executionObject(input.observationCounts)
  const observed = executionCount(counts[scope])
  const limit = capability.budget.maxPrePlanCalls
  if (limit <= 0 || observed >= limit) {
    return Object.freeze({ allowed: false, decision: 'budget_exhausted', consumesObservation: false, capability, scope, observed, limit })
  }
  return Object.freeze({ allowed: true, decision: 'observe', consumesObservation: true, capability, scope, observed, limit })
}

/** Preserve a repeated error streak when that signature is still in a sibling batch. */
export function selectAgentToolBatchErrorKey(errorKeys, previousKey = '') {
  const unique = []
  for (const value of Array.isArray(errorKeys) ? errorKeys : []) {
    const key = executionKey(value)
    if (key && !unique.includes(key)) unique.push(key)
  }
  const previous = executionKey(previousKey)
  return previous && unique.includes(previous) ? previous : (unique[0] || '')
}

/**
 * Host-neutral rendering invariant used by every Arcade coding surface. Target
 * adapters may add viewport/composition requirements, but must not replace this
 * coordinate contract with a product-specific canvas recipe.
 */
export const ORBIT_AGENT_RENDER_SURFACE_CONTRACT = [
  'Render-surface coordinate contract: derive the logical stage width and height in CSS pixels from the actual rendered container after layout.',
  'Canvas or renderer CSS size, world/camera/layout, collision, DOM HUD, and pointer/touch mapping must use that same logical stage.',
  'Device pixel ratio or adaptive render scale may change only backing-store/GPU resolution: never divide the logical stage by DPR, apply DPR twice, or mix CSS-pixel drawing/input with unscaled backing-store coordinates.',
  'For Canvas 2D, either size the backing store to logicalSize * DPR and apply the matching context transform before drawing in CSS pixels, or deliberately draw and map input in backing pixels with an identity transform; do not mix the two models.',
  'Reapply the chosen transform and recompute every dependent surface after a canvas width/height reset, container resize, orientation change, or no-reload host preview switch. Framework renderers and scale managers should own their pixel ratio instead of also scaling world coordinates manually.',
].join(' ')

/** Conservative runtime evidence thresholds for a full-size render surface. */
export const ORBIT_AGENT_RENDER_SURFACE_POLICY = Object.freeze({
  minViewportAreaCoverage: 0.55,
  minBackingScale: 1.35,
  maxSuspiciousActivityCoverage: 0.72,
  logicalRatioTolerance: 0.18,
  minDetailSamples: 12,
})

function executionObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function executionCount(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0
}

function executionKey(value) {
  return String(value || '').trim().slice(0, 1_200)
}

function agentToolCalls(value) {
  return Array.isArray(value?.tool_calls) ? value.tool_calls : []
}

function agentToolCallId(call) {
  return typeof call?.id === 'string' ? call.id.trim() : ''
}

export const ORBIT_AGENT_TOOL_BATCH_SCHEMA = 'orbit.agent-tool-batch.v1'

export function splitAgentToolCallBatch(assistant, policy = ORBIT_AGENT_EXECUTION_POLICY) {
  const allCalls = agentToolCalls(assistant)
  assertAgentTranscriptProtocol([{ role: 'assistant', tool_calls: allCalls }], { allowIncompleteTail: true })
  const limit = Math.max(1, executionCount(executionObject(policy).maxToolCallsPerTurn || ORBIT_AGENT_EXECUTION_POLICY.maxToolCallsPerTurn))
  return { allCalls, executableCalls: allCalls.slice(0, limit), skippedCalls: allCalls.slice(limit), limit }
}

export function createAgentSyntheticToolResults(toolCalls, reason = 'the host ended this tool batch before execution') {
  const detail = executionKey(reason) || 'the host ended this tool batch before execution'
  return (Array.isArray(toolCalls) ? toolCalls : []).map((call, index) => ({
    role: 'tool',
    tool_call_id: agentToolCallId(call) || `orbit_synthetic_tool_${index + 1}`,
    content: `Skipped before execution: ${detail}`,
  }))
}

function cloneAgentToolCall(call) {
  return { ...call, ...(call?.function && typeof call.function === 'object' ? { function: { ...call.function } } : {}) }
}

function normalizeAgentToolBatchResult(result) {
  if (!result || typeof result !== 'object' || result.role !== 'tool') return null
  if (typeof result.tool_call_id !== 'string') return null
  const id = result.tool_call_id.trim()
  if (!id || result.tool_call_id !== id) return null
  return {
    ...result,
    role: 'tool',
    tool_call_id: id,
    content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? ''),
  }
}

export function normalizeAgentToolBatchJournal(raw) {
  const value = executionObject(raw)
  if (value.schema !== ORBIT_AGENT_TOOL_BATCH_SCHEMA) return null
  const calls = agentToolCalls({ tool_calls: value.calls }).map(cloneAgentToolCall)
  try {
    assertAgentTranscriptProtocol([{ role: 'assistant', tool_calls: calls }], { allowIncompleteTail: true })
  } catch {
    return null
  }
  const limit = Math.min(calls.length, Math.max(0, executionCount(value.limit)))
  if (calls.length && limit < 1) return null
  const ids = new Set(calls.map(agentToolCallId))
  const results = []
  const responded = new Set()
  for (const rawResult of Array.isArray(value.results) ? value.results : []) {
    const result = normalizeAgentToolBatchResult(rawResult)
    if (!result || !ids.has(result.tool_call_id) || responded.has(result.tool_call_id)) return null
    responded.add(result.tool_call_id)
    results.push(result)
  }
  const rawDeferredMessages = Array.isArray(value.deferredMessages) ? value.deferredMessages : []
  if (rawDeferredMessages.some((message) => (
    !message
    || typeof message !== 'object'
    || message.role === 'tool'
    || agentToolCalls(message).length > 0
  ))) return null
  const deferredMessages = rawDeferredMessages.map((message) => ({ ...message }))
  if (!['open', 'closed'].includes(value.status)) return null
  const status = value.status
  if (status === 'closed' && responded.size !== calls.length) return null
  const canonicalResults = status === 'closed'
    ? calls.map((call) => results.find((result) => result.tool_call_id === agentToolCallId(call)))
    : results
  if (canonicalResults.some((result) => !result)) return null
  return { schema: ORBIT_AGENT_TOOL_BATCH_SCHEMA, status, calls, limit, results: canonicalResults, deferredMessages }
}

export function createAgentToolBatchJournal(assistant, policy = ORBIT_AGENT_EXECUTION_POLICY) {
  const split = splitAgentToolCallBatch(assistant, policy)
  return {
    schema: ORBIT_AGENT_TOOL_BATCH_SCHEMA,
    status: 'open',
    calls: split.allCalls.map(cloneAgentToolCall),
    limit: split.executableCalls.length,
    results: [],
    deferredMessages: [],
  }
}

export function recordAgentToolBatchResult(rawJournal, rawResult) {
  const journal = normalizeAgentToolBatchJournal(rawJournal)
  const result = normalizeAgentToolBatchResult(rawResult)
  if (!journal || journal.status !== 'open') throw new TypeError('Agent tool batch journal is invalid or already closed')
  if (!result) throw new TypeError('Agent tool result is invalid')
  const ids = new Set(journal.calls.map(agentToolCallId))
  if (!ids.has(result.tool_call_id)) throw new TypeError(`Agent tool result does not belong to this batch: ${result.tool_call_id}`)
  if (journal.results.some((entry) => entry.tool_call_id === result.tool_call_id)) {
    throw new TypeError(`Agent tool result was already recorded: ${result.tool_call_id}`)
  }
  return { ...journal, results: [...journal.results, result] }
}

export function deferAgentToolBatchMessage(rawJournal, message) {
  const journal = normalizeAgentToolBatchJournal(rawJournal)
  if (!journal || journal.status !== 'open') throw new TypeError('Agent tool batch journal is invalid or already closed')
  if (!message || typeof message !== 'object' || message.role === 'tool' || agentToolCalls(message).length > 0) {
    throw new TypeError('Deferred agent tool-batch message must be a non-tool message')
  }
  return { ...journal, deferredMessages: [...journal.deferredMessages, { ...message }] }
}

export function closeAgentToolBatchJournal(rawJournal, reason) {
  const journal = normalizeAgentToolBatchJournal(rawJournal)
  if (!journal) throw new TypeError('Agent tool batch journal is invalid')
  if (journal.status === 'closed') {
    return {
      journal,
      toolMessages: [...journal.results],
      deferredMessages: [...journal.deferredMessages],
      messages: [...journal.results, ...journal.deferredMessages],
      syntheticCount: 0,
    }
  }
  const byId = new Map(journal.results.map((result) => [result.tool_call_id, result]))
  let syntheticCount = 0
  const toolMessages = journal.calls.map((call) => {
    const id = agentToolCallId(call)
    const existing = byId.get(id)
    if (existing) return existing
    syntheticCount += 1
    return createAgentSyntheticToolResults([call], reason)[0]
  })
  const closedJournal = { ...journal, status: 'closed', results: toolMessages }
  assertAgentTranscriptProtocol([
    { role: 'assistant', tool_calls: closedJournal.calls },
    ...toolMessages,
    ...closedJournal.deferredMessages,
  ])
  return {
    journal: closedJournal,
    toolMessages,
    deferredMessages: [...closedJournal.deferredMessages],
    messages: [...toolMessages, ...closedJournal.deferredMessages],
    syntheticCount,
  }
}

export function agentTranscriptProtocolIssues(messages, options = {}) {
  const source = Array.isArray(messages) ? messages : []
  const allowIncompleteTail = options?.allowIncompleteTail === true
  const issues = []
  let pending = null
  for (let index = 0; index < source.length; index += 1) {
    const message = source[index]
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      if (pending) {
        const missing = [...pending.ids].filter((id) => !pending.responded.has(id))
        if (missing.length) issues.push(`message ${index + 1}: malformed message interrupted an assistant tool batch with ${missing.length} unresolved call(s)`)
        pending = null
      }
      issues.push(`message ${index + 1}: message must be an object`)
      continue
    }
    if (pending) {
      if (message.role === 'tool') {
        const id = String(message.tool_call_id || '').trim()
        if (typeof message.tool_call_id !== 'string' || !id || message.tool_call_id !== id) issues.push(`message ${index + 1}: tool result has a non-canonical tool_call_id`)
        else if (!pending.ids.has(id)) issues.push(`message ${index + 1}: tool result does not match the active assistant tool batch`)
        else if (pending.responded.has(id)) issues.push(`message ${index + 1}: duplicate tool result for ${id}`)
        else pending.responded.add(id)
        if (pending.responded.size === pending.ids.size) pending = null
        continue
      }
      const missing = [...pending.ids].filter((id) => !pending.responded.has(id))
      if (missing.length) issues.push(`message ${index + 1}: ${String(message.role || 'non-tool')} message interrupted an assistant tool batch with ${missing.length} unresolved call(s)`)
      pending = null
    }
    if (message.role === 'assistant') {
      const calls = agentToolCalls(message)
      if (!calls.length) continue
      const ids = new Set()
      for (const [callIndex, call] of calls.entries()) {
        if (!call || typeof call !== 'object') {
          issues.push(`message ${index + 1}: assistant tool call ${callIndex + 1} is malformed`)
          continue
        }
        const id = agentToolCallId(call)
        if (!id) issues.push(`message ${index + 1}: assistant tool call ${callIndex + 1} has no id`)
        else if (call.id !== id) issues.push(`message ${index + 1}: assistant tool call ${callIndex + 1} has a non-canonical id`)
        else if (ids.has(id)) issues.push(`message ${index + 1}: duplicate assistant tool call id ${id}`)
        else ids.add(id)
        if (call.type !== 'function') issues.push(`message ${index + 1}: assistant tool call ${callIndex + 1} is not a function call`)
        if (!call.function || typeof call.function !== 'object') {
          issues.push(`message ${index + 1}: assistant tool call ${callIndex + 1} has no function payload`)
        } else {
          if (typeof call.function.name !== 'string' || !call.function.name.trim()) {
            issues.push(`message ${index + 1}: assistant tool call ${callIndex + 1} has no function name`)
          }
          if (typeof call.function.arguments !== 'string') {
            issues.push(`message ${index + 1}: assistant tool call ${callIndex + 1} has invalid function arguments`)
          }
        }
      }
      if (ids.size) pending = { ids, responded: new Set() }
      continue
    }
    if (message.role === 'tool') {
      issues.push(`message ${index + 1}: orphan tool result ${String(message.tool_call_id || '').trim() || '(missing id)'}`)
      continue
    }
    if (!['system', 'developer', 'user'].includes(message.role)) issues.push(`message ${index + 1}: unsupported message role ${String(message.role || '(missing)')}`)
  }
  if (pending && !allowIncompleteTail) {
    const missing = [...pending.ids].filter((id) => !pending.responded.has(id))
    if (missing.length) issues.push(`transcript ended with ${missing.length} unresolved assistant tool call(s)`)
  }
  return issues
}

export function assertAgentTranscriptProtocol(messages, options = {}) {
  const issues = agentTranscriptProtocolIssues(messages, options)
  if (!issues.length) return true
  const error = new Error(`Agent transcript protocol violation: ${issues.slice(0, 4).join('; ')}`)
  error.code = 'ORBIT_AGENT_TRANSCRIPT_PROTOCOL'
  error.issues = issues
  throw error
}

function renderSurfaceNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * Evaluate browser-collected canvas activity without depending on a browser,
 * DOM implementation, game genre, CSS selector, or target aspect ratio.
 */
export function renderSurfaceActivityIssues(reports, policy = ORBIT_AGENT_RENDER_SURFACE_POLICY) {
  const limits = { ...ORBIT_AGENT_RENDER_SURFACE_POLICY, ...executionObject(policy) }
  const issues = []
  for (const report of Array.isArray(reports) ? reports : []) {
    const label = String(report?.probeId || report?.label || 'runtime viewport')
    const viewportWidth = Math.max(1, renderSurfaceNumber(report?.viewport?.width))
    const viewportHeight = Math.max(1, renderSurfaceNumber(report?.viewport?.height))
    const viewportArea = viewportWidth * viewportHeight
    for (const [surfaceIndex, surface] of (Array.isArray(report?.renderSurfaces) ? report.renderSurfaces : []).entries()) {
      const cssWidth = Math.max(0, renderSurfaceNumber(surface?.css?.width))
      const cssHeight = Math.max(0, renderSurfaceNumber(surface?.css?.height))
      const backingWidth = Math.max(0, renderSurfaceNumber(surface?.backing?.width))
      const backingHeight = Math.max(0, renderSurfaceNumber(surface?.backing?.height))
      const areaCoverage = cssWidth * cssHeight / viewportArea
      if (areaCoverage < renderSurfaceNumber(limits.minViewportAreaCoverage, 0.55) || cssWidth <= 4 || cssHeight <= 4) continue

      const scaleX = backingWidth / cssWidth
      const scaleY = backingHeight / cssHeight
      const activity = executionObject(surface?.activity)
      const detailSamples = executionCount(activity.detailSamples)
      const right = renderSurfaceNumber(activity?.detailBounds?.right, 1)
      const bottom = renderSurfaceNumber(activity?.detailBounds?.bottom, 1)
      if (detailSamples < executionCount(limits.minDetailSamples)) continue

      const maxActivityCoverage = renderSurfaceNumber(limits.maxSuspiciousActivityCoverage, 0.72)
      const tolerance = renderSurfaceNumber(limits.logicalRatioTolerance, 0.18)
      const minBackingScale = renderSurfaceNumber(limits.minBackingScale, 1.35)
      const unusedRight = right > 0 && right <= maxActivityCoverage
      const unusedBottom = bottom > 0 && bottom <= maxActivityCoverage
      const followsLogicalWidth = scaleX >= minBackingScale && Math.abs(right - (1 / scaleX)) <= tolerance
      const followsLogicalHeight = scaleY >= minBackingScale && Math.abs(bottom - (1 / scaleY)) <= tolerance

      if ((followsLogicalWidth && unusedBottom) || (followsLogicalHeight && unusedRight)) {
        issues.push(`${label}: a viewport-dominant render surface appears to draw CSS-pixel content only into the upper-left of a higher-resolution backing store (surface ${surfaceIndex + 1}, CSS ${Math.round(cssWidth)}x${Math.round(cssHeight)}, backing ${Math.round(backingWidth)}x${Math.round(backingHeight)}, visual detail reaches ${Math.round(right * 100)}% width / ${Math.round(bottom * 100)}% height). Keep DPR in backing resolution only and use one logical stage for drawing, camera/world, HUD, collision, and input.`)
      }
    }
  }
  return issues
}

/** Create the portable progress/failure streak state used by every agent host. */
export function createAgentExecutionState(raw = {}) {
  const source = executionObject(raw)
  return {
    consecutiveNoTools: executionCount(source.consecutiveNoTools),
    consecutiveModelFailures: executionCount(source.consecutiveModelFailures),
    lastToolErrorKey: executionKey(source.lastToolErrorKey),
    repeatedToolErrors: executionCount(source.repeatedToolErrors),
    lastValidationFailure: executionKey(source.lastValidationFailure),
    repeatedValidationFailures: executionCount(source.repeatedValidationFailures),
  }
}

/**
 * Apply one host-neutral loop event. The core decides streak semantics and
 * limits; hosts decide how to display, retry, pause, or persist the outcome.
 */
export function transitionAgentExecutionState(state, event, policy = ORBIT_AGENT_EXECUTION_POLICY) {
  const current = createAgentExecutionState(state)
  const input = executionObject(event)
  const limits = { ...ORBIT_AGENT_EXECUTION_POLICY, ...executionObject(policy) }
  const next = { ...current }
  let warning = null
  let stopReason = null

  if (input.type === 'model_success') {
    next.consecutiveModelFailures = 0
  } else if (input.type === 'model_failure') {
    next.consecutiveModelFailures += 1
    if (next.consecutiveModelFailures >= executionCount(limits.consecutiveModelFailureLimit)) {
      stopReason = 'model_failure_limit'
    }
  } else if (input.type === 'tool_batch') {
    if (executionCount(input.count) > 0) next.consecutiveNoTools = 0
    else next.consecutiveNoTools += 1
    if (next.consecutiveNoTools >= executionCount(limits.consecutiveNoToolLimit)) {
      stopReason = 'no_tool_limit'
    }
  } else if (input.type === 'tool_result' || input.type === 'tool_batch_result') {
    if (input.ok === true) {
      next.lastToolErrorKey = ''
      next.repeatedToolErrors = 0
    } else {
      const key = executionKey(input.key)
      next.repeatedToolErrors = key && key === next.lastToolErrorKey ? next.repeatedToolErrors + 1 : 1
      next.lastToolErrorKey = key
      if (next.repeatedToolErrors === executionCount(limits.repeatedToolErrorWarning)) {
        warning = 'repeated_tool_error'
      }
      if (next.repeatedToolErrors >= executionCount(limits.repeatedToolErrorLimit)) {
        stopReason = 'repeated_tool_error_limit'
      }
    }
  } else if (input.type === 'validation_result') {
    if (input.ok === true) {
      next.lastValidationFailure = ''
      next.repeatedValidationFailures = 0
    } else {
      const signature = executionKey(input.signature)
      next.repeatedValidationFailures = signature && signature === next.lastValidationFailure
        ? next.repeatedValidationFailures + 1
        : (signature ? 1 : 0)
      next.lastValidationFailure = signature
      if (next.repeatedValidationFailures >= executionCount(limits.repeatedValidationFailureLimit)) {
        stopReason = 'repeated_validation_failure_limit'
      }
    }
  } else {
    throw new TypeError(`Unknown agent execution event: ${String(input.type || '')}`)
  }

  return { state: next, warning, stopReason }
}

/**
 * Per-request output budgets for managed gateway calls. These are product
 * budgets, not provider capability claims. Direct-provider adapters may omit
 * the field so reasoning-heavy models use the provider's own policy instead of
 * sharing one response budget across reasoning and tool calls.
 */
export const ORBIT_AGENT_MODEL_OUTPUT_LIMITS = Object.freeze({
  agent: 16_000,
  referenceMedia: 4_096,
})

export const ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA = 'orbit.agent-capability-profile.v1'
export const ORBIT_AGENT_SEMANTIC_SUMMARY_SCHEMA = 'orbit.agent-semantic-summary.v1'
export const ORBIT_AGENT_CHECKPOINT_SCHEMA = 'orbit.agent-checkpoint.v1'
export const ORBIT_AGENT_INTERNAL_MESSAGE_SCHEMA = 'orbit.agent-internal-message.v1'
const ORBIT_CONTEXT_SUMMARY_MARKER = Symbol.for('orbit.agent-context-summary.v1')

export const ORBIT_AGENT_CAPABILITY_PROFILES = Object.freeze({
  'local-desktop': Object.freeze({
    schema: ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA,
    executorProfile: 'local-desktop',
    semanticCompaction: 'model',
    checkpointPersistence: 'project',
    workspaceSnapshot: 'digest',
    pendingToolRecovery: 'none',
    // Desktop summaries traverse the Worker gateway's 220k-char / 384KiB
    // envelope. Keep this below that transport boundary after JSON escaping.
    maxSemanticInputTokens: 44_000,
    maxSemanticOutputTokens: 4_096,
  }),
  'cli-local': Object.freeze({
    schema: ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA,
    executorProfile: 'cli-local',
    semanticCompaction: 'model',
    checkpointPersistence: 'run',
    workspaceSnapshot: 'none',
    pendingToolRecovery: 'inspect',
    maxSemanticInputTokens: 140_000,
    maxSemanticOutputTokens: 5_000,
  }),
  'container-local': Object.freeze({
    schema: ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA,
    executorProfile: 'container-local',
    semanticCompaction: 'model',
    checkpointPersistence: 'run',
    workspaceSnapshot: 'revision',
    pendingToolRecovery: 'inspect',
    maxSemanticInputTokens: 120_000,
    maxSemanticOutputTokens: 5_000,
  }),
  'e2b-cloud': Object.freeze({
    schema: ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA,
    executorProfile: 'e2b-cloud',
    // E2B currently consumes the shared deterministic safety compactor. The
    // profile must describe that real capability until a summarizer is wired.
    semanticCompaction: 'none',
    checkpointPersistence: 'none',
    workspaceSnapshot: 'revision',
    pendingToolRecovery: 'none',
    maxSemanticInputTokens: 96_000,
    maxSemanticOutputTokens: 4_000,
  }),
  'worker-standard': Object.freeze({
    schema: ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA,
    executorProfile: 'worker-standard',
    semanticCompaction: 'none',
    checkpointPersistence: 'run',
    workspaceSnapshot: 'revision',
    pendingToolRecovery: 'inspect',
    maxSemanticInputTokens: 96_000,
    maxSemanticOutputTokens: 4_000,
  }),
  test: Object.freeze({
    schema: ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA,
    executorProfile: 'test',
    semanticCompaction: 'none',
    checkpointPersistence: 'none',
    workspaceSnapshot: 'none',
    pendingToolRecovery: 'none',
    maxSemanticInputTokens: 32_000,
    maxSemanticOutputTokens: 2_000,
  }),
})

export const ORBIT_VISUAL_PLAN_MAX_CANDIDATES = 3

export const ORBIT_LOOP_ITERATION_POLICY = Object.freeze({
  create: ORBIT_AGENT_EXECUTION_POLICY.maxIterations,
  edit: ORBIT_AGENT_EXECUTION_POLICY.maxIterations,
  maxExecutionWindows: 6,
})

export const ORBIT_PRO_AGENT_CONTEXT_POLICY = Object.freeze({
  effectiveWindowTokens: 258_000,
  softTokenRatio: 0.72,
  targetTokenRatio: 0.58,
  hardTokenRatio: 0.86,
  softChars: 720_000,
  targetChars: 580_000,
  hardChars: 860_000,
  keepRecentMessages: 28,
  keepRecentUserMessages: 6,
  recentUserTokenBudget: 12_000,
  compactMessageCount: 140,
})

export const ORBIT_PRO_AGENT_CONVERSATION_POLICY = Object.freeze({
  maxInputChars: 32_000,
  maxPendingInputs: 64,
  maxPendingSteers: 16,
  maxClientMessageIdChars: 160,
  maxRunIdChars: 160,
})

function cleanVisualPlanText(value, maximum) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function visualPlanObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/**
 * Normalize the portable visual-direction contract used by hosts that opt in
 * to a plan-before-build flow. The core owns the three-option ceiling while
 * image generation, persistence, billing, and UI remain host capabilities.
 */
export function normalizeOrbitVisualPlan(raw) {
  const value = visualPlanObject(raw)
  if (!value) return null
  const source = Array.isArray(value.candidates) ? value.candidates : []
  const candidates = []
  const ids = new Set()
  for (let index = 0; index < source.length && candidates.length < ORBIT_VISUAL_PLAN_MAX_CANDIDATES; index += 1) {
    const candidate = visualPlanObject(source[index])
    if (!candidate) continue
    let id = cleanPlanId(candidate.id, `direction-${index + 1}`)
    while (ids.has(id)) id = `${id}-${index + 1}`.slice(0, 80)
    const label = cleanVisualPlanText(candidate.label || candidate.title, 100)
    const rationale = cleanVisualPlanText(candidate.rationale || candidate.description, 700)
    const imagePrompt = cleanVisualPlanText(candidate.imagePrompt || candidate.image_prompt || candidate.prompt, 4_000)
    if (!label || !rationale || !imagePrompt) continue
    ids.add(id)
    candidates.push({ id, label, rationale, imagePrompt })
  }
  if (!candidates.length) return null
  return {
    version: 1,
    summary: cleanVisualPlanText(value.summary, 1_200) || 'Choose a visual direction before implementation.',
    candidates,
  }
}

function parseVisualPlanJson(value) {
  if (visualPlanObject(value)) return value
  const text = String(value || '').trim()
  if (!text) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]?.trim()
  for (const candidate of [fenced, text]) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate)
      if (visualPlanObject(parsed)) return parsed
    } catch {}
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      if (visualPlanObject(parsed)) return parsed
    } catch {}
  }
  return null
}

export function parseOrbitVisualPlanAssistant(value) {
  const message = visualPlanObject(value)
  const content = message && 'content' in message ? message.content : value
  if (Array.isArray(content)) {
    return normalizeOrbitVisualPlan(parseVisualPlanJson(content
      .map((part) => visualPlanObject(part)?.text || '')
      .join('\n')))
  }
  return normalizeOrbitVisualPlan(parseVisualPlanJson(content))
}

export function buildOrbitVisualPlanImagePrompt(input = {}) {
  const originalRequest = cleanVisualPlanText(input.originalRequest, 2_400)
  const candidate = visualPlanObject(input.candidate) || {}
  const label = cleanVisualPlanText(candidate.label, 100)
  const rationale = cleanVisualPlanText(candidate.rationale, 700)
  const imagePrompt = cleanVisualPlanText(candidate.imagePrompt, 4_000)
  if (!originalRequest || !label || !imagePrompt) throw new TypeError('Visual plan image input is invalid')
  return [
    'Create one portrait 9:16 active-gameplay concept frame for a local HTML game production plan.',
    'Show a believable moment from the core playable loop, not key art, a poster, splash screen, menu, phone mockup, or mood board.',
    `Original request: ${originalRequest}`,
    `Chosen direction: ${label}. ${rationale}`,
    `Art direction: ${imagePrompt}`,
    'Include the controllable subject, immediate gameplay pressure, objective or reward, environment depth, and a compact edge-safe HUD.',
    'Keep silhouettes, lanes, interaction affordances, camera, lighting, palette, materials, and VFX readable enough for a coding agent to reproduce.',
    'No title, logo, watermark, store badge, device frame, promotional typography, or large blocks of text.',
  ].join('\n').slice(0, 8_000)
}

/**
 * Turn one user request into a finite, auditable Loop objective. Hosts own
 * persistence and execution budgets; the portable core owns completion
 * semantics so local, desktop, and cloud runtimes do not drift.
 */
export function buildOrbitLoopObjectivePrompt(prompt) {
  const objective = String(prompt || '').trim()
  if (!objective) throw new TypeError('Loop objective is invalid')
  return [
    'ORBIT_LOOP_MODE_V1',
    'This is a persistent Loop objective. Keep working until the full objective is achieved and verified; do not stop after a plausible partial result.',
    '- Infer a finite set of deliverables from the user request. If it asks for multiple games or variants, track every requested item explicitly in update_agent_plan.',
    '- For a batch, keep each game or variant isolated in a clearly named source directory and make the validated root build a playable catalog that opens every completed item. Do not overwrite an earlier item with the next one.',
    '- Treat uncertainty as incomplete. Before finish, audit the objective requirement by requirement, run the relevant builds and validation, and confirm every non-cancelled plan item is complete with evidence.',
    '- If a genuine blocker remains, record it in the plan and preserve completed local files. Never claim success merely because the iteration budget is close to exhausted.',
    '',
    'Loop objective:',
    objective,
  ].join('\n')
}

function resolvedConversationPolicy(policy = {}) {
  const base = ORBIT_PRO_AGENT_CONVERSATION_POLICY
  return {
    maxInputChars: Math.max(1, Math.floor(Number(policy.maxInputChars || base.maxInputChars))),
    maxPendingInputs: Math.max(1, Math.floor(Number(policy.maxPendingInputs || base.maxPendingInputs))),
    maxPendingSteers: Math.max(1, Math.floor(Number(policy.maxPendingSteers || base.maxPendingSteers))),
    maxClientMessageIdChars: Math.max(1, Math.floor(Number(policy.maxClientMessageIdChars || base.maxClientMessageIdChars))),
    maxRunIdChars: Math.max(1, Math.floor(Number(policy.maxRunIdChars || base.maxRunIdChars))),
  }
}

function conversationTransition(state, accepted, action, extra = {}) {
  return { state, accepted, action, ...extra }
}

function validateConversationInput(state, raw) {
  const policy = resolvedConversationPolicy(state && state.policy)
  const clientMessageId = typeof (raw && raw.clientMessageId) === 'string'
    ? raw.clientMessageId.trim()
    : ''
  if (!clientMessageId) return { reason: 'invalid_client_message_id' }
  if (clientMessageId.length > policy.maxClientMessageIdChars) return { reason: 'client_message_id_too_long' }
  const content = typeof (raw && raw.content) === 'string' ? raw.content : ''
  if (!content.trim()) return { reason: 'empty_input' }
  if (content.length > policy.maxInputChars) return { reason: 'input_too_long' }
  return { input: { clientMessageId, content } }
}

function validateConversationRunId(state, raw) {
  const policy = resolvedConversationPolicy(state && state.policy)
  const runId = typeof raw === 'string' ? raw.trim() : ''
  if (!runId) return { reason: 'invalid_run_id' }
  if (runId.length > policy.maxRunIdChars) return { reason: 'run_id_too_long' }
  return { runId }
}

function pendingConversationInputCount(state) {
  return (Array.isArray(state && state.pendingSteers) ? state.pendingSteers.length : 0)
    + (Array.isArray(state && state.queue) ? state.queue.length : 0)
}

function acceptedConversationMessage(state, input) {
  return {
    ...state,
    acceptedClientMessageIds: [...state.acceptedClientMessageIds, input.clientMessageId],
  }
}

function rejectDuplicateConversationMessage(state, raw) {
  const clientMessageId = typeof (raw && raw.clientMessageId) === 'string'
    ? raw.clientMessageId.trim()
    : ''
  return Boolean(clientMessageId && state.acceptedClientMessageIds.includes(clientMessageId))
}

function checkConversationAttempt(state, options = {}) {
  if (!state.activeRun || state.activeRun.runId !== options.runId) return { reason: 'stale_run' }
  if (!Number.isInteger(options.attemptEpoch) || state.activeRun.attemptEpoch !== options.attemptEpoch) {
    return { reason: 'stale_attempt' }
  }
  return { run: state.activeRun }
}

/**
 * Create the serializable, I/O-free lifecycle state owned by one conversation.
 * Hosts persist this state and execute its returned effects themselves.
 */
export function createAgentConversationLifecycle(options = {}) {
  return {
    version: 1,
    policy: resolvedConversationPolicy(options.policy),
    activeRun: null,
    pendingSteers: [],
    queue: [],
    queuePaused: false,
    acceptedClientMessageIds: [],
  }
}

/**
 * Submit behaves like an interactive composer: idle input starts a run, while
 * input during a run steers that same run. Use queueAgentConversationInput for
 * an explicitly deferred message.
 */
export function submitAgentConversationInput(state, rawInput, options = {}) {
  if (rejectDuplicateConversationMessage(state, rawInput)) {
    return conversationTransition(state, false, 'duplicate', { reason: 'duplicate_client_message_id' })
  }
  const validated = validateConversationInput(state, rawInput)
  if (!validated.input) return conversationTransition(state, false, 'rejected', { reason: validated.reason })

  if (state.activeRun) {
    return steerAgentConversationRun(state, validated.input, options)
  }
  if (state.queue.length) {
    return queueAgentConversationInput(state, validated.input)
  }

  const validatedRun = validateConversationRunId(state, options.runId)
  if (!validatedRun.runId) return conversationTransition(state, false, 'rejected', { reason: validatedRun.reason })
  const input = validated.input
  const next = acceptedConversationMessage({
    ...state,
    activeRun: {
      runId: validatedRun.runId,
      input,
      attemptEpoch: 1,
      interruptRequested: false,
    },
  }, input)
  return conversationTransition(next, true, 'started', { input, run: next.activeRun })
}

/** Add high-priority input to the current run and invalidate its old attempt. */
export function steerAgentConversationRun(state, rawInput, options = {}) {
  if (rejectDuplicateConversationMessage(state, rawInput)) {
    return conversationTransition(state, false, 'duplicate', { reason: 'duplicate_client_message_id' })
  }
  const validated = validateConversationInput(state, rawInput)
  if (!validated.input) return conversationTransition(state, false, 'rejected', { reason: validated.reason })
  const attempt = checkConversationAttempt(state, options)
  if (!attempt.run) return conversationTransition(state, false, 'rejected', { reason: attempt.reason })
  if (attempt.run.interruptRequested) {
    return conversationTransition(state, false, 'rejected', { reason: 'interrupt_pending' })
  }
  const policy = resolvedConversationPolicy(state.policy)
  if (pendingConversationInputCount(state) >= policy.maxPendingInputs) {
    return conversationTransition(state, false, 'rejected', { reason: 'pending_input_limit' })
  }
  if (state.pendingSteers.length >= policy.maxPendingSteers) {
    return conversationTransition(state, false, 'rejected', { reason: 'pending_steer_limit' })
  }

  const input = validated.input
  const next = acceptedConversationMessage({
    ...state,
    activeRun: {
      ...state.activeRun,
      attemptEpoch: state.activeRun.attemptEpoch + 1,
    },
    pendingSteers: [...state.pendingSteers, input],
  }, input)
  return conversationTransition(next, true, 'steered', {
    input,
    run: next.activeRun,
    attemptEpoch: next.activeRun.attemptEpoch,
  })
}

/** Append an explicitly deferred message without changing the active attempt. */
export function queueAgentConversationInput(state, rawInput) {
  if (rejectDuplicateConversationMessage(state, rawInput)) {
    return conversationTransition(state, false, 'duplicate', { reason: 'duplicate_client_message_id' })
  }
  const validated = validateConversationInput(state, rawInput)
  if (!validated.input) return conversationTransition(state, false, 'rejected', { reason: validated.reason })
  const policy = resolvedConversationPolicy(state.policy)
  if (pendingConversationInputCount(state) >= policy.maxPendingInputs) {
    return conversationTransition(state, false, 'rejected', { reason: 'pending_input_limit' })
  }
  const input = validated.input
  const next = acceptedConversationMessage({ ...state, queue: [...state.queue, input] }, input)
  return conversationTransition(next, true, 'queued', { input, queuePosition: next.queue.length - 1 })
}

/**
 * Drain one steer at an executor safe point. Queued turns are never consumed
 * while a run is active, so steer input always has priority.
 */
export function drainAgentConversationSafePoint(state, options = {}) {
  const attempt = checkConversationAttempt(state, options)
  if (!attempt.run) return conversationTransition(state, false, 'rejected', { reason: attempt.reason })
  if (attempt.run.interruptRequested) {
    return conversationTransition(state, false, 'rejected', { reason: 'interrupt_pending' })
  }
  if (!state.pendingSteers.length) return conversationTransition(state, false, 'noop')
  const input = state.pendingSteers[0]
  const next = { ...state, pendingSteers: state.pendingSteers.slice(1) }
  return conversationTransition(next, true, 'steer_drained', {
    input,
    attemptEpoch: next.activeRun.attemptEpoch,
  })
}

/** True only for output that may still be committed to the active run. */
export function isAgentConversationAttemptCurrent(state, options = {}) {
  const attempt = checkConversationAttempt(state, options)
  return Boolean(attempt.run && !attempt.run.interruptRequested)
}

/** Request cancellation and pause automatic queue draining. */
export function stopAgentConversationRun(state, options = {}) {
  if (!state.activeRun) {
    if (options.runId) return conversationTransition(state, false, 'rejected', { reason: 'stale_run' })
    if (state.queuePaused) return conversationTransition(state, false, 'noop')
    const next = { ...state, queuePaused: true }
    return conversationTransition(next, true, 'queue_paused')
  }
  const attempt = checkConversationAttempt(state, options)
  if (!attempt.run) return conversationTransition(state, false, 'rejected', { reason: attempt.reason })
  if (attempt.run.interruptRequested && state.queuePaused) {
    return conversationTransition(state, false, 'noop', { reason: 'interrupt_pending' })
  }
  const next = {
    ...state,
    queuePaused: true,
    activeRun: { ...state.activeRun, interruptRequested: true },
  }
  return conversationTransition(next, true, 'interrupt_requested', { run: next.activeRun })
}

/**
 * Commit a terminal result. Undelivered steer messages are moved ahead of the
 * regular FIFO queue on failure/interruption, so acknowledged input is never
 * silently lost.
 */
export function finishAgentConversationRun(state, options = {}) {
  const attempt = checkConversationAttempt(state, options)
  if (!attempt.run) return conversationTransition(state, false, 'rejected', { reason: attempt.reason })
  const outcome = options.outcome || 'completed'
  if (!['completed', 'failed', 'interrupted'].includes(outcome)) {
    return conversationTransition(state, false, 'rejected', { reason: 'invalid_outcome' })
  }
  if (attempt.run.interruptRequested && outcome !== 'interrupted') {
    return conversationTransition(state, false, 'rejected', { reason: 'interrupt_pending' })
  }
  if (outcome === 'completed' && state.pendingSteers.length) {
    return conversationTransition(state, false, 'rejected', { reason: 'pending_steer' })
  }
  const recoveredSteers = outcome === 'completed' ? [] : state.pendingSteers
  const next = {
    ...state,
    activeRun: null,
    pendingSteers: [],
    queue: [...recoveredSteers, ...state.queue],
    queuePaused: outcome === 'completed' ? state.queuePaused : true,
  }
  return conversationTransition(next, true, outcome, { run: attempt.run, recoveredSteers })
}

/** Start the oldest queued input when automatic draining is allowed. */
export function startNextQueuedAgentConversationRun(state, options = {}) {
  if (state.activeRun) return conversationTransition(state, false, 'rejected', { reason: 'run_active' })
  if (state.queuePaused) return conversationTransition(state, false, 'rejected', { reason: 'queue_paused' })
  if (!state.queue.length) return conversationTransition(state, false, 'noop')
  const validatedRun = validateConversationRunId(state, options.runId)
  if (!validatedRun.runId) return conversationTransition(state, false, 'rejected', { reason: validatedRun.reason })
  const input = state.queue[0]
  const next = {
    ...state,
    activeRun: {
      runId: validatedRun.runId,
      input,
      attemptEpoch: 1,
      interruptRequested: false,
    },
    queue: state.queue.slice(1),
  }
  return conversationTransition(next, true, 'started', { input, run: next.activeRun })
}

/** Resume automatic FIFO draining after a stop. */
export function resumeAgentConversationQueue(state) {
  if (!state.queuePaused) return conversationTransition(state, false, 'noop')
  const next = { ...state, queuePaused: false }
  return conversationTransition(next, true, 'queue_resumed')
}

function cleanPlanText(value, max = 800) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function cleanPlanId(value, fallback) {
  const raw = String(value || '').trim().toLowerCase()
  return raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback
}

function agentTimestamp(mode = 'epoch') {
  return mode === 'iso' ? new Date().toISOString() : Date.now()
}

export function normalizeAgentPlan(raw, current = null, options = {}) {
  const obj = raw && typeof raw === 'object' ? raw : {}
  const existing = current && typeof current === 'object' ? current : null
  const existingTodos = Array.isArray(existing && existing.todos) ? existing.todos : []
  const byId = new Map(existingTodos.map((todo) => [todo.id, todo]))
  const allowedStatus = new Set(['pending', 'in_progress', 'completed', 'blocked', 'cancelled'])
  const allowedKind = new Set(['plan', 'asset', 'code', 'sdk', 'qa', 'publish', 'repair'])
  const rawTodos = Array.isArray(obj.todos) ? obj.todos.slice(0, 12) : []
  const todos = [...existingTodos]
  const updatedAt = options.updatedAt ?? agentTimestamp(options.timestamp)

  for (let i = 0; i < rawTodos.length; i += 1) {
    const rawTodo = rawTodos[i] && typeof rawTodos[i] === 'object' ? rawTodos[i] : {}
    const id = cleanPlanId(rawTodo.id, 'todo-' + (i + 1))
    const prev = byId.get(id)
    const title = cleanPlanText(rawTodo.title || rawTodo.content || (prev && prev.title), 140)
    if (!title) continue
    const normalized = {
      id,
      title,
      status: allowedStatus.has(String(rawTodo.status)) ? String(rawTodo.status) : ((prev && prev.status) || 'pending'),
      kind: allowedKind.has(String(rawTodo.kind)) ? String(rawTodo.kind) : ((prev && prev.kind) || 'code'),
      updatedAt,
    }
    const detail = cleanPlanText(rawTodo.detail || (prev && prev.detail), 500)
    const evidence = cleanPlanText(rawTodo.evidence || (prev && prev.evidence), 700)
    if (detail) normalized.detail = detail
    if (evidence) normalized.evidence = evidence
    const idx = todos.findIndex((todo) => todo.id === id)
    if (idx >= 0) todos[idx] = normalized
    else todos.push(normalized)
  }

  const finalTodos = todos.slice(0, 12)
  if (!finalTodos.length) return null
  const currentTodoIdRaw = typeof obj.currentTodoId === 'string'
    ? obj.currentTodoId
    : typeof obj.current_todo_id === 'string'
      ? obj.current_todo_id
      : existing && existing.currentTodoId
  const requestedCurrent = currentTodoIdRaw
    ? finalTodos.find((todo) => todo.id === currentTodoIdRaw)
    : null
  // A terminal todo can never remain the visible current item. Models often
  // patch statuses without repeating currentTodoId; preserving the old id in
  // that case leaves Studio pointing at completed control/inspection work
  // even while a later todo is already in progress.
  const currentTodoId = requestedCurrent
    && requestedCurrent.status !== 'completed'
    && requestedCurrent.status !== 'cancelled'
    ? requestedCurrent.id
    : (finalTodos.find((todo) => todo.status === 'in_progress')
      || finalTodos.find((todo) => todo.status === 'pending' || todo.status === 'blocked')
      || {}).id
      || null
  const blockers = Array.isArray(obj.blockers)
    ? obj.blockers.slice(0, 6).map((blocker) => cleanPlanText(blocker, 300)).filter(Boolean)
    : (existing && Array.isArray(existing.blockers) ? existing.blockers : [])

  return {
    version: 1,
    summary: cleanPlanText(obj.summary, 700) || (existing && existing.summary) || options.defaultSummary || 'Orbit agent execution plan',
    currentTodoId,
    todos: finalTodos,
    blockers,
    updatedAt,
  }
}

export function isPublishTodo(todo) {
  const title = String((todo && todo.title) || '')
  const id = String((todo && todo.id) || '')
  return Boolean(todo && todo.kind === 'publish') || /finish|publish/i.test(title) || /finish|publish/i.test(id)
}

export function agentPlanOpenTodos(plan) {
  if (!plan || !Array.isArray(plan.todos)) {
    return [{ id: 'agent_plan_missing', title: 'Create execution plan', status: 'pending', kind: 'plan' }]
  }
  return plan.todos.filter((todo) => todo.status !== 'completed' && todo.status !== 'cancelled')
}

export function agentPlanOpenBlockingTodosForFinish(plan) {
  return agentPlanOpenTodos(plan).filter((todo) => !isPublishTodo(todo))
}

export function agentPlanOpenTodosBeforeValidation(plan) {
  return agentPlanOpenTodos(plan).filter((todo) => {
    if (!todo) return false
    if (todo.kind === 'qa' || todo.kind === 'publish' || todo.kind === 'repair') return false
    return true
  })
}

export function agentPlanReadyForFinish(plan) {
  const open = agentPlanOpenTodos(plan)
  return open.length === 0 || open.every((todo) => isPublishTodo(todo))
}

export function completePublishTodosForFinish(plan, options = {}) {
  if (!plan || !Array.isArray(plan.todos)) return plan
  const updatedAt = agentTimestamp(options.timestamp)
  let changed = false
  const todos = plan.todos.map((todo) => {
    if (todo && isPublishTodo(todo) && todo.status !== 'completed' && todo.status !== 'cancelled') {
      changed = true
      const next = {
        ...todo,
        status: 'completed',
        detail: cleanPlanText(todo.detail || options.detail || 'finish requested; final validation and publish handoff are running.', 500),
        updatedAt,
      }
      if (options.evidence && !next.evidence) next.evidence = cleanPlanText(options.evidence, 700)
      return next
    }
    return todo
  })
  if (!changed) return plan
  return {
    ...plan,
    currentTodoId: ((todos.find((todo) => todo.status !== 'completed' && todo.status !== 'cancelled') || {}).id || null),
    todos,
    blockers: [],
    updatedAt,
  }
}

export function createUpdateAgentPlanToolSpec(options = {}) {
  const inspection = options.allowInspectionBeforePlan
    ? ' Required before edits, installs, builds, validation, and finish. A bounded targeted source read/search inspection may happen first when needed; call update_agent_plan immediately after that inspection.'
    : ' First tool call must be update_agent_plan before implementation tools.'
  return defineAgentToolCapability({
    type: 'function',
    function: {
      name: 'update_agent_plan',
      description: 'Create or update the internal execution plan reported to the host progress UI. Never render this plan/todo/status/pending list inside the game UI. Todos should describe player-visible outcomes, implementation milestones, QA gates, or blocking repairs; not routine read/search operations.' + inspection,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'todos'],
        properties: {
          summary: { type: 'string' },
          currentTodoId: { type: 'string' },
          blockers: { type: 'array', maxItems: 6, items: { type: 'string' } },
          todos: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'title', 'status', 'kind'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'] },
                kind: { type: 'string', enum: ['plan', 'asset', 'code', 'sdk', 'qa', 'publish', 'repair'] },
                detail: { type: 'string' },
                evidence: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, {
    prePlan: 'establish',
    effect: 'control',
    parallel: 'serial',
    retry: 'safe',
  })
}

export function estimateAgentTextTokens(text) {
  const value = String(text || '')
  if (!value) return 0
  let ascii = 0
  let nonAscii = 0
  for (const char of value) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.5)
}

function messageTextSize(message) {
  if (!message || typeof message !== 'object') return { chars: 0, tokens: 0 }
  const values = [message.role, message.content, message.reasoning, message.reasoning_content, message.name, message.tool_call_id]
  if (Array.isArray(message.tool_calls)) values.push(JSON.stringify(message.tool_calls))
  if (Array.isArray(message.reasoning_details)) values.push(JSON.stringify(message.reasoning_details))
  if (Array.isArray(message.response_items)) values.push(JSON.stringify(message.response_items))
  if (message.orbit_internal && typeof message.orbit_internal === 'object') values.push(JSON.stringify(message.orbit_internal))
  const text = values.filter((value) => value !== undefined && value !== null).map(String).join('\n')
  return { chars: text.length, tokens: estimateAgentTextTokens(text) }
}

function resolvedContextPolicy(policy = {}) {
  const base = ORBIT_PRO_AGENT_CONTEXT_POLICY
  const effectiveWindowTokens = Math.max(8_000, Number(policy.effectiveWindowTokens || base.effectiveWindowTokens))
  const softTokenRatio = Number(policy.softTokenRatio || base.softTokenRatio)
  const targetTokenRatio = Number(policy.targetTokenRatio || base.targetTokenRatio)
  const hardTokenRatio = Math.max(softTokenRatio, Number(policy.hardTokenRatio || base.hardTokenRatio))
  return {
    effectiveWindowTokens,
    softTokenRatio,
    targetTokenRatio,
    hardTokenRatio,
    softTokens: Math.floor(effectiveWindowTokens * softTokenRatio),
    targetTokens: Math.floor(effectiveWindowTokens * targetTokenRatio),
    hardTokens: Math.floor(effectiveWindowTokens * hardTokenRatio),
    softChars: Math.max(20_000, Number(policy.softChars || base.softChars)),
    targetChars: Math.max(16_000, Number(policy.targetChars || base.targetChars)),
    hardChars: Math.max(24_000, Number(policy.hardChars || base.hardChars)),
    keepRecentMessages: Math.max(6, Number(policy.keepRecentMessages || base.keepRecentMessages)),
    keepRecentUserMessages: Math.max(1, Number(policy.keepRecentUserMessages || base.keepRecentUserMessages)),
    recentUserTokenBudget: Math.max(1_000, Number(policy.recentUserTokenBudget || base.recentUserTokenBudget)),
    compactMessageCount: Math.max(20, Number(policy.compactMessageCount || base.compactMessageCount)),
  }
}

export function agentMessageBudget(messages, policy = {}) {
  const limits = resolvedContextPolicy(policy)
  let approxChars = 0
  let approxTokens = 0
  for (const message of Array.isArray(messages) ? messages : []) {
    const size = messageTextSize(message)
    approxChars += size.chars
    approxTokens += size.tokens
  }
  return { approxChars, approxTokens, messageCount: Array.isArray(messages) ? messages.length : 0, limits }
}

function compactPortableMessage(message, preserveFull) {
  if (!message || preserveFull) return message
  const next = { ...message }
  if (next.role === 'assistant') {
    if (typeof next.reasoning === 'string' && next.reasoning.length > 1200) next.reasoning = '[older reasoning elided]\n' + next.reasoning.slice(-1000)
    if (typeof next.reasoning_content === 'string' && next.reasoning_content.length > 1200) next.reasoning_content = '[older reasoning elided]\n' + next.reasoning_content.slice(-1000)
    if (typeof next.content === 'string' && next.content.length > 4000) next.content = next.content.slice(0, 1000) + '\n[older assistant text elided]\n' + next.content.slice(-2500)
  } else if (next.role === 'tool' && typeof next.content === 'string' && next.content.length > 6000) {
    next.content = '[older tool result compacted; rerun the tool if exact output is needed]\n' + next.content.slice(-5000)
  } else if (next.role === 'user' && typeof next.content === 'string' && next.content.length > 8000) {
    next.content = next.content.slice(0, 1600) + '\n[older user observation compacted]\n' + next.content.slice(-4000)
  }
  if (typeof next.content === 'string') next.content = redactAgentSensitiveText(next.content)
  if (typeof next.reasoning === 'string') next.reasoning = redactAgentSensitiveText(next.reasoning)
  if (typeof next.reasoning_content === 'string') next.reasoning_content = redactAgentSensitiveText(next.reasoning_content)
  return next
}

function conversationBlocks(messages) {
  const blocks = []
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (message && message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const ids = new Set(message.tool_calls.map((call) => call && call.id).filter(Boolean))
      const block = [message]
      let cursor = i + 1
      while (cursor < messages.length && messages[cursor] && messages[cursor].role === 'tool' && ids.has(messages[cursor].tool_call_id)) {
        block.push(messages[cursor])
        cursor += 1
      }
      blocks.push(block)
      i = cursor - 1
    } else {
      blocks.push([message])
    }
  }
  return blocks
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(number)))
}

export function normalizeAgentCapabilityProfile(raw, fallbackProfile = 'local-desktop') {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const requested = typeof raw === 'string'
    ? raw
    : typeof source.executorProfile === 'string'
      ? source.executorProfile
      : fallbackProfile
  const base = ORBIT_AGENT_CAPABILITY_PROFILES[requested]
    || ORBIT_AGENT_CAPABILITY_PROFILES[fallbackProfile]
    || ORBIT_AGENT_CAPABILITY_PROFILES['local-desktop']
  const semanticCompaction = source.semanticCompaction === 'none' || source.semanticCompaction === 'model'
    ? source.semanticCompaction
    : base.semanticCompaction
  const checkpointPersistence = ['none', 'run', 'project'].includes(source.checkpointPersistence)
    ? source.checkpointPersistence
    : base.checkpointPersistence
  const workspaceSnapshot = ['none', 'revision', 'digest'].includes(source.workspaceSnapshot)
    ? source.workspaceSnapshot
    : base.workspaceSnapshot
  const pendingToolRecovery = ['none', 'inspect', 'idempotent'].includes(source.pendingToolRecovery)
    ? source.pendingToolRecovery
    : base.pendingToolRecovery
  return {
    schema: ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA,
    executorProfile: base.executorProfile,
    semanticCompaction,
    checkpointPersistence,
    workspaceSnapshot,
    pendingToolRecovery,
    maxSemanticInputTokens: boundedInteger(source.maxSemanticInputTokens, base.maxSemanticInputTokens, 8_000, 512_000),
    maxSemanticOutputTokens: boundedInteger(source.maxSemanticOutputTokens, base.maxSemanticOutputTokens, 512, 32_000),
  }
}

/**
 * Deterministic last-line protection for text that may become durable memory.
 * This complements provider prompts; it does not try to classify arbitrary
 * high-entropy prose as a secret.
 */
export function redactAgentSensitiveText(value) {
  let text = String(value || '')
  text = text.replace(
    /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
    '[REDACTED_PRIVATE_KEY]',
  )
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_ACCESS_KEY]')
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
  text = text.replace(/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, '[REDACTED_SLACK_TOKEN]')
  text = text.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]')
  text = text.replace(
    /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{10,}\b/g,
    '[REDACTED_JWT]',
  )
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [REDACTED]')
  const sensitiveName = '(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|secret|password|passwd|private[_-]?key|client[_-]?secret|cookie)'
  const environmentSensitiveName = '(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|service[_-]?role[_-]?key|secret[_-]?access[_-]?key|database[_-]?url|private[_-]?key|client[_-]?secret|password|passwd|token|secret)'
  text = text.replace(
    new RegExp('(^|[\\s,{])(["\\\']?)(' + environmentSensitiveName + ')(\\2)(\\s*[:=]\\s*)(["\\\'])([^"\\\'\\r\\n]{8,})(\\6)', 'gim'),
    '$1$2$3$4$5$6[REDACTED]$6',
  )
  text = text.replace(
    new RegExp('(^|[\\s,{])(["\\\']?)(' + environmentSensitiveName + ')(\\2)(\\s*[:=]\\s*)([^"\\\'\\s,;}\\]\\r\\n]{8,})', 'gim'),
    '$1$2$3$4$5[REDACTED]',
  )
  text = text.replace(
    new RegExp('(["\\\']?\\b' + sensitiveName + '\\b["\\\']?\\s*[:=]\\s*)(["\\\'])([^"\\\'\\r\\n]{8,})(\\2)', 'gi'),
    '$1$2[REDACTED]$2',
  )
  text = text.replace(
    new RegExp('(["\\\']?\\b' + sensitiveName + '\\b["\\\']?\\s*[:=]\\s*)([A-Za-z0-9_./+~-]{8,})', 'gi'),
    '$1[REDACTED]',
  )
  return text
}

function isAgentSensitiveKey(key) {
  return /^(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|service[_-]?role[_-]?key|secret[_-]?access[_-]?key|database[_-]?url|private[_-]?key|client[_-]?secret|password|passwd|cookie|token|secret)$/i.test(String(key || ''))
}

export function redactAgentSensitiveValue(value, depth = 0) {
  if (typeof value === 'string') return redactAgentSensitiveText(value)
  if (value == null || typeof value !== 'object') return value
  if (depth >= 8) return '[TRUNCATED_NESTED_VALUE]'
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => redactAgentSensitiveValue(item, depth + 1))
  const output = {}
  for (const [key, item] of Object.entries(value).slice(0, 256)) {
    output[key] = isAgentSensitiveKey(key)
      ? '[REDACTED]'
      : redactAgentSensitiveValue(item, depth + 1)
  }
  return output
}

function cleanCompactionText(value, maximum = 1_200) {
  return redactAgentSensitiveText(value).replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function compactionObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function parseCompactionJson(value) {
  const message = compactionObject(value)
  const content = message && 'content' in message ? message.content : value
  if (compactionObject(content)) return content
  const text = Array.isArray(content)
    ? content.map((part) => compactionObject(part)?.text || '').join('\n').trim()
    : String(content || '').trim()
  if (!text) return null
  const tagged = /<orbit_semantic_summary>\s*([\s\S]*?)\s*<\/orbit_semantic_summary>/i.exec(text)?.[1]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  for (const candidate of [tagged, fenced, text]) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate)
      if (compactionObject(parsed)) return parsed
    } catch {}
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      if (compactionObject(parsed)) return parsed
    } catch {}
  }
  return null
}

function cleanCompactionTextArray(value, maximumItems, maximumText) {
  if (!Array.isArray(value)) return []
  return value.slice(0, maximumItems).map((item) => cleanCompactionText(item, maximumText)).filter(Boolean)
}

function normalizeSummaryObjects(value, maximumItems, normalize) {
  if (!Array.isArray(value)) return []
  const result = []
  for (const item of value.slice(0, maximumItems)) {
    const normalized = normalize(compactionObject(item) || {})
    if (normalized) result.push(normalized)
  }
  return result
}

export function normalizeAgentSemanticSummary(raw) {
  const value = parseCompactionJson(raw)
  if (!value) return null
  if (value.schema && value.schema !== ORBIT_AGENT_SEMANTIC_SUMMARY_SCHEMA) return null
  const objective = cleanCompactionText(value.objective, 2_000)
  const latestUserIntent = cleanCompactionText(value.latestUserIntent || value.latest_user_intent, 2_000)
  const userConstraints = cleanCompactionTextArray(value.userConstraints || value.user_constraints, 16, 600)
  const userCorrections = cleanCompactionTextArray(value.userCorrections || value.user_corrections, 16, 600)
  const decisions = normalizeSummaryObjects(value.decisions, 20, (item) => {
    const summary = cleanCompactionText(item.summary || item.decision, 800)
    return summary ? { summary, sourceRefs: cleanCompactionTextArray(item.sourceRefs || item.source_refs, 12, 160) } : null
  })
  const workspaceChanges = normalizeSummaryObjects(value.workspaceChanges || value.workspace_changes, 32, (item) => {
    const path = cleanCompactionText(item.path, 500)
    const summary = cleanCompactionText(item.summary || item.change, 800)
    return path && summary ? { path, summary } : null
  })
  const validation = normalizeSummaryObjects(value.validation, 20, (item) => {
    const status = ['passed', 'failed', 'unknown'].includes(item.status) ? item.status : 'unknown'
    const summary = cleanCompactionText(item.summary || item.evidence, 1_000)
    return summary ? { status, summary } : null
  })
  const failedApproaches = normalizeSummaryObjects(value.failedApproaches || value.failed_approaches, 16, (item) => {
    const summary = cleanCompactionText(item.summary || item.failure, 800)
    const nextAction = cleanCompactionText(item.nextAction || item.next_action, 800)
    return summary ? { summary, ...(nextAction ? { nextAction } : {}) } : null
  })
  const openWork = cleanCompactionTextArray(value.openWork || value.open_work, 24, 800)
  const sourcesToRefresh = normalizeSummaryObjects(value.sourcesToRefresh || value.sources_to_refresh, 20, (item) => {
    const kind = ['file', 'tool', 'external', 'skill'].includes(item.kind) ? item.kind : 'tool'
    const ref = cleanCompactionText(item.ref || item.source, 500)
    const reason = cleanCompactionText(item.reason, 800)
    return ref && reason ? { kind, ref, reason } : null
  })
  const notes = cleanCompactionTextArray(value.notes, 16, 800)
  if (!objective && !latestUserIntent && !userConstraints.length && !userCorrections.length
    && !decisions.length && !workspaceChanges.length && !validation.length
    && !failedApproaches.length && !openWork.length && !notes.length) return null
  return {
    schema: ORBIT_AGENT_SEMANTIC_SUMMARY_SCHEMA,
    objective,
    latestUserIntent,
    userConstraints,
    userCorrections,
    decisions,
    workspaceChanges,
    validation,
    failedApproaches,
    openWork,
    sourcesToRefresh,
    notes,
  }
}

function isCompactionSummaryMessage(message) {
  if (!message || message.role !== 'user') return false
  if (message[ORBIT_CONTEXT_SUMMARY_MARKER] === true) return true
  const internal = message.orbit_internal
  return Boolean(internal
    && typeof internal === 'object'
    && internal.schema === ORBIT_AGENT_INTERNAL_MESSAGE_SCHEMA
    && internal.type === 'context_summary'
    && Number.isSafeInteger(internal.generation)
    && internal.generation > 0)
}

/** Remove host-only message metadata without changing any provider field. */
export function projectAgentMessagesForProvider(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (!message || typeof message !== 'object' || !Object.prototype.hasOwnProperty.call(message, 'orbit_internal')) {
      return message
    }
    const projected = { ...message }
    delete projected.orbit_internal
    return projected
  })
}

function compactionMessageFingerprint(messages) {
  let hash = 2166136261
  const source = Array.isArray(messages) ? messages : []
  for (const message of source) {
    const values = [message?.role, message?.tool_call_id, message?.content, message?.reasoning, message?.reasoning_content]
    if (Array.isArray(message?.tool_calls)) values.push(JSON.stringify(message.tool_calls))
    if (Array.isArray(message?.reasoning_details)) values.push(JSON.stringify(message.reasoning_details))
    if (Array.isArray(message?.response_items)) values.push(JSON.stringify(message.response_items))
    if (message?.orbit_internal && typeof message.orbit_internal === 'object') values.push(JSON.stringify(message.orbit_internal))
    const text = values.filter((value) => value !== undefined && value !== null).map(String).join('|')
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    hash ^= text.length
    hash = Math.imul(hash, 16777619)
  }
  return source.length + ':' + (hash >>> 0).toString(16)
}

function compactionMessageId(message, index, callback) {
  if (typeof callback === 'function') {
    const value = cleanCompactionText(callback(message, index), 160)
    if (value) return value
  }
  return cleanCompactionText(message && message.id, 160) || 'message-' + (index + 1)
}

function defaultCompactionProjection(message) {
  if (!message || typeof message !== 'object') return null
  const compacted = compactPortableMessage(message, false)
  const projected = { role: compacted.role }
  if (typeof compacted.content === 'string') projected.content = redactAgentSensitiveText(compacted.content)
  else if (compacted.content !== undefined) projected.content = redactAgentSensitiveText(String(compacted.content).slice(0, 8_000))
  if (compacted.tool_call_id) projected.tool_call_id = String(compacted.tool_call_id)
  if (Array.isArray(compacted.tool_calls)) {
    projected.tool_calls = compacted.tool_calls.slice(0, 16).map((call) => ({
      id: call && call.id,
      name: call && call.function && call.function.name,
      arguments: redactAgentSensitiveText(String((call && call.function && call.function.arguments) || '').slice(0, 2_000)),
    }))
  }
  return projected
}

function projectedCompactionMessage(message, index, options) {
  if (typeof options.projectMessage !== 'function') return defaultCompactionProjection(message)
  try {
    const projected = options.projectMessage(message, {
      index,
      sourceRef: compactionMessageId(message, index, options.messageId),
    })
    return projected && typeof projected === 'object' ? projected : null
  } catch {
    return { role: message && message.role, content: '[host projection failed; re-read authoritative source]' }
  }
}

function serializedCompactionSource(message, sourceRef) {
  const projected = defaultCompactionProjection(message)
  if (!projected) return ''
  return '[' + sourceRef + '] ' + JSON.stringify(projected)
}

export function buildAgentSemanticCompactionPrompt(input = {}) {
  const source = Array.isArray(input.messages) ? input.messages : []
  const maximumTokens = boundedInteger(input.maxInputTokens, 96_000, 8_000, 512_000)
  const fixedParts = [
    'Create a faithful working-memory checkpoint for an autonomous coding agent.',
    'Return ONLY one JSON object matching schema "' + ORBIT_AGENT_SEMANTIC_SUMMARY_SCHEMA + '".',
    'Preserve the current objective, latest user intent, hard constraints, later user corrections, decisions, workspace changes, validation evidence, failed approaches, remaining work, and exact sources that must be re-read.',
    'Do not invent success, files, commands, or decisions. Workspace files and fresh tool observations remain authoritative.',
    'Never reproduce secrets, credentials, hidden reasoning, or protected skill text. Mention a protected source only as something to re-read.',
    'Use these keys: schema, objective, latestUserIntent, userConstraints, userCorrections, decisions[{summary,sourceRefs}], workspaceChanges[{path,summary}], validation[{status,summary}], failedApproaches[{summary,nextAction}], openWork, sourcesToRefresh[{kind,ref,reason}], notes.',
    input.previousSummary ? 'Previous semantic checkpoint to update:\n' + JSON.stringify(redactAgentSensitiveValue(input.previousSummary)) : '',
    input.plan ? 'Current execution plan (authoritative for open todo status):\n' + redactAgentSensitiveText(JSON.stringify(input.plan)).slice(0, 8_000) : '',
    ...(Array.isArray(input.durableFacts) ? input.durableFacts.slice(0, 12).map((fact) => 'Pinned host fact: ' + cleanCompactionText(fact, 2_000)) : []),
    'Older messages to summarize, with stable source refs:',
  ].filter(Boolean)
  let usedTokens = estimateAgentTextTokens(fixedParts.join('\n\n'))
  const entries = []
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const entry = serializedCompactionSource(source[index], compactionMessageId(source[index], index, input.messageId))
    if (!entry) continue
    const tokens = estimateAgentTextTokens(entry)
    if (entries.length && usedTokens + tokens > maximumTokens) break
    entries.unshift(entry)
    usedTokens += tokens
  }
  if (entries.length < source.length) entries.unshift('[Older projected messages omitted by the semantic-input budget; preserve the previous checkpoint and mark uncertain exact sources for re-read.]')
  return [...fixedParts, ...entries].join('\n\n')
}

function recentCompactionUserMessages(source, firstUser, limits) {
  const selected = []
  let tokens = 0
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index]
    if (!message || message === firstUser || message.role !== 'user' || isCompactionSummaryMessage(message)) continue
    const size = messageTextSize(message).tokens
    if (selected.length && tokens + size > limits.recentUserTokenBudget) continue
    selected.unshift(message)
    tokens += size
    if (selected.length >= limits.keepRecentUserMessages) break
  }
  return selected
}

export function prepareAgentMessageCompaction(messages, options = {}) {
  const source = Array.isArray(messages) ? messages : []
  assertAgentTranscriptProtocol(source)
  const policy = resolvedContextPolicy(options.policy || {})
  const before = agentMessageBudget(source, policy)
  const needed = before.approxChars > policy.softChars
    || before.approxTokens > policy.softTokens
    || before.messageCount > policy.compactMessageCount
  const capabilityProfile = normalizeAgentCapabilityProfile(options.profile || options.capabilityProfile)
  const base = {
    schema: 'orbit.agent-compaction-preparation.v1',
    needed,
    before,
    policy,
    capabilityProfile,
    sourceRevision: options.sourceRevision ?? null,
    sourceFingerprint: compactionMessageFingerprint(source),
    generation: source.filter(isCompactionSummaryMessage).length + 1,
    hardLimitExceeded: before.approxChars > policy.hardChars || before.approxTokens > policy.hardTokens,
  }
  if (!needed) return { ...base, request: null, canonicalMessages: [], firstUser: null, recentUserMessages: [], tailBlocks: [], droppedMessages: [] }

  const canonicalMessages = source.filter((message) => message && message.role === 'system')
  const firstUser = source.find((message) => message && message.role === 'user' && !isCompactionSummaryMessage(message)) || null
  const fixed = new Set([...canonicalMessages, firstUser].filter(Boolean))
  const previousSummaryMessage = [...source].reverse().find(isCompactionSummaryMessage) || null
  const previousSummary = previousSummaryMessage ? normalizeAgentSemanticSummary(previousSummaryMessage) : null
  const rest = source.filter((message) => !fixed.has(message) && !isCompactionSummaryMessage(message))
  const blocks = conversationBlocks(rest)
  const tailBlocks = []
  let keptMessages = 0
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    tailBlocks.unshift(blocks[index])
    keptMessages += blocks[index].length
    if (keptMessages >= policy.keepRecentMessages) break
  }
  const keptBlocks = new Set(tailBlocks)
  const droppedMessages = blocks.filter((block) => !keptBlocks.has(block)).flat()
  const recentUserMessages = recentCompactionUserMessages(source, firstUser, policy)
  const projected = []
  const projectedRefs = []
  for (const message of droppedMessages) {
    const sourceIndex = source.indexOf(message)
    const value = projectedCompactionMessage(message, sourceIndex, options)
    if (!value) continue
    projected.push(value)
    projectedRefs.push(compactionMessageId(message, sourceIndex, options.messageId))
  }
  const durableFacts = [options.invariant, ...(Array.isArray(options.durableFacts) ? options.durableFacts : [])]
    .map((fact) => cleanCompactionText(fact, 2_000)).filter(Boolean)
  const prompt = buildAgentSemanticCompactionPrompt({
    messages: projected,
    previousSummary,
    plan: options.plan || null,
    durableFacts,
    maxInputTokens: Math.min(capabilityProfile.maxSemanticInputTokens, Math.max(8_000, policy.hardTokens - capabilityProfile.maxSemanticOutputTokens)),
    messageId: (_, index) => projectedRefs[index],
  })
  return {
    ...base,
    request: capabilityProfile.semanticCompaction === 'model'
      ? {
          schema: 'orbit.agent-semantic-compaction-request.v1',
          messages: [{ role: 'user', content: prompt }],
          maxOutputTokens: capabilityProfile.maxSemanticOutputTokens,
        }
      : null,
    canonicalMessages,
    firstUser,
    previousSummary,
    recentUserMessages,
    tailBlocks,
    droppedMessages,
    durableFacts,
    plan: options.plan || null,
    summaryLabel: cleanCompactionText(options.summaryLabel, 1_000),
  }
}

function deterministicAgentSemanticSummary(preparation) {
  const firstUserContent = preparation.firstUser && typeof preparation.firstUser.content === 'string'
    ? preparation.firstUser.content
    : ''
  const latest = preparation.recentUserMessages[preparation.recentUserMessages.length - 1]
  const latestContent = latest && typeof latest.content === 'string' ? latest.content : firstUserContent
  const openWork = preparation.plan
    ? agentPlanOpenTodos(preparation.plan).slice(0, 12).map((todo) => cleanCompactionText(todo.title, 500)).filter(Boolean)
    : []
  return {
    schema: ORBIT_AGENT_SEMANTIC_SUMMARY_SCHEMA,
    objective: cleanCompactionText(firstUserContent, 2_000),
    latestUserIntent: cleanCompactionText(latestContent, 2_000),
    userConstraints: [],
    userCorrections: preparation.recentUserMessages.slice(-6).map((message) => cleanCompactionText(message.content, 600)).filter(Boolean),
    decisions: [],
    workspaceChanges: [],
    validation: [],
    failedApproaches: [],
    openWork,
    sourcesToRefresh: [{ kind: 'tool', ref: 'older-agent-context', reason: 'Deterministic safety compaction cannot preserve exact older tool evidence; re-read authoritative workspace sources.' }],
    notes: ['Semantic compaction was unavailable; this is a bounded deterministic safety checkpoint.'],
  }
}

function compactionSummaryMessage(preparation, summary, options) {
  const parts = [
    options.legacyMarker ? '[Orbit portable context summary]' : '',
    '[Orbit semantic context summary]',
    preparation.summaryLabel || 'Earlier agent context was semantically compacted before the next model call.',
    'generation: ' + preparation.generation,
    'approx_before_tokens: ' + preparation.before.approxTokens,
    'dropped_messages: ' + preparation.droppedMessages.length,
    '<orbit_semantic_summary>\n' + JSON.stringify(summary) + '\n</orbit_semantic_summary>',
    preparation.plan ? 'Current internal execution plan:\n' + redactAgentSensitiveText(JSON.stringify(preparation.plan)).slice(0, 5_000) : '',
    ...(preparation.durableFacts || []).map((fact) => 'Pinned host fact: ' + fact),
    'Workspace files and future tool observations remain authoritative. Re-read exact source or protected skill text when needed.',
  ].filter(Boolean)
  const message = {
    role: 'user',
    content: parts.join('\n\n'),
    orbit_internal: Object.freeze({
      schema: ORBIT_AGENT_INTERNAL_MESSAGE_SCHEMA,
      type: 'context_summary',
      generation: preparation.generation,
    }),
  }
  Object.defineProperty(message, ORBIT_CONTEXT_SUMMARY_MARKER, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  })
  return message
}

function withoutOrphanToolMessages(messages) {
  const ids = new Set()
  for (const message of messages) {
    if (message && message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) if (call && call.id) ids.add(call.id)
    }
  }
  return messages.filter((message) => !message || message.role !== 'tool' || ids.has(message.tool_call_id))
}

function assembleCompactedMessages(preparation, summaryMessage, tailBlocks) {
  const tail = tailBlocks.flat()
  const tailSet = new Set(tail)
  const recent = preparation.recentUserMessages
    .filter((message) => message !== preparation.firstUser && !tailSet.has(message))
    .map((message) => compactPortableMessage(message, false))
  const preserveFrom = Math.max(0, tail.length - 4)
  return withoutOrphanToolMessages([
    ...preparation.canonicalMessages,
    preparation.firstUser,
    summaryMessage,
    ...recent,
    ...tail.map((message, index) => compactPortableMessage(message, index >= preserveFrom)),
  ].filter(Boolean))
}

export function commitAgentMessageCompaction(messages, preparation, rawSemanticSummary, options = {}) {
  const source = Array.isArray(messages) ? messages : []
  assertAgentTranscriptProtocol(source)
  const current = agentMessageBudget(source, preparation && preparation.policy ? preparation.policy : {})
  if (!preparation || preparation.schema !== 'orbit.agent-compaction-preparation.v1' || !preparation.needed) {
    return { compacted: false, reason: 'not_needed', before: preparation?.before || current, after: current }
  }
  const revisionChanged = options.sourceRevision !== undefined
    && preparation.sourceRevision !== null
    && options.sourceRevision !== preparation.sourceRevision
  if (revisionChanged || compactionMessageFingerprint(source) !== preparation.sourceFingerprint) {
    return { compacted: false, reason: 'stale_source', before: preparation.before, after: current }
  }
  let semanticSummary = normalizeAgentSemanticSummary(rawSemanticSummary)
  let mode = 'semantic'
  if (!semanticSummary) {
    const fallbackAllowed = options.allowDeterministicFallback === true
      || preparation.hardLimitExceeded
      || preparation.capabilityProfile.semanticCompaction === 'none'
    if (!fallbackAllowed) {
      return { compacted: false, reason: 'semantic_summary_invalid', before: preparation.before, after: current }
    }
    semanticSummary = deterministicAgentSemanticSummary(preparation)
    mode = 'deterministic'
  }
  const summaryMessage = compactionSummaryMessage(preparation, semanticSummary, options)
  const tailBlocks = preparation.tailBlocks.map((block) => [...block])
  let compacted = assembleCompactedMessages(preparation, summaryMessage, tailBlocks)
  let after = agentMessageBudget(compacted, preparation.policy)
  while ((after.approxChars > preparation.policy.targetChars || after.approxTokens > preparation.policy.targetTokens) && tailBlocks.length > 2) {
    tailBlocks.shift()
    compacted = assembleCompactedMessages(preparation, summaryMessage, tailBlocks)
    after = agentMessageBudget(compacted, preparation.policy)
  }
  source.splice(0, source.length, ...compacted)
  assertAgentTranscriptProtocol(source)
  return {
    compacted: true,
    before: preparation.before,
    after,
    mode,
    generation: preparation.generation,
    semanticSummary,
  }
}

function normalizedCheckpointRecentUsers(value) {
  if (!Array.isArray(value)) return []
  return value.slice(-8).map((item) => {
    const object = compactionObject(item) || {}
    const content = typeof item === 'string' ? cleanCompactionText(item, 8_000) : cleanCompactionText(object.content, 8_000)
    const id = cleanCompactionText(object.id, 160)
    return content ? { ...(id ? { id } : {}), content } : null
  }).filter(Boolean)
}

export function normalizeAgentCheckpoint(raw) {
  const value = compactionObject(raw)
  if (!value || value.schema !== ORBIT_AGENT_CHECKPOINT_SCHEMA || value.version !== 1) return null
  const run = compactionObject(value.run)
  const context = compactionObject(value.context)
  const source = compactionObject(context && context.source) || {}
  const workspace = compactionObject(value.workspace) || {}
  if (!run || !context) return null
  const runId = cleanCompactionText(run.runId, 160)
  const checkpointId = cleanCompactionText(value.checkpointId, 200)
  const createdAt = cleanCompactionText(value.createdAt, 100)
  const coreVersion = cleanCompactionText(value.coreVersion, 160)
  const adapterVersion = cleanCompactionText(value.adapterVersion, 100)
  if (!runId || !checkpointId || !createdAt || !coreVersion || !adapterVersion) return null
  const semanticSummary = context.semanticSummary == null ? null : normalizeAgentSemanticSummary(context.semanticSummary)
  if (context.semanticSummary != null && !semanticSummary) return null
  const workspaceKind = ['none', 'revision', 'digest'].includes(workspace.kind) ? workspace.kind : 'none'
  const pending = compactionObject(value.pendingToolOperation)
  let pendingToolOperation = null
  if (pending) {
    const operationId = cleanCompactionText(pending.operationId, 160)
    const toolName = cleanCompactionText(pending.toolName, 120)
    const phase = ['prepared', 'dispatched', 'result_pending'].includes(pending.phase) ? pending.phase : null
    const recovery = ['inspect', 'retry_idempotent', 'abandon'].includes(pending.recovery) ? pending.recovery : null
    if (!operationId || !toolName || !phase || !recovery) return null
    pendingToolOperation = {
      operationId,
      toolName,
      phase,
      recovery,
      ...(cleanCompactionText(pending.idempotencyKey, 200) ? { idempotencyKey: cleanCompactionText(pending.idempotencyKey, 200) } : {}),
      targetPaths: cleanCompactionTextArray(pending.targetPaths, 32, 500),
    }
  }
  const pendingToolBatch = value.pendingToolBatch == null
    ? null
    : normalizeAgentToolBatchJournal(redactAgentSensitiveValue(value.pendingToolBatch))
  if (value.pendingToolBatch != null && !pendingToolBatch) return null
  const runtime = compactionObject(value.runtime) || {}
  const normalizedPlan = value.plan == null
    ? null
    : normalizeAgentPlan(redactAgentSensitiveValue(value.plan), null, { updatedAt: createdAt })
  return {
    schema: ORBIT_AGENT_CHECKPOINT_SCHEMA,
    version: 1,
    checkpointId,
    createdAt,
    coreVersion,
    adapterVersion,
    capabilityProfile: normalizeAgentCapabilityProfile(value.capabilityProfile),
    runtime: {
      ...(cleanCompactionText(runtime.releaseId, 200) ? { releaseId: cleanCompactionText(runtime.releaseId, 200) } : {}),
      ...(cleanCompactionText(runtime.digest, 200) ? { digest: cleanCompactionText(runtime.digest, 200) } : {}),
    },
    run: {
      runId,
      attemptEpoch: boundedInteger(run.attemptEpoch, 0, 0, 1_000_000),
      compactionGeneration: boundedInteger(run.compactionGeneration, 0, 0, 1_000_000),
    },
    context: {
      semanticSummary,
      source: {
        ...(source.revision !== undefined && source.revision !== null ? { revision: source.revision } : {}),
        ...(cleanCompactionText(source.firstMessageId, 160) ? { firstMessageId: cleanCompactionText(source.firstMessageId, 160) } : {}),
        ...(cleanCompactionText(source.lastMessageId, 160) ? { lastMessageId: cleanCompactionText(source.lastMessageId, 160) } : {}),
        messageCount: boundedInteger(source.messageCount, 0, 0, 1_000_000),
        approxTokens: boundedInteger(source.approxTokens, 0, 0, 10_000_000),
      },
      recentUserMessages: normalizedCheckpointRecentUsers(context.recentUserMessages),
      ...(context.legacyIncomplete === true ? { legacyIncomplete: true } : {}),
    },
    plan: normalizedPlan,
    workspace: {
      kind: workspaceKind,
      ...(cleanCompactionText(workspace.revision, 300) ? { revision: cleanCompactionText(workspace.revision, 300) } : {}),
      ...(cleanCompactionText(workspace.digest, 300) ? { digest: cleanCompactionText(workspace.digest, 300) } : {}),
      ...(workspace.digestComplete === true || workspace.digestComplete === false
        ? { digestComplete: workspace.digestComplete }
        : {}),
      ...(cleanCompactionText(workspace.digestScope, 80) ? { digestScope: cleanCompactionText(workspace.digestScope, 80) } : {}),
      changedPaths: cleanCompactionTextArray(workspace.changedPaths, 128, 500),
    },
    pendingToolOperation,
    pendingToolBatch,
  }
}

export function createAgentCheckpoint(input = {}) {
  const run = compactionObject(input.run) || {}
  const context = compactionObject(input.context) || {}
  const source = compactionObject(context.source) || {}
  const runId = cleanCompactionText(run.runId, 160)
  const generation = boundedInteger(run.compactionGeneration, 0, 0, 1_000_000)
  const raw = {
    schema: ORBIT_AGENT_CHECKPOINT_SCHEMA,
    version: 1,
    checkpointId: input.checkpointId || ('checkpoint-' + (runId || 'run') + '-' + generation),
    createdAt: input.createdAt || new Date().toISOString(),
    coreVersion: input.coreVersion || ORBIT_PRO_AGENT_CORE_VERSION,
    adapterVersion: input.adapterVersion || '0.0.0',
    capabilityProfile: normalizeAgentCapabilityProfile(input.capabilityProfile),
    runtime: input.runtime || {},
    run: { runId, attemptEpoch: run.attemptEpoch || 0, compactionGeneration: generation },
    context: {
      semanticSummary: context.semanticSummary || null,
      source: {
        ...source,
        messageCount: source.messageCount || 0,
        approxTokens: source.approxTokens || 0,
      },
      recentUserMessages: context.recentUserMessages || [],
      legacyIncomplete: context.legacyIncomplete === true,
    },
    plan: input.plan || null,
    workspace: input.workspace || { kind: 'none', changedPaths: [] },
    pendingToolOperation: input.pendingToolOperation || null,
    pendingToolBatch: input.pendingToolBatch || null,
  }
  const normalized = normalizeAgentCheckpoint(raw)
  if (!normalized) throw new TypeError('Agent checkpoint is invalid')
  return normalized
}

/** Backwards-compatible synchronous safety compactor. New hosts should use prepare/commit with a semantic model response. */
export function compactAgentMessagesIfNeeded(messages, options = {}) {
  const preparation = prepareAgentMessageCompaction(messages, options)
  if (!preparation.needed) return { compacted: false, before: preparation.before, after: preparation.before }
  return commitAgentMessageCompaction(messages, preparation, options.semanticSummary || null, {
    sourceRevision: options.sourceRevision,
    allowDeterministicFallback: true,
    legacyMarker: true,
  })
}

const CORE_HELPERS = [
  executionObject,
  executionCount,
  executionKey,
  agentToolSpecName,
  agentToolCalls,
  agentToolCallId,
  cloneAgentToolCall,
  normalizeAgentToolBatchResult,
  renderSurfaceNumber,
  cleanVisualPlanText,
  visualPlanObject,
  parseVisualPlanJson,
  resolvedConversationPolicy,
  conversationTransition,
  validateConversationInput,
  validateConversationRunId,
  pendingConversationInputCount,
  acceptedConversationMessage,
  rejectDuplicateConversationMessage,
  checkConversationAttempt,
  cleanPlanText,
  cleanPlanId,
  agentTimestamp,
  messageTextSize,
  resolvedContextPolicy,
  compactPortableMessage,
  conversationBlocks,
  boundedInteger,
  isAgentSensitiveKey,
  cleanCompactionText,
  compactionObject,
  parseCompactionJson,
  cleanCompactionTextArray,
  normalizeSummaryObjects,
  isCompactionSummaryMessage,
  compactionMessageFingerprint,
  compactionMessageId,
  defaultCompactionProjection,
  projectedCompactionMessage,
  serializedCompactionSource,
  recentCompactionUserMessages,
  deterministicAgentSemanticSummary,
  compactionSummaryMessage,
  withoutOrphanToolMessages,
  assembleCompactedMessages,
  normalizedCheckpointRecentUsers,
]

const CORE_EXPORTS = [
  ['normalizeAgentToolCapability', normalizeAgentToolCapability],
  ['defineAgentToolCapability', defineAgentToolCapability],
  ['createAgentToolCapabilityRegistry', createAgentToolCapabilityRegistry],
  ['getAgentToolCapability', getAgentToolCapability],
  ['evaluateAgentToolPrePlan', evaluateAgentToolPrePlan],
  ['selectAgentToolBatchErrorKey', selectAgentToolBatchErrorKey],
  ['projectAgentMessagesForProvider', projectAgentMessagesForProvider],
  ['createAgentExecutionState', createAgentExecutionState],
  ['transitionAgentExecutionState', transitionAgentExecutionState],
  ['splitAgentToolCallBatch', splitAgentToolCallBatch],
  ['createAgentSyntheticToolResults', createAgentSyntheticToolResults],
  ['normalizeAgentToolBatchJournal', normalizeAgentToolBatchJournal],
  ['createAgentToolBatchJournal', createAgentToolBatchJournal],
  ['recordAgentToolBatchResult', recordAgentToolBatchResult],
  ['deferAgentToolBatchMessage', deferAgentToolBatchMessage],
  ['closeAgentToolBatchJournal', closeAgentToolBatchJournal],
  ['agentTranscriptProtocolIssues', agentTranscriptProtocolIssues],
  ['assertAgentTranscriptProtocol', assertAgentTranscriptProtocol],
  ['renderSurfaceActivityIssues', renderSurfaceActivityIssues],
  ['normalizeOrbitVisualPlan', normalizeOrbitVisualPlan],
  ['parseOrbitVisualPlanAssistant', parseOrbitVisualPlanAssistant],
  ['buildOrbitVisualPlanImagePrompt', buildOrbitVisualPlanImagePrompt],
  ['buildOrbitLoopObjectivePrompt', buildOrbitLoopObjectivePrompt],
  ['createAgentConversationLifecycle', createAgentConversationLifecycle],
  ['submitAgentConversationInput', submitAgentConversationInput],
  ['steerAgentConversationRun', steerAgentConversationRun],
  ['queueAgentConversationInput', queueAgentConversationInput],
  ['drainAgentConversationSafePoint', drainAgentConversationSafePoint],
  ['isAgentConversationAttemptCurrent', isAgentConversationAttemptCurrent],
  ['stopAgentConversationRun', stopAgentConversationRun],
  ['finishAgentConversationRun', finishAgentConversationRun],
  ['startNextQueuedAgentConversationRun', startNextQueuedAgentConversationRun],
  ['resumeAgentConversationQueue', resumeAgentConversationQueue],
  ['normalizeAgentPlan', normalizeAgentPlan],
  ['isPublishTodo', isPublishTodo],
  ['agentPlanOpenTodos', agentPlanOpenTodos],
  ['agentPlanOpenBlockingTodosForFinish', agentPlanOpenBlockingTodosForFinish],
  ['agentPlanOpenTodosBeforeValidation', agentPlanOpenTodosBeforeValidation],
  ['agentPlanReadyForFinish', agentPlanReadyForFinish],
  ['completePublishTodosForFinish', completePublishTodosForFinish],
  ['createUpdateAgentPlanToolSpec', createUpdateAgentPlanToolSpec],
  ['estimateAgentTextTokens', estimateAgentTextTokens],
  ['agentMessageBudget', agentMessageBudget],
  ['redactAgentSensitiveText', redactAgentSensitiveText],
  ['redactAgentSensitiveValue', redactAgentSensitiveValue],
  ['normalizeAgentCapabilityProfile', normalizeAgentCapabilityProfile],
  ['normalizeAgentSemanticSummary', normalizeAgentSemanticSummary],
  ['buildAgentSemanticCompactionPrompt', buildAgentSemanticCompactionPrompt],
  ['prepareAgentMessageCompaction', prepareAgentMessageCompaction],
  ['commitAgentMessageCompaction', commitAgentMessageCompaction],
  ['normalizeAgentCheckpoint', normalizeAgentCheckpoint],
  ['createAgentCheckpoint', createAgentCheckpoint],
  ['compactAgentMessagesIfNeeded', compactAgentMessagesIfNeeded],
]

/** Build the exact ESM module uploaded beside orbit-runner.mjs in E2B. */
export function buildOrbitProAgentCoreModuleSource() {
  const declarations = [
    `const ORBIT_PRO_AGENT_CORE_VERSION = ${JSON.stringify(ORBIT_PRO_AGENT_CORE_VERSION)}`,
    `const ORBIT_AGENT_EXECUTION_POLICY = Object.freeze(${JSON.stringify(ORBIT_AGENT_EXECUTION_POLICY)})`,
    `const ORBIT_AGENT_TOOL_CAPABILITY_SCHEMA = ${JSON.stringify(ORBIT_AGENT_TOOL_CAPABILITY_SCHEMA)}`,
    `const ORBIT_AGENT_TOOL_CAPABILITY = Symbol.for(ORBIT_AGENT_TOOL_CAPABILITY_SCHEMA)`,
    `const ORBIT_AGENT_RENDER_SURFACE_CONTRACT = ${JSON.stringify(ORBIT_AGENT_RENDER_SURFACE_CONTRACT)}`,
    `const ORBIT_AGENT_RENDER_SURFACE_POLICY = Object.freeze(${JSON.stringify(ORBIT_AGENT_RENDER_SURFACE_POLICY)})`,
    `const ORBIT_AGENT_MODEL_OUTPUT_LIMITS = Object.freeze(${JSON.stringify(ORBIT_AGENT_MODEL_OUTPUT_LIMITS)})`,
    `const ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA = ${JSON.stringify(ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA)}`,
    `const ORBIT_AGENT_SEMANTIC_SUMMARY_SCHEMA = ${JSON.stringify(ORBIT_AGENT_SEMANTIC_SUMMARY_SCHEMA)}`,
    `const ORBIT_AGENT_CHECKPOINT_SCHEMA = ${JSON.stringify(ORBIT_AGENT_CHECKPOINT_SCHEMA)}`,
    `const ORBIT_AGENT_INTERNAL_MESSAGE_SCHEMA = ${JSON.stringify(ORBIT_AGENT_INTERNAL_MESSAGE_SCHEMA)}`,
    `const ORBIT_AGENT_TOOL_BATCH_SCHEMA = ${JSON.stringify(ORBIT_AGENT_TOOL_BATCH_SCHEMA)}`,
    `const ORBIT_CONTEXT_SUMMARY_MARKER = Symbol.for('orbit.agent-context-summary.v1')`,
    `const ORBIT_AGENT_CAPABILITY_PROFILES = Object.freeze(${JSON.stringify(ORBIT_AGENT_CAPABILITY_PROFILES)})`,
    `const ORBIT_VISUAL_PLAN_MAX_CANDIDATES = ${JSON.stringify(ORBIT_VISUAL_PLAN_MAX_CANDIDATES)}`,
    `const ORBIT_LOOP_ITERATION_POLICY = Object.freeze(${JSON.stringify(ORBIT_LOOP_ITERATION_POLICY)})`,
    `const ORBIT_PRO_AGENT_CONTEXT_POLICY = Object.freeze(${JSON.stringify(ORBIT_PRO_AGENT_CONTEXT_POLICY)})`,
    `const ORBIT_PRO_AGENT_CONVERSATION_POLICY = Object.freeze(${JSON.stringify(ORBIT_PRO_AGENT_CONVERSATION_POLICY)})`,
    ...CORE_HELPERS.map((fn) => fn.toString()),
    ...CORE_EXPORTS.map(([, fn]) => fn.toString()),
  ]
  const aliases = [
    'ORBIT_PRO_AGENT_CORE_VERSION',
    'ORBIT_AGENT_EXECUTION_POLICY',
    'ORBIT_AGENT_TOOL_CAPABILITY_SCHEMA',
    'ORBIT_AGENT_TOOL_CAPABILITY',
    'ORBIT_AGENT_RENDER_SURFACE_CONTRACT',
    'ORBIT_AGENT_RENDER_SURFACE_POLICY',
    'ORBIT_AGENT_MODEL_OUTPUT_LIMITS',
    'ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA',
    'ORBIT_AGENT_SEMANTIC_SUMMARY_SCHEMA',
    'ORBIT_AGENT_CHECKPOINT_SCHEMA',
    'ORBIT_AGENT_INTERNAL_MESSAGE_SCHEMA',
    'ORBIT_AGENT_TOOL_BATCH_SCHEMA',
    'ORBIT_AGENT_CAPABILITY_PROFILES',
    'ORBIT_VISUAL_PLAN_MAX_CANDIDATES',
    'ORBIT_LOOP_ITERATION_POLICY',
    'ORBIT_PRO_AGENT_CONTEXT_POLICY',
    'ORBIT_PRO_AGENT_CONVERSATION_POLICY',
    ...CORE_EXPORTS.map(([exportName, fn]) => `${fn.name} as ${exportName}`),
  ]
  return `${declarations.join('\n\n')}\n\nexport { ${aliases.join(', ')} }\n`
}
