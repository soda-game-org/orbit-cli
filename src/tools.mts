import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { MAX_TOOL_OUTPUT_CHARS } from './constants.mjs'
import {
  agentPlanOpenBlockingTodosForFinish,
  completePublishTodosForFinish,
  createAgentToolCapabilityRegistry,
  defineAgentToolCapability,
  evaluateAgentToolPrePlan,
  getAgentToolCapability,
  normalizeAgentPlan,
} from '@soda_game/orbit-agent-core'
import { canonicalDirectory, durableAtomicWriteFile, isContained, redactWorkspacePath, sha256, sleep } from './util.mjs'
import type { OrbitMode, OrbitRun } from './types.mjs'

type Dynamic = Record<string, any>
type ToolDefinition = { type: 'function'; function: { name: string; description: string; parameters: Dynamic } }

function tool(name: string, description: string, parameters: Dynamic): ToolDefinition {
  return { type: 'function', function: { name, description, parameters } }
}

function declaredTool(
  name: string,
  description: string,
  parameters: Dynamic,
  capability: Dynamic,
): ToolDefinition {
  return defineAgentToolCapability(tool(name, description, parameters), capability)
}

const BASE_TOOLS = [
  declaredTool('update_agent_plan', 'Create or update the execution plan.', {
    type: 'object', additionalProperties: false, required: ['summary', 'todos'],
    properties: {
      summary: { type: 'string' }, currentTodoId: { type: 'string' }, blockers: { type: 'array', items: { type: 'string' } },
      todos: { type: 'array', minItems: 1, maxItems: 12, items: {
        type: 'object', additionalProperties: false, required: ['id', 'title', 'status', 'kind'],
        properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, kind: { type: 'string' }, detail: { type: 'string' }, evidence: { type: 'string' } },
      } },
    },
  }, { prePlan: 'establish', effect: 'control', parallel: 'serial', retry: 'safe' }),
  declaredTool('write_file', 'Write one workspace file.', { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } }, { effect: 'write', parallel: 'serial', retry: 'idempotent' }),
  declaredTool('edit_file', 'Replace one exact substring in one workspace file.', { type: 'object', additionalProperties: false, required: ['path', 'old_string', 'new_string'], properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } } }, { effect: 'write', parallel: 'serial', retry: 'idempotent' }),
  declaredTool('apply_patch', 'Apply multiple exact substring replacements.', { type: 'object', additionalProperties: false, required: ['edits'], properties: { edits: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'object', additionalProperties: false, required: ['path', 'old_string', 'new_string'], properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } } } } } }, { effect: 'write', parallel: 'serial', retry: 'idempotent' }),
  declaredTool('read_file', 'Read a workspace file by line range.', { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } } }, { prePlan: 'observe', observationScope: 'source', effect: 'read', parallel: 'safe', retry: 'safe', budget: { maxPrePlanCalls: 24 } }),
  declaredTool('list_files', 'List workspace files.', { type: 'object', additionalProperties: false, properties: {} }, { prePlan: 'observe', observationScope: 'source', effect: 'read', parallel: 'safe', retry: 'safe', budget: { maxPrePlanCalls: 8 } }),
  declaredTool('grep_files', 'Search workspace text files.', { type: 'object', additionalProperties: false, required: ['pattern'], properties: { pattern: { type: 'string' }, case_sensitive: { type: 'boolean' } } }, { prePlan: 'observe', observationScope: 'source', effect: 'read', parallel: 'safe', retry: 'safe', budget: { maxPrePlanCalls: 16 } }),
  declaredTool('read_reference_media', 'Read structured observations for specific Turn media identities. Vision-capable providers already receive the original image as a Turn input.', {
    type: 'object', additionalProperties: false,
    properties: {
      media_ids: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
      image_path: { type: 'string', description: 'Deprecated legacy alias; accepted only when it exactly matches a reference attached to this Turn.' },
    },
  }, { prePlan: 'observe', observationScope: 'input', effect: 'read', parallel: 'serial', retry: 'safe', budget: { maxPrePlanCalls: 8 } }),
  declaredTool('shell', 'Run an explicitly enabled npm install/build or JavaScript syntax check. Project build scripts execute with the current operating-system user permissions.', { type: 'object', additionalProperties: false, required: ['command'], properties: { command: { type: 'string' }, timeout_ms: { type: 'integer' } } }, { effect: 'execute', parallel: 'serial', retry: 'unsafe' }),
  declaredTool('validate_project', 'Validate source contracts, build output, paths, and local preview readiness.', { type: 'object', additionalProperties: false, properties: {} }, { effect: 'execute', parallel: 'serial', retry: 'safe' }),
  declaredTool('finish', 'Finish only after validation passes.', { type: 'object', additionalProperties: false, properties: {} }, { effect: 'control', parallel: 'serial', retry: 'safe' }),
]

const RUNTIME_DECISION_TOOL = declaredTool('select_runtime', 'Record the coding agent architecture decision for an auto-runtime create after update_agent_plan and before project mutation. Choose from explicit dimension, camera, rendering, input, physics, existing-source, and maintainability requirements; genre wording alone is not sufficient evidence for a framework.', {
  type: 'object', additionalProperties: false, required: ['runtime', 'dimension', 'rationale'],
  properties: {
    runtime: { type: 'string', enum: ['html', 'vanilla-ts', 'react-vite', 'react-three-fiber', 'three-vanilla', 'phaser'] },
    dimension: { type: 'string', enum: ['2d', '2.5d', '3d', 'mixed'] },
    rationale: { type: 'string', minLength: 12, maxLength: 600 },
  },
}, { effect: 'control', parallel: 'serial', retry: 'safe' })

const OFFICIAL_3D_TOOL = declaredTool('generate_humanoid_character', 'Generate one original rigged humanoid through the authenticated Orbit Worker when 3D generation was enabled.', {
  type: 'object', additionalProperties: false, required: ['prompt'], properties: { prompt: { type: 'string', minLength: 8, maxLength: 1024 } },
}, { effect: 'execute', parallel: 'serial', retry: 'unsafe' })

const BYOK_3D_TOOL = declaredTool('generate_3d_model', 'Generate one original GLB model with the user-configured Replicate key when 3D generation was enabled.', {
  type: 'object', additionalProperties: false, required: ['prompt', 'output_path'],
  properties: { prompt: { type: 'string', minLength: 8, maxLength: 8000 }, output_path: { type: 'string' }, face_count: { type: 'integer' }, enable_pbr: { type: 'boolean' } },
}, { effect: 'execute', parallel: 'serial', retry: 'unsafe' })

function imageTool(mode: OrbitMode): ToolDefinition {
  return declaredTool('generate_image', mode === 'orbit'
    ? 'Generate one original game image through the authenticated Orbit Worker. Use it only when a high-impact 2D asset materially improves the game, wire the returned local path into the game, and do not generate decorative assets that the final build does not use.'
    : 'Generate one original game image with the user-configured Replicate key. Use it only when a high-impact 2D asset materially improves the game, wire the returned local path into the game, and do not generate decorative assets that the final build does not use. The user\'s Replicate account may be billed.', {
  type: 'object', additionalProperties: false, required: ['prompt', 'output_path'],
  properties: {
    prompt: { type: 'string', minLength: 8, maxLength: 8000 },
    output_path: { type: 'string', description: 'Safe workspace-relative .png path.' },
    aspect_ratio: { type: 'string', enum: ['1:1', '9:16', '16:9'] },
  },
  }, { effect: 'execute', parallel: 'serial', retry: 'unsafe' })
}

export function agentTools({ mode, runtime = 'auto', operation = 'create', generateImages = false, generate3d = false }: { mode: OrbitMode; runtime?: string; operation?: 'create' | 'edit'; generateImages?: boolean; generate3d?: boolean }): ToolDefinition[] {
  const tools = [...BASE_TOOLS]
  if (runtime === 'auto' && operation === 'create') tools.splice(1, 0, RUNTIME_DECISION_TOOL)
  if (generateImages) tools.splice(tools.length - 3, 0, imageTool(mode))
  if (generate3d) tools.splice(tools.length - 3, 0, mode === 'orbit' ? OFFICIAL_3D_TOOL : BYOK_3D_TOOL)
  return tools
}

function relativePath(value: unknown): string {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
    || normalized === '.orbit' || normalized.startsWith('.orbit/')
    || normalized === '.git' || normalized.startsWith('.git/')) {
    throw new Error('Tool path must be a safe workspace-relative path')
  }
  return normalized
}

async function resolveForRead(root: string, value: unknown): Promise<{ relative: string; absolute: string; stat: import('node:fs').Stats }> {
  const relative = relativePath(value)
  const absolute = path.resolve(root, relative)
  if (!isContained(root, absolute)) throw new Error('Tool path escaped the workspace')
  const canonical = await fs.realpath(absolute)
  if (!isContained(root, canonical) || canonical !== absolute) throw new Error('Tool path traversed a symbolic link')
  const stat = await fs.lstat(absolute)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Tool path is not a regular file')
  return { relative, absolute, stat }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

async function resolveForWrite(root: string, value: unknown): Promise<{ relative: string; absolute: string }> {
  const relative = relativePath(value)
  const absolute = path.resolve(root, relative)
  if (!isContained(root, absolute)) throw new Error('Tool path escaped the workspace')
  const parts = relative.split('/')
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part)
    const existing = await fs.lstat(current).catch((error) => isMissing(error) ? null : Promise.reject(error))
    if (!existing) await fs.mkdir(current)
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) throw new Error('Tool path contains an unsafe directory')
  }
  const existing = await fs.lstat(absolute).catch((error) => isMissing(error) ? null : Promise.reject(error))
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || await fs.realpath(absolute) !== absolute)) throw new Error('Tool destination is unsafe')
  return { relative, absolute }
}

async function verifiedGeneratedImage(root: string, output: unknown, expectedRelative: string): Promise<Dynamic | null> {
  if (!output || typeof output !== 'object') return null
  const candidate = output as Dynamic
  if (candidate.relativePath !== expectedRelative
    || candidate.contentType !== 'image/png'
    || typeof candidate.sha256 !== 'string') return null
  const resolved = await resolveForRead(root, candidate.relativePath).catch(() => null)
  if (!resolved || resolved.stat.size !== Number(candidate.bytes)) return null
  const bytes = await fs.readFile(resolved.absolute)
  if (bytes.byteLength < 8
    || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    || sha256(bytes) !== candidate.sha256) return null
  return { ...candidate, path: resolved.absolute, relativePath: resolved.relative }
}

async function reusableGeneratedImage(run: OrbitRun, root: string, expectedRelative: string): Promise<{ callId: string; output: Dynamic } | null> {
  const entries = Object.entries(run.assetImages || {}).reverse()
  for (const [callId, state] of entries) {
    const output = await verifiedGeneratedImage(root, (state as Dynamic | undefined)?.output, expectedRelative)
    if (output) return { callId, output }
  }
  return null
}

export function providerAssetResult(output: Dynamic): Dynamic {
  const safe: Dynamic = {}
  if (typeof output?.relativePath === 'string') safe.relativePath = output.relativePath.slice(0, 512)
  if (typeof output?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(output.sha256)) safe.sha256 = output.sha256
  if (Number.isSafeInteger(output?.bytes) && output.bytes >= 0) safe.bytes = output.bytes
  if (typeof output?.contentType === 'string') safe.contentType = output.contentType.slice(0, 80)
  for (const key of ['width', 'height']) if (Number.isSafeInteger(output?.[key]) && output[key] > 0) safe[key] = output[key]
  if (typeof output?.model === 'string') safe.model = output.model.slice(0, 160)
  if (typeof output?.degraded === 'boolean') safe.degraded = output.degraded
  if (typeof output?.degradedFrom === 'string') safe.degradedFrom = output.degradedFrom.slice(0, 160)
  if (typeof output?.costUsd === 'number' && Number.isFinite(output.costUsd) && output.costUsd >= 0) safe.costUsd = output.costUsd
  return safe
}

async function atomicWrite(root: string, value: unknown, content: unknown): Promise<{ path: string; bytes: number; sha256: string }> {
  const resolved = await resolveForWrite(root, value)
  const bytes = Buffer.from(String(content), 'utf8')
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Tool file exceeds the 8 MiB write limit')
  await durableAtomicWriteFile(resolved.absolute, bytes)
  return { path: resolved.relative, bytes: bytes.byteLength, sha256: sha256(bytes) }
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = []
  async function visit(directory: string, prefix = ''): Promise<void> {
    if (output.length >= 2_000) return
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (['.git', '.orbit', 'node_modules'].includes(entry.name)) continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) { output.push(`${relative} [symlink blocked]`); continue }
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative)
      else if (entry.isFile()) output.push(relative)
      if (output.length >= 2_000) return
    }
  }
  await visit(root)
  return output
}

function parseAllowedCommand(command: unknown): { command: string; args: string[] } {
  const text = String(command || '').trim()
  if (!text || text.length > 500 || /[;&|><`$\n\r]/.test(text)) throw new Error('Shell command is outside the safe allowlist')
  const parts = text.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, '')) || []
  const joined = parts.join(' ')
  const nodeCheck = /^node --check ([A-Za-z0-9_./-]+)$/.exec(joined)
  const allowed = /^npm (?:install --ignore-scripts|run build)$/.test(joined)
    || Boolean(nodeCheck)
  if (!allowed) throw new Error('Shell command is outside the safe allowlist')
  if (nodeCheck && !/\.(?:js|mjs|cjs)$/.test(relativePath(nodeCheck[1]))) throw new Error('node --check requires a workspace JavaScript file')
  return { command: parts[0]!, args: parts.slice(1) }
}

async function runCommand(root: string, command: unknown, timeoutMs?: number): Promise<{ exitCode: number; signal: NodeJS.Signals | null; output: string }> {
  const parsed = parseAllowedCommand(command)
  const shellHome = path.join(root, '.orbit', 'shell-home')
  const npmCache = path.join(root, '.orbit', 'npm-cache')
  await fs.mkdir(shellHome, { recursive: true, mode: 0o700 })
  await fs.mkdir(npmCache, { recursive: true, mode: 0o700 })
  return new Promise((resolve, reject) => {
    const child = spawn(parsed.command, parsed.args, {
      cwd: root,
      shell: false,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        Path: process.env.Path,
        PATHEXT: process.env.PATHEXT,
        SystemRoot: process.env.SystemRoot,
        ComSpec: process.env.ComSpec,
        HOME: shellHome,
        USERPROFILE: shellHome,
        npm_config_cache: npmCache,
        npm_config_userconfig: path.join(shellHome, '.npmrc'),
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_update_notifier: 'false',
        CI: '1',
        NO_COLOR: '1',
      },
    })
    const chunks: Buffer[] = []
    let length = 0
    const collect = (chunk: Uint8Array) => {
      if (length >= MAX_TOOL_OUTPUT_CHARS) return
      const slice = Buffer.from(chunk).subarray(0, MAX_TOOL_OUTPUT_CHARS - length)
      chunks.push(slice); length += slice.length
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.once('error', reject)
    const timer = setTimeout(() => child.kill('SIGTERM'), Math.min(300_000, Math.max(1_000, timeoutMs || 120_000)))
    timer.unref?.()
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, signal: signal || null, output: Buffer.concat(chunks).toString('utf8') })
    })
  })
}

async function validateProject(root: string): Promise<{ ok: boolean; index?: string; issues: string[] }> {
  const files = await listFiles(root)
  let index: string | null = null
  for (const candidate of ['dist/index.html', 'index.html']) {
    if (files.includes(candidate)) { index = candidate; break }
  }
  if (!index) return { ok: false, issues: [files.includes('package.json')
    ? 'No playable index.html or dist/index.html was found. Run an explicit allowed shell build first, then validate again.'
    : 'No playable index.html or dist/index.html was found.'] }
  const html = await fs.readFile(path.join(root, index), 'utf8')
  const sourceParts = [html]
  let sourceBytes = Buffer.byteLength(html)
  for (const file of files) {
    if (!/\.(?:html|js|mjs|cjs|jsx|ts|tsx)$/i.test(file) || file.startsWith('node_modules/')) continue
    const resolved = await resolveForRead(root, file)
    if (resolved.stat.size > 2 * 1024 * 1024 || sourceBytes + resolved.stat.size > 8 * 1024 * 1024) continue
    sourceParts.push(await fs.readFile(resolved.absolute, 'utf8'))
    sourceBytes += resolved.stat.size
  }
  const source = sourceParts.join('\n')
  const issues: string[] = []
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) issues.push('Missing mobile viewport metadata.')
  if (!/OrbitArcade\s*\.\s*startGame|orbit:game:start/.test(source)) issues.push('Orbit start lifecycle is missing.')
  if (!/OrbitArcade\s*\.\s*endGame|orbit:game:end/.test(source)) issues.push('Orbit end lifecycle is missing.')
  if (!/leaderboard/i.test(source)) issues.push('A reachable leaderboard action is missing.')
  if (/(?:https?:)?\/\/(?:unpkg|cdn\.jsdelivr|cdnjs|esm\.sh)/i.test(source)) issues.push('External CDN dependencies are not allowed.')
  return { ok: issues.length === 0, index, issues }
}

export class ToolExecutor {
  readonly workspace: string
  readonly run: OrbitRun
  readonly store: any
  readonly api: any
  readonly image: any
  readonly threeD: any
  readonly allowShell: boolean
  readonly retryUnsafe: boolean
  readonly signal?: AbortSignal | null
  readonly toolCapabilities: ReturnType<typeof createAgentToolCapabilityRegistry>

  constructor({ workspace, run, store, api, image = null, threeD = null, allowShell = false, retryUnsafe = false, signal = null }: { workspace: string; run: OrbitRun; store: any; api?: any; image?: any; threeD?: any; allowShell?: boolean; retryUnsafe?: boolean; signal?: AbortSignal | null }) {
    this.workspace = workspace
    this.run = run
    this.store = store
    this.api = api
    this.image = image
    this.threeD = threeD
    this.allowShell = allowShell
    this.retryUnsafe = retryUnsafe
    this.signal = signal
    this.toolCapabilities = createAgentToolCapabilityRegistry(agentTools({
      mode: run.mode, runtime: run.runtime, operation: run.operation,
      generateImages: run.generateImages, generate3d: run.generate3d,
    }))
  }

  async execute(call: Dynamic): Promise<string> {
    const name = String(call?.function?.name || '')
    let args: Dynamic
    try { args = JSON.parse(call?.function?.arguments || '{}') } catch { throw new Error(`Invalid JSON arguments for ${name}`) }
    const root = await canonicalDirectory(this.workspace)
    const prePlanEvaluation = evaluateAgentToolPrePlan(name, {
      registry: this.toolCapabilities,
      // An already-journaled batch must be settled during crash recovery before
      // another model turn, even when it came from a legacy checkpoint without
      // the newer explicit plan field.
      hasPlan: Boolean(this.run.plan || this.run.pendingToolBatch),
      allowSourceObservation: true,
      observationCounts: {
        input: Number(this.run.prePlanInputObservationCount || 0),
        source: Number(this.run.prePlanSourceObservationCount || 0),
      },
    })
    if (!prePlanEvaluation.allowed) {
      throw new Error('Establish the execution plan before tools that are not declared as bounded input/source observations')
    }
    if (prePlanEvaluation.consumesObservation && prePlanEvaluation.scope === 'input') {
      this.run.prePlanInputObservationCount = Number(this.run.prePlanInputObservationCount || 0) + 1
    } else if (prePlanEvaluation.consumesObservation && prePlanEvaluation.scope === 'source') {
      this.run.prePlanSourceObservationCount = Number(this.run.prePlanSourceObservationCount || 0) + 1
    }
    if (name === 'update_agent_plan') {
      const plan = normalizeAgentPlan(args, this.run.plan)
      if (!plan) throw new Error('update_agent_plan requires at least one valid todo')
      this.run.plan = plan
      await this.store.save(this.run)
      return JSON.stringify({ ok: true, plan }).slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    if (name === 'select_runtime') {
      if (this.run.operation !== 'create' || this.run.runtime !== 'auto') throw new Error('select_runtime is only available for an auto-runtime create')
      if (this.run.runtimeDecision) throw new Error(`Runtime was already selected as ${this.run.runtimeDecision.runtime}`)
      const runtime = String(args.runtime || '').trim()
      const dimension = String(args.dimension || '').trim()
      const rationale = String(args.rationale || '').trim()
      if (!['html', 'vanilla-ts', 'react-vite', 'react-three-fiber', 'three-vanilla', 'phaser'].includes(runtime)) throw new Error('select_runtime requires a concrete supported runtime')
      if (!['2d', '2.5d', '3d', 'mixed'].includes(dimension) || rationale.length < 12) throw new Error('select_runtime requires a supported dimension and concrete rationale')
      if (['react-three-fiber', 'three-vanilla'].includes(runtime) && dimension !== '3d') throw new Error('A Three.js runtime requires an explicit 3d dimension decision')
      this.run.runtimeDecision = { schema: 'orbit.agent-runtime-decision.v1', runtime, dimension, rationale, decidedBy: 'agent' }
      this.run.requestedRuntime = 'auto'
      this.run.runtime = runtime
      await this.store.save(this.run)
      return JSON.stringify({ ok: true, runtimeDecision: this.run.runtimeDecision }).slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    const capability = getAgentToolCapability(name, this.toolCapabilities)
    if (this.run.operation === 'create' && this.run.runtime === 'auto' && !this.run.runtimeDecision
      && capability.effect !== 'read' && name !== 'update_agent_plan' && name !== 'select_runtime') {
      throw new Error('Record the architecture with select_runtime after update_agent_plan and before mutating or executing the project')
    }
    if (name === 'write_file') return JSON.stringify(await atomicWrite(root, args.path, args.content))
    if (name === 'read_file') {
      const file = await resolveForRead(root, args.path)
      if (file.stat.size > 2 * 1024 * 1024) throw new Error('File is too large to read')
      const lines = (await fs.readFile(file.absolute, 'utf8')).split(/\r?\n/)
      const offset = Math.max(0, Number(args.offset) || 0)
      const limit = Math.min(2_000, Math.max(1, Number(args.limit) || 400))
      return lines.slice(offset, offset + limit).map((line, index) => `${offset + index}: ${line}`).join('\n').slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    if (name === 'edit_file') {
      const file = await resolveForRead(root, args.path)
      const source = await fs.readFile(file.absolute, 'utf8')
      const oldText = String(args.old_string)
      const newText = String(args.new_string)
      if (!oldText) throw new Error('edit_file old_string cannot be empty')
      this.run.fileOperations ||= {}
      const existingOperation = this.run.fileOperations[call.id]
      if (existingOperation) {
        if (existingOperation.type !== 'edit_file' || existingOperation.path !== file.relative
          || existingOperation.argumentsHash !== sha256(String(call.function.arguments || ''))) throw new Error('Saved edit operation does not match this tool call')
        const currentHash = sha256(source)
        if (currentHash === existingOperation.postSha256) return JSON.stringify({ ok: true, recovered: true, path: file.relative })
        if (currentHash !== existingOperation.preSha256) throw new Error('edit_file destination changed after the durable operation intent')
        const resumed = source.replace(oldText, newText)
        if (sha256(resumed) !== existingOperation.postSha256) throw new Error('edit_file durable postimage no longer matches the tool arguments')
        const result = await atomicWrite(root, file.relative, resumed)
        existingOperation.status = 'applied'
        await this.store.save(this.run)
        return JSON.stringify({ ...result, recovered: true })
      }
      const occurrences = source.split(oldText).length - 1
      if (occurrences !== 1) throw new Error(`edit_file expected one match, found ${occurrences}`)
      const next = source.replace(oldText, newText)
      this.run.fileOperations[call.id] = {
        type: 'edit_file', path: file.relative, argumentsHash: sha256(String(call.function.arguments || '')),
        preSha256: sha256(source), postSha256: sha256(next), status: 'pending',
      }
      await this.store.save(this.run)
      const result = await atomicWrite(root, file.relative, next)
      this.run.fileOperations[call.id].status = 'applied'
      await this.store.save(this.run)
      return JSON.stringify(result)
    }
    if (name === 'apply_patch') {
      if (!Array.isArray(args.edits) || !args.edits.length) throw new Error('apply_patch requires edits')
      const working = new Map<string, string>()
      this.run.fileOperations ||= {}
      const argumentsHash = sha256(String(call.function.arguments || ''))
      const existingOperation = this.run.fileOperations[call.id]
      if (existingOperation && (existingOperation.type !== 'apply_patch' || existingOperation.argumentsHash !== argumentsHash)) {
        throw new Error('Saved patch operation does not match this tool call')
      }
      if (existingOperation) {
        for (const expected of existingOperation.files || []) {
          const file = await resolveForRead(root, expected.path)
          const source = await fs.readFile(file.absolute, 'utf8')
          const currentHash = sha256(source)
          if (currentHash === expected.postSha256) continue
          if (currentHash !== expected.preSha256) throw new Error(`apply_patch destination changed after durable intent: ${file.relative}`)
          working.set(file.relative, source)
        }
      } else {
        for (const edit of args.edits) {
          const file = await resolveForRead(root, edit.path)
          const source = working.has(file.relative) ? working.get(file.relative)! : await fs.readFile(file.absolute, 'utf8')
          working.set(file.relative, source)
        }
      }
      for (const edit of args.edits) {
        const file = await resolveForRead(root, edit.path)
        if (!working.has(file.relative)) continue
        const source = working.get(file.relative)!
        const oldText = String(edit.old_string)
        const newText = String(edit.new_string)
        if (!oldText) throw new Error('apply_patch old_string cannot be empty')
        const count = source.split(oldText).length - 1
        if (count !== 1) throw new Error(`apply_patch expected one match in ${file.relative}, found ${count}`)
        working.set(file.relative, source.replace(oldText, newText))
      }
      if (!existingOperation) {
        const files = []
        for (const [relative, content] of working) {
          const file = await resolveForRead(root, relative)
          const source = await fs.readFile(file.absolute, 'utf8')
          files.push({ path: relative, preSha256: sha256(source), postSha256: sha256(content) })
        }
        this.run.fileOperations[call.id] = { type: 'apply_patch', argumentsHash, files, status: 'pending' }
        await this.store.save(this.run)
      }
      const results: Array<{ path: string; bytes: number; sha256: string }> = []
      for (const [file, content] of working) results.push(await atomicWrite(root, file, content))
      this.run.fileOperations[call.id].status = 'applied'
      await this.store.save(this.run)
      return JSON.stringify({ ok: true, files: results })
    }
    if (name === 'list_files') return ((await listFiles(root)).join('\n') || 'No files').slice(0, MAX_TOOL_OUTPUT_CHARS)
    if (name === 'grep_files') {
      const pattern = String(args.pattern || '')
      if (!pattern || pattern.length > 300) throw new Error('grep pattern is invalid')
      const needle = args.case_sensitive ? pattern : pattern.toLowerCase()
      const matches: string[] = []
      for (const file of await listFiles(root)) {
        if (matches.length >= 300 || !/\.(?:html|css|js|mjs|cjs|jsx|ts|tsx|json|md)$/i.test(file)) continue
        const resolved = await resolveForRead(root, file)
        if (resolved.stat.size > 2 * 1024 * 1024) continue
        const lines = (await fs.readFile(resolved.absolute, 'utf8')).split(/\r?\n/)
        lines.forEach((line, index) => {
          if (matches.length < 300 && (args.case_sensitive ? line : line.toLowerCase()).includes(needle)) matches.push(`${file}:${index + 1}:${line}`)
        })
      }
      return (matches.join('\n') || 'No matches').slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    if (name === 'read_reference_media') {
      const observations = Array.isArray(this.run.mediaObservations) ? this.run.mediaObservations : []
      const inputItems = Array.isArray(this.run.inputItems) ? this.run.inputItems : []
      const requested = Array.isArray(args.media_ids)
        ? args.media_ids.map(String).filter(Boolean).slice(0, 8)
        : []
      if (typeof args.image_path === 'string' && args.image_path) {
        const matches = (Array.isArray(this.run.references) ? this.run.references : []).filter((value) => (
          [value?.privatePath, value?.originalName, value?.path].includes(args.image_path)
        ))
        if (matches.length !== 1 || !matches[0]?.id) throw new Error('Legacy image_path must uniquely match an attachment in this Turn')
        requested.push(matches[0].id)
      }
      if (!requested.length) throw new Error('read_reference_media requires media_ids')
      const items = requested.map((mediaId) => {
        const inputItem = inputItems.find((item) => {
          const attachmentId = item.type === 'attachment'
            ? item.attachment.id
            : item.type === 'image' || item.type === 'localImage'
              ? item.attachmentId
              : undefined
          const itemMediaId = item.type === 'image' || item.type === 'localImage' ? item.mediaId : undefined
          return item.id === mediaId || attachmentId === mediaId || itemMediaId === mediaId
        })
        const attachmentId = inputItem?.type === 'attachment'
          ? inputItem.attachment.id
          : inputItem?.type === 'image' || inputItem?.type === 'localImage'
            ? inputItem.attachmentId || mediaId
            : mediaId
        const observation = observations.find((value) => value?.id === mediaId
          || value?.attachmentId === attachmentId
          || value?.mediaId === mediaId)
        if (observation) return { sourceItemId: inputItem?.id || null, attachmentId, observation }
        if ((this.run.mode === 'byok' || this.run.visionCapability?.vision === true) && inputItem && (inputItem.type === 'image' || inputItem.type === 'localImage'
          || inputItem.type === 'attachment' && inputItem.attachment.kind === 'image')) {
          return { sourceItemId: inputItem.id, attachmentId, status: 'direct_turn_input', note: 'The original image was projected directly as a Turn input.' }
        }
        if (this.run.referenceSummary && args.image_path) {
          return { sourceItemId: inputItem?.id || null, attachmentId, status: 'legacy_aggregate', summary: String(this.run.referenceSummary) }
        }
        throw new Error(`No media observation is available for ${mediaId}`)
      })
      return JSON.stringify({ items }).slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    if (name === 'shell') {
      if (!this.allowShell) throw new Error('Project code execution is disabled. Review the workspace, then restart with --allow-shell only if you accept local-user filesystem access.')
      const result = await runCommand(root, args.command, args.timeout_ms)
      return JSON.stringify({ ...result, output: redactWorkspacePath(result.output, root) }).slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    if (name === 'validate_project') {
      const result = await validateProject(root)
      this.run.lastValidation = result
      await this.store.save(this.run)
      return JSON.stringify(result).slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    if (name === 'finish') {
      if (!this.run.lastValidation?.ok) throw new Error('finish requires a passing validate_project result')
      const openTodos = agentPlanOpenBlockingTodosForFinish(this.run.plan)
      if (openTodos.length) throw new Error(`finish requires completed implementation todos: ${openTodos.map((todo) => todo.title).join(', ')}`)
      this.run.plan = completePublishTodosForFinish(this.run.plan) ?? null
      await this.store.save(this.run)
      return JSON.stringify({ ok: true, finished: true, validation: this.run.lastValidation })
    }
    if (name === 'generate_image') {
      if (!this.run.generateImages || (this.run.mode === 'orbit' && !this.api)) throw new Error('Image generation was not enabled for this run')
      const outputPath = relativePath(args.output_path)
      this.run.assetImages ||= {}
      this.run.assetImages[call.id] ||= {}
      const reusable = await reusableGeneratedImage(this.run, root, outputPath)
      if (reusable) {
        this.run.assetImages[call.id] = {
          ...this.run.assetImages[call.id],
          outputPath,
          output: reusable.output,
          reusedFromCallId: reusable.callId,
        }
        await this.store.save(this.run)
        return JSON.stringify({ ...providerAssetResult(reusable.output), reused: true }).slice(0, MAX_TOOL_OUTPUT_CHARS)
      }
      this.run.assetImages[call.id].outputPath = outputPath
      await this.store.save(this.run)
      const result = await this.image.generate({
        mode: this.run.mode,
        api: this.api,
        workspace: root,
        prompt: args.prompt,
        output: outputPath,
        aspectRatio: args.aspect_ratio || '1:1',
        state: this.run.assetImages[call.id],
        retryUnsafe: this.retryUnsafe,
        signal: this.signal,
        clientRunId: `${this.run.id}.image.${String(call.id).replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80)}`,
        requestKey: `image_${String(call.id).replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 120)}`,
        persist: async () => this.store.save(this.run),
      })
      return JSON.stringify(providerAssetResult(result)).slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    if (name === 'generate_3d_model') {
      if (!this.run.generate3d) throw new Error('3D generation was not enabled for this run')
      this.run.asset3d ||= {}
      const result = await this.threeD.generate({
        mode: 'byok', workspace: root, prompt: args.prompt, output: args.output_path,
        faceCount: args.face_count, enablePbr: args.enable_pbr, state: this.run.asset3d,
        signal: this.signal, persist: async () => this.store.save(this.run),
      })
      return JSON.stringify(providerAssetResult(result))
    }
    if (name === 'generate_humanoid_character') {
      if (!this.run.generate3d || !this.run.cloudRunId) throw new Error('Official 3D generation is unavailable for this run')
      const requestKey = `humanoid_${call.id}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128)
      let envelope = await this.api.startHumanoid(this.run.cloudRunId, requestKey, String(args.prompt).slice(0, 1024))
      const deadline = Date.now() + 20 * 60_000
      while (true) {
        const job = envelope.job
        const status = String(job?.status || '')
        const jobId = String(job?.job_id || '')
        if (status === 'succeeded') return JSON.stringify({ ...job.manifest, generationJobRef: `job:${jobId}`, cadeCharged: Number(job.cade_charged || 0) }).slice(0, MAX_TOOL_OUTPUT_CHARS)
        if (status === 'failed' || status === 'canceled') throw new Error(String(job?.error?.code || `ENGINE_HUMANOID_${status.toUpperCase()}`))
        if (!jobId || Date.now() >= deadline) throw new Error('ENGINE_HUMANOID_GENERATION_TIMEOUT')
        await sleep(Math.max(1_000, Math.min(5_000, Number(envelope.poll_after_ms) || 5_000)), this.signal)
        envelope = await this.api.humanoidStatus(this.run.cloudRunId, jobId)
      }
    }
    throw new Error(`Unsupported tool: ${name}`)
  }
}
