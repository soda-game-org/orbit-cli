import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ensureLocalStoreMedia, LOCAL_STORE_MEDIA_PATHS } from '../src/store-media.mjs'

function run(workspace: string, generateImages: boolean): any {
  return {
    id: 'run-store-media', threadId: 'thread-store-media', workspace, prompt: 'A bright original puzzle game',
    mode: 'byok', generateImages, storeMediaGeneration: {},
  }
}

test('store media is non-blocking when image generation is unavailable', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-store-media-'))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  const checkpoint = run(workspace, false)
  const manifest = await ensureLocalStoreMedia({ run: checkpoint, image: null, persist: async () => undefined })
  assert.equal(manifest.assets.listing_cover.state, 'skipped')
  assert.equal(manifest.assets.app_icon.reason, 'capability_unavailable')
  assert.equal(JSON.parse(await fs.readFile(path.join(workspace, LOCAL_STORE_MEDIA_PATHS.manifest), 'utf8')).schema, 'orbit.agent-store-media.v1')
})

test('store media uses exact logical roles and local artifact paths', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-store-media-'))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  const checkpoint = run(workspace, true)
  const calls: any[] = []
  const image = { generate: async (input: any) => {
    calls.push(input)
    const absolute = path.join(workspace, input.output)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, Buffer.from('89504e470d0a1a0a00000000', 'hex'))
    return { relativePath: input.output, contentType: 'image/png', sha256: 'a'.repeat(64), width: input.aspectRatio === '3:4' ? 768 : 512, height: input.aspectRatio === '3:4' ? 1024 : 512 }
  } }
  const manifest = await ensureLocalStoreMedia({ run: checkpoint, image, persist: async () => undefined })
  assert.deepEqual(calls.map((call) => [call.output, call.aspectRatio]), [
    [LOCAL_STORE_MEDIA_PATHS.listingCover, '3:4'],
    [LOCAL_STORE_MEDIA_PATHS.appIcon, '1:1'],
  ])
  assert.equal(manifest.assets.listing_cover.state, 'generated')
  assert.equal(manifest.assets.app_icon.location, LOCAL_STORE_MEDIA_PATHS.appIcon)
})
