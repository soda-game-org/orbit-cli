import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RunStore } from '../src/run-store.mjs'
import { WebCliServer } from '../src/web/server.mjs'

test('protects management APIs and isolates preview content on another origin', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-web-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const directories = { config: path.join(root, 'config'), data: path.join(root, 'data') }
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><title>Preview</title>')
  const store = new RunStore({ directories })
  const run = await store.create({ workspace, prompt: 'test', mode: 'orbit' })
  run.lastValidation = { ok: true, index: 'index.html' }
  await store.transition(run, 'completed')
  const config = { get: async () => ({ mode: 'orbit' }), update: async (value) => value }
  const auth = { status: async () => ({ signedIn: false }), login: async () => ({}), logout: async () => {} }
  const server = new WebCliServer({
    asset3d: {}, manager: {}, auth, config, credentials: {}, store, apiFactory: () => ({}), publishFactory: () => ({}), directories,
  })
  const started = await server.start({ open: false })
  t.after(() => server.close())
  const url = new URL(started.url)
  const secrets = new URLSearchParams(url.hash.slice(1))
  const headers = { Origin: started.origin, Authorization: `Bearer ${secrets.get('token')}`, 'X-Orbit-CSRF': secrets.get('csrf'), 'Content-Type': 'application/json' }

  const page = await fetch(started.origin)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /frame-src http:\/\/127\.0\.0\.1:\*/)
  assert.equal((await fetch(`${started.origin}/api/bootstrap`)).status, 403)
  assert.equal((await fetch(`${started.origin}/api/bootstrap`, { headers: { ...headers, Origin: 'http://evil.invalid' } })).status, 403)
  assert.equal((await fetch(`${started.origin}/api/bootstrap`, { headers })).status, 200)
  const { Origin: _origin, ...browserGetHeaders } = headers
  assert.equal((await fetch(`${started.origin}/api/bootstrap`, { headers: browserGetHeaders })).status, 200)

  const envelope = await fetch(`${started.origin}/api/runs/${run.id}/preview`, { method: 'POST', headers, body: '{}' }).then((response) => response.json())
  const preview = await fetch(envelope.url)
  assert.equal(preview.status, 200)
  assert.notEqual(new URL(envelope.url).origin, started.origin)
  assert.match(preview.headers.get('content-security-policy'), /connect-src 'none'/)
  assert.match(preview.headers.get('content-security-policy'), new RegExp(`frame-ancestors ${started.origin.replaceAll('.', '\\.')}`))
})
