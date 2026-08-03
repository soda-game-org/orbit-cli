import fs from 'node:fs/promises'
import path from 'node:path'
import { providerCredentialAccount } from './credentials.mjs'
import { collectStream, id, isContained, sha256, sleep } from './util.mjs'

const MODEL = 'tencent/hunyuan-3d-3.1'
const MAX_MODEL_BYTES = 64 * 1024 * 1024
const TERMINAL = new Set(['ready', 'failed', 'cancelled', 'acked'])

async function responseJson(response) {
  const text = Buffer.from(await collectStream(response.body, 1024 * 1024)).toString('utf8')
  try { return text ? JSON.parse(text) : null } catch { return null }
}

export function isValidGlb(bytes) {
  if (bytes.byteLength < 20 || Buffer.from(bytes.subarray(0, 4)).toString('ascii') !== 'glTF') return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(4, true) === 2 && view.getUint32(8, true) === bytes.byteLength
}

async function writeGlb(workspace, output, bytes) {
  if (!isValidGlb(bytes)) throw new Error('3D provider output is not a valid GLB 2.0 file')
  const root = await fs.realpath(workspace)
  const target = path.resolve(root, output || 'assets/models/generated.glb')
  if (!isContained(root, target)) throw new Error('3D output path escaped the workspace')
  const relative = path.relative(root, target).split(path.sep)
  let current = root
  for (const part of relative.slice(0, -1)) {
    current = path.join(current, part)
    const before = await fs.lstat(current).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (!before) await fs.mkdir(current, { mode: 0o755 })
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('3D output directory is unsafe')
    if (!isContained(root, await fs.realpath(current))) throw new Error('3D output directory escaped the workspace')
  }
  const temporary = `${target}.${process.pid}.tmp`
  await fs.writeFile(temporary, bytes, { mode: 0o644, flag: 'wx' })
  await fs.rename(temporary, target)
  return { path: target, relativePath: path.relative(root, target).split(path.sep).join('/'), sha256: sha256(bytes), bytes: bytes.byteLength }
}

function outputUrl(value) {
  if (typeof value === 'string' && value.startsWith('https://')) return value
  if (Array.isArray(value)) {
    for (const item of value) { const found = outputUrl(item); if (found) return found }
  }
  if (value && typeof value === 'object') {
    for (const key of ['glb', 'mesh', 'model', 'output']) {
      const found = outputUrl(value[key]); if (found) return found
    }
  }
  return null
}

function validateDeliveryUrl(value) {
  if (!value) throw new Error('Replicate returned no GLB download URL')
  const url = new URL(value)
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || (host !== 'replicate.delivery' && !host.endsWith('.replicate.delivery'))) {
    throw new Error('Replicate returned an untrusted model download URL')
  }
  return url
}

export class ThreeDService {
  constructor({ api, credentials, fetchImpl = fetch }) {
    this.api = api
    this.credentials = credentials
    this.fetchImpl = fetchImpl
  }

  async generate(input) {
    return input.mode === 'byok' ? this.#byok(input) : this.#official(input)
  }

  async #official(input) {
    const state = input.state || {}
    if (!state.cloudRunId) {
      const begun = await this.api.beginRun({
        clientRunId: input.clientRunId || id('asset3d_'),
        purpose: 'artboard_model3d',
        modelId: MODEL,
      })
      state.cloudRunId = begun.run_id
      await input.persist?.(state)
    }
    if (!state.jobId) {
      const started = await this.api.start3dJob(state.cloudRunId, {
        requestKey: input.requestKey || id('model3d_'),
        prompt: String(input.prompt).slice(0, 8_000),
        model: MODEL,
        faceCount: Math.min(1_500_000, Math.max(40_000, Number(input.faceCount) || 100_000)),
        enablePbr: input.enablePbr !== false,
      })
      state.jobId = started.job.id
      state.status = started.job.status
      await input.persist?.(state)
    }
    let job
    while (true) {
      const envelope = await this.api.get3dJob(state.cloudRunId, state.jobId)
      job = envelope.job
      state.status = job.status
      await input.persist?.(state)
      await input.onProgress?.(job)
      if (TERMINAL.has(job.status)) break
      await sleep(5_000, input.signal)
    }
    if (job.status !== 'ready' && job.status !== 'acked') throw new Error(`Orbit 3D generation ended with ${job.status}: ${job.error_code || 'unknown error'}`)
    if (job.status === 'acked' && state.output) return state.output
    const downloaded = await this.api.download3dJob(state.cloudRunId, state.jobId)
    const expectedHash = downloaded.response.headers.get('x-orbit-content-sha256')?.toLowerCase()
    const actualHash = sha256(downloaded.bytes)
    if (!expectedHash || expectedHash !== actualHash || job.content_sha256 !== actualHash) throw new Error('Orbit 3D receipt hash did not match downloaded bytes')
    const output = await writeGlb(input.workspace, input.output, downloaded.bytes)
    state.output = output
    await input.persist?.(state)
    await this.api.ack3dJob(state.cloudRunId, state.jobId, actualHash)
    state.status = 'acked'
    await input.persist?.(state)
    return output
  }

  async #byok(input) {
    const token = await this.credentials.get(providerCredentialAccount('replicate'))
    if (!token) throw new Error('No Replicate API key is configured')
    const state = input.state || {}
    if (!state.predictionId) {
      state.requestPending = true
      await input.persist?.(state)
      const response = await this.fetchImpl(`https://api.replicate.com/v1/models/${MODEL}/predictions`, {
        method: 'POST', signal: input.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: {
          prompt: String(input.prompt).slice(0, 8_000),
          face_count: Math.min(1_500_000, Math.max(40_000, Number(input.faceCount) || 100_000)),
          generate_type: 'Normal',
          enable_pbr: input.enablePbr !== false,
        } }),
      })
      const body = await responseJson(response)
      if (!response.ok || !body?.id) throw new Error(body?.detail || `Replicate 3D request failed (${response.status})`)
      state.predictionId = body.id
      state.status = body.status
      state.requestPending = false
      await input.persist?.(state)
    }
    let prediction
    while (true) {
      const response = await this.fetchImpl(`https://api.replicate.com/v1/predictions/${encodeURIComponent(state.predictionId)}`, {
        signal: input.signal, headers: { Authorization: `Bearer ${token}` },
      })
      prediction = await responseJson(response)
      if (!response.ok || !prediction) throw new Error(`Replicate 3D polling failed (${response.status})`)
      state.status = prediction.status
      await input.persist?.(state)
      await input.onProgress?.(prediction)
      if (['succeeded', 'failed', 'canceled'].includes(prediction.status)) break
      await sleep(5_000, input.signal)
    }
    if (prediction.status !== 'succeeded') throw new Error(`Replicate 3D generation ${prediction.status}: ${prediction.error || 'unknown error'}`)
    const url = validateDeliveryUrl(outputUrl(prediction.output))
    const response = await this.fetchImpl(url, { redirect: 'error', signal: input.signal })
    if (!response.ok) throw new Error(`Replicate model download failed (${response.status})`)
    const bytes = await collectStream(response.body, MAX_MODEL_BYTES)
    const output = await writeGlb(input.workspace, input.output, bytes)
    state.output = output
    await input.persist?.(state)
    return output
  }
}
