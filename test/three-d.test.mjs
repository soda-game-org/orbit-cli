import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { ThreeDService, isValidGlb } from '../src/three-d.mjs'

function glbFixture() {
  const bytes = Buffer.alloc(20)
  bytes.write('glTF', 0, 'ascii')
  bytes.writeUInt32LE(2, 4)
  bytes.writeUInt32LE(bytes.byteLength, 8)
  return bytes
}

test('BYOK 3D validates the GLB receipt and writes a safe workspace file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-3d-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const glb = glbFixture()
  let calls = 0
  const service = new ThreeDService({
    credentials: { get: async () => 'test-token' },
    fetchImpl: async (url, init = {}) => {
      calls += 1
      if (String(url).includes('/models/')) return Response.json({ id: 'prediction-1', status: 'starting' })
      if (String(url).includes('/predictions/')) return Response.json({ id: 'prediction-1', status: 'succeeded', output: 'https://replicate.delivery/test/model.glb' })
      assert.equal(String(url), 'https://replicate.delivery/test/model.glb')
      assert.equal(init.redirect, 'error')
      return new Response(glb, { status: 200, headers: { 'content-type': 'model/gltf-binary' } })
    },
  })
  const state = {}
  const output = await service.generate({
    mode: 'byok', workspace, output: 'assets/models/ship.glb', prompt: 'An original low-poly arcade ship', state,
    persist: async () => {}, pollIntervalMs: 1,
  })
  assert.equal(calls, 3)
  assert.equal(output.relativePath, 'assets/models/ship.glb')
  assert.equal(isValidGlb(await fs.readFile(output.path)), true)
  assert.equal(state.predictionId, 'prediction-1')
})

test('3D output extension and symlink boundaries are checked before provider access', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-3d-path-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const outside = path.join(root, 'outside')
  await fs.mkdir(workspace)
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(workspace, 'linked'))
  let credentialsRead = false
  const service = new ThreeDService({ credentials: { get: async () => { credentialsRead = true; return 'test-token' } } })
  await assert.rejects(service.generate({ mode: 'byok', workspace, output: 'model.txt', prompt: 'An original low-poly arcade ship' }), /workspace-relative \.glb/)
  await assert.rejects(service.generate({ mode: 'byok', workspace, output: 'linked/model.glb', prompt: 'An original low-poly arcade ship' }), /unsafe|escaped/)
  assert.equal(credentialsRead, false)
})

test('official 3D retries a transient status request without starting a second job', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-3d-official-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const glb = glbFixture()
  const hash = createHash('sha256').update(glb).digest('hex')
  let starts = 0
  let polls = 0
  const state = {}
  const service = new ThreeDService({
    api: {
      beginRun: async () => ({ run_id: 'cloud-1' }),
      start3dJob: async () => { starts += 1; return { job: { id: 'job-1', status: 'processing' } } },
      get3dJob: async () => {
        polls += 1
        if (polls === 1) throw Object.assign(new Error('temporary mirror error'), { status: 502 })
        return { job: { id: 'job-1', status: 'ready', content_sha256: hash } }
      },
      download3dJob: async () => ({
        response: new Response(glb, { headers: { 'x-orbit-content-sha256': hash } }),
        bytes: glb,
      }),
      ack3dJob: async () => ({ job: { id: 'job-1', status: 'acked' } }),
    },
  })
  const output = await service.generate({
    mode: 'orbit', workspace, output: 'assets/models/robot.glb', prompt: 'An original arcade robot',
    state, pollIntervalMs: 1, persist: async () => {},
  })
  assert.equal(starts, 1)
  assert.equal(polls, 2)
  assert.equal(output.relativePath, 'assets/models/robot.glb')
  assert.equal(state.status, 'acked')
})
