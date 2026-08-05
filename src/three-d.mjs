import fs from 'node:fs/promises'
import path from 'node:path'
import { providerCredentialAccount } from './credentials.mjs'
import { collectStream, id, isContained, sha256, sleep } from './util.mjs'
import { generateReplicateModel3d, validateReplicateDeliveryUrl } from '../packages/orbit-provider-core/index.mjs'

const MODEL = 'tencent/hunyuan-3d-3.1'
const MAX_MODEL_BYTES = 64 * 1024 * 1024
const TERMINAL = new Set(['ready', 'failed', 'cancelled', 'acked'])

function retryableOfficialPollError(error) {
  const status = Number(error?.status)
  return status === 408 || status === 425 || status === 429 || status >= 500
    || ['AbortError', 'TimeoutError'].includes(error?.name)
    || error instanceof TypeError
}

async function responseJson(response) {
  const text = Buffer.from(await collectStream(response.body, 1024 * 1024)).toString('utf8')
  try { return text ? JSON.parse(text) : null } catch { return null }
}

export function isValidGlb(bytes) {
  if (bytes.byteLength < 20 || Buffer.from(bytes.subarray(0, 4)).toString('ascii') !== 'glTF') return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(4, true) === 2 && view.getUint32(8, true) === bytes.byteLength
}

async function prepareGlbTarget(workspace, output) {
  const root = await fs.realpath(workspace)
  const relativeOutput = String(output || 'assets/models/generated.glb').replaceAll('\\', '/')
  if (!relativeOutput || relativeOutput.startsWith('/') || /^[A-Za-z]:/.test(relativeOutput)
    || relativeOutput.split('/').some((part) => !part || part === '.' || part === '..')
    || path.posix.extname(relativeOutput).toLowerCase() !== '.glb') {
    throw new Error('3D output must be a safe workspace-relative .glb path')
  }
  const target = path.resolve(root, relativeOutput)
  if (!isContained(root, target)) throw new Error('3D output path escaped the workspace')
  const relative = path.relative(root, target).split(path.sep)
  let current = root
  for (const part of relative.slice(0, -1)) {
    current = path.join(current, part)
    const before = await fs.lstat(current).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (!before) await fs.mkdir(current, { mode: 0o755 })
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('3D output directory is unsafe')
    if (await fs.realpath(current) !== current || !isContained(root, current)) throw new Error('3D output directory escaped the workspace')
  }
  const existing = await fs.lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || await fs.realpath(target) !== target)) throw new Error('3D output destination is unsafe')
  return { root, target }
}

async function writeGlb(prepared, bytes) {
  if (!isValidGlb(bytes)) throw new Error('3D provider output is not a valid GLB 2.0 file')
  const { root, target } = prepared
  const parent = path.dirname(target)
  if (await fs.realpath(parent) !== parent || !isContained(root, parent)) throw new Error('3D output directory changed while generating')
  const temporary = `${target}.${process.pid}.tmp`
  await fs.writeFile(temporary, bytes, { mode: 0o644, flag: 'wx' })
  await fs.rename(temporary, target)
  return { path: target, relativePath: path.relative(root, target).split(path.sep).join('/'), sha256: sha256(bytes), bytes: bytes.byteLength }
}

export class ThreeDService {
  constructor({ api, credentials, fetchImpl = fetch }) {
    this.api = api
    this.credentials = credentials
    this.fetchImpl = fetchImpl
  }

  async generate(input) {
    const prepared = await prepareGlbTarget(input.workspace, input.output)
    return input.mode === 'byok' ? this.#byok({ ...input, prepared }) : this.#official({ ...input, prepared })
  }

  async #official(input) {
    const state = input.state || {}
    const pollIntervalMs = Math.max(1, Number(input.pollIntervalMs) || 5_000)
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
      let envelope
      for (let attempt = 0; ; attempt += 1) {
        try {
          envelope = await this.api.get3dJob(state.cloudRunId, state.jobId)
          break
        } catch (error) {
          if (input.signal?.aborted || attempt >= 3 || !retryableOfficialPollError(error)) throw error
          await input.onProgress?.({ status: 'poll_retry' })
          await sleep(pollIntervalMs, input.signal)
        }
      }
      job = envelope.job
      state.status = job.status
      await input.persist?.(state)
      await input.onProgress?.(job)
      if (TERMINAL.has(job.status)) break
      await sleep(pollIntervalMs, input.signal)
    }
    if (job.status !== 'ready' && job.status !== 'acked') throw new Error(`Orbit 3D generation ended with ${job.status}: ${job.error_code || 'unknown error'}`)
    if (job.status === 'acked' && state.output) return state.output
    const downloaded = await this.api.download3dJob(state.cloudRunId, state.jobId)
    const expectedHash = downloaded.response.headers.get('x-orbit-content-sha256')?.toLowerCase()
    const actualHash = sha256(downloaded.bytes)
    if (!expectedHash || expectedHash !== actualHash || job.content_sha256 !== actualHash) throw new Error('Orbit 3D receipt hash did not match downloaded bytes')
    const output = await writeGlb(input.prepared, downloaded.bytes)
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
    const generated = await generateReplicateModel3d({
      apiKey: token,
      prompt: input.prompt,
      faceCount: input.faceCount,
      enablePbr: input.enablePbr,
      state,
      signal: input.signal,
      fetchImpl: this.fetchImpl,
      persist: input.persist,
      onProgress: input.onProgress,
    })
    const url = validateReplicateDeliveryUrl(generated.outputUrl)
    const response = await this.fetchImpl(url, { redirect: 'error', signal: input.signal })
    if (!response.ok) throw new Error(`Replicate model download failed (${response.status})`)
    const bytes = await collectStream(response.body, MAX_MODEL_BYTES)
    const output = await writeGlb(input.prepared, bytes)
    state.output = output
    await input.persist?.(state)
    return output
  }
}
