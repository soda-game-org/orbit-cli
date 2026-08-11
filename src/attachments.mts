import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGE_BYTES_TOTAL,
  MAX_REFERENCE_IMAGES,
} from './constants.mjs'
import { canonicalDirectory, id, isContained, sha256 } from './util.mjs'
import type { OrbitReference } from './types.mjs'

export interface ReferenceImageMetadata extends OrbitReference {
  schema: string
  id: string
  kind: 'image'
  purpose: string
  position: number
  createdAt: string
  source: string
  privatePath: string
  originalName: string
  mime: string
  bytes: number
  sha256: string
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

const EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])
const CANONICAL_EXTENSION = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
])

export const REFERENCE_ATTACHMENT_SCHEMA = 'orbit.attachment.v1'
const REFERENCE_PURPOSE = 'input_image'
const REFERENCE_SOURCE = 'local_reference'

export function sniffImage(bytes: Uint8Array): string | null {
  const buffer = Buffer.from(bytes)
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

async function safeDirectory(root: string, relative: string): Promise<string> {
  const target = path.join(root, relative)
  const parts = relative.split('/')
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    const before = await fs.lstat(current).catch((error) => isMissing(error) ? null : Promise.reject(error))
    if (!before) {
      await fs.mkdir(current, { mode: 0o700 }).catch((error) => isMissing(error) || (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? undefined
        : Promise.reject(error))
    }
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe reference directory: ${part}`)
    const canonical = await fs.realpath(current)
    if (!isContained(root, canonical)) throw new Error('Reference directory escaped the workspace')
  }
  return target
}

async function readSafeImage(file: string): Promise<{ bytes: Buffer; mime: string; extension: string; originalName: string }> {
  if (!path.isAbsolute(file)) throw new TypeError(`Reference image path must be absolute: ${file}`)
  const extension = path.extname(file).toLowerCase()
  const expectedMime = EXTENSIONS.get(extension)
  if (!expectedMime) throw new Error(`Unsupported reference image extension: ${extension || '(none)'}`)
  const before = await fs.lstat(file)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Reference image must be a regular non-symlink file: ${file}`)
  if (before.size < 16 || before.size > MAX_REFERENCE_IMAGE_BYTES) throw new Error(`Reference image must be 16 bytes to 5 MiB: ${file}`)
  let handle
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  } catch {
    throw new Error(`Reference image could not be opened without following links: ${file}`)
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`Reference image changed while it was being opened: ${file}`)
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error(`Reference image changed while it was being read: ${file}`)
    const mime = sniffImage(bytes)
    if (!mime || mime !== expectedMime) throw new Error(`Reference image extension and file signature do not match: ${file}`)
    return { bytes, mime, extension, originalName: path.basename(file) }
  } finally {
    await handle.close()
  }
}

function referenceLabel(reference: Partial<ReferenceImageMetadata>): string {
  return typeof reference?.originalName === 'string' && reference.originalName
    ? reference.originalName.slice(0, 160)
    : 'reference image'
}

function validateReferenceMetadata(reference: unknown): ReferenceImageMetadata {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw new TypeError('Reference image metadata is invalid')
  const candidate = reference as Record<string, unknown>
  if (typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.sha256)) throw new TypeError('Reference image hash is invalid')
  if (typeof candidate.mime !== 'string' || !CANONICAL_EXTENSION.has(candidate.mime)) throw new TypeError('Reference image MIME type is invalid')
  if (!Number.isSafeInteger(candidate.bytes) || Number(candidate.bytes) < 16 || Number(candidate.bytes) > MAX_REFERENCE_IMAGE_BYTES) {
    throw new TypeError('Reference image byte size is invalid')
  }
  if (candidate.schema != null) {
    if (candidate.schema !== REFERENCE_ATTACHMENT_SCHEMA
      || candidate.id !== `attachment_${candidate.sha256}`
      || candidate.kind !== 'image'
      || candidate.purpose !== REFERENCE_PURPOSE
      || candidate.source !== REFERENCE_SOURCE
      || !Number.isSafeInteger(candidate.position)
      || Number(candidate.position) < 0
      || Number(candidate.position) >= MAX_REFERENCE_IMAGES
      || typeof candidate.createdAt !== 'string'
      || !Number.isFinite(new Date(candidate.createdAt).getTime())) {
      throw new TypeError('Reference attachment contract is invalid')
    }
  }
  if (typeof candidate.privatePath === 'string') {
    const expected = `.orbit/references/${candidate.sha256}${CANONICAL_EXTENSION.get(candidate.mime as string)}`
    if (candidate.privatePath !== expected) throw new TypeError('Reference image private path is invalid')
  }
  return reference as ReferenceImageMetadata
}

async function referenceTarget(reference: unknown, workspace?: string | null): Promise<{ metadata: ReferenceImageMetadata; root: string | null; target: string }> {
  const metadata = validateReferenceMetadata(reference)
  const root = workspace ? await canonicalDirectory(workspace) : null
  let target
  if (root && typeof metadata.privatePath === 'string') {
    target = path.resolve(root, ...metadata.privatePath.split('/'))
    if (!isContained(root, target)) throw new Error('Reference image private path escaped the workspace')
  } else if (typeof metadata.path === 'string' && path.isAbsolute(metadata.path)) {
    // Compatibility for v1 checkpoints written before portable attachment
    // metadata. Active CLI code always supplies the workspace boundary.
    const parent = await fs.realpath(path.dirname(path.resolve(metadata.path)))
    target = path.join(parent, path.basename(metadata.path))
    if (root && !isContained(root, target)) throw new Error('Legacy reference image path escaped the workspace')
  } else {
    throw new Error('Reference image requires a workspace-relative private path')
  }
  return { metadata, root, target }
}

async function readVerifiedReference(reference: unknown, workspace?: string | null): Promise<Buffer> {
  const { metadata, root, target } = await referenceTarget(reference, workspace)
  const before = await fs.lstat(target)
  if (!before.isFile() || before.isSymbolicLink() || before.size !== metadata.bytes) {
    throw new Error(`Reference image changed after ingestion: ${referenceLabel(metadata)}`)
  }
  const canonical = await fs.realpath(target)
  if (canonical !== target || (root && !isContained(root, canonical))) {
    throw new Error(`Reference image escaped the workspace: ${referenceLabel(metadata)}`)
  }
  let handle
  try {
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  } catch {
    throw new Error(`Reference image could not be opened without following links: ${referenceLabel(metadata)}`)
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`Reference image changed while it was being opened: ${referenceLabel(metadata)}`)
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || sha256(bytes) !== metadata.sha256 || sniffImage(bytes) !== metadata.mime) {
      throw new Error(`Reference image changed after ingestion: ${referenceLabel(metadata)}`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

export async function ingestReferenceImages(workspace: string, files: string[]): Promise<ReferenceImageMetadata[]> {
  if (!Array.isArray(files)) throw new TypeError('Reference images must be an array')
  if (files.length > MAX_REFERENCE_IMAGES) throw new Error(`At most ${MAX_REFERENCE_IMAGES} reference images are allowed`)
  const root = await canonicalDirectory(workspace, { create: true })
  if (!files.length) return []
  const destination = await safeDirectory(root, '.orbit/references')
  const results: ReferenceImageMetadata[] = []
  const createdAt = new Date().toISOString()
  let total = 0
  for (const [position, file] of files.entries()) {
    const image = await readSafeImage(file)
    total += image.bytes.byteLength
    if (total > MAX_REFERENCE_IMAGE_BYTES_TOTAL) throw new Error('Reference images exceed the 16 MiB total limit')
    const digest = sha256(image.bytes)
    const output = path.join(destination, `${digest}${image.extension === '.jpeg' ? '.jpg' : image.extension}`)
    if (!isContained(root, output)) throw new Error('Reference destination escaped the workspace')
    const existing = await fs.lstat(output).catch((error) => isMissing(error) ? null : Promise.reject(error))
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== image.bytes.byteLength) {
        throw new Error('Existing reference cache entry is unsafe')
      }
    } else {
      const temporary = `${output}.${process.pid}.${id()}.tmp`
      let handle: Awaited<ReturnType<typeof fs.open>> | null = null
      try {
        handle = await fs.open(temporary, 'wx', 0o600)
        await handle.writeFile(image.bytes)
        await handle.sync()
        await handle.close()
        handle = null
        await fs.link(temporary, output).catch((error) => (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? undefined
          : Promise.reject(error))
        const directoryHandle = await fs.open(destination, 'r').catch(() => null)
        if (directoryHandle) {
          try { await directoryHandle.sync() } catch {} finally { await directoryHandle.close() }
        }
      } finally {
        await handle?.close().catch(() => undefined)
        await fs.unlink(temporary).catch(() => undefined)
      }
    }
    const reference: ReferenceImageMetadata = {
      schema: REFERENCE_ATTACHMENT_SCHEMA,
      id: `attachment_${digest}`,
      kind: 'image',
      purpose: REFERENCE_PURPOSE,
      position,
      createdAt,
      source: REFERENCE_SOURCE,
      privatePath: `.orbit/references/${path.basename(output)}`,
      originalName: image.originalName.slice(0, 160),
      mime: image.mime,
      bytes: image.bytes.byteLength,
      sha256: digest,
    }
    await readVerifiedReference(reference, root)
    results.push(reference)
  }
  return results
}

export async function referenceDataUrl(reference: ReferenceImageMetadata, workspace: string): Promise<string> {
  const bytes = await readVerifiedReference(reference, workspace)
  return `data:${reference.mime};base64,${bytes.toString('base64')}`
}
