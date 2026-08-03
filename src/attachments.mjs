import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGE_BYTES_TOTAL,
  MAX_REFERENCE_IMAGES,
} from './constants.mjs'
import { canonicalDirectory, isContained, sha256 } from './util.mjs'

const EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])

export function sniffImage(bytes) {
  const buffer = Buffer.from(bytes)
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

async function safeDirectory(root, relative) {
  const target = path.join(root, relative)
  const parts = relative.split('/')
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    const before = await fs.lstat(current).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (!before) await fs.mkdir(current, { mode: 0o700 })
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe reference directory: ${part}`)
    const canonical = await fs.realpath(current)
    if (!isContained(root, canonical)) throw new Error('Reference directory escaped the workspace')
  }
  return target
}

async function readSafeImage(file) {
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
    return { bytes, mime, extension, originalName: path.basename(file), source: file }
  } finally {
    await handle.close()
  }
}

export async function ingestReferenceImages(workspace, files) {
  if (!Array.isArray(files)) throw new TypeError('Reference images must be an array')
  if (files.length > MAX_REFERENCE_IMAGES) throw new Error(`At most ${MAX_REFERENCE_IMAGES} reference images are allowed`)
  const root = await canonicalDirectory(workspace, { create: true })
  const destination = await safeDirectory(root, '.orbit/references')
  const results = []
  let total = 0
  for (const file of files) {
    const image = await readSafeImage(file)
    total += image.bytes.byteLength
    if (total > MAX_REFERENCE_IMAGE_BYTES_TOTAL) throw new Error('Reference images exceed the 16 MiB total limit')
    const digest = sha256(image.bytes)
    const output = path.join(destination, `${digest}${image.extension === '.jpeg' ? '.jpg' : image.extension}`)
    if (!isContained(root, output)) throw new Error('Reference destination escaped the workspace')
    const existing = await fs.lstat(output).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== image.bytes.byteLength) {
        throw new Error('Existing reference cache entry is unsafe')
      }
    } else {
      const temporary = `${output}.${process.pid}.tmp`
      await fs.writeFile(temporary, image.bytes, { flag: 'wx', mode: 0o600 })
      await fs.rename(temporary, output)
    }
    results.push({
      path: output,
      privatePath: `.orbit/references/${path.basename(output)}`,
      originalName: image.originalName.slice(0, 160),
      mime: image.mime,
      bytes: image.bytes.byteLength,
      sha256: digest,
    })
  }
  return results
}

export async function referenceDataUrl(reference) {
  const bytes = await fs.readFile(reference.path)
  if (sha256(bytes) !== reference.sha256 || sniffImage(bytes) !== reference.mime) {
    throw new Error(`Reference image changed after ingestion: ${reference.originalName}`)
  }
  return `data:${reference.mime};base64,${bytes.toString('base64')}`
}
