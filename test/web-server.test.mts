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
  let savedCredential
  const credentials = {
    get: async (account) => account === 'provider:openrouter' ? 'configured-key' : null,
    set: async (account, secret) => { savedCredential = { account, secret } },
  }
  const byok = { models: async (provider) => {
    assert.equal(provider, 'openrouter')
    return [{ id: 'vendor/model', name: 'Model', vision: true }]
  } }
  let imageInput
  const assetImage = { create: async (input) => {
    imageInput = input
    return { id: 'run_11111111-1111-4111-8111-111111111111', state: 'completed', result: { relativePath: input.output } }
  } }
  let streamedInput
  const manager = { create: async (input) => {
    streamedInput = input
    await input.onProgress?.({ type: 'tool_started', toolName: 'write_file', occurredAt: new Date().toISOString() })
    return { ...run, id: 'run_22222222-2222-4222-8222-222222222222', state: 'completed' }
  } }
  const server = new WebCliServer({
    asset3d: {}, assetImage, manager, auth, byok, config, credentials, store, apiFactory: () => ({}), publishFactory: () => ({}), directories,
  })
  const started = await server.start({ open: false })
  t.after(() => server.close())
  const url = new URL(started.url)
  const secrets = new URLSearchParams(url.hash.slice(1))
  const headers = { Origin: started.origin, Authorization: `Bearer ${secrets.get('token')}`, 'X-Orbit-CSRF': secrets.get('csrf'), 'Content-Type': 'application/json' }

  const page = await fetch(started.origin)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /frame-src http:\/\/127\.0\.0\.1:\*/)
  assert.match(await page.text(), /id="browse-models"/)
  const pageHtml = await fetch(started.origin).then((response) => response.text())
  assert.doesNotMatch(pageHtml, /placeholder="Automatic"/)
  assert.match(pageHtml, /id="generateImages"/)
  assert.match(pageHtml, /id="image-form"/)
  assert.match(pageHtml, /id="preview"[^>]+sandbox="allow-scripts allow-pointer-lock allow-same-origin"/)
  assert.match(pageHtml, /class="pane project-sidebar"/)
  assert.match(pageHtml, /class="pane console"/)
  assert.match(pageHtml, /class="pane preview-shell"/)
  assert.doesNotMatch(pageHtml, />Usage</)
  assert.doesNotMatch(pageHtml, />Catch</)
  const appSource = await fetch(`${started.origin}/app.js`).then((response) => response.text())
  assert.match(appSource, /if\s*\(viewKeys\.runs === key\)\s*return/)
  assert.match(appSource, /if\s*\(viewKeys\.providers === key\)\s*return/)
  assert.match(appSource, /if\s*\(refreshPromise\)\s*return refreshPromise/)
  assert.match(appSource, /if \(\$\('preview'\)\.dataset\.url !== body\.url\)/)
  assert.match(appSource, /if \(!await ensureRunAccess\(\)\)\s*return/)
  assert.match(appSource, /if \(\$\('mode'\)\.value === 'orbit' && !state\.auth\.signedIn\)/)
  assert.equal((await fetch(`${started.origin}/api/bootstrap`)).status, 403)
  assert.equal((await fetch(`${started.origin}/api/bootstrap`, { headers: { ...headers, Origin: 'http://evil.invalid' } })).status, 403)
  const bootstrapResponse = await fetch(`${started.origin}/api/bootstrap`, { headers })
  assert.equal(bootstrapResponse.status, 200)
  const bootstrap = await bootstrapResponse.json()
  assert.deepEqual(bootstrap.managedModel, { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' })
  assert.equal(bootstrap.providers.find((provider) => provider.id === 'zhipu-cn').label, 'Zhipu BigModel (China)')
  assert.equal(bootstrap.providers.find((provider) => provider.id === 'openrouter').configured, true)
  assert.equal(bootstrap.providers.find((provider) => provider.id === 'kimi-global').configured, false)
  assert.equal(bootstrap.defaultWorkspace, path.join(process.cwd(), 'orbit-game'))
  assert.equal(bootstrap.runs[0].failureCategory, 'none')
  assert.equal(bootstrap.runs[0].recoveryDisposition, 'terminal')
  assert.equal(bootstrap.runs[0].gameName, 'Preview')
  assert.equal(bootstrap.runs[0].folderName, 'workspace')
  assert.equal(bootstrap.runs[0].displayName, 'Preview')
  const persistedCheckpoint = JSON.parse(await fs.readFile(path.join(store.directory(run.id), 'checkpoint.json'), 'utf8'))
  assert.equal(Object.hasOwn(persistedCheckpoint, 'failureCategory'), false)
  assert.equal(Object.hasOwn(persistedCheckpoint, 'recoveryDisposition'), false)
  const { Origin: _origin, ...browserGetHeaders } = headers
  assert.equal((await fetch(`${started.origin}/api/bootstrap`, { headers: browserGetHeaders })).status, 200)
  const deniedRun = await fetch(`${started.origin}/api/runs/stream`, {
    method: 'POST', headers, body: JSON.stringify({ workspace, prompt: 'Must not start', mode: 'byok', provider: 'kimi-global', runtime: 'html' }),
  })
  assert.equal(deniedRun.status, 500)
  assert.match((await deniedRun.json()).error, /Configure a Kimi .*API key/)
  assert.equal(streamedInput, undefined)
  const catalog = await fetch(`${started.origin}/api/provider/models?provider=openrouter`, { headers }).then((response) => response.json())
  assert.deepEqual(catalog.models, [{ id: 'vendor/model', name: 'Model', vision: true }])
  const saved = await fetch(`${started.origin}/api/provider`, { method: 'POST', headers, body: JSON.stringify({ provider: 'kimi-global', apiKey: 'test-key' }) })
  assert.equal(saved.status, 200)
  assert.deepEqual(savedCredential, { account: 'provider:kimi-global', secret: 'test-key' })
  const streamResponse = await fetch(`${started.origin}/api/runs/stream`, {
    method: 'POST', headers, body: JSON.stringify({ workspace, prompt: 'Build a game', mode: 'byok', provider: 'openrouter', runtime: 'html' }),
  })
  assert.equal(streamResponse.status, 200)
  assert.match(streamResponse.headers.get('content-type'), /application\/x-ndjson/)
  const streamMessages = (await streamResponse.text()).trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(streamMessages.map((message) => message.type), ['progress', 'complete'])
  assert.equal(streamMessages[0].event.toolName, 'write_file')
  assert.equal(streamMessages[1].run.recoveryDisposition, 'terminal')
  assert.equal(streamedInput.source, 'cli_gui')
  assert.equal(streamedInput.onProgress instanceof Function, true)
  const imageResponse = await fetch(`${started.origin}/api/assets/image`, {
    method: 'POST', headers, body: JSON.stringify({ workspace, prompt: 'An original arcade icon', output: 'assets/images/icon.png', aspectRatio: '1:1' }),
  })
  assert.equal(imageResponse.status, 200)
  const imageBody = await imageResponse.json()
  assert.equal(imageBody.run.failureCategory, 'none')
  assert.equal(imageBody.run.recoveryDisposition, 'terminal')
  assert.equal(imageInput.source, 'cli_gui')
  assert.equal(imageInput.output, 'assets/images/icon.png')

  const movedWorkspace = path.join(root, 'moved-workspace')
  await fs.rename(workspace, movedWorkspace)
  const relocated = await fetch(`${started.origin}/api/runs/${run.id}/relocate`, {
    method: 'POST', headers, body: JSON.stringify({ workspace: movedWorkspace }),
  }).then((response) => response.json())
  assert.equal(relocated.workspace, await fs.realpath(movedWorkspace))
  assert.deepEqual(relocated.updatedRunIds, [run.id])
  assert.equal((await store.load(run.id)).workspace, await fs.realpath(movedWorkspace))

  const envelope = await fetch(`${started.origin}/api/runs/${run.id}/preview`, { method: 'POST', headers, body: '{}' }).then((response) => response.json())
  const preview = await fetch(envelope.url)
  assert.equal(preview.status, 200)
  assert.notEqual(new URL(envelope.url).origin, started.origin)
  assert.match(preview.headers.get('content-security-policy'), /connect-src 'none'/)
  assert.match(preview.headers.get('content-security-policy'), new RegExp(`frame-ancestors ${started.origin.replaceAll('.', '\\.')}`))
})
