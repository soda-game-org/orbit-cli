import { API_ORIGIN, ENGINE_AGENT_CONTEXT_SCHEMA, ENGINE_CONTRACT_VERSION, ENGINE_LLM_CONTRACT_VERSION, VERSION } from './constants.mjs'
import { collectStream, publicError } from './util.mjs'

const MAX_JSON_RESPONSE = 8 * 1024 * 1024

export class OrbitApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message)
    this.name = 'OrbitApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export class OrbitApi {
  constructor(auth, { origin = API_ORIGIN, fetchImpl = fetch, source = 'cli' } = {}) {
    this.auth = auth
    this.origin = new URL(origin).origin
    this.fetchImpl = fetchImpl
    this.source = source
  }

  async request(pathname, init = {}, { timeoutMs = 30_000, raw = false } = {}) {
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
      let body = null
      const text = Buffer.from(await collectStream(response.body, MAX_JSON_RESPONSE)).toString('utf8')
      try { body = text ? JSON.parse(text) : null } catch { body = null }
      if (!response.ok) {
        throw new OrbitApiError(response.status, body?.code || null, body?.message || `Orbit request failed (${response.status})`, body)
      }
      return body
    } finally {
      clearTimeout(timer)
    }
  }

  models() {
    return this.request('/api/engine/models', { method: 'GET', headers: { 'Cache-Control': 'no-store' } })
  }

  beginRun({ clientRunId, purpose, modelId, generate3d = false }) {
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

  complete({ cloudRunId, requestKey, purpose = 'agent', messages, tools = [], runtime = 'html', operation = 'create', maxOutputTokens = 16_000, signal }) {
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

  heartbeat(cloudRunId) {
    return this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/heartbeat`, {
      method: 'POST', body: JSON.stringify({ contract_version: 1 }),
    })
  }

  settle(cloudRunId, state, errorCode = null) {
    if (!['complete', 'fail', 'cancel'].includes(state)) throw new TypeError('Invalid settlement state')
    return this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/${state}`, {
      method: 'POST',
      body: JSON.stringify({ contract_version: 1, ...(errorCode ? { error_code: errorCode } : {}) }),
    })
  }

  artboardModels() {
    return this.request('/api/engine/artboard/models', { method: 'GET' })
  }

  start3dJob(cloudRunId, input) {
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

  get3dJob(cloudRunId, jobId) {
    return this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/artboard/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' })
  }

  async download3dJob(cloudRunId, jobId) {
    const response = await this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/artboard/jobs/${encodeURIComponent(jobId)}/content`, { method: 'GET' }, { raw: true, timeoutMs: 5 * 60_000 })
    const bytes = await collectStream(response.body, 64 * 1024 * 1024)
    return { response, bytes }
  }

  ack3dJob(cloudRunId, jobId, contentSha256) {
    return this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/artboard/jobs/${encodeURIComponent(jobId)}/ack`, {
      method: 'POST', body: JSON.stringify({ contract_version: 1, content_sha256: contentSha256 }),
    })
  }

  startHumanoid(cloudRunId, requestKey, prompt, motions = []) {
    return this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/humanoid-characters`, {
      method: 'POST', body: JSON.stringify({ contract_version: 1, request_key: requestKey, prompt, motions }),
    })
  }

  humanoidStatus(cloudRunId, jobId) {
    return this.request(`/api/engine/runs/${encodeURIComponent(cloudRunId)}/humanoid-characters/${encodeURIComponent(jobId)}`, { method: 'GET' })
  }

  publish(form) {
    return this.request('/api/games/publish-pro-import', { method: 'POST', body: form }, { timeoutMs: 5 * 60_000 })
  }

  uploadLogs(body) {
    return this.request('/api/engine/cli/logs', { method: 'POST', body: JSON.stringify(body) })
      .catch((error) => ({ accepted_event_ids: [], error: publicError(error) }))
  }
}
