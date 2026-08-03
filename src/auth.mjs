import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './constants.mjs'
import { openExternal } from './util.mjs'

const SESSION_ACCOUNT = 'orbit-session'
const LOOPBACK = '127.0.0.1'
const LOGIN_TIMEOUT_MS = 5 * 60_000

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

function client() {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      flowType: 'pkce',
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
      storage: memoryStorage(),
    },
  })
}

function callbackPage(ok) {
  const heading = ok ? 'Signed in to Orbit' : 'Orbit sign-in was not completed'
  const detail = ok ? 'You can close this tab and return to Orbit CLI.' : 'No local session was created. Return to Orbit CLI and try again.'
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"><title>${heading}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f5f5f7;font:15px system-ui}.card{width:min(420px,calc(100vw - 40px));padding:36px;border:1px solid #2a2a30;border-radius:20px;background:#151519}h1{font-size:26px;margin:0 0 12px}p{color:#aaaab2;line-height:1.6;margin:0}</style></head><body><main class="card"><h1>${heading}</h1><p>${detail}</p></main></body></html>`
}

function responseHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    Connection: 'close',
  }
}

async function closeServer(server) {
  if (!server.listening) return
  await new Promise((resolve) => server.close(resolve))
}

export class OrbitAuth {
  constructor(credentials) {
    this.credentials = credentials
  }

  async login({ open = openExternal, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
    const supabase = client()
    const nonce = randomBytes(32).toString('base64url')
    const callbackPath = `/oauth/callback/${nonce}`
    let expectedHost = ''
    let consumed = false
    let resolveCallback
    const callback = new Promise((resolve) => { resolveCallback = resolve })
    const server = createServer((request, response) => {
      if (request.socket.remoteAddress !== LOOPBACK && request.socket.remoteAddress !== `::ffff:${LOOPBACK}`) {
        response.writeHead(403, responseHeaders('text/plain; charset=utf-8')).end('Forbidden')
        return
      }
      if (request.method !== 'GET' || request.headers.host !== expectedHost || !request.url || request.url.length > 8192) {
        response.writeHead(400, responseHeaders('text/plain; charset=utf-8')).end('Invalid callback')
        return
      }
      let url
      try { url = new URL(request.url, `http://${expectedHost}`) } catch {
        response.writeHead(400, responseHeaders('text/plain; charset=utf-8')).end('Invalid callback')
        return
      }
      if (url.pathname !== callbackPath || consumed) {
        response.writeHead(consumed ? 409 : 404, responseHeaders('text/plain; charset=utf-8')).end('Not found')
        return
      }
      const error = url.searchParams.get('error_description') || url.searchParams.get('error')
      const codes = url.searchParams.getAll('code')
      if (error || codes.length !== 1 || !codes[0] || codes[0].length > 4096) {
        consumed = true
        response.writeHead(400, responseHeaders('text/html; charset=utf-8')).end(callbackPage(false))
        resolveCallback({ error: new Error(error?.slice(0, 300) || 'OAuth callback did not contain one valid code') })
        return
      }
      consumed = true
      resolveCallback({ code: codes[0], response })
    })

    const timer = setTimeout(() => resolveCallback({ error: new Error('Orbit sign-in timed out') }), timeoutMs)
    timer.unref?.()
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen({ host: LOOPBACK, port: 0, exclusive: true }, resolve)
      })
      const address = server.address()
      expectedHost = `${LOOPBACK}:${address.port}`
      const redirectTo = `http://${expectedHost}${callbackPath}`
      const start = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true },
      })
      if (start.error || !start.data.url) throw new Error(start.error?.message || 'Could not start Orbit OAuth')
      const authorizationUrl = new URL(start.data.url)
      const authority = new URL(SUPABASE_URL)
      if (authorizationUrl.protocol !== 'https:' || authorizationUrl.origin !== authority.origin
        || authorizationUrl.pathname !== '/auth/v1/authorize' || authorizationUrl.username || authorizationUrl.password) {
        throw new Error('Refusing an OAuth URL outside the Orbit trust root')
      }
      await open(authorizationUrl.toString())
      const result = await callback
      if (result.error) throw result.error
      try {
        const exchange = await supabase.auth.exchangeCodeForSession(result.code)
        if (exchange.error || !exchange.data.session) throw new Error(exchange.error?.message || 'Orbit session exchange failed')
        await this.#save(exchange.data.session)
        result.response.writeHead(200, responseHeaders('text/html; charset=utf-8')).end(callbackPage(true))
        return safeSession(exchange.data.session)
      } catch (error) {
        result.response.writeHead(400, responseHeaders('text/html; charset=utf-8')).end(callbackPage(false))
        throw error
      }
    } finally {
      clearTimeout(timer)
      await closeServer(server)
    }
  }

  async logout() {
    const session = await this.#load()
    if (session?.access_token) {
      await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
        method: 'POST',
        headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${session.access_token}` },
      }).catch(() => undefined)
    }
    await this.credentials.delete(SESSION_ACCOUNT)
  }

  async status() {
    try {
      const session = await this.session()
      return { signedIn: true, ...safeSession(session) }
    } catch {
      return { signedIn: false }
    }
  }

  async accessToken() {
    return (await this.session()).access_token
  }

  async session() {
    const current = await this.#load()
    if (!current?.access_token || !current?.refresh_token) throw new Error('Sign in first with `orbit auth login`')
    const expiresAt = Number(current.expires_at || 0)
    if (expiresAt > Math.floor(Date.now() / 1000) + 60) return current
    const supabase = client()
    const refreshed = await supabase.auth.refreshSession({ refresh_token: current.refresh_token })
    if (refreshed.error || !refreshed.data.session) {
      await this.credentials.delete(SESSION_ACCOUNT)
      throw new Error('Orbit session expired; run `orbit auth login` again')
    }
    await this.#save(refreshed.data.session)
    return refreshed.data.session
  }

  async #load() {
    const raw = await this.credentials.get(SESSION_ACCOUNT)
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  async #save(session) {
    await this.credentials.set(SESSION_ACCOUNT, JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      token_type: session.token_type,
      user: { id: session.user?.id, email: session.user?.email || null },
    }))
  }
}

function safeSession(session) {
  return {
    userId: session.user?.id || null,
    email: session.user?.email || null,
    expiresAt: session.expires_at || null,
  }
}
