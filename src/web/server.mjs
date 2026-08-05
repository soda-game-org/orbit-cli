import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { sniffImage } from '../attachments.mjs'
import { appDirectories, canonicalDirectory, collectStream, ensurePrivateDirectory, isContained, openExternal, publicError } from '../util.mjs'
import { providerCredentialAccount } from '../credentials.mjs'
import { CODING_PROVIDER_IDS, PROVIDER_IDS, PROVIDERS } from '../constants.mjs'
import { withRecoveryView } from '../recovery-view.mjs'

const HOST = '127.0.0.1'
const MAX_BODY = 24 * 1024 * 1024
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
])

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function headers(type, extra = {}) {
  return {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  }
}

function send(response, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  response.writeHead(status, headers(type, extra))
  response.end(type.startsWith('application/json') ? JSON.stringify(body) : body)
}

async function bodyJson(request) {
  const bytes = await collectStream(request, MAX_BODY)
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { throw new Error('Request body must be valid JSON') }
}

async function writeUploads(files, directories) {
  if (!Array.isArray(files) || files.length > 8) throw new Error('At most 8 reference images are allowed')
  const directory = await ensurePrivateDirectory(path.join(directories.data, 'web-uploads', randomBytes(12).toString('hex')))
  const paths = []
  try {
    let total = 0
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      if (!file || typeof file.name !== 'string' || typeof file.data !== 'string') throw new Error('Reference upload is invalid')
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw new Error('Reference upload is not canonical base64')
      const bytes = Buffer.from(file.data, 'base64')
      total += bytes.byteLength
      if (bytes.byteLength < 16 || bytes.byteLength > 5 * 1024 * 1024 || total > 16 * 1024 * 1024) throw new Error('Reference upload exceeds the image limits')
      const mime = sniffImage(bytes)
      const expected = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' })[mime]
      const supplied = path.extname(file.name).toLowerCase()
      if (!expected || (supplied !== expected && !(mime === 'image/jpeg' && supplied === '.jpeg'))) throw new Error('Reference extension and file signature do not match')
      const output = path.join(directory, `${index}${expected}`)
      await fs.writeFile(output, bytes, { flag: 'wx', mode: 0o600 })
      paths.push(output)
    }
    return { directory, paths }
  } catch (error) {
    for (const file of paths) await fs.unlink(file).catch(() => undefined)
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function cleanupUploads(upload) {
  if (!upload) return
  for (const file of upload.paths) await fs.unlink(file).catch(() => undefined)
  await fs.rm(upload.directory, { recursive: true, force: true }).catch(() => undefined)
}

function previewType(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2' })[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

async function safePreviewFile(root, pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html'
  if (relative.split('/').some((part) => !part || part === '.' || part === '..') || relative.includes('\\')) throw new Error('Invalid preview path')
  const absolute = path.resolve(root, relative)
  if (!isContained(root, absolute)) throw new Error('Preview path escaped the project')
  const stat = await fs.lstat(absolute)
  if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(absolute) !== absolute || stat.size > 64 * 1024 * 1024) throw new Error('Unsafe preview file')
  return { absolute, stat }
}

export class WebCliServer {
  constructor({ asset3d, assetImage, manager, auth, byok, config, credentials, store, apiFactory, publishFactory, directories = appDirectories() }) {
    Object.assign(this, { asset3d, assetImage, manager, auth, byok, config, credentials, store, apiFactory, publishFactory, directories })
    this.token = randomBytes(32).toString('base64url')
    this.csrf = randomBytes(32).toString('base64url')
    this.projects = new Map()
  }

  async start({ open = true } = {}) {
    this.main = createServer((request, response) => this.#mainRequest(request, response).catch((error) => send(response, 500, { error: publicError(error) })))
    await new Promise((resolve, reject) => { this.main.once('error', reject); this.main.listen({ host: HOST, port: 0, exclusive: true }, resolve) })
    this.mainHost = `${HOST}:${this.main.address().port}`
    this.mainOrigin = `http://${this.mainHost}`
    this.preview = createServer((request, response) => this.#previewRequest(request, response).catch(() => send(response, 404, 'Not found', 'text/plain; charset=utf-8')))
    await new Promise((resolve, reject) => { this.preview.once('error', reject); this.preview.listen({ host: HOST, port: 0, exclusive: true }, resolve) })
    this.previewHost = `${HOST}:${this.preview.address().port}`
    this.previewOrigin = `http://${this.previewHost}`
    const url = `${this.mainOrigin}/#token=${encodeURIComponent(this.token)}&csrf=${encodeURIComponent(this.csrf)}`
    if (open) openExternal(url)
    return { url, origin: this.mainOrigin, close: () => this.close() }
  }

  async close() {
    await Promise.all([this.main, this.preview].filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))))
  }

  #authorized(request) {
    const origin = request.headers.origin
    // Browsers do not consistently send Origin on same-origin GET requests.
    // The random bearer + CSRF tokens and exact Host still make these reads
    // unforgeable; any explicitly cross-origin request remains rejected.
    const sameOriginGet = request.method === 'GET' && !origin
    return request.headers.host === this.mainHost
      && (origin === this.mainOrigin || sameOriginGet)
      && equalSecret(String(request.headers.authorization || '').replace(/^Bearer\s+/i, ''), this.token)
      && equalSecret(request.headers['x-orbit-csrf'], this.csrf)
  }

  async #mainRequest(request, response) {
    const url = new URL(request.url || '/', this.mainOrigin)
    if (request.headers.host !== this.mainHost) return send(response, 400, { error: 'Invalid host' })
    if (request.method === 'GET' && STATIC.has(url.pathname)) {
      const [file, type] = STATIC.get(url.pathname)
      const body = await fs.readFile(new URL(`./${file}`, import.meta.url))
      return send(response, 200, body, type, {
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src http://127.0.0.1:*; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Cross-Origin-Opener-Policy': 'same-origin',
      })
    }
    if (!url.pathname.startsWith('/api/') || !this.#authorized(request)) return send(response, 403, { error: 'Forbidden' })
    if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
      const providers = Object.entries(PROVIDERS).map(([id, definition]) => ({
        id, label: definition.label, purpose: definition.purpose, vision: definition.vision, modelDiscovery: Boolean(definition.modelsPath),
      }))
      const runs = (await this.store.list()).map(withRecoveryView)
      return send(response, 200, { config: await this.config.get(), auth: await this.auth.status(), runs, providers })
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/login') return send(response, 200, await this.auth.login())
    if (request.method === 'POST' && url.pathname === '/api/auth/logout') { await this.auth.logout(); return send(response, 200, { ok: true }) }
    if (request.method === 'POST' && url.pathname === '/api/config') return send(response, 200, await this.config.update(await bodyJson(request)))
    if (request.method === 'GET' && url.pathname === '/api/provider/models') {
      const provider = url.searchParams.get('provider')
      if (!CODING_PROVIDER_IDS.includes(provider)) throw new Error('A supported coding provider is required')
      return send(response, 200, { provider, models: await this.byok.models(provider) })
    }
    if (request.method === 'POST' && url.pathname === '/api/provider') {
      const body = await bodyJson(request)
      if (!PROVIDER_IDS.includes(body.provider) || typeof body.apiKey !== 'string' || !body.apiKey.trim()) throw new Error('Provider and API key are required')
      await this.credentials.set(providerCredentialAccount(body.provider), body.apiKey.trim())
      return send(response, 200, { ok: true, provider: body.provider })
    }
    if (request.method === 'POST' && url.pathname === '/api/runs') {
      const body = await bodyJson(request)
      const upload = await writeUploads(body.files || [], this.directories)
      try {
        const run = await this.manager.create({
          source: 'cli_gui', prompt: body.prompt, workspace: body.workspace, operation: body.operation,
          mode: body.mode, provider: body.provider, model: body.model, runtime: body.runtime,
          generateImages: body.generateImages === true, generate3d: body.generate3d === true, cloudLogs: body.cloudLogs === true,
          allowShell: body.allowShell === true, referenceImages: upload.paths,
        })
        return send(response, 200, { run: withRecoveryView(run) })
      } finally { await cleanupUploads(upload) }
    }
    if (request.method === 'POST' && url.pathname === '/api/assets/image') {
      const body = await bodyJson(request)
      const run = await this.assetImage.create({
        source: 'cli_gui', prompt: body.prompt, workspace: body.workspace,
        output: body.output, aspectRatio: body.aspectRatio, cloudLogs: body.cloudLogs === true,
      })
      return send(response, 200, { run: withRecoveryView(run) })
    }
    if (request.method === 'POST' && url.pathname === '/api/assets/3d') {
      const body = await bodyJson(request)
      const run = await this.asset3d.create({
        source: 'cli_gui', prompt: body.prompt, workspace: body.workspace,
        mode: body.mode, output: body.output, cloudLogs: body.cloudLogs === true,
      })
      return send(response, 200, { run: withRecoveryView(run) })
    }
    const resume = /^\/api\/runs\/(run_[0-9a-f-]{36})\/resume$/.exec(url.pathname)
    if (request.method === 'POST' && resume) {
      const body = await bodyJson(request)
      const stored = await this.store.load(resume[1])
      const run = stored.kind === 'asset3d'
        ? await this.asset3d.resume(resume[1], { retryUnsafe: body.retryUnsafe === true })
        : stored.kind === 'assetimage'
          ? await this.assetImage.resume(resume[1], { retryUnsafe: body.retryUnsafe === true })
          : await this.manager.resume(resume[1], { allowShell: body.allowShell === true, retryUnsafe: body.retryUnsafe === true })
      return send(response, 200, { run: withRecoveryView(run) })
    }
    const preview = /^\/api\/runs\/(run_[0-9a-f-]{36})\/preview$/.exec(url.pathname)
    if (request.method === 'POST' && preview) {
      const run = await this.store.load(preview[1])
      if (run.kind === 'asset3d' || run.kind === 'assetimage') return send(response, 409, { error: 'Standalone asset runs do not have a game preview' })
      const workspace = await canonicalDirectory(run.workspace)
      const candidate = path.join(workspace, run.lastValidation?.index?.startsWith('dist/') ? 'dist' : '.')
      const candidateStat = await fs.lstat(candidate)
      const root = await fs.realpath(candidate)
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink() || (root !== workspace && !isContained(workspace, root))) {
        return send(response, 409, { error: 'Validated preview directory is no longer safe' })
      }
      const key = randomBytes(18).toString('base64url')
      if (this.projects.size >= 200) this.projects.delete(this.projects.keys().next().value)
      this.projects.set(key, root)
      return send(response, 200, { url: `${this.previewOrigin}/p/${key}/index.html` })
    }
    const publish = /^\/api\/runs\/(run_[0-9a-f-]{36})\/publish$/.exec(url.pathname)
    if (request.method === 'POST' && publish) {
      const body = await bodyJson(request)
      if (body.confirmed !== true) return send(response, 409, { error: 'Explicit publish confirmation is required' })
      const run = await this.store.load(publish[1])
      if (run.state !== 'completed' || !run.lastValidation?.ok) return send(response, 409, { error: 'Only completed and validated runs can be published' })
      const api = this.apiFactory('cli_gui')
      const result = await this.publishFactory(api).publish({ workspace: run.workspace, title: body.title, prompt: run.prompt, runtime: run.runtime, locale: body.locale, gameId: body.gameId })
      return send(response, 200, result)
    }
    return send(response, 404, { error: 'Not found' })
  }

  async #previewRequest(request, response) {
    if (request.method !== 'GET' || request.headers.host !== this.previewHost) return send(response, 404, 'Not found', 'text/plain; charset=utf-8')
    const url = new URL(request.url || '/', this.previewOrigin)
    const match = /^\/p\/([A-Za-z0-9_-]{24})\/(.+)$/.exec(url.pathname)
    const root = match && this.projects.get(match[1])
    if (!root) return send(response, 404, 'Not found', 'text/plain; charset=utf-8')
    const file = await safePreviewFile(root, `/${match[2]}`)
    const bytes = await fs.readFile(file.absolute)
    return send(response, 200, bytes, previewType(file.absolute), {
      'Content-Security-Policy': `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'none'; worker-src 'self' blob:; frame-ancestors ${this.mainOrigin}; base-uri 'none'; form-action 'none'`,
      'Cross-Origin-Resource-Policy': 'same-site',
    })
  }
}
