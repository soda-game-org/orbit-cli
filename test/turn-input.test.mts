import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ingestReferenceImages } from '../src/attachments.mjs'
import {
  byokReferenceMediaCache,
  mediaObservation,
  projectTurnInputMessage,
  turnInputItems,
} from '../src/turn-input.mjs'

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)])

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-turn-input-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const source = path.join(root, 'reference.png')
  await fs.writeFile(source, png)
  return { workspace, source }
}

test('duplicate image occurrences preserve item identity and stable attachment identity', async (t) => {
  const { workspace, source } = await fixture(t)
  const references = await ingestReferenceImages(workspace, [source, source])
  const items = turnInputItems('Build from both placements', references, 'turn-test')
  const attachments = items.filter((item) => item.type === 'attachment')
  assert.equal(attachments.length, 2)
  assert.notEqual(attachments[0].id, attachments[1].id)
  assert.equal(attachments[0].attachment.id, attachments[1].attachment.id)
  assert.deepEqual(attachments.map((item) => item.metadata?.position), [0, 1])
})

test('text-only projection emits one structured observation per image occurrence without aggregation', async (t) => {
  const { workspace, source } = await fixture(t)
  const references = await ingestReferenceImages(workspace, [source, source])
  const items = turnInputItems('Build this game', references, 'turn-text')
  const attachments = items.filter((item) => item.type === 'attachment')
  assert.equal(attachments.length, 2)
  const observation = mediaObservation(attachments[0], 'A centered blue board with a compact HUD.', 'turn-text-0')
  const message = projectTurnInputMessage({
    inputItems: items,
    capabilities: { vision: false, imageInputs: [], nativeAttachments: false, maxImagesPerTurn: 0 },
    observations: [observation],
  })
  const structured = message.content.filter((part) => part.type === 'text' && String(part.text).startsWith('{'))
  assert.equal(structured.length, 2)
  const projected = structured.map((part) => JSON.parse(part.text))
  assert.deepEqual(projected.map((value) => value.sourceItemId), attachments.map((attachment) => attachment.id))
  assert.equal(new Set(projected.map((value) => value.sourceItemId)).size, 2)
  assert.deepEqual(projected.map((value) => value.attachmentId), [attachments[0].attachment.id, attachments[0].attachment.id])
  assert.equal(projected.every((value) => value.observation.summary === observation.summary), true)
})

test('vision BYOK projection sends verified images directly and fails closed without vision observations', async (t) => {
  const { workspace, source } = await fixture(t)
  const references = await ingestReferenceImages(workspace, [source, source])
  const items = turnInputItems('Build this game', references, 'turn-vision')
  const cache = await byokReferenceMediaCache(items, references, workspace)
  const message = projectTurnInputMessage({
    inputItems: items,
    capabilities: { vision: true, imageInputs: ['data_url'], nativeAttachments: false, maxImagesPerTurn: 8 },
    mediaCache: cache,
  })
  assert.equal(message.content.filter((part) => part.type === 'image_url').length, 2)
  assert.match(message.content.find((part) => part.type === 'image_url').image_url.url, /^data:image\/png;base64,/)
  assert.throws(() => projectTurnInputMessage({
    inputItems: items,
    capabilities: { vision: false, imageInputs: [], nativeAttachments: false, maxImagesPerTurn: 0 },
  }), (error) => error?.code === 'ORBIT_AGENT_INPUT_PROJECTION_BLOCKED')
})
