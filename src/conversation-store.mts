import fs from 'node:fs/promises'
import path from 'node:path'
import {
  normalizeAgentInputItems,
  normalizeAgentProject,
  normalizeAgentThread,
  normalizeAgentTurn,
  type OrbitAgentInputItem,
  type OrbitAgentProject,
  type OrbitAgentThread,
  type OrbitAgentTurn,
} from '@soda_game/orbit-agent-core'
import { canonicalDirectory, ensurePrivateDirectory, id, isRecord, readJson, writeJsonAtomic, type AppDirectories } from './util.mjs'
import type { OrbitMessage, OrbitRun } from './types.mjs'

const RUN_LINK_SCHEMA = 'orbit.cli-run-link.v1' as const
const ATTEMPT_SCHEMA = 'orbit.cli-attempt.v1' as const
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const RUN_ID = new RegExp(`^run_${UUID}$`)
const PROJECT_ID = new RegExp(`^project_${UUID}$`)
const THREAD_ID = new RegExp(`^thread_${UUID}$`)
const TURN_ID = new RegExp(`^turn_${UUID}$`)
const ATTEMPT_ID = new RegExp(`^attempt_${UUID}$`)

export interface OrbitCliRunLink {
  schema: typeof RUN_LINK_SCHEMA
  runId: string
  projectId: string
  threadId: string
  turnId: string
  baseMessageCount: number
  createdAt: string
}

export interface OrbitCliAttempt {
  schema: typeof ATTEMPT_SCHEMA
  id: string
  runId: string
  turnId: string
  ordinal: number
  state: 'running' | 'completed' | 'paused' | 'interrupted' | 'failed' | 'cancelled'
  startedAt: string
  finishedAt: string | null
  errorCode: string | null
}

export interface OrbitCliThreadSnapshot extends OrbitAgentThread {
  workspace: string
  runIds: string[]
  latestRunId: string | null
}

function resolvedWorkspace(value: unknown): string {
  const source = typeof value === 'string' ? value.trim() : ''
  if (!source) throw new TypeError('Project workspace is invalid')
  const workspace = path.resolve(source)
  if (!path.isAbsolute(workspace) || workspace === path.parse(workspace).root) throw new TypeError('Project workspace is invalid')
  return workspace
}

async function canonicalWorkspaceIdentity(value: unknown): Promise<string> {
  let cursor = resolvedWorkspace(value)
  const missing: string[] = []
  while (true) {
    try {
      return path.join(await fs.realpath(cursor), ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(cursor)
      if (parent === cursor) throw error
      missing.unshift(path.basename(cursor))
      cursor = parent
    }
  }
}

function runSuffix(runId: string): string {
  return RUN_ID.test(runId) ? runId.slice(4) : ''
}

function legacyInputItems(run: OrbitRun, turnId: string): OrbitAgentInputItem[] {
  const raw: Record<string, unknown>[] = [{ id: `${turnId}:text`, type: 'text', text: String(run.prompt || '') }]
  for (const [position, reference] of (Array.isArray(run.references) ? run.references : []).entries()) {
    const attachmentId = typeof reference?.id === 'string' && reference.id
      ? reference.id
      : typeof reference?.sha256 === 'string' && reference.sha256
        ? `attachment_${reference.sha256}`
        : `${run.id}:reference:${position}`
    raw.push({
      id: `${turnId}:attachment:${position}`,
      type: 'attachment',
      attachment: {
        id: attachmentId,
        kind: 'image',
        name: reference?.originalName,
        mediaType: reference?.mime,
        sizeBytes: reference?.bytes,
        digest: reference?.sha256,
        sourceRef: reference?.privatePath,
      },
      metadata: { position },
    })
  }
  return normalizeAgentInputItems(raw, { fallbackId: `${turnId}:input` })
}

function finalTurnState(run: OrbitRun): OrbitAgentTurn['state'] {
  if (run.state === 'completed') return 'completed'
  if (run.state === 'failed') return 'failed'
  if (run.state === 'cancelled') return 'cancelled'
  if (run.state === 'interrupted' || run.state === 'paused') return 'interrupted'
  return run.state === 'running' || run.state === 'recovering' ? 'in_progress' : 'pending'
}

function exactMessagePrefix(previous: unknown[], current: unknown[]): boolean {
  if (previous.length > current.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (JSON.stringify(previous[index]) !== JSON.stringify(current[index])) return false
  }
  return true
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value
  return Buffer.from(value).subarray(0, Math.max(0, maximumBytes)).toString('utf8')
}

function displayText(value: unknown, maximumBytes = 32 * 1024): string {
  const source = typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.flatMap((part) => typeof part?.text === 'string' ? [part.text] : []).join('\n')
      : ''
  if (Buffer.byteLength(source) <= maximumBytes) return source
  const marker = '\n[turn display output truncated]\n'
  const allowance = Math.max(0, maximumBytes - Buffer.byteLength(marker))
  return `${utf8Prefix(source, Math.floor(allowance / 2))}${marker}${utf8Prefix(source.slice(Math.floor(source.length / 2)), Math.ceil(allowance / 2))}`
}

function displayMessage(source: OrbitMessage): OrbitMessage | null {
  if (source.role === 'assistant') {
    const calls = (Array.isArray(source.tool_calls) ? source.tool_calls : []).slice(0, 16).flatMap((call) => {
      if (typeof call?.id !== 'string' || call.type !== 'function'
        || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') return []
      return [{
        id: utf8Prefix(call.id, 512),
        type: 'function' as const,
        function: {
          name: utf8Prefix(call.function.name, 512),
          arguments: displayText(call.function.arguments, 4 * 1024),
        },
      }]
    })
    return {
      role: 'assistant',
      content: displayText(source.content),
      ...(calls.length ? { tool_calls: calls } : {}),
    }
  }
  if (source.role === 'tool') {
    if (typeof source.tool_call_id !== 'string') return null
    return {
      role: 'tool',
      tool_call_id: utf8Prefix(source.tool_call_id, 512),
      content: displayText(source.content),
    }
  }
  return null
}

function fitDisplayMessage(message: OrbitMessage, maximumBytes: number): OrbitMessage | null {
  if (Buffer.byteLength(JSON.stringify(message)) <= maximumBytes) return message
  const placeholder: OrbitMessage = message.role === 'tool'
    ? { role: 'tool', tool_call_id: utf8Prefix(String(message.tool_call_id || 'omitted'), 128), content: '[turn display output omitted: exceeds display budget]' }
    : { role: 'assistant', content: '[turn display output omitted: exceeds display budget]' }
  return Buffer.byteLength(JSON.stringify(placeholder)) <= maximumBytes ? placeholder : null
}

function boundedTurnOutput(messages: OrbitMessage[], maximumMessages = 64, maximumBytes = 256 * 1024): OrbitMessage[] {
  const output: OrbitMessage[] = []
  let bytes = 0
  for (const source of [...messages].reverse()) {
    const projected = displayMessage(source)
    if (!projected) continue
    const message = fitDisplayMessage(projected, maximumBytes - bytes)
    if (!message) break
    const size = Buffer.byteLength(JSON.stringify(message))
    if (bytes + size > maximumBytes) break
    output.unshift(message)
    bytes += size
    if (output.length >= maximumMessages) break
  }
  return output
}

export class ConversationStore {
  readonly now: () => Date
  readonly root: string

  constructor({ directories, now = () => new Date() }: { directories: AppDirectories; now?: () => Date }) {
    this.now = now
    this.root = path.join(directories.data, 'conversations')
  }

  #directory(kind: 'projects' | 'threads' | 'run-links' | 'attempts'): string {
    return path.join(this.root, kind)
  }

  #projectFile(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new TypeError('Project id is invalid')
    return path.join(this.#directory('projects'), `${projectId}.json`)
  }

  #threadFile(threadId: string): string {
    if (!THREAD_ID.test(threadId)) throw new TypeError('Thread id is invalid')
    return path.join(this.#directory('threads'), `${threadId}.json`)
  }

  #linkFile(runId: string): string {
    if (!RUN_ID.test(runId)) throw new TypeError('Run id is invalid')
    return path.join(this.#directory('run-links'), `${runId}.json`)
  }

  #attemptFile(attemptId: string): string {
    if (!ATTEMPT_ID.test(attemptId)) throw new TypeError('Attempt id is invalid')
    return path.join(this.#directory('attempts'), `${attemptId}.json`)
  }

  async #writeNew(file: string, value: unknown): Promise<void> {
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

  async #withLock<T>(name: string, callback: () => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(name)) throw new TypeError('Conversation lock name is invalid')
    const directory = await ensurePrivateDirectory(path.join(this.root, 'locks'))
    const lock = path.join(directory, `${name}.lock`)
    const token = id('lock_')
    const owner = { pid: process.pid, token, createdAt: new Date().toISOString() }
    let acquired = false
    for (let attempt = 0; attempt < 3_000; attempt += 1) {
      try {
        await this.#writeNew(lock, owner)
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
        const age = stat ? Date.now() - stat.mtimeMs : 0
        const valid = typeof current?.token === 'string' && current.token.length > 0
        if (live || !valid && age < 1_000) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          continue
        }
        const latest = await fs.lstat(lock).catch(() => null)
        if (stat && latest && stat.dev === latest.dev && stat.ino === latest.ino) await fs.unlink(lock).catch(() => undefined)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    if (!acquired) throw new Error(`Timed out acquiring conversation lock: ${name}`)
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

  async #exists(file: string): Promise<boolean> {
    try { await fs.access(file); return true } catch { return false }
  }

  async #uniqueId(prefix: 'project' | 'thread' | 'turn' | 'attempt', preferred = ''): Promise<string> {
    const expression = prefix === 'project' ? PROJECT_ID : prefix === 'thread' ? THREAD_ID : prefix === 'turn' ? TURN_ID : ATTEMPT_ID
    const file = (value: string) => prefix === 'project'
      ? this.#projectFile(value)
      : prefix === 'thread'
        ? this.#threadFile(value)
        : prefix === 'attempt'
          ? this.#attemptFile(value)
          : ''
    const available = async (value: string) => prefix === 'turn'
      ? !(await this.threads()).some((thread) => thread.turns.some((turn) => turn.id === value))
      : !await this.#exists(file(value))
    if (preferred) {
      if (!expression.test(preferred)) throw new TypeError(`Preferred ${prefix} id is invalid`)
      if (!await available(preferred)) throw new Error(`Preferred ${prefix} id is already assigned: ${preferred}`)
      return preferred
    }
    for (let count = 0; count < 20; count += 1) {
      const candidate = id(`${prefix}_`)
      if (await available(candidate)) return candidate
    }
    throw new Error(`Could not allocate a unique ${prefix} id`)
  }

  async #jsonFiles(kind: 'projects' | 'threads' | 'attempts'): Promise<unknown[]> {
    const directory = await ensurePrivateDirectory(this.#directory(kind))
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const output: unknown[] = []
    for (const entry of entries.slice(0, 20_000)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      output.push(await readJson<unknown>(path.join(directory, entry.name), null).catch(() => null))
    }
    return output
  }

  async projects(): Promise<OrbitAgentProject[]> {
    return (await this.#jsonFiles('projects')).map(normalizeAgentProject).filter((value): value is OrbitAgentProject => Boolean(value))
  }

  async threads(): Promise<OrbitAgentThread[]> {
    return (await this.#jsonFiles('threads')).map(normalizeAgentThread).filter((value): value is OrbitAgentThread => Boolean(value))
  }

  async project(projectId: string): Promise<OrbitAgentProject | null> {
    return normalizeAgentProject(await readJson<unknown>(this.#projectFile(projectId), null).catch(() => null))
  }

  async thread(threadId: string): Promise<OrbitAgentThread | null> {
    return normalizeAgentThread(await readJson<unknown>(this.#threadFile(threadId), null).catch(() => null))
  }

  async #hostRunTurn(runId: string): Promise<{ thread: OrbitAgentThread; turn: OrbitAgentTurn } | null> {
    const matches: Array<{ thread: OrbitAgentThread; turn: OrbitAgentTurn }> = []
    for (const thread of await this.threads()) {
      for (const turn of thread.turns.filter((candidate) => candidate.metadata?.hostRunId === runId)) matches.push({ thread, turn })
    }
    if (matches.length > 1) throw new Error(`Run ${runId} is referenced by multiple canonical turns`)
    return matches[0] || null
  }

  async linkForRun(runId: string): Promise<OrbitCliRunLink | null> {
    const value = await readJson<unknown>(this.#linkFile(runId), null).catch(() => null)
    if (!isRecord(value) || value.schema !== RUN_LINK_SCHEMA || value.runId !== runId
      || !PROJECT_ID.test(String(value.projectId || '')) || !THREAD_ID.test(String(value.threadId || ''))
      || !TURN_ID.test(String(value.turnId || '')) || !Number.isSafeInteger(value.baseMessageCount) || value.baseMessageCount < 0) return null
    return value as OrbitCliRunLink
  }

  async ensureProject(workspace: string, preferredId = ''): Promise<OrbitAgentProject> {
    const requestedRoot = resolvedWorkspace(workspace)
    const rootRef = await canonicalDirectory(requestedRoot).catch(() => requestedRoot)
    return this.#withLock('project-index', async () => {
      for (const project of await this.projects()) {
        if (!project.rootRef) continue
        const requested = resolvedWorkspace(project.rootRef)
        const candidate = await canonicalDirectory(requested).catch(() => requested)
        if (candidate !== rootRef) continue
        if (project.rootRef !== rootRef) {
          const canonical = normalizeAgentProject({ ...project, rootRef, name: path.basename(rootRef), updatedAt: this.now().toISOString() })
          if (!canonical) throw new Error('Could not canonicalize the project workspace')
          await writeJsonAtomic(this.#projectFile(project.id), canonical)
          return canonical
        }
        return project
      }
      const projectId = await this.#uniqueId('project', preferredId)
      const now = this.now().toISOString()
      const project = normalizeAgentProject({
        id: projectId,
        name: path.basename(rootRef),
        rootRef,
        threadIds: [],
        createdAt: now,
        updatedAt: now,
        metadata: { host: 'orbit-cli' },
      })
      if (!project) throw new Error('Could not create the canonical project record')
      await this.#writeNew(this.#projectFile(project.id), project)
      return project
    })
  }

  async #syncProjectThreadIds(projectId: string): Promise<void> {
    await this.#withLock(`project-${projectId}`, async () => {
      const project = await this.project(projectId)
      if (!project) throw new Error(`Project record is missing: ${projectId}`)
      const threadIds = (await this.threads()).filter((thread) => thread.projectId === projectId).map((thread) => thread.id).sort()
      const existing = [...project.threadIds].sort()
      if (JSON.stringify(existing) === JSON.stringify(threadIds)) return
      const nextProject = normalizeAgentProject({
        ...project,
        threadIds: [...new Set(threadIds)],
        updatedAt: this.now().toISOString(),
      })
      if (!nextProject) throw new Error('Could not update the canonical project record')
      await writeJsonAtomic(this.#projectFile(project.id), nextProject)
    })
  }

  async createThread(workspace: string, options: { title?: string; legacy?: boolean; preferredId?: string } = {}): Promise<OrbitAgentThread> {
    const project = await this.ensureProject(workspace)
    const threadId = await this.#uniqueId('thread', options.preferredId)
    const now = this.now().toISOString()
    const thread = normalizeAgentThread({
      id: threadId,
      projectId: project.id,
      title: String(options.title || 'New session').trim().slice(0, 160) || 'New session',
      turns: [],
      createdAt: now,
      updatedAt: now,
      metadata: { host: 'orbit-cli', ...(options.legacy ? { legacy: true } : {}) },
    })
    if (!thread) throw new Error('Could not create the canonical thread record')
    await this.#writeNew(this.#threadFile(thread.id), thread)
    await this.#syncProjectThreadIds(project.id)
    return thread
  }

  async ensureThread(workspace: string, requestedThreadId?: string, title = 'New session'): Promise<OrbitAgentThread> {
    const project = await this.ensureProject(workspace)
    if (!requestedThreadId) return this.createThread(project.rootRef || workspace, { title })
    const thread = await this.thread(requestedThreadId)
    if (!thread || thread.projectId !== project.id) throw new Error('Session does not belong to this project workspace')
    return thread
  }

  async createTurn(input: {
    workspace: string
    threadId: string
    runId: string
    inputItems: OrbitAgentInputItem[]
    baseMessageCount: number
    preferredTurnId?: string
    createdAt?: string
  }): Promise<OrbitAgentTurn> {
    if (!RUN_ID.test(input.runId)) throw new TypeError('Run id is invalid')
    if (!THREAD_ID.test(input.threadId)) throw new TypeError('Thread id is invalid')
    const project = await this.ensureProject(input.workspace)
    return this.#withLock(`run-link-${input.runId}`, async () => {
    const globallyRecovered = await this.#hostRunTurn(input.runId)
    if (globallyRecovered) {
      if (globallyRecovered.thread.id !== input.threadId || globallyRecovered.thread.projectId !== project.id) {
        throw new Error(`Run ${input.runId} already belongs to another canonical turn`)
      }
      if (input.preferredTurnId && globallyRecovered.turn.id !== input.preferredTurnId) {
        throw new Error(`Run ${input.runId} canonical turn identity conflicts with its checkpoint intent`)
      }
      await this.#writeRunLink({
        schema: RUN_LINK_SCHEMA,
        runId: input.runId,
        projectId: project.id,
        threadId: globallyRecovered.thread.id,
        turnId: globallyRecovered.turn.id,
        baseMessageCount: Number(globallyRecovered.turn.metadata?.hostBaseMessageCount) || 0,
        createdAt: globallyRecovered.turn.createdAt || input.createdAt || this.now().toISOString(),
      })
      return globallyRecovered.turn
    }
    return this.#withLock(`thread-${input.threadId}`, async () => {
      const thread = await this.thread(input.threadId)
      if (!thread || thread.projectId !== project.id) throw new Error('Session does not belong to this project workspace')
      const linked = await this.linkForRun(input.runId)
      if (linked) {
        if (linked.projectId !== project.id || linked.threadId !== thread.id) throw new Error(`Run ${input.runId} is linked to another session`)
        if (input.preferredTurnId && linked.turnId !== input.preferredTurnId) throw new Error(`Run ${input.runId} turn link conflicts with its checkpoint intent`)
        const linkedTurn = thread.turns.find((turn) => turn.id === linked.turnId)
        if (!linkedTurn) throw new Error(`Run ${input.runId} link points to a missing turn`)
        return linkedTurn
      }
      const recovered = thread.turns.find((turn) => turn.metadata?.hostRunId === input.runId)
      if (recovered) {
        if (input.preferredTurnId && recovered.id !== input.preferredTurnId) {
          throw new Error(`Run ${input.runId} canonical turn identity conflicts with its checkpoint intent`)
        }
        await this.#writeRunLink({
          schema: RUN_LINK_SCHEMA,
          runId: input.runId,
          projectId: project.id,
          threadId: thread.id,
          turnId: recovered.id,
          baseMessageCount: Number(recovered.metadata?.hostBaseMessageCount) || 0,
          createdAt: recovered.createdAt || input.createdAt || this.now().toISOString(),
        })
        return recovered
      }
      const turnId = await this.#uniqueId('turn', input.preferredTurnId)
      const createdAt = input.createdAt || this.now().toISOString()
      const baseMessageCount = Math.max(0, Math.floor(input.baseMessageCount))
      const turn = normalizeAgentTurn({
        id: turnId,
        threadId: thread.id,
        sequence: thread.turns.length,
        state: 'pending',
        inputItems: input.inputItems,
        outputMessages: [],
        createdAt,
        metadata: { host: 'orbit-cli', hostRunId: input.runId, hostBaseMessageCount: baseMessageCount },
      }, { threadId: thread.id })
      if (!turn) throw new Error('Could not create the canonical turn record')
      const nextThread = normalizeAgentThread({ ...thread, turns: [...thread.turns, turn], updatedAt: createdAt })
      if (!nextThread) throw new Error('Could not update the canonical thread record')
      await writeJsonAtomic(this.#threadFile(thread.id), nextThread)
      await this.#writeRunLink({
        schema: RUN_LINK_SCHEMA,
        runId: input.runId,
        projectId: project.id,
        threadId: thread.id,
        turnId: turn.id,
        baseMessageCount,
        createdAt,
      })
      return turn
    })
    })
  }

  async #writeRunLink(link: OrbitCliRunLink): Promise<void> {
    try {
      await this.#writeNew(this.#linkFile(link.runId), link)
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
      const existing = await this.linkForRun(link.runId)
      if (!existing || existing.projectId !== link.projectId || existing.threadId !== link.threadId || existing.turnId !== link.turnId) {
        throw new Error(`Run ${link.runId} has a conflicting turn link`)
      }
    }
  }

  async #reconcileRunLinkBase(runId: string, expectedBaseMessageCount: number): Promise<void> {
    await this.#withLock(`run-link-${runId}`, async () => {
      const link = await this.linkForRun(runId)
      if (!link || link.baseMessageCount === expectedBaseMessageCount) return
      await this.#withLock(`thread-${link.threadId}`, async () => {
        const thread = await this.thread(link.threadId)
        if (!thread || thread.projectId !== link.projectId) throw new Error(`Run ${runId} canonical link is invalid`)
        const index = thread.turns.findIndex((turn) => turn.id === link.turnId && turn.metadata?.hostRunId === runId)
        if (index < 0) throw new Error(`Run ${runId} canonical turn is missing`)
        const turn = normalizeAgentTurn({
          ...thread.turns[index],
          metadata: { ...thread.turns[index]!.metadata, hostBaseMessageCount: expectedBaseMessageCount },
        }, { threadId: thread.id })
        if (!turn) throw new Error(`Run ${runId} canonical turn boundary is invalid`)
        const turns = [...thread.turns]
        turns[index] = turn
        const next = normalizeAgentThread({ ...thread, turns })
        if (!next) throw new Error(`Run ${runId} canonical session is invalid`)
        await writeJsonAtomic(this.#threadFile(thread.id), next)
        await writeJsonAtomic(this.#linkFile(runId), { ...link, baseMessageCount: expectedBaseMessageCount })
      })
    })
  }

  async updateTurnFromRun(run: OrbitRun): Promise<void> {
    const link = await this.linkForRun(run.id)
    if (!link) return
    if (run.threadId && run.threadId !== link.threadId || run.turnId && run.turnId !== link.turnId) {
      throw new Error(`Run ${run.id} checkpoint intent conflicts with its canonical turn link`)
    }
    const project = await this.project(link.projectId)
    if (!project?.rootRef) throw new Error(`Run ${run.id} canonical project is missing`)
    const runWorkspace = await canonicalDirectory(resolvedWorkspace(run.workspace)).catch(() => resolvedWorkspace(run.workspace))
    const projectWorkspace = await canonicalDirectory(resolvedWorkspace(project.rootRef)).catch(() => resolvedWorkspace(project.rootRef))
    if (runWorkspace !== projectWorkspace) throw new Error(`Run ${run.id} canonical link belongs to another project workspace`)
    await this.#withLock(`thread-${link.threadId}`, async () => {
      const thread = await this.thread(link.threadId)
      if (!thread || thread.projectId !== link.projectId) throw new Error(`Run ${run.id} canonical turn link is invalid`)
      const index = thread.turns.findIndex((turn) => turn.id === link.turnId)
      if (index < 0) throw new Error(`Run ${run.id} canonical turn link points to a missing turn`)
      const markerIndex = run.messages.findIndex((message) => message?.orbit_internal?.schema === 'orbit.cli-turn-marker.v1'
        && message.orbit_internal.turnId === link.turnId)
      const taggedOutput = run.messages.filter((message) => message?.orbit_internal?.schema === 'orbit.cli-turn-output.v1'
        && message.orbit_internal.turnId === link.turnId && message.role !== 'user')
      const outputCandidates = Array.isArray(run.turnOutputMessages)
        ? run.turnOutputMessages.filter((message) => message.role !== 'user')
        : taggedOutput.length
          ? taggedOutput
          : run.messages.slice(markerIndex >= 0 ? markerIndex + 1 : link.baseMessageCount).filter((message) => message.role !== 'user')
      const outputMessages = boundedTurnOutput(outputCandidates)
      const updated = normalizeAgentTurn({
        ...thread.turns[index],
        state: finalTurnState(run),
        outputMessages,
        ...(run.finishedAt ? { completedAt: run.finishedAt } : {}),
      }, { threadId: thread.id })
      if (!updated) throw new Error('Could not update the canonical turn record')
      if (JSON.stringify(updated) === JSON.stringify(thread.turns[index])) return
      const turns = [...thread.turns]
      turns[index] = updated
      const updatedAt = String(thread.updatedAt || '').localeCompare(String(run.updatedAt || '')) >= 0
        ? thread.updatedAt
        : run.updatedAt
      const next = normalizeAgentThread({ ...thread, turns, updatedAt })
      if (!next) throw new Error('Could not update the canonical thread record')
      await writeJsonAtomic(this.#threadFile(thread.id), next)
    })
  }

  async ensureLegacyIndex(runs: OrbitRun[]): Promise<void> {
    const chronological = runs
      .filter((run) => RUN_ID.test(String(run.id || '')) && run.kind !== 'asset3d' && run.kind !== 'assetimage')
      .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || left.id.localeCompare(right.id))
    const previousMessages = new Map<string, OrbitMessage[]>()
    for (const run of chronological) {
      const intendedThreadId = THREAD_ID.test(String(run.threadId || '')) ? String(run.threadId) : ''
      const messages = Array.isArray(run.messages) ? run.messages : []
      const hasTurnMarker = messages.some((message) => message?.orbit_internal?.schema === 'orbit.cli-turn-marker.v1')
      const hasStableOutput = Array.isArray(run.turnOutputMessages) && run.turnOutputMessages.length > 0
        || messages.some((message) => message?.orbit_internal?.schema === 'orbit.cli-turn-output.v1'
          && (!run.turnId || message.orbit_internal.turnId === run.turnId))
      let baseMessageCount = 0
      if (intendedThreadId && !hasTurnMarker) {
        const previous = previousMessages.get(intendedThreadId)
        if (previous) {
          if (!exactMessagePrefix(previous, messages) && !hasStableOutput) {
            throw Object.assign(new Error(`Run ${run.id} does not preserve the preceding transcript prefix, so its legacy Turn output boundary cannot be inferred safely.`), {
              code: 'LEGACY_TRANSCRIPT_BOUNDARY_UNSAFE',
            })
          }
          if (exactMessagePrefix(previous, messages)) baseMessageCount = previous.length
        }
      }
      const linked = await this.linkForRun(run.id)
      if (linked) {
        if (intendedThreadId && linked.threadId !== intendedThreadId) throw new Error(`Run ${run.id} link conflicts with its checkpoint session intent`)
        if (intendedThreadId) {
          await this.#reconcileRunLinkBase(run.id, baseMessageCount)
          previousMessages.set(intendedThreadId, messages)
        }
        continue
      }
      let workspace = ''
      try { workspace = resolvedWorkspace(run.workspace) } catch { continue }
      const suffix = runSuffix(run.id)
      const project = await this.ensureProject(workspace, suffix ? `project_${suffix}` : '')
      const preferredLegacyThreadId = !intendedThreadId && suffix ? `thread_${suffix}` : ''
      let thread = intendedThreadId
        ? await this.thread(intendedThreadId)
        : preferredLegacyThreadId
          ? await this.thread(preferredLegacyThreadId)
          : null
      if (thread && thread.projectId !== project.id) throw new Error(`Run ${run.id} points to a session in another project`)
      if (thread && preferredLegacyThreadId && thread.metadata?.legacy !== true) {
        throw new Error(`Run ${run.id} deterministic legacy session id is already assigned`)
      }
      if (!thread) {
        thread = await this.createThread(workspace, {
          title: String(run.prompt || 'Imported session').replace(/\s+/g, ' ').slice(0, 160),
          legacy: !intendedThreadId,
          preferredId: intendedThreadId || (suffix ? `thread_${suffix}` : ''),
        })
      }
      const intendedTurnId = TURN_ID.test(String(run.turnId || '')) ? String(run.turnId) : ''
      const turnId = intendedTurnId || (suffix ? `turn_${suffix}` : '')
      await this.createTurn({
        workspace,
        threadId: thread.id,
        runId: run.id,
        inputItems: Array.isArray(run.inputItems) ? normalizeAgentInputItems(run.inputItems) : legacyInputItems(run, turnId || `turn_${run.id}`),
        baseMessageCount,
        preferredTurnId: turnId,
        createdAt: run.createdAt,
      })
      if (intendedThreadId) previousMessages.set(intendedThreadId, messages)
      await this.updateTurnFromRun(run)
    }
  }

  async #reconcileThreadOrder(runs: OrbitRun[]): Promise<void> {
    const runById = new Map(runs.map((run) => [run.id, run]))
    const threadIds = new Set<string>()
    for (const run of runs) {
      const link = await this.linkForRun(run.id)
      if (link) threadIds.add(link.threadId)
    }
    for (const threadId of threadIds) {
      await this.#withLock(`thread-${threadId}`, async () => {
        const thread = await this.thread(threadId)
        if (!thread) throw new Error(`Canonical session is missing: ${threadId}`)
        const ordered = [...thread.turns].sort((left, right) => {
          const leftRunId = String(left.metadata?.hostRunId || '')
          const rightRunId = String(right.metadata?.hostRunId || '')
          const leftRun = runById.get(leftRunId)
          const rightRun = runById.get(rightRunId)
          return String(leftRun?.createdAt || left.createdAt || '').localeCompare(String(rightRun?.createdAt || right.createdAt || ''))
            || Number(left.sequence || 0) - Number(right.sequence || 0)
            || leftRunId.localeCompare(rightRunId)
            || left.id.localeCompare(right.id)
        }).map((turn, sequence) => normalizeAgentTurn({ ...turn, sequence }, { threadId })!)
        if (JSON.stringify(ordered) === JSON.stringify(thread.turns)) return
        const next = normalizeAgentThread({ ...thread, turns: ordered })
        if (!next) throw new Error(`Could not reconcile canonical session order: ${threadId}`)
        await writeJsonAtomic(this.#threadFile(threadId), next)
      })
    }
  }

  async listThreadSnapshots(runs: OrbitRun[], workspace?: string): Promise<OrbitCliThreadSnapshot[]> {
    await this.ensureLegacyIndex(runs)
    await this.#reconcileThreadOrder(runs)
    const chronologicalRuns = [...runs].sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || left.id.localeCompare(right.id))
    for (const run of chronologicalRuns) await this.updateTurnFromRun(run)
    const projects = new Map((await this.projects()).map((project) => [project.id, project]))
    for (const projectId of projects.keys()) await this.#syncProjectThreadIds(projectId)
    const links = new Map<string, OrbitCliRunLink>()
    for (const run of runs) {
      const link = await this.linkForRun(run.id)
      if (link) links.set(run.id, link)
    }
    const requestedFilter = workspace ? resolvedWorkspace(workspace) : ''
    const filterWorkspace = requestedFilter ? await canonicalDirectory(requestedFilter).catch(() => requestedFilter) : ''
    const output: OrbitCliThreadSnapshot[] = []
    for (const thread of await this.threads()) {
      const project = thread.projectId ? projects.get(thread.projectId) : null
      let requestedRoot = ''
      try { requestedRoot = project?.rootRef ? resolvedWorkspace(project.rootRef) : '' } catch { continue }
      const rootRef = requestedRoot ? await canonicalDirectory(requestedRoot).catch(() => requestedRoot) : ''
      if (!project || filterWorkspace && rootRef !== filterWorkspace) continue
      const byTurn = new Map<string, string>()
      for (const run of runs) {
        const link = links.get(run.id)
        if (link?.threadId === thread.id) byTurn.set(link.turnId, run.id)
      }
      const runIds = thread.turns.flatMap((turn) => byTurn.get(turn.id) || [])
      output.push({ ...thread, workspace: rootRef, runIds, latestRunId: runIds.at(-1) || null })
    }
    return output.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
  }

  async latestRunForThread(runs: OrbitRun[], threadId: string): Promise<OrbitRun | null> {
    const snapshot = (await this.listThreadSnapshots(runs)).find((thread) => thread.id === threadId)
    return snapshot?.latestRunId ? runs.find((run) => run.id === snapshot.latestRunId) || null : null
  }

  async startAttempt(runId: string): Promise<OrbitCliAttempt> {
    if (!RUN_ID.test(runId)) throw new TypeError('Run id is invalid')
    return this.#withLock(`attempt-${runId}`, async () => {
      const link = await this.linkForRun(runId)
      if (!link) throw new Error(`Run ${runId} is not linked to a turn`)
      const attempts = (await this.#jsonFiles('attempts')).filter((value): value is OrbitCliAttempt => (
        isRecord(value) && value.schema === ATTEMPT_SCHEMA && value.runId === runId && ATTEMPT_ID.test(String(value.id || ''))
      ))
      const now = this.now().toISOString()
      for (const attempt of attempts.filter((candidate) => candidate.state === 'running')) {
        attempt.state = 'interrupted'
        attempt.finishedAt = now
        attempt.errorCode = 'LOCAL_PROCESS_INTERRUPTED'
        await writeJsonAtomic(this.#attemptFile(attempt.id), attempt)
      }
      const attemptId = await this.#uniqueId('attempt')
      const attempt: OrbitCliAttempt = {
        schema: ATTEMPT_SCHEMA,
        id: attemptId,
        runId,
        turnId: link.turnId,
        ordinal: Math.max(0, ...attempts.map((candidate) => Number(candidate.ordinal) || 0)) + 1,
        state: 'running',
        startedAt: now,
        finishedAt: null,
        errorCode: null,
      }
      await this.#writeNew(this.#attemptFile(attempt.id), attempt)
      return attempt
    })
  }

  async finishAttempt(attemptId: string, state: OrbitCliAttempt['state'], errorCode: string | null = null): Promise<OrbitCliAttempt> {
    if (!ATTEMPT_ID.test(attemptId)) throw new TypeError('Attempt id is invalid')
    if (!['completed', 'paused', 'interrupted', 'failed', 'cancelled'].includes(state)) throw new TypeError('Attempt state is invalid')
    const identity = await readJson<OrbitCliAttempt | null>(this.#attemptFile(attemptId), null)
    if (!identity || identity.schema !== ATTEMPT_SCHEMA || identity.id !== attemptId || !RUN_ID.test(identity.runId)) {
      throw new Error(`Attempt is missing: ${attemptId}`)
    }
    return this.#withLock(`attempt-${identity.runId}`, async () => {
      const attempt = await readJson<OrbitCliAttempt | null>(this.#attemptFile(attemptId), null)
      if (!attempt || attempt.schema !== ATTEMPT_SCHEMA || attempt.id !== attemptId || attempt.runId !== identity.runId) {
        throw new Error(`Attempt is missing: ${attemptId}`)
      }
      if (attempt.state !== 'running') return attempt
      attempt.state = state
      attempt.finishedAt = this.now().toISOString()
      attempt.errorCode = errorCode ? String(errorCode).slice(0, 160) : null
      await writeJsonAtomic(this.#attemptFile(attempt.id), attempt)
      return attempt
    })
  }

  async attemptsForRun(runId: string): Promise<OrbitCliAttempt[]> {
    if (!RUN_ID.test(runId)) throw new TypeError('Run id is invalid')
    return (await this.#jsonFiles('attempts')).filter((value): value is OrbitCliAttempt => (
      isRecord(value) && value.schema === ATTEMPT_SCHEMA && value.runId === runId && ATTEMPT_ID.test(String(value.id || ''))
    )).sort((left, right) => left.ordinal - right.ordinal)
  }

  async interruptRunningAttempts(runId: string, errorCode = 'LOCAL_PROCESS_INTERRUPTED'): Promise<void> {
    await this.reconcileRunningAttempts(runId, 'interrupted', errorCode)
  }

  async reconcileRunningAttempts(runId: string, state: Exclude<OrbitCliAttempt['state'], 'running'>, errorCode: string | null = null): Promise<void> {
    if (!RUN_ID.test(runId)) throw new TypeError('Run id is invalid')
    await this.#withLock(`attempt-${runId}`, async () => {
      const now = this.now().toISOString()
      for (const attempt of await this.attemptsForRun(runId)) {
        if (attempt.state !== 'running') continue
        attempt.state = state
        attempt.finishedAt = now
        attempt.errorCode = errorCode
        await writeJsonAtomic(this.#attemptFile(attempt.id), attempt)
      }
    })
  }

  async relocateProject(previousWorkspace: string, workspace: string): Promise<void> {
    await this.withProjectRelocation(previousWorkspace, workspace, async () => undefined)
  }

  async relocationProjectId(previousWorkspace: string, workspace: string): Promise<string | null> {
    const previous = await canonicalWorkspaceIdentity(previousWorkspace)
    const next = await canonicalWorkspaceIdentity(workspace)
    return this.#withLock('project-index', async () => {
      const projects = await this.projects()
      const identities = await Promise.all(projects.map((project) => canonicalWorkspaceIdentity(project.rootRef).catch(() => '')))
      const source = projects.filter((_project, index) => identities[index] === previous)
      const targets = projects.filter((_project, index) => identities[index] === next)
      if (source.length > 1 || targets.length > 1) throw new Error('Canonical project workspace identity is duplicated')
      if (targets.some((project) => project.id !== source[0]?.id)) throw new Error('Relocation target already belongs to another canonical project')
      return source[0]?.id || null
    })
  }

  async withProjectRelocation<T>(previousWorkspace: string, workspace: string, callback: () => Promise<T>, expectedProjectId?: string | null): Promise<T> {
    const previous = await canonicalWorkspaceIdentity(previousWorkspace)
    const next = await canonicalWorkspaceIdentity(workspace)
    return this.#withLock('project-index', async () => {
      const projects = await this.projects()
      const identities = await Promise.all(projects.map((project) => canonicalWorkspaceIdentity(project.rootRef).catch(() => '')))
      let source = projects.filter((_project, index) => identities[index] === previous)
      const targets = projects.filter((_project, index) => identities[index] === next)
      if (source.length > 1 || targets.length > 1) throw new Error('Canonical project workspace identity is duplicated')
      if (!source.length && expectedProjectId) {
        const linkedIdentity = projects.find((project) => project.id === expectedProjectId)
        if (linkedIdentity) source = [linkedIdentity]
      }
      if (!source.length) {
        if (expectedProjectId && targets[0]?.id !== expectedProjectId) throw new Error('Canonical project for the previous workspace is missing')
        if (!expectedProjectId && targets.length) throw new Error('Relocation target already belongs to another canonical project')
        return callback()
      }
      if (expectedProjectId === null || expectedProjectId && source[0]!.id !== expectedProjectId) throw new Error('Canonical relocation project identity changed')
      if (targets.some((project) => project.id !== source[0]!.id)) throw new Error('Relocation target already belongs to another canonical project')
      const result = await callback()
      const updated = normalizeAgentProject({ ...source[0], rootRef: next, name: path.basename(next), updatedAt: this.now().toISOString() })
      if (!updated) throw new Error('Could not relocate the canonical project record')
      await writeJsonAtomic(this.#projectFile(updated.id), updated)
      return result
    })
  }
}
