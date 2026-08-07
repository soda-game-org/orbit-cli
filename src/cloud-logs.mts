import path from 'node:path'
import { CLOUD_LOG_SCHEMA, MAX_CLOUD_LOG_QUEUE, VERSION } from './constants.mjs'
import { appDirectories, readJson, redactDiagnostic, writeJsonAtomic, type AppDirectories } from './util.mjs'
import type { OrbitClientSource, OrbitRun } from './types.mjs'

interface QueuedCloudEvent extends Record<string, any> {
  event_id: string
  client_run_id: string
  source: OrbitClientSource
  sequence: number
  event_type: string
  level: string
  occurred_at: string
}

type CloudApiFactory = (source: OrbitClientSource) => {
  uploadLogs(input: Record<string, unknown>): Promise<Record<string, any>>
}

export class CloudLogSink {
  readonly apiFactory: CloudApiFactory
  readonly file: string
  flushing: Promise<{ accepted: number }> | null

  constructor(apiFactory: CloudApiFactory, { directories = appDirectories() }: { directories?: AppDirectories } = {}) {
    this.apiFactory = apiFactory
    this.file = path.join(directories.data, 'cloud-log-queue.json')
    this.flushing = null
  }

  async emit(run: OrbitRun, event: Record<string, any>): Promise<void> {
    if (!run.cloudLogs) return
    const queue = await this.#read()
    queue.push({
      event_id: event.id,
      client_run_id: run.id,
      source: run.source,
      sequence: ++run.sequence,
      event_type: String(event.type || 'internal_error').slice(0, 80),
      level: levelFor(event.type),
      occurred_at: event.occurredAt,
      ...(event.toolName ? { tool_name: String(event.toolName).slice(0, 80) } : {}),
      ...(typeof event.success === 'boolean' ? { success: event.success } : {}),
      ...(Number.isFinite(event.durationMs) ? { duration_ms: Math.max(0, Math.floor(event.durationMs)) } : {}),
      ...(event.errorCode ? { error_code: redactDiagnostic(event.errorCode).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160) } : {}),
    })
    await this.#write(queue.slice(-MAX_CLOUD_LOG_QUEUE))
    await this.flush(run.source).catch(() => undefined)
  }

  async flush(source: OrbitClientSource | null = null): Promise<{ accepted: number }> {
    if (this.flushing) return this.flushing
    this.flushing = this.#flushAll(source).finally(() => { this.flushing = null })
    return this.flushing
  }

  async #flushAll(source: OrbitClientSource | null): Promise<{ accepted: number }> {
    let accepted = 0
    for (let batch = 0; batch < 100; batch += 1) {
      const result = await this.#flush(source)
      accepted += result.accepted
      if (!result.accepted) break
    }
    return { accepted }
  }

  async #flush(source: OrbitClientSource | null): Promise<{ accepted: number }> {
    const queue = await this.#read()
    if (!queue.length) return { accepted: 0 }
    const selectedSource = source || queue[0]!.source
    const batch = queue.filter((event) => event.source === selectedSource).slice(0, 50)
    if (!batch.length) return { accepted: 0 }
    const api = this.apiFactory(selectedSource)
    const response = await api.uploadLogs({
      contract_version: 1,
      schema: CLOUD_LOG_SCHEMA,
      source: selectedSource,
      client_version: VERSION,
      platform: process.platform,
      arch: process.arch,
      events: batch.map(({ source: _source, ...event }) => event),
    })
    const accepted = new Set(Array.isArray(response?.accepted_event_ids) ? response.accepted_event_ids : [])
    if (!accepted.size) return { accepted: 0 }
    await this.#write(queue.filter((event) => !accepted.has(event.event_id)))
    return { accepted: accepted.size }
  }

  async #read(): Promise<QueuedCloudEvent[]> {
    const value = await readJson<unknown>(this.file, [])
    return Array.isArray(value) ? value as QueuedCloudEvent[] : []
  }

  async #write(queue: QueuedCloudEvent[]): Promise<void> {
    await writeJsonAtomic(this.file, queue)
  }
}

function levelFor(type: unknown): string {
  const value = String(type || '')
  if (value.includes('failed') || value.includes('error')) return 'error'
  if (value.includes('retry') || value.includes('interrupted') || value.includes('paused')) return 'warn'
  return 'info'
}
