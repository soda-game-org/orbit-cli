import fs from 'node:fs/promises'
import path from 'node:path'
import { RUN_SCHEMA } from './constants.mjs'
import { appDirectories, ensurePrivateDirectory, id, isRecord, readJson, writeJsonAtomic } from './util.mjs'

const RESUMABLE_STATES = new Set(['queued', 'running', 'recovering', 'interrupted', 'paused'])
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled'])

function pendingToolNeedsUnsafeRetry(run) {
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

export class RunStore {
  constructor({ directories = appDirectories(), now = () => new Date() } = {}) {
    this.directories = directories
    this.now = now
    this.root = path.join(directories.data, 'runs')
  }

  async create(input) {
    const runId = input.id || id('run_')
    if (!/^run_[0-9a-f-]{36}$/.test(runId)) throw new TypeError('Run id is invalid')
    const timestamp = this.now().toISOString()
    const run = {
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
      unsafeResumeRequired: false,
      lastError: null,
      result: null,
    }
    await this.save(run)
    await this.appendEvent(run.id, 'run_created', { source: run.source, mode: run.mode })
    return run
  }

  directory(runId) {
    if (!/^run_[0-9a-f-]{36}$/.test(runId)) throw new TypeError('Run id is invalid')
    return path.join(this.root, runId)
  }

  async load(runId) {
    const run = await readJson(path.join(this.directory(runId), 'checkpoint.json'))
    if (!isRecord(run) || run.schema !== RUN_SCHEMA || run.id !== runId) throw new Error(`Run checkpoint is missing or invalid: ${runId}`)
    return run
  }

  async save(run) {
    if (!isRecord(run) || run.schema !== RUN_SCHEMA) throw new TypeError('Run checkpoint is invalid')
    run.updatedAt = this.now().toISOString()
    await writeJsonAtomic(path.join(this.directory(run.id), 'checkpoint.json'), run)
    return run
  }

  async transition(run, state, patch = {}) {
    if (![...RESUMABLE_STATES, ...TERMINAL_STATES].includes(state)) throw new TypeError('Run state is invalid')
    Object.assign(run, patch, { state })
    if (state === 'running' && !run.startedAt) run.startedAt = this.now().toISOString()
    if (TERMINAL_STATES.has(state)) run.finishedAt = this.now().toISOString()
    await this.save(run)
    await this.appendEvent(run.id, `run_${state}`, { errorCode: run.lastError?.code || null })
    return run
  }

  async appendEvent(runId, type, fields = {}) {
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

  async list() {
    await ensurePrivateDirectory(this.root)
    const entries = await fs.readdir(this.root, { withFileTypes: true })
    const runs = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^run_[0-9a-f-]{36}$/.test(entry.name)) continue
      const run = await this.load(entry.name).catch(() => null)
      if (run) runs.push(run)
    }
    return runs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  }

  async recoverInterrupted() {
    const recovered = []
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

  async isActive(runId) {
    const value = await readJson(path.join(this.directory(runId), 'active.lock'), null)
    const pid = Number(value?.pid)
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async acquire(runId) {
    const lock = path.join(this.directory(runId), 'active.lock')
    await ensurePrivateDirectory(this.directory(runId))
    try {
      const handle = await fs.open(lock, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: this.now().toISOString() }))
      await handle.close()
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const value = await readJson(lock, {})
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

function safeEventFields(fields) {
  const allowed = {}
  for (const key of ['source', 'mode', 'toolName', 'success', 'durationMs', 'errorCode', 'iteration', 'state', 'requestKey']) {
    const value = fields[key]
    if (typeof value === 'string') allowed[key] = value.slice(0, 160)
    else if (typeof value === 'number' && Number.isFinite(value)) allowed[key] = value
    else if (typeof value === 'boolean' || value === null) allowed[key] = value
  }
  return allowed
}
