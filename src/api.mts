import { API_ORIGIN, ENGINE_AGENT_CONTEXT_SCHEMA, ENGINE_CONTRACT_VERSION, ENGINE_LLM_CONTRACT_VERSION, VERSION } from './constants.mjs'
import { sniffImage } from './attachments.mjs'
import { collectStream, publicError, sha256 } from './util.mjs'
import type { OrbitClientSource } from './types.mjs'

const MAX_JSON_RESPONSE = 8 * 1024 * 1024
const MAX_IMAGE_RESPONSE = 16 * 1024 * 1024
const OFFICIAL_IMAGE_MODELS = new Set(['google/nano-banana', 'google/imagen-4-fast'])

export class OrbitApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly details: unknown

  constructor(status: number, code: string | null, message: string, details: unknown = null) {
    super(message)
    this.name = 'OrbitApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export class OrbitApi {
  readonly auth: { accessToken(): Promise<string> }
  readonly origin: string
  readonly fetchImpl: typeof fetch
  readonly source: OrbitClientSource

  constructor(auth: { accessToken(): Promise<string> }, { origin = API_ORIGIN, fetchImpl = fetch, source = 'cli' }: { origin?: string; fetchImpl?: typeof fetch; source?: OrbitClientSource } = {}) {
    this.auth = auth
    this.origin = new URL(origin).origin
    this.fetchImpl = fetchImpl
    this.source = source
  }

  async request(pathname: string, init: RequestInit = {}, { timeoutMs = 30_000, raw = false }: { timeoutMs?: number; raw?: boolean } = {}): Promise<any> {
    const token = await this.auth.accessToken()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('Orbit request timed out')), timeoutMs)
    timer.unref?.()
    try {
      const response = await this.fetchImpl(new URL(pathname, this.origin), {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Orbit-Client': this.source,
          'X-Orbit-Client-Version': VERSION,
          ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      })
      if (raw && response.ok) return response
      let body: Record<string, any> | null = null
      const text = Buffer.from(await collectStream(response.body, MAX_JSON_RESPONSE)).toString('utf8')
      try { body = text ? JSON.parse(text) : null } catch { body = null }
      if (!response.ok) {
        const code = body?.code || null
        const message = response.status === 402 && (code === 'ENGINE_INSUFFICIENT_CADE' || code === 'ENGINE_CADE_CHECKPOINT_EXHAUSTED')
          ? `${body?.message || 'Orbit Cade is exhausted'} Run \`orbit account billing\` to recharge; your local checkpoint was preserved.`
          : body?.message || `Orbit request failed (${response.status})`
        throw new OrbitApiError(response.status, code, message, body)
      }
      return body
    } finally {
      clearTimeout(timer)
    }
  }

  models(): Promise<any> {
    return this.request('/api/engine/models', { method: 'GET', headers: { 'Cache-Control': 'no-store' } })
  }

  billingCatalog(locale = 'en', timeoutMs = 5_000): Promise<any> {
    if (!['en', 'zh'].includes(locale)) throw new TypeError('Billing locale is invalid')
    return this.request(`/api/billing/engine/catalog?locale=${encodeURIComponent(locale)}`, {
      method: 'GET',
      headers: { 'Cache-Control': 'no-store' },
    }, { timeoutMs })
  }

  beginRun({ clientRunId, purpose, modelId, generate3d = false }: { clientRunId: string; purpose: string; modelId: string; generate3d?: boolean }): Promise<any> {
    return this.request('/api/engine/runs', {
      method: 'POST',
      body: JSON.stringify({
        contract_version: ENGINE_CONTRACT_VERSION,
        client_run_id: clientRunId,
        model_id: modelId,
        purpose,
        app_version: VERSION,
        generate_3d_models: generate3d,
      }),
    })
  }

  complete({ cloudRunId, requestKey, purpose = 'agent', messages, tools = [], runtime = 'html', operation = 'create', maxOutputTokens = 16_000, signal }: { cloudRunId: string; requestKey: string; purpose?: string; messages: Record<string, any>[]; tools?: Record<string, any>[]; runtime?: string; operation?: string; maxOutputTokens?: number; signal?: AbortSignal | null }): Promise<any> {
    return this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/llm`, {
      method: 'POST',
      signal,
      body: JSON.stringify({
        contract_version: ENGINE_LLM_CONTRACT_VERSION,
        request_key: requestKey,
        purpose,
        messages,
        tools,
        ...(purpose === 'agent' ? {
          agent_context: {
            schema: ENGINE_AGENT_CONTEXT_SCHEMA,
            operation,
            runtime,
            target_standard: 'orbit',
            skill_policy: 'server',
          },
        } : {}),
        max_output_tokens: maxOutputTokens,
      }),
    }, { timeoutMs: 12 * 60_000 })
  }

  heartbeat(cloudRunId: string): Promise<any> {
    return this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/heartbeat`, {
      method: 'POST', body: JSON.stringify({ contract_version: 1 }),
    })
  }

  settle(cloudRunId: string, state: 'complete' | 'fail' | 'cancel', errorCode: string | null = null): Promise<any> {
    if (!['complete', 'fail', 'cancel'].includes(state)) throw new TypeError('Invalid settlement state')
    return this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/${state}`, {
      method: 'POST',
      body: JSON.stringify({ contract_version: 1, ...(errorCode ? { error_code: errorCode } : {}) }),
    })
  }

  artboardModels(): Promise<any> {
    return this.request('/api/engine/artboard/models', { method: 'GET' })
  }

  async generateImage(cloudRunId: string, input: { aspectRatio: string; requestKey: string; prompt: string; signal?: AbortSignal | null }): Promise<Record<string, any>> {
    const aspectRatio = ['1:1', '9:16', '16:9'].includes(input.aspectRatio) ? input.aspectRatio : null
    if (!aspectRatio) throw new TypeError('Image aspect ratio must be 1:1, 9:16, or 16:9')
    const response = await this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/artboard/images`, {
      method: 'POST',
      signal: input.signal,
      body: JSON.stringify({
        contract_version: 1,
        request_key: input.requestKey,
        prompt: input.prompt,
        aspect_ratio: aspectRatio,
      }),
    }, { raw: true, timeoutMs: 5 * 60_000 })
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (!contentType || !['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) throw new Error('Orbit image response has an unsupported content type')
    const declared = response.headers.get('content-length')
    if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 16 || Number(declared) > MAX_IMAGE_RESPONSE)) {
      throw new Error('Orbit image response declared an invalid size')
    }
    const bytes = await collectStream(response.body, MAX_IMAGE_RESPONSE)
    if (bytes.byteLength < 16 || (declared !== null && Number(declared) !== bytes.byteLength)) throw new Error('Orbit image response was truncated')
    if (sniffImage(bytes) !== contentType) throw new Error('Orbit image response signature does not match its content type')
    const actualHash = sha256(bytes)
    const model = response.headers.get('x-orbit-image-model')
    const degradedFrom = response.headers.get('x-orbit-image-degraded-from')
    const expectedHash = response.headers.get('x-orbit-content-sha256')?.toLowerCase()
    const expectedDimensions = aspectRatio === '1:1' ? [1024, 1024] : aspectRatio === '9:16' ? [576, 1024] : [1024, 576]
    if (response.headers.get('x-orbit-contract-version') !== '1'
      || response.headers.get('x-orbit-request-key') !== input.requestKey
      || !model || !OFFICIAL_IMAGE_MODELS.has(model)
      || (degradedFrom !== null && (degradedFrom !== 'google/nano-banana' || model === degradedFrom))
      || response.headers.get('x-orbit-image-aspect-ratio') !== aspectRatio
      || Number(response.headers.get('x-orbit-image-width')) !== expectedDimensions[0]
      || Number(response.headers.get('x-orbit-image-height')) !== expectedDimensions[1]
      || !expectedHash || expectedHash !== actualHash) {
      throw new Error('Orbit image receipt did not match the downloaded bytes')
    }
    return {
      bytes,
      contentType,
      contentSha256: actualHash,
      model,
      degraded: degradedFrom !== null,
      degradedFrom,
      width: expectedDimensions[0],
      height: expectedDimensions[1],
      aspectRatio,
      costUsd: Number(response.headers.get('x-orbit-cost-usd')) || 0,
      runCostUsd: Number(response.headers.get('x-orbit-run-cost-usd')) || 0,
    }
  }

  start3dJob(cloudRunId: string, input: Record<string, any>): Promise<any> {
    return this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/artboard/jobs`, {
      method: 'POST',
      body: JSON.stringify({
        contract_version: 1,
        request_key: input.requestKey,
        kind: 'model3d',
        prompt: input.prompt,
        model: input.model,
        options: { face_count: input.faceCount, enable_pbr: input.enablePbr },
      }),
    })
  }

  get3dJob(cloudRunId: string, jobId: string): Promise<any> {
    return this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/artboard/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' })
  }

  async download3dJob(cloudRunId: string, jobId: string): Promise<{ response: Response; bytes: Buffer }> {
    const response = await this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/artboard/jobs/${encodeURIComponent(jobId)}/content`, { method: 'GET' }, { raw: true, timeoutMs: 5 * 60_000 })
    const bytes = await collectStream(response.body, 64 * 1024 * 1024)
    return { response, bytes }
  }

  ack3dJob(cloudRunId: string, jobId: string, contentSha256: string): Promise<any> {
    return this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/artboard/jobs/${encodeURIComponent(jobId)}/ack`, {
      method: 'POST', body: JSON.stringify({ contract_version: 1, content_sha256: contentSha256 }),
    })
  }

  startHumanoid(cloudRunId: string, requestKey: string, prompt: string, motions: string[] = []): Promise<any> {
    return this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/humanoid-characters`, {
      method: 'POST', body: JSON.stringify({ contract_version: 1, request_key: requestKey, prompt, motions }),
    })
  }

  humanoidStatus(cloudRunId: string, jobId: string): Promise<any> {
    return this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/humanoid-characters/${encodeURIComponent(jobId)}`, { method: 'GET' })
  }

  publish(form: FormData): Promise<any> {
    return this.request('/api/games/publish-pro-import', { method: 'POST', body: form }, { timeoutMs: 5 * 60_000 })
  }

  uploadLogs(body: Record<string, unknown>): Promise<any> {
    return this.request('/api/engine/cli/logs', { method: 'POST', body: JSON.stringify(body) })
      .catch((error) => ({ accepted_event_ids: [], error: publicError(error) }))
  }
}
