import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createGzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { scanSecretBytes, secretLikeFileName } from './secret-scan.mjs'
import { canonicalDirectory, isContained, writeJsonAtomic } from './util.mjs'

const SOURCE_EXCLUDED_DIRECTORIES = new Set(['.git', '.orbit', 'node_modules', 'dist', 'coverage'])
const MAX_FILES = 5_000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

function portable(value) {
  const normalized = value.split(path.sep).join('/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')
    || Buffer.byteLength(normalized) > 512 || normalized.includes('\0')) throw new Error(`Non-portable publish path: ${value}`)
  return normalized
}

function excludedSourceDirectory(name, directory) {
  return directory && SOURCE_EXCLUDED_DIRECTORIES.has(name.toLowerCase())
}

async function readStable(root, absolute, stat) {
  const canonical = await fs.realpath(absolute)
  if (!isContained(root, canonical) || canonical !== absolute) throw new Error('Publish path traversed a symbolic link')
  const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error('Publish file changed while being opened')
    return await handle.readFile()
  } finally { await handle.close() }
}

async function collect(root, base, { source }) {
  const start = path.join(root, base)
  const startStat = await fs.lstat(start)
  if (!startStat.isDirectory() || startStat.isSymbolicLink() || await fs.realpath(start) !== start) throw new Error(`${base} is not a safe directory`)
  const files = []
  let total = 0
  async function visit(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (secretLikeFileName(entry.name)) throw new Error(`Secret-like files cannot be published: ${relative}`)
      if (source && excludedSourceDirectory(entry.name, entry.isDirectory())) continue
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links cannot be published: ${relative}`)
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) { await visit(absolute, relative); continue }
      if (!entry.isFile()) throw new Error(`Only regular files can be published: ${relative}`)
      const stat = await fs.lstat(absolute)
      if (stat.size > MAX_FILE_BYTES) throw new Error(`Publish file is too large: ${relative}`)
      total += stat.size
      if (files.length >= MAX_FILES || total > MAX_TOTAL_BYTES) throw new Error('Publish project exceeds the file or byte limit')
      const bytes = await readStable(root, absolute, stat)
      const secretKinds = scanSecretBytes(bytes)
      if (secretKinds.length) throw new Error(`Secret-like content cannot be published: ${relative} (${secretKinds.join(', ')})`)
      files.push({ path: portable(relative), bytes, mode: stat.mode & 0o111 ? 0o755 : 0o644 })
    }
  }
  await visit(start, '')
  return files
}

function octal(value, width) { return `${value.toString(8).padStart(width - 1, '0')}\0` }
function field(buffer, offset, length, value) { Buffer.from(value).copy(buffer, offset, 0, length) }
function tarHeader(name, size, mode = 0o644) {
  let prefix = ''
  let leaf = name
  if (Buffer.byteLength(name) > 100) {
    const slashIndexes = [...name.matchAll(/\//g)].map((match) => match.index)
    const split = slashIndexes.reverse().find((index) => Buffer.byteLength(name.slice(0, index)) <= 155 && Buffer.byteLength(name.slice(index + 1)) <= 100)
    if (split == null) throw new Error(`Publish source path is too long: ${name}`)
    prefix = name.slice(0, split)
    leaf = name.slice(split + 1)
  }
  const out = Buffer.alloc(512)
  field(out, 0, 100, leaf); field(out, 100, 8, octal(mode, 8)); field(out, 108, 8, octal(0, 8)); field(out, 116, 8, octal(0, 8))
  field(out, 124, 12, octal(size, 12)); field(out, 136, 12, octal(Math.floor(Date.now() / 1000), 12))
  out.fill(0x20, 148, 156); out[156] = '0'.charCodeAt(0); field(out, 257, 6, 'ustar\0'); field(out, 263, 2, '00'); field(out, 345, 155, prefix)
  let sum = 0; for (const byte of out) sum += byte
  field(out, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return out
}

async function sourceArchive(files) {
  function* chunks() {
    for (const file of files) {
      yield tarHeader(file.path, file.bytes.byteLength, file.mode)
      yield file.bytes
      const padding = (512 - (file.bytes.byteLength % 512)) % 512
      if (padding) yield Buffer.alloc(padding)
    }
    yield Buffer.alloc(1024)
  }
  const output = []
  for await (const chunk of Readable.from(chunks()).pipe(createGzip({ level: 9 }))) output.push(Buffer.from(chunk))
  return Buffer.concat(output)
}

function contentType(file) {
  const extension = path.extname(file).toLowerCase()
  return ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' })[extension] || 'application/octet-stream'
}

export class PublishService {
  constructor(api) { this.api = api }

  async prepare(input) {
    const root = await canonicalDirectory(input.workspace)
    const dist = await collect(root, 'dist', { source: false })
    const index = dist.find((file) => file.path === 'index.html')
    if (!index) throw new Error('dist/index.html is required before publishing')
    if (dist.some((file) => file.path.split('/').some((part) => part.includes('__')))) throw new Error('Published dist paths cannot contain double underscores')
    const source = await collect(root, '.', { source: true })
    if (!source.length) throw new Error('Project source is empty')
    const archive = await sourceArchive(source)
    const html = index.bytes.toString('utf8')
    const title = String(input.title || /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1] || path.basename(root)).trim().slice(0, 240)
    const prompt = String(input.prompt || title).trim().slice(0, 32_000)
    const runtime = ['html', 'vanilla-ts', 'react-vite', 'react-three-fiber', 'three-vanilla', 'phaser'].includes(input.runtime) ? input.runtime : 'html'
    return { root, dist, archive, title, prompt, runtime, gameId: input.gameId || null }
  }

  async publish(input) {
    const prepared = await this.prepare(input)
    const form = new FormData()
    form.set('meta', JSON.stringify({
      ...(prepared.gameId ? { game_id: prepared.gameId } : {}),
      title: prepared.title,
      prompt: prepared.prompt,
      content_locale: input.locale === 'zh' ? 'zh' : 'en',
      is_public: true,
      is_feed_listed: true,
      pro_runtime: prepared.runtime,
    }))
    form.set('source', new Blob([prepared.archive], { type: 'application/gzip' }), 'source.tar.gz')
    for (const file of prepared.dist) {
      form.set(`dist__${file.path.replaceAll('/', '__')}`, new Blob([file.bytes], { type: contentType(file.path) }), path.basename(file.path))
    }
    const response = await this.api.publish(form)
    const gameId = response?.game?.id
    if (typeof gameId !== 'string' || !gameId) throw new Error('Orbit returned no published game id')
    await writeJsonAtomic(path.join(prepared.root, '.orbit', 'cloud.json'), {
      version: 1, gameId, title: response.game.title || prepared.title, publishedAt: new Date().toISOString(),
    })
    return response
  }
}
