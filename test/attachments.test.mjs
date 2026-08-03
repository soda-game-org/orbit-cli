import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ingestReferenceImages, referenceDataUrl, sniffImage } from '../src/attachments.mjs'

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
  assert.equal(reference.mime, 'image/png')
  assert.match(reference.privatePath, /^\.orbit\/references\/[a-f0-9]{64}\.png$/)
  assert.match(await referenceDataUrl(reference), /^data:image\/png;base64,/)
  assert.equal(sniffImage(new Uint8Array(png)), 'image/png')
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
