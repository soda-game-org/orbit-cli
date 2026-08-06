import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  REFERENCE_ATTACHMENT_SCHEMA,
  ingestReferenceImages,
  referenceDataUrl,
  sniffImage,
} from '../src/attachments.mjs'

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)])

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-attachments-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  return { root, workspace }
}

test('accepts a matching PNG and revalidates cached bytes', async (t) => {
  const { root, workspace } = await fixture(t)
  const source = path.join(root, 'reference.png')
  await fs.writeFile(source, png)
  const [reference] = await ingestReferenceImages(workspace, [source])
  assert.deepEqual({
    schema: reference.schema,
    id: reference.id,
    kind: reference.kind,
    purpose: reference.purpose,
    position: reference.position,
    source: reference.source,
    mime: reference.mime,
    bytes: reference.bytes,
  }, {
    schema: REFERENCE_ATTACHMENT_SCHEMA,
    id: `attachment_${reference.sha256}`,
    kind: 'image',
    purpose: 'input_image',
    position: 0,
    source: 'local_reference',
    mime: 'image/png',
    bytes: png.byteLength,
  })
  assert.equal(Number.isFinite(new Date(reference.createdAt).getTime()), true)
  assert.equal(Object.hasOwn(reference, 'path'), false)
  assert.match(reference.privatePath, /^\.orbit\/references\/[a-f0-9]{64}\.png$/)
  assert.match(await referenceDataUrl(reference, workspace), /^data:image\/png;base64,/)
  assert.equal(sniffImage(new Uint8Array(png)), 'image/png')
})

test('deduplicates reference blobs while preserving each run-link position', async (t) => {
  const { root, workspace } = await fixture(t)
  const source = path.join(root, 'reference.png')
  await fs.writeFile(source, png)
  const references = await ingestReferenceImages(workspace, [source, source])
  assert.equal(references[0].id, references[1].id)
  assert.equal(references[0].sha256, references[1].sha256)
  assert.equal(references[0].privatePath, references[1].privatePath)
  assert.deepEqual(references.map((reference) => reference.position), [0, 1])
  assert.deepEqual(references.map((reference) => reference.purpose), ['input_image', 'input_image'])
  assert.deepEqual(await fs.readdir(path.join(workspace, '.orbit', 'references')), [path.basename(references[0].privatePath)])
})

test('resolves portable metadata after a workspace move and keeps legacy path compatibility', async (t) => {
  const { root, workspace } = await fixture(t)
  const source = path.join(root, 'reference.png')
  await fs.writeFile(source, png)
  const [reference] = await ingestReferenceImages(workspace, [source])
  const previousPath = path.join(workspace, ...reference.privatePath.split('/'))
  const moved = path.join(root, 'moved-workspace')
  await fs.rename(workspace, moved)
  assert.match(await referenceDataUrl({ ...reference, path: previousPath }, moved), /^data:image\/png;base64,/)

  const currentPath = path.join(moved, ...reference.privatePath.split('/'))
  const legacy = {
    path: currentPath,
    originalName: reference.originalName,
    mime: reference.mime,
    bytes: reference.bytes,
    sha256: reference.sha256,
  }
  assert.match(await referenceDataUrl(legacy, moved), /^data:image\/png;base64,/)
})

test('revalidates a cached reference hash, signature and symlink boundary on every read', async (t) => {
  const { root, workspace } = await fixture(t)
  const source = path.join(root, 'reference.png')
  await fs.writeFile(source, png)
  const [reference] = await ingestReferenceImages(workspace, [source])
  const cached = path.join(workspace, ...reference.privatePath.split('/'))
  await fs.writeFile(cached, Buffer.concat([png.subarray(0, 8), Buffer.alloc(png.byteLength - 8, 1)]))
  await assert.rejects(referenceDataUrl(reference, workspace), /changed after ingestion/)

  await fs.unlink(cached)
  await fs.writeFile(source, png)
  await fs.symlink(source, cached)
  await assert.rejects(referenceDataUrl(reference, workspace), /changed after ingestion|escaped the workspace/)
})

test('rejects extension spoofing and source symbolic links', async (t) => {
  const { root, workspace } = await fixture(t)
  const spoofed = path.join(root, 'reference.jpg')
  await fs.writeFile(spoofed, png)
  await assert.rejects(ingestReferenceImages(workspace, [spoofed]), /signature/)
  const target = path.join(root, 'target.png')
  const link = path.join(root, 'link.png')
  await fs.writeFile(target, png)
  await fs.symlink(target, link)
  await assert.rejects(ingestReferenceImages(workspace, [link]), /non-symlink/)
})

test('rejects a workspace reference cache redirected through a symlink', async (t) => {
  const { root, workspace } = await fixture(t)
  const source = path.join(root, 'reference.png')
  const outside = path.join(root, 'outside')
  await fs.writeFile(source, png)
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(workspace, '.orbit'))
  await assert.rejects(ingestReferenceImages(workspace, [source]), /Unsafe reference directory/)
})
