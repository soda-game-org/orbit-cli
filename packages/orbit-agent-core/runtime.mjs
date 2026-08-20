/**
 * Portable Orbit agent policy shared by CLI, desktop, and cloud hosts.
 *
 * Keep this module free of filesystem, process, network, Worker, Electron, and
 * E2B imports. Those capabilities belong to host adapters.
 */

export const ORBIT_AGENT_CORE_VERSION = 'orbit-agent-core/0.6.0'
/** @deprecated Use ORBIT_AGENT_CORE_VERSION. */
export const ORBIT_PRO_AGENT_CORE_VERSION = ORBIT_AGENT_CORE_VERSION

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

/**
 * Portable Orbit Arcade host/iframe contract. Hosts own transport and UI, but
 * coding agents and validators must agree on these capabilities. Keep
 * target-specific delivery rules in host adapters.
 */
export const ORBIT_ARCADE_SDK_CONTRACT_SCHEMA = 'orbit.arcade-sdk-contract.v1'
export const ORBIT_ARCADE_SDK_CONTRACT = Object.freeze({
  schema: ORBIT_ARCADE_SDK_CONTRACT_SCHEMA,
  lifecycle: Object.freeze({
    start: Object.freeze({ method: 'OrbitArcade.startGame', event: 'orbit:game:start' }),
    end: Object.freeze({ method: 'OrbitArcade.endGame', event: 'orbit:game:end' }),
  }),
  required: Object.freeze([
    'lifecycle',
    'score_and_end_state',
    'replay',
    'pause_and_help',
    'mobile_touch',
    'desktop_keyboard',
    'responsive_resize',
    'leaderboard',
  ]),
  optional: Object.freeze(['coin', 'cade', 'llm_chat', 'multiplayer', 'camera', 'microphone', 'motion']),
  forbiddenDirectCapabilities: Object.freeze([
    'network',
    'websocket',
    'device_permissions',
    'external_navigation',
  ]),
})

export function orbitArcadeSdkContractText(options = {}) {
  const detail = options?.detail === 'compact' ? 'compact' : 'minimal'
  const lines = [
    'Orbit Arcade SDK contract:',
    '- Define/use window.OrbitArcade. Call OrbitArcade.startGame() when active gameplay begins and OrbitArcade.endGame({ outcome, score, scoreLabel }) exactly once when a run ends.',
    '- Provide a visible start path, score/end state, replay, How to Play, pause, mobile touch controls, desktop keyboard parity, and responsive resize behavior.',
    '- Provide OrbitArcade.openLeaderboard(), post orbit:leaderboard:open, and consume orbit:leaderboard:update for the game-over leaderboard flow.',
    '- Preserve the existing SDK and input paths during edits; losing lifecycle, input, pause, replay, or leaderboard is a blocking regression.',
    '- Optional coin, Cade, LLM chat, multiplayer, camera, microphone, and motion features must use the Orbit host bridge, never direct network, socket, permission, or external-navigation APIs.',
  ]
  if (detail === 'compact') {
    lines.push('- Multiplayer public play uses the host matchmaker; device and LLM features require explicit user actions and local failure fallbacks.')
  }
  return lines.join('\n')
}

/** Conservative source-level baseline; runtime hosts may add deeper QA. */
export function orbitArcadeSdkSourceIssues(source) {
  const text = String(source || '')
  const issues = []
  if (!/OrbitArcade\s*\.\s*startGame|orbit:game:start/.test(text)) issues.push('Orbit start lifecycle is missing.')
  if (!/OrbitArcade\s*\.\s*endGame|orbit:game:end/.test(text)) issues.push('Orbit end lifecycle is missing.')
  if (!/openLeaderboard|orbit:leaderboard:open|orbit:leaderboard:update/.test(text)) issues.push('Orbit leaderboard flow is missing.')
  if (!/pointer|touch|click|mousedown|mouseup/i.test(text)) issues.push('Mobile pointer/touch input is missing.')
  if (!/keydown|keyup|KeyboardEvent/.test(text)) issues.push('Desktop keyboard input is missing.')
  return issues
}

/**
 * Store media is a logical delivery contract, not a storage contract. Web
 * adapters may resolve roles to R2 URLs; local adapters resolve them to safe
 * project or artifact paths.
 */
export const ORBIT_AGENT_STORE_MEDIA_SCHEMA = 'orbit.agent-store-media.v1'
export const ORBIT_AGENT_STORE_MEDIA_ROLES = Object.freeze({
  listingCover: Object.freeze({
    role: 'listing_cover',
    aspectRatio: '3:4',
    preferredWidth: 768,
    preferredHeight: 1024,
    requiredForPlayable: false,
  }),
  appIcon: Object.freeze({
    role: 'app_icon',
    aspectRatio: '1:1',
    preferredWidth: 512,
    preferredHeight: 512,
    requiredForPlayable: false,
  }),
})

function normalizeAgentStoreMediaAsset(raw, role) {
  const source = executionObject(raw)
  const state = ['provided', 'generated', 'fallback', 'skipped', 'missing', 'failed'].includes(source.state)
    ? source.state
    : 'missing'
  const value = {
    role,
    state,
    requiredForPlayable: false,
  }
  const location = agentPortableText(source.location, 2_000)
  const mediaType = agentPortableText(source.mediaType || source.media_type, 120)
  const reason = agentPortableText(source.reason, 1_000)
  const digest = agentPortableText(source.digest, 240)
  if (location) value.location = location
  if (mediaType) value.mediaType = mediaType
  if (reason) value.reason = reason
  if (digest) value.digest = digest
  if (Number.isSafeInteger(source.width) && source.width > 0) value.width = source.width
  if (Number.isSafeInteger(source.height) && source.height > 0) value.height = source.height
  return Object.freeze(value)
}

export function normalizeAgentStoreMediaManifest(raw, options = {}) {
  const source = executionObject(raw)
  const assets = executionObject(source.assets)
  return Object.freeze({
    schema: ORBIT_AGENT_STORE_MEDIA_SCHEMA,
    projectId: agentPortableId(source.projectId || source.project_id || options.projectId),
    updatedAt: agentOptionalTimestamp(source.updatedAt || source.updated_at || options.updatedAt),
    assets: Object.freeze({
      listing_cover: normalizeAgentStoreMediaAsset(assets.listing_cover || assets.listingCover, 'listing_cover'),
      app_icon: normalizeAgentStoreMediaAsset(assets.app_icon || assets.appIcon, 'app_icon'),
    }),
  })
}

/**
 * Portable image intent and artifact contracts. Provider selection, model
 * choice, credentials, billing, journals, remote object keys, and materialized
 * bytes remain host concerns and must never be accepted from the Agent.
 */
export const ORBIT_AGENT_IMAGE_SCHEMA = 'orbit.agent-image.v1'
export const ORBIT_AGENT_IMAGE_CAPABILITY_SCHEMA = 'orbit.agent-image-capability.v1'
export const ORBIT_AGENT_IMAGE_KINDS = Object.freeze([
  'sprite',
  'background',
  'tile',
  'ui_icon',
  'cover',
  'texture',
  'other',
])
export const ORBIT_AGENT_IMAGE_ASPECT_RATIOS = Object.freeze(['1:1', '3:4', '4:3', '9:16', '16:9'])

export function normalizeAgentImageCapabilities(raw = {}) {
  const source = executionObject(raw)
  const route = ['managed', 'byok'].includes(source.route) ? source.route : 'none'
  const generate = route !== 'none' && source.generate !== false
  return Object.freeze({
    schema: ORBIT_AGENT_IMAGE_CAPABILITY_SCHEMA,
    route,
    generate,
    backgroundRemoval: generate && source.backgroundRemoval === true,
    controlImage: generate && source.controlImage === true,
    spritesheet: generate && source.spritesheet === true,
    gameMap: generate && source.gameMap === true,
    visionReview: source.visionReview === true,
    localMaterialization: source.localMaterialization === true,
  })
}

/** Decide whether the declared host route can truthfully execute an image intent. */
export function evaluateAgentImageIntent(raw, capabilities = {}) {
  const intent = normalizeAgentImageIntent(raw)
  const profile = normalizeAgentImageCapabilities(capabilities)
  if (!intent) return Object.freeze({ allowed: false, reason: 'invalid_intent', intent: null, capabilities: profile })
  if (!profile.generate) return Object.freeze({ allowed: false, reason: 'image_generation_unavailable', intent, capabilities: profile })
  if (intent.transparentBackground && !profile.backgroundRemoval) {
    return Object.freeze({ allowed: false, reason: 'background_removal_unavailable', intent, capabilities: profile })
  }
  return Object.freeze({ allowed: true, reason: 'available', intent, capabilities: profile })
}

export function normalizeAgentImageIntent(raw, options = {}) {
  const source = executionObject(raw)
  const prompt = agentPortableText(source.prompt, 8_000)
  if (prompt.length < 8) return null
  const outputPath = agentPortableText(source.output_path || source.outputPath || options.outputPath, 512)
  const rawKind = agentPortableText(source.kind || options.kind, 80)
  const kind = ORBIT_AGENT_IMAGE_KINDS.includes(rawKind) ? rawKind : 'other'
  const rawAspectRatio = agentPortableText(source.aspect_ratio || source.aspectRatio || options.aspectRatio, 24)
  const aspectRatio = ORBIT_AGENT_IMAGE_ASPECT_RATIOS.includes(rawAspectRatio) ? rawAspectRatio : undefined
  const width = Number.isSafeInteger(source.width) && source.width >= 256 && source.width <= 8192 ? source.width : undefined
  const height = Number.isSafeInteger(source.height) && source.height >= 256 && source.height <= 8192 ? source.height : undefined
  const value = {
    schema: ORBIT_AGENT_IMAGE_SCHEMA,
    prompt,
    kind,
    transparentBackground: source.transparent_background === true || source.transparentBackground === true,
  }
  if (outputPath) value.outputPath = outputPath
  if (aspectRatio) value.aspectRatio = aspectRatio
  if (width !== undefined) value.width = width
  if (height !== undefined) value.height = height
  return Object.freeze(value)
}

/**
 * Project a host result into the only image fields the Agent may observe.
 * Deliberately ignores provider, model, prediction id, receipt, cost, object
 * key, and raw provider URL fields even if a host accidentally supplies them.
 */
export function projectAgentImageArtifact(raw, options = {}) {
  const source = executionObject(raw)
  const artifactId = agentPortableId(source.artifactId || source.id || options.artifactId)
  const projectPath = agentPortableText(source.projectPath || source.relativePath || options.projectPath, 512)
  const artifactRef = agentPortableText(source.artifactRef || options.artifactRef, 2_000)
  if (!artifactId && !projectPath && !artifactRef) return null
  const value = {
    schema: ORBIT_AGENT_IMAGE_SCHEMA,
    artifactId: artifactId || agentFallbackId('image-artifact', `${projectPath}\0${artifactRef}`),
    mediaType: agentPortableText(source.mediaType || source.contentType || source.content_type || options.mediaType, 120) || 'image/png',
  }
  if (projectPath) value.projectPath = projectPath
  if (artifactRef) value.artifactRef = artifactRef
  const digest = agentPortableText(source.sha256 || source.digest, 240)
  if (/^[a-f0-9]{64}$/.test(digest)) value.sha256 = digest
  for (const key of ['width', 'height', 'bytes']) {
    if (Number.isSafeInteger(source[key]) && source[key] >= 0) value[key] = source[key]
  }
  if (source.transparentBackground === true || source.transparent_background === true) value.transparentBackground = true
  if (source.backgroundRemovalFailed === true || source.background_removal_failed === true) value.backgroundRemovalFailed = true
  if (source.recovered === true) value.recovered = true
  if (source.reused === true) value.reused = true
  return Object.freeze(value)
}

/** Build the canonical single-image tool spec for a declared host capability. */
export function createGenerateImageToolSpec(options = {}) {
  const destination = options.destination === 'host' ? 'host' : 'workspace'
  const properties = {
    prompt: { type: 'string', minLength: 8, maxLength: 8_000 },
    kind: { type: 'string', enum: [...ORBIT_AGENT_IMAGE_KINDS] },
    aspect_ratio: { type: 'string', enum: [...ORBIT_AGENT_IMAGE_ASPECT_RATIOS] },
  }
  if (options.dimensions !== false) {
    properties.width = { type: 'integer', minimum: 256, maximum: 8_192 }
    properties.height = { type: 'integer', minimum: 256, maximum: 8_192 }
  }
  if (options.backgroundRemoval === true) {
    properties.transparent_background = {
      type: 'boolean',
      description: 'Per-asset request for real alpha transparency. Use true for composited sprites/icons and false for full-bleed backgrounds. Never emulate transparency with CSS or chroma keying.',
    }
  }
  if (destination === 'workspace') {
    properties.output_path = { type: 'string', description: 'Safe workspace-relative PNG destination chosen for this asset.' }
  }
  return defineAgentToolCapability({
    type: 'function',
    function: {
      name: 'generate_image',
      description: agentPortableText(options.description, 4_000) || 'Generate one original game image only when it materially improves active play. The host owns provider, model, credentials, billing, retry, and storage policy. If requested transparency fails, treat the result as opaque or regenerate; never fake alpha in CSS/canvas.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: destination === 'workspace' ? ['prompt', 'output_path'] : ['prompt'],
        properties,
      },
    },
  }, {
    effect: 'execute',
    parallel: 'serial',
    retry: 'unsafe',
  })
}

/** Build the shared 6x5 character-spritesheet intent contract. */
export function createGenerateSpritesheetToolSpec(options = {}) {
  const destination = options.destination === 'host' ? 'host' : 'workspace'
  const properties = {
    character_description: { type: 'string', minLength: 8, maxLength: 2_000 },
    character_role: { type: 'string', minLength: 2, maxLength: 240 },
    world_visual_context: { type: 'string', maxLength: 2_000 },
    style: { type: 'string', maxLength: 500 },
    projection: { type: 'string', enum: ['top_down', 'side_view'] },
    action_kind: { type: 'string', maxLength: 160 },
    action_description: { type: 'string', maxLength: 500 },
  }
  if (destination === 'workspace') {
    properties.output_path = { type: 'string', description: 'Safe workspace-relative PNG destination for the 6x5 sheet.' }
  }
  return defineAgentToolCapability({
    type: 'function',
    function: {
      name: 'generate_spritesheet',
      description: agentPortableText(options.description, 4_000) || 'Generate one original 6x5 character spritesheet with real alpha. Use top_down for multi-facing movement or side_view for platformer movement. The host owns provider, billing, background removal, validation, and materialization.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: destination === 'workspace'
          ? ['character_description', 'character_role', 'output_path']
          : ['character_description', 'character_role'],
        properties,
      },
    },
  }, { effect: 'execute', parallel: 'serial', retry: 'unsafe' })
}

/** Build the shared illustrated 2D game-map intent contract. */
export function createGenerateGameMapToolSpec(options = {}) {
  const destination = options.destination === 'host' ? 'host' : 'workspace'
  const namedArea = {
    type: 'object', additionalProperties: false, required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 120 },
      name: { type: 'string', maxLength: 240 },
      description: { type: 'string', maxLength: 1_000 },
    },
  }
  const properties = {
    description: { type: 'string', minLength: 8, maxLength: 4_000 },
    style: { type: 'string', maxLength: 500 },
    projection: { type: 'string', enum: ['top_down', 'side_view'] },
    regions: { type: 'array', maxItems: 12, items: namedArea },
    elements: { type: 'array', maxItems: 16, items: namedArea },
    pseudo_3d: { type: 'boolean' },
    width: { type: 'integer', minimum: 512, maximum: 1_024 },
    height: { type: 'integer', minimum: 512, maximum: 1_024 },
  }
  if (destination === 'workspace') {
    properties.output_path = { type: 'string', description: 'Safe workspace-relative PNG destination for the map background.' }
  }
  return defineAgentToolCapability({
    type: 'function',
    function: {
      name: 'generate_game_map',
      description: agentPortableText(options.description, 4_000) || 'Generate one original illustrated 2D game map or level background without characters. Use top_down for RPG/arena maps and side_view for platformer levels. The host owns provider, billing, validation, and materialization.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: destination === 'workspace' ? ['description', 'output_path'] : ['description'],
        properties,
      },
    },
  }, { effect: 'execute', parallel: 'serial', retry: 'unsafe' })
}

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

export const ORBIT_AGENT_PROJECT_SCHEMA = 'orbit.agent-project.v1'
export const ORBIT_AGENT_THREAD_SCHEMA = 'orbit.agent-thread.v1'
export const ORBIT_AGENT_TURN_SCHEMA = 'orbit.agent-turn.v1'
export const ORBIT_AGENT_INPUT_ITEM_SCHEMA = 'orbit.agent-input-item.v1'
export const ORBIT_AGENT_MEDIA_OBSERVATION_SCHEMA = 'orbit.agent-media-observation.v1'
export const ORBIT_AGENT_MEDIA_CACHE_SCHEMA = 'orbit.agent-media-cache.v1'
export const ORBIT_AGENT_PROVIDER_CAPABILITY_SCHEMA = 'orbit.agent-provider-capability.v1'
export const ORBIT_AGENT_INPUT_PROJECTION_SCHEMA = 'orbit.agent-input-projection.v1'

function agentPortableText(value, maximum = 32_000) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

function agentPortableId(value, fallback = '') {
  return agentPortableText(value, 240) || fallback
}

function agentStableHash(value) {
  let source = ''
  try {
    source = typeof value === 'string' ? value : (JSON.stringify(value ?? null) || String(value ?? ''))
  } catch {
    source = Object.prototype.toString.call(value)
  }
  let hash = 2166136261
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function agentFallbackId(prefix, value, index = 0) {
  return `${prefix}-${Math.max(1, executionCount(index) + 1)}-${agentStableHash(value)}`
}

function agentPortableMetadata(value) {
  const source = executionObject(value)
  const output = {}
  for (const [key, entry] of Object.entries(source).slice(0, 64)) {
    const name = agentPortableText(key, 120)
    if (!name || entry === undefined || typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') continue
    try {
      output[name] = JSON.parse(JSON.stringify(entry))
    } catch {}
  }
  return output
}

function agentOptionalTimestamp(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : undefined
}

function agentOptionalPositiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

function agentMediaKind(value, fallback = 'other') {
  return ['image', 'document', 'audio', 'video', 'archive', 'other'].includes(value) ? value : fallback
}

function agentInputItemType(value) {
  if (value === 'local_image' || value === 'local-image') return 'localImage'
  if (value === 'reference') return 'ref'
  if (['text', 'image', 'localImage', 'attachment', 'ref'].includes(value)) return value
  if (value === 'input_text') return 'text'
  if (value === 'image_url' || value === 'input_image') return 'image'
  return ''
}

function agentImageUrl(source) {
  if (typeof source.url === 'string') return source.url.trim()
  if (typeof source.image_url === 'string') return source.image_url.trim()
  if (typeof source.image_url?.url === 'string') return source.image_url.url.trim()
  if (typeof source.source?.url === 'string') return source.source.url.trim()
  if (typeof source.source?.value === 'string' && ['url', 'data_url'].includes(source.source.type)) return source.source.value.trim()
  return ''
}

function agentPrivateNetworkHostname(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!value || value === 'localhost' || value.endsWith('.localhost') || value === '::' || value === '::1' || value.startsWith('::ffff:')) return true
  const embeddedIpv4 = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)?.[1]
  if (embeddedIpv4 && embeddedIpv4 !== value && agentPrivateNetworkHostname(embeddedIpv4)) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number)
    if (octets.some((part) => part > 255)) return true
    if (octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224) return true
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true
    if (octets[0] === 169 && octets[1] === 254) return true
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true
    if (octets[0] === 192 && octets[1] === 0 && [0, 2].includes(octets[2])) return true
    if (octets[0] === 192 && octets[1] === 88 && octets[2] === 99) return true
    if (octets[0] === 192 && octets[1] === 168) return true
    if (octets[0] === 198 && [18, 19].includes(octets[1])) return true
    if (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) return true
    if (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) return true
  }
  return value.startsWith('fc') || value.startsWith('fd')
    || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
    || value.startsWith('ff') || value.startsWith('2001:db8')
}

function agentSafeImageUrl(value) {
  const source = typeof value === 'string' ? value.trim() : ''
  if (!source) return ''
  if (source.startsWith('data:')) {
    if (source.length > 12 * 1024 * 1024) return ''
    return /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z0-9+/=\r\n]+$/i.test(source) ? source : ''
  }
  if (source.length > 8_192) return ''
  try {
    const url = new URL(source)
    if (url.protocol !== 'https:' || url.username || url.password || agentPrivateNetworkHostname(url.hostname)) return ''
    return url.href
  } catch {
    return ''
  }
}

function agentSafeInlineImageUrl(value) {
  const url = agentSafeImageUrl(value)
  return url.startsWith('data:image/') ? url : ''
}

function agentLocalImagePath(source) {
  if (typeof source.path === 'string') return source.path.trim()
  if (typeof source.localPath === 'string') return source.localPath.trim()
  if (typeof source.local_path === 'string') return source.local_path.trim()
  if (typeof source.source?.path === 'string') return source.source.path.trim()
  if (typeof source.source?.value === 'string' && source.source.type === 'local_path') return source.source.value.trim()
  return ''
}

/** Normalize one portable turn input without reading files or fetching URLs. */
export function normalizeAgentInputItem(raw, options = {}) {
  const input = typeof raw === 'string' ? { type: 'text', text: raw } : executionObject(raw)
  const type = agentInputItemType(input.type || (typeof input.text === 'string' ? 'text' : ''))
  if (!type) return null
  const index = executionCount(options.index)
  const fallbackId = agentPortableId(options.fallbackId)
    || agentFallbackId('input', input, index)
  const id = agentPortableId(input.id || input.itemId || input.item_id, fallbackId)
  const base = {
    schema: ORBIT_AGENT_INPUT_ITEM_SCHEMA,
    id,
    type,
    ...(agentOptionalTimestamp(input.createdAt || input.created_at) ? { createdAt: agentOptionalTimestamp(input.createdAt || input.created_at) } : {}),
    ...(Object.keys(agentPortableMetadata(input.metadata)).length ? { metadata: agentPortableMetadata(input.metadata) } : {}),
  }

  if (type === 'text') {
    const text = typeof input.text === 'string'
      ? input.text
      : typeof input.content === 'string'
        ? input.content
        : ''
    if (!text.trim()) return null
    return { ...base, type: 'text', text }
  }

  const mediaId = agentPortableId(input.mediaId || input.media_id)
  const attachmentId = agentPortableId(input.attachmentId || input.attachment_id)
  const mediaType = agentPortableText(input.mediaType || input.media_type || input.mimeType || input.mime_type, 240)
  const detail = ['auto', 'low', 'high'].includes(input.detail) ? input.detail : undefined

  if (type === 'image') {
    // Canonical `image` inputs are portable inline data URLs. A remote Web
    // asset is an attachment whose host-validated URL belongs in MediaCache.
    const url = agentSafeInlineImageUrl(agentImageUrl(input))
    if (!url) return null
    return {
      ...base,
      type: 'image',
      url,
      ...(mediaId ? { mediaId } : {}),
      ...(attachmentId ? { attachmentId } : {}),
      ...(mediaType ? { mediaType } : {}),
      ...(detail ? { detail } : {}),
    }
  }

  if (type === 'localImage') {
    const path = agentLocalImagePath(input)
    if (!path) return null
    return {
      ...base,
      type: 'localImage',
      path: path.slice(0, 8_192),
      mediaId: mediaId || id,
      ...(attachmentId ? { attachmentId } : {}),
      ...(mediaType ? { mediaType } : {}),
      ...(detail ? { detail } : {}),
    }
  }

  if (type === 'attachment') {
    const source = executionObject(input.attachment)
    const normalizedAttachmentId = agentPortableId(
      source.id || source.attachmentId || source.attachment_id || attachmentId || input.ref,
      id,
    )
    const kind = agentMediaKind(source.kind || input.kind, mediaType.startsWith('image/') ? 'image' : 'other')
    const name = agentPortableText(source.name || input.name || input.filename, 500)
    const normalizedMediaType = agentPortableText(source.mediaType || source.media_type || source.mimeType || source.mime_type || mediaType, 240)
    const sizeBytes = agentOptionalPositiveInteger(source.sizeBytes ?? source.size_bytes ?? input.sizeBytes ?? input.size_bytes)
    const digest = agentPortableText(source.digest || input.digest, 300)
    const sourceRef = agentPortableText(source.sourceRef || source.source_ref || input.sourceRef || input.source_ref || input.path || input.url, 8_192)
    const observationId = agentPortableId(input.observationId || input.observation_id)
    return {
      ...base,
      type: 'attachment',
      attachment: {
        id: normalizedAttachmentId,
        kind,
        ...(name ? { name } : {}),
        ...(normalizedMediaType ? { mediaType: normalizedMediaType } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(digest ? { digest } : {}),
        ...(sourceRef ? { sourceRef } : {}),
      },
      ...(observationId ? { observationId } : {}),
    }
  }

  const source = executionObject(input.ref || input.reference)
  const targetId = agentPortableId(
    source.targetId || source.target_id || source.attachmentId || source.attachment_id
      || input.targetId || input.target_id || attachmentId || input.mediaId || input.media_id,
  )
  if (!targetId) return null
  const kind = ['attachment', 'media', 'turn', 'project', 'external'].includes(source.kind || input.kind)
    ? (source.kind || input.kind)
    : (attachmentId || source.attachmentId || source.attachment_id ? 'attachment' : 'external')
  const refId = agentPortableId(source.id || input.refId || input.ref_id, id)
  const label = agentPortableText(source.label || input.label || input.name, 500)
  const observationId = agentPortableId(input.observationId || input.observation_id)
  return {
    ...base,
    type: 'ref',
    ref: { id: refId, kind, targetId, ...(label ? { label } : {}) },
    ...(observationId ? { observationId } : {}),
  }
}

export function normalizeAgentInputItems(raw, options = {}) {
  const source = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  const items = []
  const ids = new Set()
  for (const [index, value] of source.entries()) {
    const item = normalizeAgentInputItem(value, { ...options, index })
    if (!item) continue
    let id = item.id
    let suffix = 2
    while (ids.has(id)) id = `${item.id}-${suffix++}`.slice(0, 240)
    ids.add(id)
    items.push(id === item.id ? item : { ...item, id })
  }
  return items
}

function normalizeAgentMediaFact(raw, index) {
  const source = typeof raw === 'string' ? { text: raw } : executionObject(raw)
  const text = agentPortableText(source.text || source.value || source.summary, 2_000)
  if (!text) return null
  const id = agentPortableId(source.id, agentFallbackId('fact', source, index))
  const label = agentPortableText(source.label || source.kind, 160)
  const confidenceNumber = Number(source.confidence)
  const confidence = Number.isFinite(confidenceNumber)
    ? Math.max(0, Math.min(1, confidenceNumber))
    : undefined
  const sourceRef = agentPortableText(source.sourceRef || source.source_ref || source.location, 500)
  return {
    id,
    text,
    ...(label ? { label } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(sourceRef ? { sourceRef } : {}),
  }
}

/** Normalize a bounded semantic observation for one attachment or media item. */
export function normalizeAgentMediaObservation(raw, options = {}) {
  const source = typeof raw === 'string' ? { summary: raw } : executionObject(raw)
  const attachmentId = agentPortableId(source.attachmentId || source.attachment_id || options.attachmentId)
  const mediaId = agentPortableId(source.mediaId || source.media_id || options.mediaId)
  if (!attachmentId && !mediaId) return null
  const id = agentPortableId(
    source.id || source.observationId || source.observation_id,
    agentFallbackId('observation', { attachmentId, mediaId }, 0),
  )
  const rawStatus = source.status
  const status = ['ready', 'partial', 'unavailable', 'failed'].includes(rawStatus)
    ? rawStatus
    : (source.summary || source.facts ? 'ready' : 'unavailable')
  const summary = agentPortableText(source.summary || source.description, 16_000)
  const facts = (Array.isArray(source.facts) ? source.facts : [])
    .slice(0, 64)
    .map(normalizeAgentMediaFact)
    .filter(Boolean)
  const kind = agentMediaKind(source.kind, 'other')
  const mediaType = agentPortableText(source.mediaType || source.media_type || source.mimeType || source.mime_type, 240)
  const digest = agentPortableText(source.digest, 300)
  const createdAt = agentOptionalTimestamp(source.createdAt || source.created_at)
  return {
    schema: ORBIT_AGENT_MEDIA_OBSERVATION_SCHEMA,
    id,
    ...(attachmentId ? { attachmentId } : {}),
    ...(mediaId ? { mediaId } : {}),
    kind,
    status,
    summary,
    facts,
    ...(mediaType ? { mediaType } : {}),
    ...(digest ? { digest } : {}),
    ...(createdAt ? { createdAt } : {}),
  }
}

function normalizeAgentMediaCacheEntry(raw, fallbackKey = '') {
  const source = executionObject(raw)
  const mediaId = agentPortableId(source.mediaId || source.media_id)
  const attachmentId = agentPortableId(source.attachmentId || source.attachment_id)
  const sourceItemId = agentPortableId(source.sourceItemId || source.source_item_id)
  const key = agentPortableId(source.key, fallbackKey || mediaId || attachmentId || sourceItemId)
  if (!key || (!mediaId && !attachmentId && !sourceItemId)) return null
  const rawResolved = executionObject(source.resolved)
  let resolvedType = rawResolved.type
  let resolvedValue = typeof rawResolved.value === 'string' ? rawResolved.value.trim() : ''
  if (!resolvedValue && typeof source.url === 'string') {
    resolvedValue = source.url.trim()
    resolvedType = resolvedValue.startsWith('data:') ? 'data_url' : 'url'
  } else if (!resolvedValue && typeof source.dataUrl === 'string') {
    resolvedValue = source.dataUrl.trim()
    resolvedType = 'data_url'
  } else if (!resolvedValue && typeof source.providerFileId === 'string') {
    resolvedValue = source.providerFileId.trim()
    resolvedType = 'provider_file'
  } else if (!resolvedValue && typeof source.hostRef === 'string') {
    resolvedValue = source.hostRef.trim()
    resolvedType = 'host_ref'
  }
  const resolved = resolvedValue && ['url', 'data_url', 'provider_file', 'host_ref'].includes(resolvedType)
    ? ['url', 'data_url'].includes(resolvedType)
      ? (agentSafeImageUrl(resolvedValue) ? { type: resolvedType, value: agentSafeImageUrl(resolvedValue) } : null)
      : { type: resolvedType, value: resolvedValue.slice(0, 8_192) }
    : null
  let status = ['ready', 'missing', 'failed'].includes(source.status)
    ? source.status
    : (resolved ? 'ready' : 'missing')
  if (status === 'ready' && !resolved) status = 'failed'
  const observationId = agentPortableId(source.observationId || source.observation_id)
  const mediaType = agentPortableText(source.mediaType || source.media_type || source.mimeType || source.mime_type, 240)
  const digest = agentPortableText(source.digest, 300)
  const updatedAt = agentOptionalTimestamp(source.updatedAt || source.updated_at)
  return {
    key,
    ...(mediaId ? { mediaId } : {}),
    ...(attachmentId ? { attachmentId } : {}),
    ...(sourceItemId ? { sourceItemId } : {}),
    status,
    resolved,
    ...(observationId ? { observationId } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(digest ? { digest } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

export function normalizeAgentMediaCache(raw) {
  const source = Array.isArray(raw) ? { entries: raw } : executionObject(raw)
  const rawEntries = Array.isArray(source.entries)
    ? source.entries.map((entry) => [null, entry])
    : Object.entries(executionObject(source.entries))
  const entries = []
  const keys = new Set()
  for (const [fallbackKey, value] of rawEntries.slice(0, 2_000)) {
    const entry = normalizeAgentMediaCacheEntry(value, fallbackKey || '')
    if (!entry || keys.has(entry.key)) continue
    keys.add(entry.key)
    entries.push(entry)
  }
  return { schema: ORBIT_AGENT_MEDIA_CACHE_SCHEMA, entries }
}

export function normalizeAgentProject(raw) {
  const source = executionObject(raw)
  const id = agentPortableId(source.id || source.projectId || source.project_id)
  if (!id) return null
  const name = agentPortableText(source.name || source.title, 500)
  const rootRef = agentPortableText(source.rootRef || source.root_ref || source.workspaceRef || source.workspace_ref || source.rootUri || source.root_uri, 8_192)
  const createdAt = agentOptionalTimestamp(source.createdAt || source.created_at)
  const updatedAt = agentOptionalTimestamp(source.updatedAt || source.updated_at)
  const threadIds = [...new Set((Array.isArray(source.threadIds || source.thread_ids) ? (source.threadIds || source.thread_ids) : [])
    .map((value) => agentPortableId(value)).filter(Boolean))].slice(0, 10_000)
  const metadata = agentPortableMetadata(source.metadata)
  return {
    schema: ORBIT_AGENT_PROJECT_SCHEMA,
    id,
    ...(name ? { name } : {}),
    ...(rootRef ? { rootRef } : {}),
    threadIds,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  }
}

export function normalizeAgentTurn(raw, options = {}) {
  const source = executionObject(raw)
  const threadId = agentPortableId(source.threadId || source.thread_id || source.sessionId || source.session_id || options.threadId)
  const id = agentPortableId(source.id || source.turnId || source.turn_id)
  if (!id) return null
  const inputSource = source.inputItems ?? source.input_items ?? source.input ?? source.items
    ?? (typeof source.content === 'string' ? [{ type: 'text', text: source.content }] : [])
  const legacyAttachments = Array.isArray(source.attachments) ? source.attachments.map((attachment) => ({ type: 'attachment', attachment })) : []
  const inputItems = normalizeAgentInputItems([
    ...(Array.isArray(inputSource) ? inputSource : inputSource === undefined || inputSource === null ? [] : [inputSource]),
    ...legacyAttachments,
  ])
  const outputSource = source.outputMessages || source.output_messages || source.output || source.messages
  const outputMessages = (Array.isArray(outputSource) ? outputSource : [])
    .filter((message) => message && typeof message === 'object' && !Array.isArray(message))
    .map((message) => ({ ...message }))
  const state = ['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'interrupted'].includes(source.state || source.status)
    ? (source.state || source.status)
    : 'pending'
  const sequence = agentOptionalPositiveInteger(source.sequence ?? source.index)
  const createdAt = agentOptionalTimestamp(source.createdAt || source.created_at)
  const completedAt = agentOptionalTimestamp(source.completedAt || source.completed_at)
  const metadata = agentPortableMetadata(source.metadata)
  return {
    schema: ORBIT_AGENT_TURN_SCHEMA,
    id,
    ...(threadId ? { threadId } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    state,
    inputItems,
    outputMessages,
    ...(createdAt ? { createdAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  }
}

export function normalizeAgentThread(raw) {
  const source = executionObject(raw)
  const id = agentPortableId(source.id || source.threadId || source.thread_id || source.sessionId || source.session_id)
  if (!id) return null
  const projectId = agentPortableId(source.projectId || source.project_id)
  const title = agentPortableText(source.title || source.name, 500)
  const turns = (Array.isArray(source.turns) ? source.turns : [])
    .slice(0, 100_000)
    .map((turn) => normalizeAgentTurn(turn, { threadId: id }))
    .filter(Boolean)
  const createdAt = agentOptionalTimestamp(source.createdAt || source.created_at)
  const updatedAt = agentOptionalTimestamp(source.updatedAt || source.updated_at)
  const metadata = agentPortableMetadata(source.metadata)
  return {
    schema: ORBIT_AGENT_THREAD_SCHEMA,
    id,
    ...(projectId ? { projectId } : {}),
    ...(title ? { title } : {}),
    turns,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  }
}

/** Session is a compatibility name for the canonical Thread entity. */
export function normalizeAgentSession(raw) {
  return normalizeAgentThread(raw)
}

export function normalizeAgentProviderCapabilities(raw = {}) {
  const source = executionObject(raw)
  const vision = source.vision === true || source.supportsVision === true || source.supports_vision === true
  const requestedInputs = Array.isArray(source.imageInputs || source.image_inputs)
    ? (source.imageInputs || source.image_inputs)
    : typeof source.imageInput === 'string'
      ? [source.imageInput]
      : []
  const imageInputs = [...new Set(requestedInputs.filter((value) => ['url', 'data_url', 'provider_file', 'host_ref'].includes(value)))]
  return {
    schema: ORBIT_AGENT_PROVIDER_CAPABILITY_SCHEMA,
    vision,
    imageInputs: vision ? imageInputs : [],
    nativeAttachments: source.nativeAttachments === true || source.native_attachments === true,
    maxImagesPerTurn: Math.max(0, Math.min(1_000, agentOptionalPositiveInteger(source.maxImagesPerTurn ?? source.max_images_per_turn) ?? (vision ? 32 : 0))),
  }
}

function agentObservationIndexes(raw) {
  const values = Array.isArray(raw) ? raw : Array.isArray(raw?.observations) ? raw.observations : []
  const byId = new Map()
  const byAttachment = new Map()
  const byMedia = new Map()
  for (const value of values.slice(0, 10_000)) {
    const observation = normalizeAgentMediaObservation(value)
    if (!observation) continue
    byId.set(observation.id, observation)
    if (observation.attachmentId && !byAttachment.has(observation.attachmentId)) byAttachment.set(observation.attachmentId, observation)
    if (observation.mediaId && !byMedia.has(observation.mediaId)) byMedia.set(observation.mediaId, observation)
  }
  return { byId, byAttachment, byMedia }
}

function agentCacheIndexes(raw) {
  const cache = normalizeAgentMediaCache(raw)
  const byItem = new Map()
  const byAttachment = new Map()
  const byMedia = new Map()
  const append = (index, key, entry) => {
    if (!key) return
    const entries = index.get(key) || []
    entries.push(entry)
    index.set(key, entries)
  }
  for (const entry of cache.entries) {
    append(byItem, entry.sourceItemId, entry)
    append(byAttachment, entry.attachmentId, entry)
    append(byMedia, entry.mediaId, entry)
  }
  return { cache, byItem, byAttachment, byMedia }
}

function agentInputIdentity(item) {
  if (item.type === 'attachment') return { attachmentId: item.attachment.id, mediaId: '', refId: '' }
  if (item.type === 'ref') {
    return {
      attachmentId: item.ref.kind === 'attachment' ? item.ref.targetId : '',
      mediaId: item.ref.kind === 'media' ? item.ref.targetId : '',
      refId: item.ref.id,
    }
  }
  return { attachmentId: item.attachmentId || '', mediaId: item.mediaId || item.id, refId: '' }
}

function agentCacheEntriesForItem(item, identity, cacheIndexes) {
  const entries = [
    ...(cacheIndexes.byItem.get(item.id) || []),
    ...(identity.attachmentId ? cacheIndexes.byAttachment.get(identity.attachmentId) || [] : []),
    ...(identity.mediaId ? cacheIndexes.byMedia.get(identity.mediaId) || [] : []),
  ]
  const seen = new Set()
  return entries.filter((entry) => {
    if (!entry || seen.has(entry.key)) return false
    seen.add(entry.key)
    return true
  })
}

function agentCacheEntryForItem(item, identity, cacheIndexes) {
  return agentCacheEntriesForItem(item, identity, cacheIndexes)[0] || null
}

function agentResolvedMedia(item, identity, cacheIndexes, capabilities) {
  if (item.type === 'image') {
    return { type: item.url.startsWith('data:') ? 'data_url' : 'url', value: item.url }
  }
  const ready = agentCacheEntriesForItem(item, identity, cacheIndexes)
    .filter((entry) => entry.status === 'ready' && entry.resolved)
  const supported = ready.find((entry) => capabilities.imageInputs.includes(entry.resolved.type))
  return (supported || ready[0])?.resolved || null
}

function agentObservationForItem(item, identity, observationIndexes, cacheIndexes) {
  const explicitId = agentPortableId(item.observationId)
  const cacheObservation = agentCacheEntriesForItem(item, identity, cacheIndexes)
    .map((entry) => agentPortableId(entry.observationId))
    .map((id) => id ? observationIndexes.byId.get(id) : null)
    .find(Boolean)
  return (explicitId ? observationIndexes.byId.get(explicitId) : null)
    || cacheObservation
    || (identity.attachmentId ? observationIndexes.byAttachment.get(identity.attachmentId) : null)
    || (identity.mediaId ? observationIndexes.byMedia.get(identity.mediaId) : null)
    || null
}

function agentUsableObservation(observation) {
  return Boolean(
    observation
    && ['ready', 'partial'].includes(observation.status)
    && (String(observation.summary || '').trim() || (Array.isArray(observation.facts) && observation.facts.length > 0)),
  )
}

function agentObservationProviderPart(item, identity, observation, reason = '') {
  const fallback = {
    schema: ORBIT_AGENT_MEDIA_OBSERVATION_SCHEMA,
    id: agentFallbackId('observation', { item: item.id, ...identity }, 0),
    ...(identity.attachmentId ? { attachmentId: identity.attachmentId } : {}),
    ...(identity.mediaId ? { mediaId: identity.mediaId } : {}),
    kind: item.type === 'attachment' ? item.attachment.kind : ['image', 'localImage'].includes(item.type) ? 'image' : 'other',
    status: 'unavailable',
    summary: reason || 'No host-provided media observation is available.',
    facts: [],
  }
  const structured = {
    schema: ORBIT_AGENT_MEDIA_OBSERVATION_SCHEMA,
    sourceItemId: item.id,
    ...(identity.attachmentId ? { attachmentId: identity.attachmentId } : {}),
    ...(identity.mediaId ? { mediaId: identity.mediaId } : {}),
    ...(identity.refId ? { refId: identity.refId } : {}),
    observation: observation || fallback,
  }
  return {
    type: 'input_text',
    sourceItemId: item.id,
    ...(identity.attachmentId ? { attachmentId: identity.attachmentId } : {}),
    ...(identity.mediaId ? { mediaId: identity.mediaId } : {}),
    ...(identity.refId ? { refId: identity.refId } : {}),
    structured: true,
    text: JSON.stringify(structured),
  }
}

/** Project canonical turn inputs without mutating, aggregating, fetching, or reading them. */
export function projectAgentInputItemsForProvider(rawItems, options = {}) {
  const sourceItems = Array.isArray(rawItems) ? rawItems : rawItems === undefined || rawItems === null ? [] : [rawItems]
  const inputItems = normalizeAgentInputItems(rawItems)
  const capabilities = normalizeAgentProviderCapabilities(options.capabilities || options.providerCapabilities)
  const observationIndexes = agentObservationIndexes(options.observations)
  const cacheIndexes = agentCacheIndexes(options.mediaCache)
  const providerItems = []
  const issues = sourceItems.flatMap((value, index) => normalizeAgentInputItem(value, { index }) ? [] : [{
    code: 'invalid_input_item',
    severity: 'error',
    sourceItemId: agentPortableId(executionObject(value).id || executionObject(value).itemId, `input-${index + 1}`),
    message: 'The input item is invalid or contains an unsafe media source.',
  }])
  let imageCount = 0

  for (const item of inputItems) {
    if (item.type === 'text') {
      providerItems.push({ type: 'input_text', sourceItemId: item.id, text: item.text })
      continue
    }
    const identity = agentInputIdentity(item)
    const observation = agentObservationForItem(item, identity, observationIndexes, cacheIndexes)
    const usableObservation = agentUsableObservation(observation)
    const cacheEntries = agentCacheEntriesForItem(item, identity, cacheIndexes)
    const cacheEntry = cacheEntries.find((entry) => String(entry.mediaType || '').startsWith('image/')) || cacheEntries[0] || null
    const resolved = agentResolvedMedia(item, identity, cacheIndexes, capabilities)
    const refIsVisual = item.type === 'ref'
      && (observation?.kind === 'image' || String(cacheEntry?.mediaType || '').startsWith('image/'))
    const visualKind = item.type === 'image'
      || item.type === 'localImage'
      || (item.type === 'attachment' && item.attachment.kind === 'image')
      || refIsVisual
    const supportedImage = Boolean(
      visualKind
      && capabilities.vision
      && resolved
      && capabilities.imageInputs.includes(resolved.type)
      && imageCount < capabilities.maxImagesPerTurn,
    )
    if (supportedImage) {
      imageCount += 1
      providerItems.push({
        type: 'input_image',
        sourceItemId: item.id,
        ...(identity.attachmentId ? { attachmentId: identity.attachmentId } : {}),
        ...(identity.mediaId ? { mediaId: identity.mediaId } : {}),
        ...(identity.refId ? { refId: identity.refId } : {}),
        source: { ...resolved },
        detail: item.detail || 'auto',
      })
      continue
    }
    if (capabilities.vision && visualKind && imageCount >= capabilities.maxImagesPerTurn) {
      issues.push({ code: 'image_limit', severity: 'warning', sourceItemId: item.id, message: 'The provider image limit was reached; projected the item observation instead.' })
    } else if (capabilities.vision && visualKind && !resolved) {
      issues.push({ code: 'media_unresolved', severity: 'error', sourceItemId: item.id, message: 'The host did not provide a provider-ready media cache entry.' })
    } else if (capabilities.vision && visualKind && resolved && !capabilities.imageInputs.includes(resolved.type)) {
      issues.push({ code: 'media_source_unsupported', severity: 'error', sourceItemId: item.id, message: `The provider does not accept ${resolved.type} image inputs.` })
    }
    if (!observation) {
      issues.push({
        code: 'media_observation_missing',
        severity: 'error',
        sourceItemId: item.id,
        ...(identity.attachmentId ? { attachmentId: identity.attachmentId } : {}),
        message: 'A structured media observation is required before this input can be sent to the provider.',
      })
    } else if (!usableObservation) {
      issues.push({
        code: 'media_observation_error',
        severity: 'error',
        sourceItemId: item.id,
        ...(identity.attachmentId ? { attachmentId: identity.attachmentId } : {}),
        message: 'The structured media observation is unavailable, failed, or empty.',
      })
    }
    providerItems.push(agentObservationProviderPart(
      item,
      identity,
      observation,
      capabilities.vision ? 'The image could not be projected with the provider capabilities supplied by the host.' : 'The text-only provider received a structured media observation.',
    ))
  }

  return {
    schema: ORBIT_AGENT_INPUT_PROJECTION_SCHEMA,
    capabilities,
    inputItems,
    providerItems,
    issues,
    blocked: issues.some((issue) => issue.severity === 'error'),
  }
}

export function assertAgentInputProjectionReady(projection) {
  const source = executionObject(projection)
  if (source.schema !== ORBIT_AGENT_INPUT_PROJECTION_SCHEMA || !Array.isArray(source.issues)) {
    throw new TypeError('Agent input projection is invalid')
  }
  const blocking = source.issues.filter((issue) => issue && issue.severity === 'error')
  if (!blocking.length) return true
  const error = new Error(`Agent input projection is blocked: ${blocking.slice(0, 4).map((issue) => `${issue.code}:${issue.sourceItemId}`).join(', ')}`)
  error.code = 'ORBIT_AGENT_INPUT_PROJECTION_BLOCKED'
  error.issues = blocking
  throw error
}

export function projectAgentTurnForProvider(rawTurn, options = {}) {
  const turn = normalizeAgentTurn(rawTurn, options)
  if (!turn) throw new TypeError('Agent turn is invalid')
  const projection = projectAgentInputItemsForProvider(turn.inputItems, options)
  return { ...projection, turn }
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
  agent: 65_536,
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

function agentMessageContentText(value, maximum = Number.MAX_SAFE_INTEGER) {
  const limit = Number.isSafeInteger(maximum) && maximum > 0 ? maximum : Number.MAX_SAFE_INTEGER
  const parts = []
  let length = 0
  const append = (text) => {
    if (length >= limit) return
    const source = String(text || '')
    if (!source) return
    const remaining = limit - length
    const chunk = source.slice(0, remaining)
    parts.push(chunk)
    length += chunk.length
  }
  const visit = (entry, depth = 0) => {
    if (length >= limit || entry === undefined || entry === null || depth > 8) return
    if (typeof entry === 'string') {
      append(entry)
      return
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1)
      return
    }
    if (typeof entry !== 'object') {
      append(String(entry))
      return
    }
    const type = String(entry.type || '')
    if (typeof entry.text === 'string') {
      append(entry.text)
      return
    }
    if (['image', 'image_url', 'input_image'].includes(type) || entry.image_url) {
      append('[image input]')
      return
    }
    try {
      append(JSON.stringify(entry))
    } catch {
      append(Object.prototype.toString.call(entry))
    }
  }
  visit(value)
  return parts.join('\n')
}

function agentMessageImageCount(value) {
  let count = 0
  const visit = (entry, depth = 0) => {
    if (entry === undefined || entry === null || depth > 8) return
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1)
      return
    }
    if (typeof entry !== 'object') return
    const type = String(entry.type || '')
    if (['image', 'image_url', 'input_image'].includes(type) || entry.image_url) count += 1
  }
  visit(value)
  return count
}

function agentMessageFingerprintValue(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

function agentMessageInputItems(message) {
  const raw = Array.isArray(message?.inputItems)
    ? message.inputItems
    : Array.isArray(message?.input_items)
      ? message.input_items
      : []
  return normalizeAgentInputItems(raw)
}

function isAgentTurnInputMessage(message) {
  return Boolean(message && message.role === 'user' && agentMessageInputItems(message).length)
}

function compactAgentMessageText(value, maximum, head, tail) {
  const source = String(value || '')
  if (source.length <= maximum) return source
  return `${source.slice(0, head)}\n[older structured user text compacted]\n${source.slice(-tail)}`
}

function compactAgentStructuredContent(content, maximum = 8_000) {
  if (typeof content === 'string') return compactAgentMessageText(content, maximum, 1_600, 4_000)
  if (!Array.isArray(content)) return content
  return content.map((part) => {
    if (!part || typeof part !== 'object' || typeof part.text !== 'string') return part
    return { ...part, text: compactAgentMessageText(part.text, maximum, 1_600, 4_000) }
  })
}

function compactAgentInputItemSidecar(value) {
  return agentMessageInputItems({ inputItems: value }).map((item) => item.type === 'text'
    ? { ...item, text: compactAgentMessageText(item.text, 8_000, 1_600, 4_000) }
    : item)
}

function messageTextSize(message) {
  if (!message || typeof message !== 'object') return { chars: 0, tokens: 0 }
  const contentText = agentMessageContentText(message.content)
  const imageCount = agentMessageImageCount(message.content)
  const values = [message.role, message.reasoning, message.reasoning_content, message.name, message.tool_call_id]
  if (Array.isArray(message.tool_calls)) values.push(JSON.stringify(message.tool_calls))
  if (Array.isArray(message.reasoning_details)) values.push(JSON.stringify(message.reasoning_details))
  if (Array.isArray(message.response_items)) values.push(JSON.stringify(message.response_items))
  if (message.orbit_internal && typeof message.orbit_internal === 'object') values.push(JSON.stringify(message.orbit_internal))
  const baseText = values.filter((value) => value !== undefined && value !== null).map(String).join('\n')
  const inputItems = agentMessageInputItems(message)
  const observations = Array.isArray(message.mediaObservations)
    ? message.mediaObservations
    : Array.isArray(message.media_observations)
      ? message.media_observations
      : []
  const sidecarText = [
    ...inputItems.map((item) => item.type === 'text' ? item.text : `[${item.type} input:${item.id}]`),
    ...observations.map((observation) => {
      const normalized = normalizeAgentMediaObservation(observation)
      return normalized ? [normalized.summary, ...normalized.facts.map((fact) => fact.text)].join('\n') : ''
    }),
  ].filter(Boolean).join('\n')
  const contentChars = contentText.length + imageCount * 8_192
  const contentTokens = estimateAgentTextTokens(contentText) + imageCount * 2_048
  const sidecarImageCount = inputItems.filter((item) => item.type === 'image' || item.type === 'localImage'
    || item.type === 'attachment' && item.attachment.kind === 'image').length
  const sidecarChars = sidecarText.length + sidecarImageCount * 8_192
  const sidecarTokens = estimateAgentTextTokens(sidecarText) + sidecarImageCount * 2_048
  // Image tokenization is provider/model dependent. A conservative portable
  // estimate prevents structured image turns from looking nearly free. Host
  // input sidecars describe the same projected turn, so use the larger view
  // instead of double-counting both persistent and provider representations.
  return {
    chars: baseText.length + Math.max(contentChars, sidecarChars),
    tokens: estimateAgentTextTokens(baseText) + Math.max(contentTokens, sidecarTokens),
  }
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
  } else if (next.role === 'user') {
    next.content = compactAgentStructuredContent(next.content)
    if (Array.isArray(next.inputItems)) next.inputItems = compactAgentInputItemSidecar(next.inputItems)
    if (Array.isArray(next.input_items)) next.input_items = compactAgentInputItemSidecar(next.input_items)
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
    if (!message || typeof message !== 'object') return message
    const hostFields = ['orbit_internal', 'inputItems', 'input_items', 'mediaObservations', 'media_observations']
    if (!hostFields.some((field) => Object.prototype.hasOwnProperty.call(message, field))) return message
    const projected = { ...message }
    for (const field of hostFields) delete projected[field]
    return projected
  })
}

function compactionMessageFingerprint(messages) {
  let hash = 2166136261
  const source = Array.isArray(messages) ? messages : []
  for (const message of source) {
    const values = [message?.role, message?.tool_call_id, agentMessageFingerprintValue(message?.content), message?.reasoning, message?.reasoning_content]
    if (Array.isArray(message?.tool_calls)) values.push(JSON.stringify(message.tool_calls))
    if (Array.isArray(message?.reasoning_details)) values.push(JSON.stringify(message.reasoning_details))
    if (Array.isArray(message?.response_items)) values.push(JSON.stringify(message.response_items))
    if (Array.isArray(message?.inputItems)) values.push(JSON.stringify(message.inputItems))
    if (Array.isArray(message?.input_items)) values.push(JSON.stringify(message.input_items))
    if (Array.isArray(message?.mediaObservations)) values.push(JSON.stringify(message.mediaObservations))
    if (Array.isArray(message?.media_observations)) values.push(JSON.stringify(message.media_observations))
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
  if (compacted.content !== undefined) {
    projected.content = redactAgentSensitiveText(agentMessageContentText(compacted.content, 8_000))
  }
  if (compacted.tool_call_id) projected.tool_call_id = String(compacted.tool_call_id)
  if (Array.isArray(compacted.tool_calls)) {
    projected.tool_calls = compacted.tool_calls.slice(0, 16).map((call) => ({
      id: call && call.id,
      name: call && call.function && call.function.name,
      arguments: redactAgentSensitiveText(String((call && call.function && call.function.arguments) || '').slice(0, 2_000)),
    }))
  }
  const rawInputItems = Array.isArray(compacted.inputItems)
    ? compacted.inputItems
    : Array.isArray(compacted.input_items)
      ? compacted.input_items
      : []
  if (rawInputItems.length) {
    projected.inputItemRefs = normalizeAgentInputItems(rawInputItems).slice(0, 64).map((item) => {
      if (item.type === 'text') {
        return { id: item.id, type: item.type, text: redactAgentSensitiveText(item.text).slice(0, 2_000) }
      }
      if (item.type === 'attachment') {
        return {
          id: item.id,
          type: item.type,
          attachmentId: item.attachment.id,
          kind: item.attachment.kind,
          ...(item.attachment.name ? { name: item.attachment.name } : {}),
          ...(item.observationId ? { observationId: item.observationId } : {}),
        }
      }
      if (item.type === 'ref') {
        return {
          id: item.id,
          type: item.type,
          refId: item.ref.id,
          refKind: item.ref.kind,
          targetId: item.ref.targetId,
          ...(item.observationId ? { observationId: item.observationId } : {}),
        }
      }
      return {
        id: item.id,
        type: item.type,
        mediaId: item.mediaId || item.id,
        ...(item.attachmentId ? { attachmentId: item.attachmentId } : {}),
      }
    })
  }
  const rawObservations = Array.isArray(compacted.mediaObservations)
    ? compacted.mediaObservations
    : Array.isArray(compacted.media_observations)
      ? compacted.media_observations
      : []
  if (rawObservations.length) {
    projected.mediaObservations = rawObservations
      .map((observation) => normalizeAgentMediaObservation(observation))
      .filter(Boolean)
      .slice(0, 64)
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
  const retainedUserContext = (Array.isArray(input.retainedUserMessages) ? input.retainedUserMessages : [])
    .slice(-8)
    .map((message, index) => {
      const projected = defaultCompactionProjection(message)
      return projected ? `[retained-user-${index + 1}] ${JSON.stringify(projected)}` : ''
    })
    .filter(Boolean)
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
    retainedUserContext.length
      ? 'Canonical/retained user context (also retained outside the summary):\n' + retainedUserContext.join('\n')
      : '',
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

function recentCompactionUserMessages(source, firstUser, latestTurnUser, limits) {
  const selected = new Set()
  let tokens = 0
  if (latestTurnUser && latestTurnUser !== firstUser) {
    selected.add(latestTurnUser)
    tokens += Math.min(messageTextSize(latestTurnUser).tokens, limits.recentUserTokenBudget)
  }
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index]
    if (!message || message === firstUser || message === latestTurnUser || message.role !== 'user' || isCompactionSummaryMessage(message)) continue
    const size = messageTextSize(message).tokens
    if (selected.size && tokens + size > limits.recentUserTokenBudget) continue
    selected.add(message)
    tokens += size
    if (selected.size >= limits.keepRecentUserMessages) break
  }
  return source.filter((message) => selected.has(message))
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
  const latestTurnUser = [...source].reverse().find((message) => isAgentTurnInputMessage(message)) || firstUser
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
  const recentUserMessages = recentCompactionUserMessages(source, firstUser, latestTurnUser, policy)
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
    retainedUserMessages: [firstUser, latestTurnUser, ...recentUserMessages].filter(Boolean),
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
    latestTurnUser,
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
  const firstUserContent = agentMessageContentText(preparation.firstUser?.content, 8_000)
  const latest = preparation.latestTurnUser || preparation.recentUserMessages[preparation.recentUserMessages.length - 1]
  const latestContent = agentMessageContentText(latest?.content, 8_000) || firstUserContent
  const openWork = preparation.plan
    ? agentPlanOpenTodos(preparation.plan).slice(0, 12).map((todo) => cleanCompactionText(todo.title, 500)).filter(Boolean)
    : []
  return {
    schema: ORBIT_AGENT_SEMANTIC_SUMMARY_SCHEMA,
    objective: cleanCompactionText(firstUserContent, 2_000),
    latestUserIntent: cleanCompactionText(latestContent, 2_000),
    userConstraints: [],
    userCorrections: preparation.recentUserMessages.slice(-6).map((message) => cleanCompactionText(agentMessageContentText(message.content, 2_000), 600)).filter(Boolean),
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

function visualCompactionPins(preparation) {
  const selected = []
  let imageCount = 0
  for (const message of [...preparation.droppedMessages].reverse()) {
    if (!message || message.role !== 'user') continue
    const images = agentMessageInputItems(message).filter((item) => item.type === 'image' || item.type === 'localImage'
      || item.type === 'attachment' && item.attachment.kind === 'image').length
    if (!images || imageCount + images > 8) continue
    selected.unshift(compactPortableMessage(message, false))
    imageCount += images
  }
  return selected
}

function assembleCompactedMessages(preparation, summaryMessage, tailBlocks) {
  const tail = tailBlocks.flat()
  const tailSet = new Set(tail)
  const recent = preparation.recentUserMessages
    .filter((message) => message !== preparation.firstUser && !tailSet.has(message))
    .map((message) => compactPortableMessage(message, false))
  const visualPins = visualCompactionPins(preparation)
  const preserveFrom = Math.max(0, tail.length - 4)
  return withoutOrphanToolMessages([
    ...preparation.canonicalMessages,
    preparation.firstUser,
    summaryMessage,
    ...visualPins,
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
  agentMessageContentText,
  agentMessageImageCount,
  agentMessageFingerprintValue,
  agentMessageInputItems,
  isAgentTurnInputMessage,
  compactAgentMessageText,
  compactAgentStructuredContent,
  compactAgentInputItemSidecar,
  agentPortableText,
  agentPortableId,
  agentStableHash,
  agentFallbackId,
  agentPortableMetadata,
  agentOptionalTimestamp,
  agentOptionalPositiveInteger,
  agentMediaKind,
  agentInputItemType,
  agentImageUrl,
  agentPrivateNetworkHostname,
  agentSafeImageUrl,
  agentSafeInlineImageUrl,
  agentLocalImagePath,
  normalizeAgentMediaFact,
  normalizeAgentMediaCacheEntry,
  agentObservationIndexes,
  agentCacheIndexes,
  agentInputIdentity,
  agentCacheEntriesForItem,
  agentCacheEntryForItem,
  agentResolvedMedia,
  agentObservationForItem,
  agentUsableObservation,
  agentObservationProviderPart,
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
  visualCompactionPins,
  assembleCompactedMessages,
  normalizedCheckpointRecentUsers,
  normalizeAgentStoreMediaAsset,
]

const CORE_EXPORTS = [
  ['normalizeAgentInputItem', normalizeAgentInputItem],
  ['normalizeAgentInputItems', normalizeAgentInputItems],
  ['normalizeAgentMediaObservation', normalizeAgentMediaObservation],
  ['normalizeAgentMediaCache', normalizeAgentMediaCache],
  ['normalizeAgentProject', normalizeAgentProject],
  ['normalizeAgentTurn', normalizeAgentTurn],
  ['normalizeAgentThread', normalizeAgentThread],
  ['normalizeAgentSession', normalizeAgentSession],
  ['normalizeAgentProviderCapabilities', normalizeAgentProviderCapabilities],
  ['projectAgentInputItemsForProvider', projectAgentInputItemsForProvider],
  ['assertAgentInputProjectionReady', assertAgentInputProjectionReady],
  ['projectAgentTurnForProvider', projectAgentTurnForProvider],
  ['orbitArcadeSdkContractText', orbitArcadeSdkContractText],
  ['orbitArcadeSdkSourceIssues', orbitArcadeSdkSourceIssues],
  ['normalizeAgentStoreMediaManifest', normalizeAgentStoreMediaManifest],
  ['normalizeAgentImageCapabilities', normalizeAgentImageCapabilities],
  ['evaluateAgentImageIntent', evaluateAgentImageIntent],
  ['normalizeAgentImageIntent', normalizeAgentImageIntent],
  ['projectAgentImageArtifact', projectAgentImageArtifact],
  ['createGenerateImageToolSpec', createGenerateImageToolSpec],
  ['createGenerateSpritesheetToolSpec', createGenerateSpritesheetToolSpec],
  ['createGenerateGameMapToolSpec', createGenerateGameMapToolSpec],
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

/** Build the exact ESM module uploaded beside host runners. */
export function buildOrbitAgentCoreModuleSource() {
  const declarations = [
    // Function#toString() observes the bundled function body at runtime. When
    // a host bundle enables esbuild keepNames, nested functions can reference
    // its private __name helper. The uploaded module runs outside that bundle,
    // so carry a compatible helper with the generated source instead of
    // depending on the host bundler's closure.
    `const __name = (target, value) => { try { Object.defineProperty(target, 'name', { value, configurable: true }) } catch {} return target }`,
    `const ORBIT_AGENT_CORE_VERSION = ${JSON.stringify(ORBIT_AGENT_CORE_VERSION)}`,
    `const ORBIT_PRO_AGENT_CORE_VERSION = ${JSON.stringify(ORBIT_PRO_AGENT_CORE_VERSION)}`,
    `const ORBIT_AGENT_EXECUTION_POLICY = Object.freeze(${JSON.stringify(ORBIT_AGENT_EXECUTION_POLICY)})`,
    `const ORBIT_AGENT_TOOL_CAPABILITY_SCHEMA = ${JSON.stringify(ORBIT_AGENT_TOOL_CAPABILITY_SCHEMA)}`,
    `const ORBIT_AGENT_TOOL_CAPABILITY = Symbol.for(ORBIT_AGENT_TOOL_CAPABILITY_SCHEMA)`,
    `const ORBIT_AGENT_RENDER_SURFACE_CONTRACT = ${JSON.stringify(ORBIT_AGENT_RENDER_SURFACE_CONTRACT)}`,
    `const ORBIT_AGENT_RENDER_SURFACE_POLICY = Object.freeze(${JSON.stringify(ORBIT_AGENT_RENDER_SURFACE_POLICY)})`,
    `const ORBIT_ARCADE_SDK_CONTRACT_SCHEMA = ${JSON.stringify(ORBIT_ARCADE_SDK_CONTRACT_SCHEMA)}`,
    `const ORBIT_ARCADE_SDK_CONTRACT = Object.freeze(${JSON.stringify(ORBIT_ARCADE_SDK_CONTRACT)})`,
    `const ORBIT_AGENT_STORE_MEDIA_SCHEMA = ${JSON.stringify(ORBIT_AGENT_STORE_MEDIA_SCHEMA)}`,
    `const ORBIT_AGENT_STORE_MEDIA_ROLES = Object.freeze(${JSON.stringify(ORBIT_AGENT_STORE_MEDIA_ROLES)})`,
    `const ORBIT_AGENT_IMAGE_SCHEMA = ${JSON.stringify(ORBIT_AGENT_IMAGE_SCHEMA)}`,
    `const ORBIT_AGENT_IMAGE_CAPABILITY_SCHEMA = ${JSON.stringify(ORBIT_AGENT_IMAGE_CAPABILITY_SCHEMA)}`,
    `const ORBIT_AGENT_IMAGE_KINDS = Object.freeze(${JSON.stringify(ORBIT_AGENT_IMAGE_KINDS)})`,
    `const ORBIT_AGENT_IMAGE_ASPECT_RATIOS = Object.freeze(${JSON.stringify(ORBIT_AGENT_IMAGE_ASPECT_RATIOS)})`,
    `const ORBIT_AGENT_MODEL_OUTPUT_LIMITS = Object.freeze(${JSON.stringify(ORBIT_AGENT_MODEL_OUTPUT_LIMITS)})`,
    `const ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA = ${JSON.stringify(ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA)}`,
    `const ORBIT_AGENT_SEMANTIC_SUMMARY_SCHEMA = ${JSON.stringify(ORBIT_AGENT_SEMANTIC_SUMMARY_SCHEMA)}`,
    `const ORBIT_AGENT_CHECKPOINT_SCHEMA = ${JSON.stringify(ORBIT_AGENT_CHECKPOINT_SCHEMA)}`,
    `const ORBIT_AGENT_INTERNAL_MESSAGE_SCHEMA = ${JSON.stringify(ORBIT_AGENT_INTERNAL_MESSAGE_SCHEMA)}`,
    `const ORBIT_AGENT_TOOL_BATCH_SCHEMA = ${JSON.stringify(ORBIT_AGENT_TOOL_BATCH_SCHEMA)}`,
    `const ORBIT_AGENT_PROJECT_SCHEMA = ${JSON.stringify(ORBIT_AGENT_PROJECT_SCHEMA)}`,
    `const ORBIT_AGENT_THREAD_SCHEMA = ${JSON.stringify(ORBIT_AGENT_THREAD_SCHEMA)}`,
    `const ORBIT_AGENT_TURN_SCHEMA = ${JSON.stringify(ORBIT_AGENT_TURN_SCHEMA)}`,
    `const ORBIT_AGENT_INPUT_ITEM_SCHEMA = ${JSON.stringify(ORBIT_AGENT_INPUT_ITEM_SCHEMA)}`,
    `const ORBIT_AGENT_MEDIA_OBSERVATION_SCHEMA = ${JSON.stringify(ORBIT_AGENT_MEDIA_OBSERVATION_SCHEMA)}`,
    `const ORBIT_AGENT_MEDIA_CACHE_SCHEMA = ${JSON.stringify(ORBIT_AGENT_MEDIA_CACHE_SCHEMA)}`,
    `const ORBIT_AGENT_PROVIDER_CAPABILITY_SCHEMA = ${JSON.stringify(ORBIT_AGENT_PROVIDER_CAPABILITY_SCHEMA)}`,
    `const ORBIT_AGENT_INPUT_PROJECTION_SCHEMA = ${JSON.stringify(ORBIT_AGENT_INPUT_PROJECTION_SCHEMA)}`,
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
    'ORBIT_AGENT_CORE_VERSION',
    'ORBIT_PRO_AGENT_CORE_VERSION',
    'ORBIT_AGENT_EXECUTION_POLICY',
    'ORBIT_AGENT_TOOL_CAPABILITY_SCHEMA',
    'ORBIT_AGENT_TOOL_CAPABILITY',
    'ORBIT_AGENT_RENDER_SURFACE_CONTRACT',
    'ORBIT_AGENT_RENDER_SURFACE_POLICY',
    'ORBIT_ARCADE_SDK_CONTRACT_SCHEMA',
    'ORBIT_ARCADE_SDK_CONTRACT',
    'ORBIT_AGENT_STORE_MEDIA_SCHEMA',
    'ORBIT_AGENT_STORE_MEDIA_ROLES',
    'ORBIT_AGENT_IMAGE_SCHEMA',
    'ORBIT_AGENT_IMAGE_CAPABILITY_SCHEMA',
    'ORBIT_AGENT_IMAGE_KINDS',
    'ORBIT_AGENT_IMAGE_ASPECT_RATIOS',
    'ORBIT_AGENT_MODEL_OUTPUT_LIMITS',
    'ORBIT_AGENT_CAPABILITY_PROFILE_SCHEMA',
    'ORBIT_AGENT_SEMANTIC_SUMMARY_SCHEMA',
    'ORBIT_AGENT_CHECKPOINT_SCHEMA',
    'ORBIT_AGENT_INTERNAL_MESSAGE_SCHEMA',
    'ORBIT_AGENT_TOOL_BATCH_SCHEMA',
    'ORBIT_AGENT_PROJECT_SCHEMA',
    'ORBIT_AGENT_THREAD_SCHEMA',
    'ORBIT_AGENT_TURN_SCHEMA',
    'ORBIT_AGENT_INPUT_ITEM_SCHEMA',
    'ORBIT_AGENT_MEDIA_OBSERVATION_SCHEMA',
    'ORBIT_AGENT_MEDIA_CACHE_SCHEMA',
    'ORBIT_AGENT_PROVIDER_CAPABILITY_SCHEMA',
    'ORBIT_AGENT_INPUT_PROJECTION_SCHEMA',
    'ORBIT_AGENT_CAPABILITY_PROFILES',
    'ORBIT_VISUAL_PLAN_MAX_CANDIDATES',
    'ORBIT_LOOP_ITERATION_POLICY',
    'ORBIT_PRO_AGENT_CONTEXT_POLICY',
    'ORBIT_PRO_AGENT_CONVERSATION_POLICY',
    ...CORE_EXPORTS.map(([exportName, fn]) => `${fn.name} as ${exportName}`),
  ]
  return `${declarations.join('\n\n')}\n\nexport { ${aliases.join(', ')} }\n`
}

/** @deprecated Use buildOrbitAgentCoreModuleSource. */
export function buildOrbitProAgentCoreModuleSource() {
  return buildOrbitAgentCoreModuleSource()
}
