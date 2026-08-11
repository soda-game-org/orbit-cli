import fs from 'node:fs/promises'
import path from 'node:path'
import { RUN_SCHEMA } from './constants.mjs'
import { appDirectories, canonicalDirectory, ensurePrivateDirectory, id, isContained, isRecord, readJson, writeJsonAtomic, type AppDirectories } from './util.mjs'
import type { OrbitRun, OrbitRunCreateInput, OrbitRunState } from './types.mjs'

const RESUMABLE_STATES = new Set<OrbitRunState>(['queued', 'running', 'recovering', 'interrupted', 'paused'])
const TERMINAL_STATES = new Set<OrbitRunState>(['completed', 'failed', 'cancelled'])

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

export class RunStore {
  readonly directories: AppDirectories
  readonly now: () => Date
  readonly root: string

  constructor({ directories = appDirectories(), now = () => new Date() }: { directories?: AppDirectories; now?: () => Date } = {}) {
    this.directories = directories
    this.now = now
    this.root = path.join(directories.data, 'runs')
  }

  async create(input: OrbitRunCreateInput): Promise<OrbitRun> {
    const runId = input.id || id('run_')
    if (!/^run_[0-9a-f-]{36}$/.test(runId)) throw new TypeError('Run id is invalid')
    const timestamp = this.now().toISOString()
    const run: OrbitRun = {
      schema: RUN_SCHEMA,
      id: runId,
      source: input.source === 'cli_gui' ? 'cli_gui' : 'cli',
      state: 'queued',
      operation: input.operation === 'edit' ? 'edit' : 'create',
      prompt: String(input.prompt || '').slice(0, 32_000),
      workspace: input.workspace,
      mode: input.mode === 'byok' ? 'byok' : 'orbit',
      provider: input.provider || null,
      model: input.model || '',
      runtime: input.runtime || 'html',
      generateImages: input.generateImages === true,
      generate3d: input.generate3d === true,
      cloudLogs: input.cloudLogs === true,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      finishedAt: null,
      sequence: 0,
      iteration: 0,
      messages: [],
      references: input.references || [],
      referenceSummary: null,
      plan: null,
      cloudRunId: null,
      pendingModelCall: null,
      pendingTool: null,
      pendingToolBatch: null,
      pendingToolBatchControl: null,
      executionState: null,
      unsafeResumeRequired: false,
      lastError: null,
      result: null,
    }
    await this.save(run)
    await this.appendEvent(run.id, 'run_created', { source: run.source, mode: run.mode })
    return run
  }

  directory(runId: string): string {
    if (!/^run_[0-9a-f-]{36}$/.test(runId)) throw new TypeError('Run id is invalid')
    return path.join(this.root, runId)
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

  async list(): Promise<OrbitRun[]> {
    await ensurePrivateDirectory(this.root)
    const entries = await fs.readdir(this.root, { withFileTypes: true })
    const runs: OrbitRun[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^run_[0-9a-f-]{36}$/.test(entry.name)) continue
      const run = await this.load(entry.name).catch(() => null)
      if (run) runs.push(run)
    }
    return runs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  }

  /**
   * Rebind every checkpoint for one workspace after the user moves its folder.
   * The old directory may be missing; the replacement must be an explicit,
   * existing, non-symlink local directory.
   */
  async relocateWorkspace(runId: string, nextWorkspace: string): Promise<{ previousWorkspace: string; workspace: string; updatedRunIds: string[] }> {
    const anchor = await this.load(runId)
    const previousRoot = path.resolve(String(anchor.workspace || ''))
    if (!path.isAbsolute(previousRoot) || previousRoot === path.parse(previousRoot).root) {
      throw new Error('Saved workspace path is invalid')
    }
    const nextRoot = await canonicalDirectory(path.resolve(String(nextWorkspace || '')))
    const affected = (await this.list()).filter((run) => path.resolve(String(run.workspace || '')) === previousRoot)
    for (const run of affected) {
      if (await this.isActive(run.id)) throw new Error(`Run ${run.id} is active; stop it before relocating the workspace`)
    }
    if (previousRoot === nextRoot) {
      return { previousWorkspace: previousRoot, workspace: nextRoot, updatedRunIds: affected.map((run) => run.id) }
    }
    for (const run of affected) {
      run.workspace = nextRoot
      if (isRecord(run.result) && typeof run.result.workspace === 'string') {
        run.result.workspace = String(rebaseStoredPath(run.result.workspace, previousRoot, nextRoot))
      }
      if (Array.isArray(run.references)) {
        run.references = run.references.map((reference) => isRecord(reference) && typeof reference.path === 'string'
          ? { ...reference, path: String(rebaseStoredPath(reference.path, previousRoot, nextRoot)) }
          : reference)
      }
      await this.save(run)
      await this.appendEvent(run.id, 'workspace_relocated')
    }
    return { previousWorkspace: previousRoot, workspace: nextRoot, updatedRunIds: affected.map((run) => run.id) }
  }

  async recoverInterrupted(): Promise<OrbitRun[]> {
    const recovered: OrbitRun[] = []
    for (const run of await this.list()) {
      if (run.state !== 'running' && run.state !== 'recovering') continue
      if (await this.isActive(run.id)) continue
      const pendingUnsafe = run.mode === 'byok' && Boolean(run.pendingModelCall)
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
      recovered.push(run)
    }
    return recovered
  }

  async isActive(runId: string): Promise<boolean> {
    const value = await readJson<Record<string, unknown> | null>(path.join(this.directory(runId), 'active.lock'), null)
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
    try {
      const handle = await fs.open(lock, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: this.now().toISOString() }))
      await handle.close()
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
      const value = await readJson<Record<string, unknown>>(lock, {})
      const pid = Number(value?.pid)
      let active = false
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); active = true } catch {}
      }
      if (active) throw new Error(`Run ${runId} is active in process ${pid}`)
      await fs.unlink(lock)
      return this.acquire(runId)
    }
    return async () => { await fs.unlink(lock).catch(() => undefined) }
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
