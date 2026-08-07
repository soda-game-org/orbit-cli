import assert from 'node:assert/strict'
import test from 'node:test'
import { get } from 'node:http'
import { firstPartyAuthorizationUrl, OrbitAuth } from '../src/auth.mjs'
import { SUPABASE_URL } from '../src/constants.mjs'

class MemoryCredentials {
  values = new Map()
  async get(key) { return this.values.get(key) || null }
  async set(key, value) { this.values.set(key, value) }
  async delete(key) { this.values.delete(key) }
}

function session() {
  return {
    access_token: 'access-token-for-test', refresh_token: 'refresh-token-for-test',
    expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer',
    user: { id: '550e8400-e29b-41d4-a716-446655440000', email: 'test@example.com' },
  }
}

function clientFixture({ authorizationOrigin = SUPABASE_URL } = {}) {
  let redirectTo = ''
  const client = { auth: {
    signInWithOAuth: async (input) => {
      redirectTo = input.options.redirectTo
      return { data: { url: `${authorizationOrigin}/auth/v1/authorize?provider=google` }, error: null }
    },
    exchangeCodeForSession: async (code) => code === 'one-time-code'
      ? { data: { session: session() }, error: null }
      : { data: { session: null }, error: { message: 'bad code' } },
    refreshSession: async () => ({ data: { session: session() }, error: null }),
  } }
  return { client, redirect: () => redirectTo }
}

function getWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { Host: host } }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    request.once('error', reject)
  })
}

test('uses a random loopback callback, rejects a bad Host, and stores only the exchanged session', async () => {
  const credentials = new MemoryCredentials()
  const fixture = clientFixture()
  let callbackRequests
  const auth = new OrbitAuth(credentials, { clientFactory: () => fixture.client })
  const result = await auth.login({ open: () => {
    const callback = fixture.redirect()
    callbackRequests = (async () => {
      const wrongHost = await getWithHost(`${callback}?code=one-time-code`, 'attacker.invalid')
      assert.equal(wrongHost, 400)
      return fetch(`${callback}?code=one-time-code`)
    })()
  } })
  const callback = new URL(fixture.redirect())
  assert.equal(callback.hostname, '127.0.0.1')
  assert.notEqual(callback.port, '')
  assert.match(callback.pathname, /^\/oauth\/callback\/[A-Za-z0-9_-]{40,}$/)
  assert.equal((await callbackRequests).status, 200)
  assert.deepEqual(result, { userId: session().user.id, email: session().user.email, expiresAt: session().expires_at })
  assert.equal((await auth.status()).signedIn, true)
})

test('refuses an authorization URL outside the configured Supabase trust root', async () => {
  const fixture = clientFixture({ authorizationOrigin: 'https://attacker.invalid' })
  let opened = false
  const auth = new OrbitAuth(new MemoryCredentials(), { clientFactory: () => fixture.client })
  await assert.rejects(auth.login({ open: () => { opened = true }, timeoutMs: 100 }), /trust root/)
  assert.equal(opened, false)
})

test('opens the existing PKCE request through the first-party Orbit authorization page', () => {
  const upstream = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent('http://127.0.0.1:4000/oauth/callback/abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890')}`
  const wrapped = new URL(firstPartyAuthorizationUrl(upstream))
  assert.equal(wrapped.origin, 'https://orbit-arcade.com')
  assert.equal(wrapped.pathname, '/auth/native')
  const fragment = new URLSearchParams(wrapped.hash.slice(1))
  assert.equal(fragment.get('authorization'), upstream)
  assert.equal(fragment.get('surface'), 'cli')
})

test('times out without persisting a partial session', async () => {
  const credentials = new MemoryCredentials()
  const fixture = clientFixture()
  const auth = new OrbitAuth(credentials, { clientFactory: () => fixture.client })
  await assert.rejects(auth.login({ open: () => {}, timeoutMs: 20 }), /timed out/)
  assert.deepEqual(await auth.status(), { signedIn: false })
})
