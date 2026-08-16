import fs from 'node:fs/promises'
import path from 'node:path'
import { RUN_SCHEMA } from './constants.mjs'
import { appDirectories, canonicalDirectory, ensurePrivateDirectory, id, isContained, isOrbitRunId, isRecord, readJson, sha256, writeJsonAtomic, type AppDirectories } from './util.mjs'
import type { OrbitRun, OrbitRunCreateInput, OrbitRunState } from './types.mjs'
import { ConversationStore } from './conversation-store.mjs'
import type { OrbitAgentInputItem } from '@soda_game/orbit-agent-core'

const RESUMABLE_STATES = new Set<OrbitRunState>(['queued', 'running', 'recovering', 'interrupted', 'paused'])
const TERMINAL_STATES = new Set<OrbitRunState>(['completed', 'failed', 'cancelled'])
const RELOCATION_SCHEMA = 'orbit.cli-workspace-relocation.v1' as const

interface WorkspaceRelocationIntent {
  schema: typeof RELOCATION_SCHEMA
  anchorRunId: string
  previousWorkspace: string
  previousWorkspaceAliases?: string[]
  workspace: string
  projectId?: string | null
  runIds: string[]
  completedRunIds: string[]
  state: 'pending' | 'completed'
  createdAt: string
  updatedAt: string
}

function assertRelocationIntent(value: unknown, expectedAnchorRunId?: string): asserts value is WorkspaceRelocationIntent {
  const intent = value as WorkspaceRelocationIntent
  if (!isRecord(intent) || intent.schema !== RELOCATION_SCHEMA
    || !isOrbitRunId(intent.anchorRunId)
    || expectedAnchorRunId && intent.anchorRunId !== expectedAnchorRunId
    || !path.isAbsolute(intent.previousWorkspace) || !path.isAbsolute(intent.workspace)
    || !Array.isArray(intent.runIds) || !Array.isArray(intent.completedRunIds)
    || !intent.runIds.every(isOrbitRunId) || !intent.completedRunIds.every(isOrbitRunId)
    || new Set(intent.runIds).size !== intent.runIds.length
    || new Set(intent.completedRunIds).size !== intent.completedRunIds.length
    || !intent.runIds.includes(intent.anchorRunId)
    || !intent.completedRunIds.every((id) => intent.runIds.includes(id))
    || !['pending', 'completed'].includes(intent.state)) {
    throw new Error(`Run ${expectedAnchorRunId || intent?.anchorRunId || 'unknown'} workspace relocation journal is invalid`)
  }
}

function pendingToolNeedsUnsafeRetry(run: OrbitRun): boolean {
  const pending = run.pendingTool
  if (!pending) return false
  if (pending.name === 'shell') return true
  if (pending.name === 'generate_image') {
    const state = run.assetImages?.[pending.id]
    if (state?.output || run.mode === 'byok' && state?.predictionId) return false
    return state?.requestPending === true || run.mode === 'orbit'
  }
  if (pending.name === 'generate_3d_model') return !(run.mode === 'byok' && run.asset3d?.predictionId)
  return false
}

function rebaseStoredPath(value: unknown, previousRoot: string, nextRoot: string): unknown {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return value
  const resolved = path.resolve(value)
  if (resolved === previousRoot) return nextRoot
  return isContained(previousRoot, resolved)
    ? path.join(nextRoot, path.relative(previousRoot, resolved))
    : value
}

function rebaseHostPathFields(value: unknown, previousRoot: string, nextRoot: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => rebaseHostPathFields(entry, previousRoot, nextRoot))
  if (!isRecord(value)) return value
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    output[key] = ['path', 'privatePath', 'sourceRef', 'workspace'].includes(key)
      ? rebaseStoredPath(entry, previousRoot, nextRoot)
      : rebaseHostPathFields(entry, previousRoot, nextRoot)
  }
  return output
}

async function writeJsonExclusive(file: string, value: unknown): Promise<void> {
  const directory = await ensurePrivateDirectory(path.dirname(file))
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${id()}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
    await handle.close()
    handle = null
    await fs.link(temporary, file)
    const directoryHandle = await fs.open(directory, 'r').catch(() => null)
    if (directoryHandle) {
      try { await directoryHandle.sync() } catch {} finally { await directoryHandle.close() }
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await fs.unlink(temporary).catch(() => undefined)
  }
}

export class RunStore {
  readonly directories: AppDirectories
  readonly now: () => Date
  readonly root: string
  readonly conversations: ConversationStore

  constructor({ directories = appDirectories(), now = () => new Date() }: { directories?: AppDirectories; now?: () => Date } = {}) {
    this.directories = directories
    this.now = now
    this.root = path.join(directories.data, 'runs')
    this.conversations = new ConversationStore({ directories, now })
  }

  async create(input: OrbitRunCreateInput): Promise<OrbitRun> {
    const runId = input.id || id('run_')
    if (!isOrbitRunId(runId)) throw new TypeError('Run id is invalid')
    const timestamp = this.now().toISOString()
    const run: OrbitRun = {
      schema: RUN_SCHEMA,
      id: runId,
      source: input.source === 'cli_gui' ? 'cli_gui' : 'cli',
      state: 'queued',
      operation: input.operation === 'edit' ? 'edit' : 'create',
      prompt: String(input.prompt || '').slice(0, 32_000),
      workspace: input.workspace,
      historicalWorkspaceRoots: Array.isArray(input.historicalWorkspaceRoots)
        ? [...new Set(input.historicalWorkspaceRoots.map(String).filter((value) => path.isAbsolute(value)))].slice(-8)
        : [],
      mode: input.mode === 'byok' ? 'byok' : 'orbit',
      provider: input.provider || null,
      model: input.model || '',
      runtime: input.runtime || 'auto',
      generateImages: input.generateImages === true,
      generate3d: input.generate3d === true,
      cloudLogs: input.cloudLogs === true,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      finishedAt: null,
      sequence: 0,
      iteration: 0,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      messages: Array.isArray(input.messages) ? structuredClone(input.messages) : [],
      inputItems: Array.isArray(input.inputItems) ? structuredClone(input.inputItems) : [],
      mediaObservations: Array.isArray(input.mediaObservations) ? structuredClone(input.mediaObservations) : [],
      mediaCache: input.mediaCache ? structuredClone(input.mediaCache) : { schema: 'orbit.agent-media-cache.v1', entries: [] },
      ...(input.visionCapability ? { visionCapability: structuredClone(input.visionCapability) } : {}),
      turnInputProjected: false,
      references: input.references || [],
      ...(input.kind === 'assetimage' || input.kind === 'asset3d' ? { kind: input.kind } : {}),
      ...(input.kind === 'assetimage' ? {
        assetImage: structuredClone(input.assetImage || {}),
        assetOutput: String(input.assetOutput || 'assets/images/generated.png'),
        assetAspectRatio: String(input.assetAspectRatio || '1:1'),
      } : {}),
      ...(input.kind === 'asset3d' ? {
        asset3d: structuredClone(input.asset3d || {}),
        assetOutput: String(input.assetOutput || 'assets/models/generated.glb'),
      } : {}),
      referenceSummary: null,
      plan: null,
      cloudRunId: null,
      pendingSemanticCompaction: null,
      compactionDeferredFingerprint: null,
      pendingModelCall: null,
      pendingTool: null,
      pendingToolBatch: null,
      pendingToolBatchControl: null,
      executionState: null,
      unsafeResumeRequired: false,
      lastError: null,
      result: null,
    }
    await writeJsonExclusive(path.join(this.directory(run.id), 'checkpoint.json'), run)
    await this.appendEvent(run.id, 'run_created', { source: run.source, mode: run.mode })
    return run
  }

  async withThreadLease<T>(threadId: string, callback: () => Promise<T>): Promise<T> {
    if (!/^thread_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(threadId)) {
      throw new TypeError('Thread id is invalid')
    }
    const directory = await ensurePrivateDirectory(path.join(this.directories.data, 'thread-leases'))
    const lock = path.join(directory, `${threadId}.lock`)
    const token = id('lease_')
    const owner = { pid: process.pid, token, createdAt: this.now().toISOString() }
    let acquired = false
    for (let count = 0; count < 3_000; count += 1) {
      try {
        await writeJsonExclusive(lock, owner)
        acquired = true
        break
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
        const stat = await fs.lstat(lock).catch(() => null)
        const current = await readJson<Record<string, unknown> | null>(lock, null).catch(() => null)
        const pid = Number(current?.pid)
        let live = false
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); live = true } catch {}
        }
        const valid = typeof current?.token === 'string' && current.token.length > 0
        const age = stat ? Date.now() - stat.mtimeMs : 0
        if (live || !valid && age < 1_000) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          continue
        }
        const latest = await fs.lstat(lock).catch(() => null)
        if (stat && latest && stat.dev === latest.dev && stat.ino === latest.ino) await fs.unlink(lock).catch(() => undefined)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    if (!acquired) throw new Error(`Timed out acquiring session creation lease: ${threadId}`)
    const heartbeat = setInterval(async () => {
      const current = await readJson<Record<string, unknown> | null>(lock, null).catch(() => null)
      if (current?.token === token) await fs.utimes(lock, new Date(), new Date()).catch(() => undefined)
    }, 5_000)
    heartbeat.unref?.()
    try {
      return await callback()
    } finally {
      clearInterval(heartbeat)
      const current = await readJson<Record<string, unknown> | null>(lock, null).catch(() => null)
      if (current?.token === token) await fs.unlink(lock).catch(() => undefined)
    }
  }

  async acquireWorkspace(workspace: string, { allowMissing = false }: { allowMissing?: boolean } = {}): Promise<() => Promise<void>> {
    const resolved = path.resolve(String(workspace || ''))
    if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root) throw new TypeError('Workspace is invalid')
    const canonical = await canonicalDirectory(resolved).catch((error) => {
      if (allowMissing && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return resolved
      throw error
    })
    const directory = await ensurePrivateDirectory(path.join(this.directories.data, 'workspace-leases'))
    const lock = path.join(directory, `${sha256(canonical)}.lock`)
    const token = id('lease_')
    const owner = { pid: process.pid, token, workspace: canonical, createdAt: this.now().toISOString() }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await writeJsonExclusive(lock, owner)
        const heartbeat = setInterval(async () => {
          const current = await readJson<Record<string, unknown> | null>(lock, null).catch(() => null)
          if (current?.token === token) await fs.utimes(lock, new Date(), new Date()).catch(() => undefined)
        }, 5_000)
        heartbeat.unref?.()
        return async () => {
          clearInterval(heartbeat)
          const current = await readJson<Record<string, unknown> | null>(lock, null).catch(() => null)
          if (current?.token === token) await fs.unlink(lock).catch(() => undefined)
        }
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
        const stat = await fs.lstat(lock).catch(() => null)
        if (!stat) continue
        const current = await readJson<Record<string, unknown> | null>(lock, null).catch(() => null)
        const pid = Number(current?.pid)
        let live = false
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); live = true } catch {}
        }
        if (live) throw Object.assign(new Error(`Project workspace is already active in process ${pid}`), { code: 'WORKSPACE_ACTIVE' })
        if ((!current || typeof current.token !== 'string') && Date.now() - stat.mtimeMs < 1_000) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          continue
        }
        const latest = await fs.lstat(lock).catch(() => null)
        if (latest && latest.dev === stat.dev && latest.ino === stat.ino) await fs.unlink(lock).catch(() => undefined)
      }
    }
    throw new Error(`Timed out acquiring project workspace lease: ${canonical}`)
  }

  directory(runId: string): string {
    if (!isOrbitRunId(runId)) throw new TypeError('Run id is invalid')
    return path.join(this.root, runId)
  }

  #relocationFile(runId: string): string {
    if (!isOrbitRunId(runId)) throw new TypeError('Run id is invalid')
    return path.join(this.directories.data, 'relocations', `${runId}.json`)
  }

  async load(runId: string): Promise<OrbitRun> {
    const run = await readJson<unknown>(path.join(this.directory(runId), 'checkpoint.json'))
    if (!isRecord(run) || run.schema !== RUN_SCHEMA || run.id !== runId) throw new Error(`Run checkpoint is missing or invalid: ${runId}`)
    return run as OrbitRun
  }

  async save(run: OrbitRun): Promise<OrbitRun> {
    if (!isRecord(run) || run.schema !== RUN_SCHEMA) throw new TypeError('Run checkpoint is invalid')
    run.updatedAt = this.now().toISOString()
    await writeJsonAtomic(path.join(this.directory(run.id), 'checkpoint.json'), run)
    return run
  }

  async transition(run: OrbitRun, state: OrbitRunState, patch: Partial<OrbitRun> = {}): Promise<OrbitRun> {
    if (![...RESUMABLE_STATES, ...TERMINAL_STATES].includes(state)) throw new TypeError('Run state is invalid')
    Object.assign(run, patch, { state })
    if (state === 'running' && !run.startedAt) run.startedAt = this.now().toISOString()
    if (TERMINAL_STATES.has(state)) run.finishedAt = this.now().toISOString()
    await this.save(run)
    await this.appendEvent(run.id, `run_${state}`, { errorCode: run.lastError?.code || null })
    return run
  }

  async appendEvent(runId: string, type: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const directory = await ensurePrivateDirectory(this.directory(runId))
    const event = {
      id: id(),
      occurredAt: this.now().toISOString(),
      type: String(type).slice(0, 80),
      ...safeEventFields(fields),
    }
    await fs.appendFile(path.join(directory, 'events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 })
    return event
  }

  async events(runId: string): Promise<Record<string, unknown>[]> {
    const file = path.join(this.directory(runId), 'events.jsonl')
    let source = ''
    try {
      source = await fs.readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw new Error(`Run event history is unexpectedly large: ${runId}`)
    return source.split(/\r?\n/).filter(Boolean).slice(-500).flatMap((line) => {
      try {
        const event: unknown = JSON.parse(line)
        return isRecord(event) ? [event] : []
      } catch {
        return []
      }
    })
  }

  async #listRuns(): Promise<OrbitRun[]> {
    await ensurePrivateDirectory(this.root)
    const entries = await fs.readdir(this.root, { withFileTypes: true })
    const runs: OrbitRun[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !isOrbitRunId(entry.name)) continue
      const run = await this.load(entry.name).catch(() => null)
      if (run) runs.push(run)
    }
    return runs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  }

  async #recoverPendingRelocations(): Promise<void> {
    const directory = path.join(this.directories.data, 'relocations')
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const runId = entry.name.slice(0, -5)
      if (!isOrbitRunId(runId)) throw new Error(`Workspace relocation journal has an invalid filename: ${entry.name}`)
      const intent = await readJson<WorkspaceRelocationIntent>(path.join(directory, entry.name))
      assertRelocationIntent(intent, runId)
      if (intent.state === 'pending') await this.relocateWorkspace(runId, intent.workspace)
      else await this.#assertCompletedRelocation(intent)
    }
  }

  async #assertCompletedRelocation(intent: WorkspaceRelocationIntent): Promise<void> {
    if (intent.completedRunIds.length !== intent.runIds.length) {
      throw new Error(`Run ${intent.anchorRunId} completed relocation cursor is incomplete`)
    }
    for (const affectedRunId of intent.runIds) {
      const run = await this.load(affectedRunId)
      if (path.resolve(String(run.workspace || '')) !== path.resolve(intent.workspace)) {
        throw new Error(`Run ${affectedRunId} relocation cursor does not match its checkpoint`)
      }
    }
  }

  async list(): Promise<OrbitRun[]> {
    await this.#recoverPendingRelocations()
    return this.#listRuns()
  }

  /**
   * Rebind every checkpoint for one workspace after the user moves its folder.
   * The old directory may be missing; the replacement must be an explicit,
   * existing, non-symlink local directory.
   */
  async relocateWorkspace(runId: string, nextWorkspace: string): Promise<{ previousWorkspace: string; workspace: string; updatedRunIds: string[] }> {
    let intent = await readJson<WorkspaceRelocationIntent | null>(this.#relocationFile(runId), null)
    const requestedNext = await canonicalDirectory(path.resolve(String(nextWorkspace || '')))
    if (intent) assertRelocationIntent(intent, runId)
    if (intent?.state === 'completed') {
      await this.#assertCompletedRelocation(intent)
      if (intent.workspace === requestedNext) {
        return { previousWorkspace: intent.previousWorkspace, workspace: intent.workspace, updatedRunIds: intent.runIds }
      }
      // A completed journal is immutable history, not a permanent claim on
      // this anchor. A later folder move starts a fresh generation below.
      intent = null
    }
    if (intent && (intent.schema !== RELOCATION_SCHEMA || intent.anchorRunId !== runId || intent.workspace !== requestedNext)) {
      throw new Error(`Run ${runId} has a conflicting workspace relocation intent`)
    }
    const anchor = await this.load(runId)
    const previousRoot = intent?.previousWorkspace || path.resolve(String(anchor.workspace || ''))
    if (!path.isAbsolute(previousRoot) || previousRoot === path.parse(previousRoot).root) throw new Error('Saved workspace path is invalid')
    const roots = [...new Set([previousRoot, requestedNext])].sort()
    const workspaceReleases: Array<() => Promise<void>> = []
    const runReleases: Array<() => Promise<void>> = []
    try {
      for (const root of roots) workspaceReleases.push(await this.acquireWorkspace(root, { allowMissing: root === previousRoot }))
      intent = await readJson<WorkspaceRelocationIntent | null>(this.#relocationFile(runId), null)
      if (intent) assertRelocationIntent(intent, runId)
      if (intent?.state === 'completed' && intent.workspace !== requestedNext) {
        await this.#assertCompletedRelocation(intent)
        intent = null
      }
      if (!intent) {
        const affected = (await this.#listRuns())
          .filter((run) => path.resolve(String(run.workspace || '')) === previousRoot)
          .sort((left, right) => left.id.localeCompare(right.id))
        if (previousRoot === requestedNext) {
          return { previousWorkspace: previousRoot, workspace: requestedNext, updatedRunIds: affected.map((run) => run.id) }
        }
        const now = this.now().toISOString()
        const linkedProjectId = (await this.conversations.linkForRun(runId))?.projectId
        const linkedProject = linkedProjectId ? await this.conversations.project(linkedProjectId) : null
        intent = {
          schema: RELOCATION_SCHEMA,
          anchorRunId: runId,
          previousWorkspace: previousRoot,
          previousWorkspaceAliases: [...new Set([
            previousRoot,
            String(anchor.workspace || ''),
            String(linkedProject?.rootRef || ''),
          ].filter((value) => path.isAbsolute(value)))],
          workspace: requestedNext,
          projectId: linkedProjectId || await this.conversations.relocationProjectId(previousRoot, requestedNext),
          runIds: affected.map((run) => run.id),
          completedRunIds: [],
          state: 'pending',
          createdAt: now,
          updatedAt: now,
        }
        await writeJsonAtomic(this.#relocationFile(runId), intent)
      }
      if (!intent || intent.schema !== RELOCATION_SCHEMA || intent.previousWorkspace !== previousRoot || intent.workspace !== requestedNext) {
        throw new Error(`Run ${runId} workspace relocation intent is invalid`)
      }
      const relocation = intent
      if (relocation.projectId === undefined) {
        relocation.projectId = await this.conversations.relocationProjectId(previousRoot, requestedNext)
        relocation.updatedAt = this.now().toISOString()
        await writeJsonAtomic(this.#relocationFile(runId), relocation)
      }
      for (const affectedRunId of relocation.runIds) runReleases.push(await this.acquire(affectedRunId))
      const completed = new Set(relocation.completedRunIds)
      const alreadyMoved: string[] = []
      for (const affectedRunId of relocation.runIds) {
        const run = await this.load(affectedRunId)
        const currentWorkspace = path.resolve(String(run.workspace || ''))
        if (completed.has(affectedRunId) && currentWorkspace !== requestedNext) {
          throw new Error(`Run ${affectedRunId} relocation cursor does not match its checkpoint`)
        }
        if (!completed.has(affectedRunId) && currentWorkspace !== previousRoot && currentWorkspace !== requestedNext) {
          throw new Error(`Run ${affectedRunId} moved outside the durable relocation intent`)
        }
        if (!completed.has(affectedRunId) && currentWorkspace === requestedNext) alreadyMoved.push(affectedRunId)
      }
      if (relocation.state === 'completed') {
        if (completed.size !== relocation.runIds.length) throw new Error(`Run ${runId} completed relocation cursor is incomplete`)
        return { previousWorkspace: previousRoot, workspace: requestedNext, updatedRunIds: relocation.runIds }
      }
      if (alreadyMoved.length) {
        for (const movedRunId of alreadyMoved) completed.add(movedRunId)
        relocation.completedRunIds = [...completed]
        relocation.updatedAt = this.now().toISOString()
        await writeJsonAtomic(this.#relocationFile(runId), relocation)
      }
      await this.conversations.withProjectRelocation(previousRoot, requestedNext, async () => {
      for (const affectedRunId of relocation.runIds) {
        const run = await this.load(affectedRunId)
        const currentWorkspace = path.resolve(String(run.workspace || ''))
        if (currentWorkspace !== previousRoot && currentWorkspace !== requestedNext) {
          throw new Error(`Run ${run.id} moved outside the durable relocation intent`)
        }
        if (!completed.has(run.id)) {
          if (currentWorkspace === previousRoot) {
            run.workspace = requestedNext
            run.historicalWorkspaceRoots = [...new Set([
              ...(Array.isArray(run.historicalWorkspaceRoots) ? run.historicalWorkspaceRoots : []),
              ...(Array.isArray(relocation.previousWorkspaceAliases) ? relocation.previousWorkspaceAliases : []),
              previousRoot,
              String(run.workspace || ''),
            ])].slice(-8)
            run.result = rebaseHostPathFields(run.result, previousRoot, requestedNext) as Record<string, any> | null
            run.references = rebaseHostPathFields(run.references, previousRoot, requestedNext) as typeof run.references
            run.inputItems = rebaseHostPathFields(run.inputItems, previousRoot, requestedNext) as typeof run.inputItems
            run.mediaCache = rebaseHostPathFields(run.mediaCache, previousRoot, requestedNext) as typeof run.mediaCache
            run.assetImages = rebaseHostPathFields(run.assetImages, previousRoot, requestedNext)
            run.assetImage = rebaseHostPathFields(run.assetImage, previousRoot, requestedNext)
            run.asset3d = rebaseHostPathFields(run.asset3d, previousRoot, requestedNext)
            run.messages = run.messages.map((message) => Array.isArray(message.inputItems)
              ? { ...message, inputItems: rebaseHostPathFields(message.inputItems, previousRoot, requestedNext) }
              : message)
            await this.save(run)
            await this.appendEvent(run.id, 'workspace_relocated')
          }
          completed.add(run.id)
          relocation.completedRunIds = [...completed]
          relocation.updatedAt = this.now().toISOString()
          await writeJsonAtomic(this.#relocationFile(runId), relocation)
        }
      }
      }, relocation.projectId)
      relocation.state = 'completed'
      relocation.updatedAt = this.now().toISOString()
      await writeJsonAtomic(this.#relocationFile(runId), relocation)
      return { previousWorkspace: previousRoot, workspace: requestedNext, updatedRunIds: relocation.runIds }
    } finally {
      for (const release of runReleases.reverse()) await release().catch(() => undefined)
      for (const release of workspaceReleases.reverse()) await release().catch(() => undefined)
    }
  }

  async createThread(workspace: string, title?: string): Promise<import('@soda_game/orbit-agent-core').OrbitAgentThread> {
    return this.conversations.createThread(workspace, { title })
  }

  async ensureThread(workspace: string, threadId?: string, title?: string): Promise<import('@soda_game/orbit-agent-core').OrbitAgentThread> {
    return this.conversations.ensureThread(workspace, threadId, title)
  }

  async listThreads(workspace?: string): Promise<import('./conversation-store.mjs').OrbitCliThreadSnapshot[]> {
    return this.listThreadsFromRuns(await this.list(), workspace)
  }

  async listThreadsFromRuns(runs: OrbitRun[], workspace?: string): Promise<import('./conversation-store.mjs').OrbitCliThreadSnapshot[]> {
    return this.conversations.listThreadSnapshots(runs, workspace)
  }

  async thread(threadId: string): Promise<import('@soda_game/orbit-agent-core').OrbitAgentThread | null> {
    return this.conversations.thread(threadId)
  }

  async projectHasRuns(projectId: string): Promise<boolean> {
    return (await this.conversations.threads()).some((thread) => (
      thread.projectId === projectId
      && thread.turns.some((turn) => isOrbitRunId(turn.metadata?.hostRunId))
    ))
  }

  async latestRunForThread(threadId: string): Promise<OrbitRun | null> {
    const thread = await this.conversations.thread(threadId)
    if (!thread) return null
    for (const turn of [...thread.turns].reverse()) {
      const runId = turn.metadata?.hostRunId
      if (isOrbitRunId(runId)) return this.load(runId)
    }
    return null
  }

  async linkRunToTurn(input: {
    workspace: string
    threadId: string
    runId: string
    inputItems: OrbitAgentInputItem[]
    baseMessageCount: number
    preferredTurnId?: string
    createdAt?: string
  }): Promise<import('@soda_game/orbit-agent-core').OrbitAgentTurn> {
    return this.conversations.createTurn(input)
  }

  async linkForRun(runId: string): Promise<import('./conversation-store.mjs').OrbitCliRunLink | null> {
    return this.conversations.linkForRun(runId)
  }

  async updateTurnFromRun(run: OrbitRun): Promise<void> {
    await this.conversations.updateTurnFromRun(run)
  }

  async startAttempt(runId: string): Promise<import('./conversation-store.mjs').OrbitCliAttempt> {
    return this.conversations.startAttempt(runId)
  }

  async finishAttempt(
    attemptId: string,
    state: import('./conversation-store.mjs').OrbitCliAttempt['state'],
    errorCode: string | null = null,
  ): Promise<import('./conversation-store.mjs').OrbitCliAttempt> {
    return this.conversations.finishAttempt(attemptId, state, errorCode)
  }

  async attemptsForRun(runId: string): Promise<import('./conversation-store.mjs').OrbitCliAttempt[]> {
    return this.conversations.attemptsForRun(runId)
  }

  async recoverInterrupted(): Promise<OrbitRun[]> {
    const recovered: OrbitRun[] = []
    const candidates = await this.list()
    for (const candidate of candidates) {
      if (candidate.state !== 'running' && candidate.state !== 'recovering') continue
      let release: (() => Promise<void>) | null = null
      try {
        release = await this.acquire(candidate.id)
      } catch (error) {
        if (String((error as Error)?.message || '').includes(' is active in process ')) continue
        throw error
      }
      try {
        const run = await this.load(candidate.id)
        if (run.state !== 'running' && run.state !== 'recovering') continue
        const pendingUnsafe = run.mode === 'byok' && (Boolean(run.pendingModelCall)
          || run.pendingSemanticCompaction?.status === 'pending')
          || pendingToolNeedsUnsafeRetry(run)
          || run.kind === 'assetimage' && run.assetImage?.requestPending && !run.assetImage?.output
          || run.kind === 'asset3d' && run.mode === 'byok' && run.asset3d?.requestPending && !run.asset3d?.predictionId
        run.unsafeResumeRequired = pendingUnsafe
        run.lastError = {
          code: 'LOCAL_PROCESS_INTERRUPTED',
          message: pendingUnsafe
            ? 'The previous process stopped during a non-idempotent operation; explicit retry confirmation is required.'
            : 'The previous process stopped; this run can resume from its last durable checkpoint.',
        }
        await this.transition(run, 'interrupted')
        await this.conversations.interruptRunningAttempts(run.id)
        recovered.push(run)
      } finally {
        await release()
      }
    }
    for (const candidate of candidates) {
      let release: (() => Promise<void>) | null = null
      try {
        release = await this.acquire(candidate.id)
      } catch (error) {
        if (String((error as Error)?.message || '').includes(' is active in process ')) continue
        throw error
      }
      try {
        const run = await this.load(candidate.id).catch(() => null)
        if (!run || run.state === 'running' || run.state === 'recovering') continue
        const attemptState = run.state === 'completed' ? 'completed'
          : run.state === 'cancelled' ? 'cancelled'
            : run.state === 'failed' ? 'failed'
              : run.state === 'paused' ? 'paused'
                : 'interrupted'
        await this.conversations.reconcileRunningAttempts(run.id, attemptState, run.lastError?.code || null)
      } finally {
        await release()
      }
    }
    return recovered
  }

  async isActive(runId: string): Promise<boolean> {
    const lock = path.join(this.directory(runId), 'active.lock')
    const stat = await fs.lstat(lock).catch(() => null)
    if (!stat) return false
    const value = await readJson<Record<string, unknown> | null>(lock, null).catch(() => null)
    if (!value || typeof value.token !== 'string') return Date.now() - stat.mtimeMs < 1_000
    const pid = Number(value?.pid)
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async acquire(runId: string): Promise<() => Promise<void>> {
    const lock = path.join(this.directory(runId), 'active.lock')
    await ensurePrivateDirectory(this.directory(runId))
    const token = id('lease_')
    const owner = { pid: process.pid, token, createdAt: this.now().toISOString() }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await writeJsonExclusive(lock, owner)
        const heartbeat = setInterval(async () => {
          const current = await readJson<Record<string, unknown> | null>(lock, null).catch(() => null)
          if (current?.token === token) await fs.utimes(lock, new Date(), new Date()).catch(() => undefined)
        }, 5_000)
        heartbeat.unref?.()
        return async () => {
          clearInterval(heartbeat)
          const current = await readJson<Record<string, unknown> | null>(lock, null).catch(() => null)
          if (current?.token === token) await fs.unlink(lock).catch(() => undefined)
        }
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
        const stat = await fs.lstat(lock).catch(() => null)
        if (!stat) continue
        const value = await readJson<Record<string, unknown> | null>(lock, null).catch(() => null)
        const pid = Number(value?.pid)
        let active = false
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); active = true } catch {}
        }
        if (active) throw new Error(`Run ${runId} is active in process ${pid}`)
        if ((!value || typeof value.token !== 'string') && Date.now() - stat.mtimeMs < 1_000) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          continue
        }
        const latest = await fs.lstat(lock).catch(() => null)
        if (latest && latest.dev === stat.dev && latest.ino === stat.ino) await fs.unlink(lock).catch(() => undefined)
      }
    }
    throw new Error(`Timed out acquiring run lease: ${runId}`)
  }
}

function safeEventFields(fields: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const allowed: Record<string, string | number | boolean | null> = {}
  for (const key of ['source', 'mode', 'toolName', 'success', 'durationMs', 'errorCode', 'iteration', 'state', 'requestKey']) {
    const value = fields[key]
    if (typeof value === 'string') allowed[key] = value.slice(0, 160)
    else if (typeof value === 'number' && Number.isFinite(value)) allowed[key] = value
    else if (typeof value === 'boolean' || value === null) allowed[key] = value
  }
  return allowed
}
