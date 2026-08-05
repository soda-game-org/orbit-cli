import fs from 'node:fs/promises'
import path from 'node:path'
import { providerCredentialAccount } from './credentials.mjs'
import { boundedString, canonicalDirectory, collectStream, id, isContained, sha256 } from './util.mjs'
import { generateReplicateImage } from '../packages/orbit-provider-core/index.mjs'

const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const EXTENSIONS = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
})

function catalogModel(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : []
  const preferred = catalog?.default_model_id || catalog?.defaultModelId || catalog?.default || catalog?.defaults?.pro || catalog?.defaults?.standard
  if (preferred && models.some((model) => model?.id === preferred)) return preferred
  return models.find((model) => model?.available !== false)?.id || null
}

async function prepareTarget(workspace, output) {
  const root = await canonicalDirectory(workspace)
  const relative = String(output || 'assets/images/generated.png').replaceAll('\\', '/')
  if (!relative || relative.startsWith('/') || /^[A-Za-z]:/.test(relative)
    || relative.split('/').some((part) => !part || part === '.' || part === '..')
    || path.posix.extname(relative).toLowerCase() !== '.png') {
    throw new Error('Image output must be a safe workspace-relative .png path')
  }
  const target = path.resolve(root, relative)
  if (!isContained(root, target)) throw new Error('Image output path escaped the workspace')
  let current = root
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part)
    const before = await fs.lstat(current).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (!before) await fs.mkdir(current, { mode: 0o755 })
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) throw new Error('Image output directory is unsafe')
  }
  const existing = await fs.lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || await fs.realpath(target) !== target)) throw new Error('Image output destination is unsafe')
  return { root, relative, target }
}

async function writeImage(prepared, generated) {
  const expectedExtension = EXTENSIONS[generated.contentType]
  if (expectedExtension !== '.png') throw new Error('Orbit returned an image format that does not match the requested .png output')
  if (!Buffer.from(generated.bytes).subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error('Image bytes do not match the declared PNG format')
  }
  const { root, relative, target } = prepared
  const parent = path.dirname(target)
  if (await fs.realpath(parent) !== parent || !isContained(root, parent)) throw new Error('Image output directory changed while generating')
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, generated.bytes, { flag: 'wx', mode: 0o644 })
  await fs.rename(temporary, target)
  return {
    path: target,
    relativePath: relative,
    bytes: generated.bytes.byteLength,
    sha256: sha256(generated.bytes),
    contentType: generated.contentType,
    width: generated.width,
    height: generated.height,
    model: generated.model,
    degraded: generated.degraded === true,
    degradedFrom: generated.degradedFrom || null,
    costUsd: generated.costUsd,
  }
}

export class ImageService {
  constructor({ credentials = null, fetchImpl = fetch } = {}) {
    this.credentials = credentials
    this.fetchImpl = fetchImpl
  }

  async generate(input) {
    const state = input.state || {}
    if (state.output) return state.output
    const prompt = boundedString(input.prompt, 'Image prompt', 8_000)
    const prepared = await prepareTarget(input.workspace, input.output)
    if (input.mode === 'byok') return this.#byok({ ...input, state, prompt, prepared })
    return this.#official({ ...input, state, prompt, prepared })
  }

  async #byok(input) {
    const { state } = input
    if (state.requestPending && !state.predictionId) {
      if (!input.retryUnsafe) {
        const error = new Error('The previous Replicate image submission may have succeeded; check Replicate usage before retrying')
        error.code = 'UNSAFE_IMAGE_RETRY_REQUIRED'
        throw error
      }
      const retryAttempt = Number(state.retryAttempt || 0) + 1
      for (const key of Object.keys(state)) delete state[key]
      state.retryAttempt = retryAttempt
      await input.persist?.(state)
    }
    const token = await this.credentials?.get(providerCredentialAccount('replicate'))
    if (!token) throw new Error('No Replicate API key is configured')
    let generated
    try {
      generated = await generateReplicateImage({
        apiKey: token,
        prompt: input.prompt,
        aspectRatio: input.aspectRatio || '1:1',
        state,
        signal: input.signal,
        fetchImpl: this.fetchImpl,
        persist: input.persist,
        onProgress: input.onProgress,
        pollIntervalMs: input.pollIntervalMs,
      })
    } catch (error) {
      if (state.requestPending && !state.predictionId) {
        const unsafe = new Error(error instanceof Error ? error.message : String(error))
        unsafe.code = 'UNSAFE_IMAGE_RETRY_REQUIRED'
        throw unsafe
      }
      if (state.predictionId && !['failed', 'canceled'].includes(state.status)) {
        const resumable = new Error(error instanceof Error ? error.message : String(error))
        resumable.code = 'IMAGE_PROVIDER_RESUME_REQUIRED'
        throw resumable
      }
      throw error
    }
    const response = await this.fetchImpl(generated.outputUrl, { redirect: 'error', signal: input.signal })
    if (!response.ok) {
      const resumable = new Error(`Replicate image download failed (${response.status})`)
      resumable.code = 'IMAGE_PROVIDER_RESUME_REQUIRED'
      throw resumable
    }
    const bytes = await collectStream(response.body, MAX_IMAGE_BYTES)
    const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
    const width = bytes.byteLength >= 24 && Buffer.from(bytes).subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16)
      : null
    const height = width != null ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20) : null
    const output = await writeImage(input.prepared, {
      bytes,
      contentType,
      width,
      height,
      model: generated.model,
      degraded: false,
      degradedFrom: null,
    })
    state.output = output
    await input.persist?.(state)
    return output
  }

  async #official(input) {
    const { state } = input
    if (state.requestPending && !input.retryUnsafe) {
      const error = new Error('The previous image request may have reached the provider; explicit unsafe retry is required')
      error.code = 'UNSAFE_IMAGE_RETRY_REQUIRED'
      throw error
    }
    if (state.requestPending && input.retryUnsafe) {
      if (state.cloudRunId) {
        await input.api.settle(state.cloudRunId, 'fail', 'client_unsafe_retry').catch(() => undefined)
      }
      delete state.cloudRunId
      delete state.requestKey
      delete state.clientRunId
      state.requestPending = false
      state.retryAttempt = Number(state.retryAttempt || 0) + 1
      await input.persist?.(state)
    }
    if (!state.cloudRunId) {
      state.modelId ||= catalogModel(await input.api.models())
      if (!state.modelId) throw new Error('Orbit returned no model for the image-generation lease')
      const baseClientRunId = input.clientRunId || id('image_')
      state.clientRunId ||= state.retryAttempt
        ? `${baseClientRunId}.retry.${state.retryAttempt}`.slice(0, 160)
        : baseClientRunId
      await input.persist?.(state)
      const begun = await input.api.beginRun({
        clientRunId: state.clientRunId,
        purpose: 'artboard_image',
        modelId: state.modelId,
      })
      state.cloudRunId = begun.run_id
      state.requestKey = input.requestKey || id('image_request_')
      await input.persist?.(state)
    }
    state.requestPending = true
    await input.persist?.(state)
    let generated
    try {
      generated = await input.api.generateImage(state.cloudRunId, {
        requestKey: state.requestKey,
        prompt: input.prompt,
        aspectRatio: input.aspectRatio || '1:1',
        signal: input.signal,
      })
      const output = await writeImage(input.prepared, generated)
      state.requestPending = false
      state.output = output
      await input.persist?.(state)
      await input.api.settle(state.cloudRunId, 'complete').catch(() => undefined)
      return output
    } catch (error) {
      await input.persist?.(state)
      if (!generated || state.requestPending) {
        const unsafe = new Error(error instanceof Error ? error.message : String(error))
        unsafe.code = 'UNSAFE_IMAGE_RETRY_REQUIRED'
        throw unsafe
      }
      await input.api.settle(state.cloudRunId, 'complete').catch(() => undefined)
      throw error
    }
  }
}
