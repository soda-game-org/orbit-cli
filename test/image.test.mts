import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { OrbitApi } from '../src/api.mjs'
import { ImageService } from '../src/image.mjs'
import { sha256 } from '../src/util.mjs'

const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
  0x00, 0x00, 0x00, 0x00,
])
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
])

function imageHeaders(requestKey, overrides = {}) {
  return {
    'content-type': 'image/webp',
    'content-length': String(WEBP.byteLength),
    'x-orbit-contract-version': '1',
    'x-orbit-request-key': requestKey,
    'x-orbit-image-model': 'google/nano-banana',
    'x-orbit-image-aspect-ratio': '1:1',
    'x-orbit-image-width': '1024',
    'x-orbit-image-height': '1024',
    'x-orbit-content-sha256': sha256(WEBP),
    'x-orbit-cost-usd': '0.039',
    'x-orbit-run-cost-usd': '0.039',
    ...overrides,
  }
}

test('Orbit image API validates the signed receipt and response bytes', async () => {
  let request
  const api = new OrbitApi({ accessToken: async () => 'test-token' }, {
    origin: 'https://api.example.test',
    fetchImpl: async (url, init) => {
      request = { url: String(url), init }
      return new Response(WEBP, { status: 200, headers: imageHeaders('image_request_1') })
    },
  })
  const result = await api.generateImage('11111111-1111-4111-8111-111111111111', {
    requestKey: 'image_request_1', prompt: 'An original arcade icon', aspectRatio: '1:1',
  })
  assert.equal(request.url, 'https://api.example.test/api/engine/runs/11111111-1111-4111-8111-111111111111/artboard/images')
  assert.equal(request.init.headers.Authorization, 'Bearer test-token')
  assert.deepEqual(JSON.parse(request.init.body), {
    contract_version: 1, request_key: 'image_request_1', prompt: 'An original arcade icon', aspect_ratio: '1:1',
  })
  assert.equal(result.contentType, 'image/webp')
  assert.equal(result.contentSha256, sha256(WEBP))
  assert.deepEqual([result.width, result.height], [1024, 1024])
  assert.equal(result.degraded, false)
  assert.equal(result.degradedFrom, null)
})

test('Orbit image API accepts an explicit signed fallback receipt', async () => {
  const api = new OrbitApi({ accessToken: async () => 'test-token' }, {
    origin: 'https://api.example.test',
    fetchImpl: async () => new Response(WEBP, { status: 200, headers: imageHeaders('image_request_fallback', {
      'x-orbit-image-model': 'google/imagen-4-fast',
      'x-orbit-image-degraded-from': 'google/nano-banana',
    }) }),
  })
  const result = await api.generateImage('11111111-1111-4111-8111-111111111111', {
    requestKey: 'image_request_fallback', prompt: 'An original arcade icon', aspectRatio: '1:1',
  })
  assert.equal(result.model, 'google/imagen-4-fast')
  assert.equal(result.degraded, true)
  assert.equal(result.degradedFrom, 'google/nano-banana')
})

test('ImageService attempts to settle the ambiguous run before an unsafe retry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-image-retry-settle-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const settled = []
  const state = {
    requestPending: true,
    cloudRunId: '22222222-2222-4222-8222-222222222222',
    requestKey: 'old-request',
    clientRunId: 'old-client-run',
  }
  await new ImageService().generate({
    workspace, output: 'assets/icon.png', prompt: 'An original arcade icon', state, retryUnsafe: true,
    api: {
      settle: async (...args) => { settled.push(args) },
      models: async () => ({ default: 'agent-model', models: [{ id: 'agent-model' }] }),
      beginRun: async () => ({ run_id: '33333333-3333-4333-8333-333333333333' }),
      generateImage: async () => ({ bytes: PNG, contentType: 'image/png', width: 1024, height: 1024, model: 'google/nano-banana' }),
    },
    persist: async () => {},
  })
  assert.deepEqual(settled[0], ['22222222-2222-4222-8222-222222222222', 'fail', 'client_unsafe_retry'])
})

test('Orbit image API rejects a mismatched content receipt', async () => {
  const api = new OrbitApi({ accessToken: async () => 'test-token' }, {
    origin: 'https://api.example.test',
    fetchImpl: async () => new Response(WEBP, { status: 200, headers: imageHeaders('image_request_2', { 'x-orbit-content-sha256': '0'.repeat(64) }) }),
  })
  await assert.rejects(api.generateImage('11111111-1111-4111-8111-111111111111', {
    requestKey: 'image_request_2', prompt: 'An original arcade icon', aspectRatio: '1:1',
  }), /receipt did not match/)
})

test('ImageService checkpoints the paid request and writes only a safe PNG path', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-image-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const state = {}
  const checkpoints = []
  let settled = false
  const service = new ImageService()
  const result = await service.generate({
    workspace, output: 'assets/images/icon.png', prompt: 'An original neon arcade icon', aspectRatio: '1:1', state,
    api: {
      models: async () => ({ default: 'agent-model', models: [{ id: 'first-model' }, { id: 'agent-model' }] }),
      beginRun: async (input) => {
        assert.equal(input.modelId, 'agent-model')
        return { run_id: '22222222-2222-4222-8222-222222222222' }
      },
      generateImage: async () => ({ bytes: PNG, contentType: 'image/png', width: 1024, height: 1024, model: 'google/nano-banana', costUsd: 0.039 }),
      settle: async () => { settled = true },
    },
    persist: async () => { checkpoints.push(structuredClone(state)) },
  })
  assert.equal(result.relativePath, 'assets/images/icon.png')
  assert.equal(sha256(await fs.readFile(result.path)), sha256(PNG))
  assert.equal(settled, true)
  assert.equal(state.requestPending, false)
  assert.equal(checkpoints.some((checkpoint) => checkpoint.requestPending === true), true)
})

test('ImageService rejects an unsafe destination before reserving a paid run', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-image-path-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const outside = path.join(root, 'outside')
  await fs.mkdir(workspace)
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(workspace, 'linked'))
  let called = false
  await assert.rejects(new ImageService().generate({
    workspace, output: 'linked/icon.png', prompt: 'An original neon arcade icon', state: {},
    api: { models: async () => { called = true } },
  }), /unsafe/)
  assert.equal(called, false)
})

test('ImageService fails closed when a paid request has an ambiguous result', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-image-retry-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const state = {}
  await assert.rejects(new ImageService().generate({
    workspace, output: 'generated.png', prompt: 'An original neon arcade icon', state,
    api: {
      models: async () => ({ default: 'agent-model', models: [{ id: 'first-model' }, { id: 'agent-model' }] }),
      beginRun: async (input) => {
        assert.equal(input.modelId, 'agent-model')
        return { run_id: '22222222-2222-4222-8222-222222222222' }
      },
      generateImage: async () => { throw new Error('connection reset') },
    },
    persist: async () => {},
  }), (error) => error.code === 'UNSAFE_IMAGE_RETRY_REQUIRED')
  assert.equal(state.requestPending, true)
})

test('ImageService materializes a BYOK Replicate prediction as a verified local PNG', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-image-byok-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const state = {}
  const requests = []
  const service = new ImageService({
    credentials: { get: async (account) => {
      assert.equal(account, 'provider:replicate')
      return 'replicate-key'
    } },
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init })
      if (String(url).includes('/models/')) return Response.json({ id: 'prediction-image-1', status: 'starting' })
      if (String(url).includes('/predictions/')) return Response.json({ id: 'prediction-image-1', status: 'succeeded', output: 'https://replicate.delivery/test/game.png' })
      assert.equal(String(url), 'https://replicate.delivery/test/game.png')
      assert.equal(init.redirect, 'error')
      return new Response(PNG, { headers: { 'content-type': 'image/png' } })
    },
  })
  const output = await service.generate({
    mode: 'byok', workspace, output: 'assets/images/game.png',
    prompt: 'Original high-impact game background', aspectRatio: '16:9', state,
    pollIntervalMs: 1, persist: async () => {},
  })
  assert.equal(requests.length, 3)
  assert.equal(output.relativePath, 'assets/images/game.png')
  assert.equal(output.model, 'google/nano-banana')
  assert.equal(output.width, 1)
  assert.equal(output.height, 1)
  assert.equal(sha256(await fs.readFile(output.path)), sha256(PNG))
  assert.deepEqual(state.output, output)
})

test('ImageService requires explicit confirmation after an ambiguous Replicate submission', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-image-byok-unsafe-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const state = {}
  const service = new ImageService({
    credentials: { get: async () => 'replicate-key' },
    fetchImpl: async () => { throw new TypeError('connection reset') },
  })
  await assert.rejects(service.generate({
    mode: 'byok', workspace, output: 'assets/images/game.png',
    prompt: 'Original high-impact game background', state, persist: async () => {},
  }), (error) => error.code === 'UNSAFE_IMAGE_RETRY_REQUIRED')
  assert.equal(state.requestPending, true)
  assert.equal(state.predictionId, undefined)
})
