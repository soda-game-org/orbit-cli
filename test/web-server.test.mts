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
  const uploadRoot = path.join(directories.data, 'web-uploads')
  const oldUpload = path.join(uploadRoot, 'aaaaaaaaaaaaaaaaaaaaaaaa')
  const activeUpload = path.join(uploadRoot, 'bbbbbbbbbbbbbbbbbbbbbbbb')
  await fs.mkdir(oldUpload, { recursive: true })
  await fs.mkdir(activeUpload, { recursive: true })
  await fs.writeFile(path.join(oldUpload, '0.png'), 'orphan')
  await fs.writeFile(path.join(activeUpload, '0.png'), 'active')
  const oldTime = new Date(Date.now() - 2 * 60 * 60_000)
  await fs.utimes(oldUpload, oldTime, oldTime)
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(path.join(workspace, 'dist'), { recursive: true })
  await fs.writeFile(path.join(workspace, 'dist', 'index.html'), '<!doctype html><title>Preview</title>')
  const store = new RunStore({ directories })
  const run = await store.create({ workspace, prompt: 'test', mode: 'orbit' })
  run.lastValidation = { ok: true, index: 'dist/index.html' }
  await store.transition(run, 'completed')
  const originalList = store.list.bind(store)
  let runListCalls = 0
  Object.defineProperty(store, 'list', { value: async () => { runListCalls += 1; return originalList() } })
  const config = { get: async () => ({ mode: 'orbit' }), update: async (value) => value }
  let authReads = 0
  const auth = { status: async () => { authReads += 1; return { signedIn: false } }, login: async () => ({}), logout: async () => {} }
  let savedCredential
  const credentialReads = []
  const credentials = {
    get: async (account) => { credentialReads.push(account); return account === 'provider:openrouter' ? 'configured-key' : null },
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
  let uploadRemovedDuringRun = false
  const manager = { create: async (input) => {
    streamedInput = input
    if (input.referenceImages?.length) {
      assert.equal(await fs.stat(input.referenceImages[0]).then(() => true, () => false), true)
      await input.onReferencesIngested?.()
      uploadRemovedDuringRun = await Promise.all(input.referenceImages.map((file) => fs.stat(file).then(() => false, () => true)))
        .then((values) => values.every(Boolean))
    }
    await input.onProgress?.({ type: 'tool_started', toolName: 'write_file', occurredAt: new Date().toISOString() })
    return { ...run, id: 'run_22222222-2222-4222-8222-222222222222', state: 'completed' }
  } }
  const server = new WebCliServer({
    asset3d: {}, assetImage, manager, auth, byok, config, credentials, store, apiFactory: () => ({}), publishFactory: () => ({}), directories,
  })
  const started = await server.start({ open: false })
  t.after(() => server.close())
  assert.equal(await fs.stat(oldUpload).then(() => true, () => false), false)
  assert.equal(await fs.stat(activeUpload).then(() => true, () => false), true)
  const url = new URL(started.url)
  const secrets = new URLSearchParams(url.hash.slice(1))
  const headers = { Origin: started.origin, Authorization: `Bearer ${secrets.get('token')}`, 'X-Orbit-CSRF': secrets.get('csrf'), 'Content-Type': 'application/json' }

  const page = await fetch(started.origin)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /frame-src http:\/\/127\.0\.0\.1:\*/)
  const pageHtml = await page.text()
  assert.match(pageHtml, /<div id="root"><\/div>/)
  assert.match(pageHtml, /href="\/app\.css"/)
  assert.match(pageHtml, /src="\/app\.js"/)
  const appSource = await fetch(`${started.origin}/app.js`).then((response) => response.text())
  assert.match(appSource, /\/api\/orbit\/models/)
  assert.match(appSource, /Start a new game/)
  assert.match(appSource, /Same game, fresh context/)
  assert.match(appSource, /Validated builds only/)
  assert.match(appSource, /allow-scripts allow-pointer-lock allow-same-origin/)
  const appCss = await fetch(`${started.origin}/app.css`).then((response) => response.text())
  assert.match(appCss, /\.orbit-shell/)
  assert.doesNotMatch(appCss, /@import\s+["']@heroui/)
  assert.equal((await fetch(`${started.origin}/api/bootstrap`)).status, 403)
  assert.equal((await fetch(`${started.origin}/api/bootstrap`, { headers: { ...headers, Origin: 'http://evil.invalid' } })).status, 403)
  const listCallsBeforeBootstrap = runListCalls
  const bootstrapResponse = await fetch(`${started.origin}/api/bootstrap`, { headers })
  assert.equal(bootstrapResponse.status, 200)
  const bootstrap = await bootstrapResponse.json()
  assert.equal(runListCalls, listCallsBeforeBootstrap + 1)
  assert.deepEqual(bootstrap.managedModel, { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' })
  assert.equal(bootstrap.providers.find((provider) => provider.id === 'zhipu-cn').label, 'Zhipu BigModel (China)')
  assert.equal(bootstrap.auth.checked, false)
  assert.equal(bootstrap.providers.find((provider) => provider.id === 'openrouter').configured, null)
  assert.equal(bootstrap.providers.find((provider) => provider.id === 'kimi-global').configured, null)
  assert.equal(authReads, 0)
  assert.deepEqual(credentialReads, [])
  assert.equal(bootstrap.defaultWorkspace, path.join(process.cwd(), 'orbit-game'))
  assert.equal(bootstrap.runs[0].failureCategory, 'none')
  assert.equal(bootstrap.runs[0].recoveryDisposition, 'terminal')
  assert.equal(bootstrap.runs[0].gameName, 'Preview')
  assert.equal(bootstrap.runs[0].folderName, 'workspace')
  assert.equal(bootstrap.runs[0].displayName, 'Preview')
  assert.equal(bootstrap.threads.length, 1)
  assert.deepEqual(bootstrap.threads[0].runIds, [run.id])
  const persistedCheckpoint = JSON.parse(await fs.readFile(path.join(store.directory(run.id), 'checkpoint.json'), 'utf8'))
  assert.equal(Object.hasOwn(persistedCheckpoint, 'failureCategory'), false)
  assert.equal(Object.hasOwn(persistedCheckpoint, 'recoveryDisposition'), false)
  const { Origin: _origin, ...browserGetHeaders } = headers
  const listCallsBeforeGetBootstrap = runListCalls
  assert.equal((await fetch(`${started.origin}/api/bootstrap`, { headers: browserGetHeaders })).status, 200)
  assert.equal(runListCalls, listCallsBeforeGetBootstrap + 1)
  assert.equal(authReads, 0)
  assert.deepEqual(credentialReads, [])
  const access = await fetch(`${started.origin}/api/access/status`, { headers }).then((response) => response.json())
  assert.equal(access.auth.checked, true)
  assert.equal(access.auth.signedIn, false)
  assert.equal(authReads, 1)
  const providerStatus = await fetch(`${started.origin}/api/provider/status?provider=openrouter`, { headers }).then((response) => response.json())
  assert.deepEqual(providerStatus, { provider: 'openrouter', configured: true })
  assert.deepEqual(credentialReads, ['provider:openrouter'])
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
  const createdThreadResponse = await fetch(`${started.origin}/api/threads`, {
    method: 'POST', headers, body: JSON.stringify({ workspace, title: 'Second session' }),
  })
  assert.equal(createdThreadResponse.status, 200)
  const createdThread = (await createdThreadResponse.json()).thread
  assert.equal(createdThread.title, 'Second session')
  assert.equal(createdThread.workspace, await fs.realpath(workspace))
  const streamResponse = await fetch(`${started.origin}/api/runs/stream`, {
    method: 'POST', headers, body: JSON.stringify({
      workspace, threadId: createdThread.id, prompt: 'Build a game', operation: 'edit', mode: 'byok', provider: 'openrouter', runtime: 'html',
      files: [{
        name: 'reference.png',
        data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]).toString('base64'),
      }],
    }),
  })
  assert.equal(streamResponse.status, 200)
  assert.match(streamResponse.headers.get('content-type'), /application\/x-ndjson/)
  const streamMessages = (await streamResponse.text()).trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(streamMessages.map((message) => message.type), ['progress', 'complete'])
  assert.equal(streamMessages[0].event.toolName, 'write_file')
  assert.equal(streamMessages[1].run.recoveryDisposition, 'terminal')
  assert.equal(streamMessages[1].thread.id, createdThread.id)
  assert.deepEqual(streamMessages[1].thread.runIds, [streamMessages[1].run.id])
  assert.equal(streamedInput.source, 'cli_gui')
  assert.equal(streamedInput.threadId, createdThread.id)
  assert.equal(streamedInput.operation, 'edit')
  assert.equal(streamedInput.onProgress instanceof Function, true)
  assert.equal(uploadRemovedDuringRun, true)
  const imageResponse = await fetch(`${started.origin}/api/assets/image`, {
    method: 'POST', headers, body: JSON.stringify({ workspace, prompt: 'An original arcade icon', output: 'assets/images/icon.png', aspectRatio: '1:1' }),
  })
  assert.equal(imageResponse.status, 200)
  const imageBody = await imageResponse.json()
  assert.equal(imageBody.run.failureCategory, 'none')
  assert.equal(imageBody.run.recoveryDisposition, 'terminal')
  assert.equal(imageBody.thread.kind, 'assets')
  assert.deepEqual(imageBody.thread.runIds, [imageBody.run.id])
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

test('bootstrap title metadata refuses symlink and oversized project indexes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-web-safe-title-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const directories = { config: path.join(root, 'config'), data: path.join(root, 'data') }
  const store = new RunStore({ directories })
  const secret = path.join(root, 'secret.html')
  await fs.writeFile(secret, '<title>PRIVATE OUTSIDE TITLE</title>')
  const linkedWorkspace = path.join(root, 'linked-workspace')
  await fs.mkdir(linkedWorkspace)
  await fs.symlink(secret, path.join(linkedWorkspace, 'index.html'))
  const linked = await store.create({ workspace: linkedWorkspace, prompt: 'linked', mode: 'orbit' })
  linked.lastValidation = { ok: true, index: 'index.html' }
  await store.transition(linked, 'completed')
  const largeWorkspace = path.join(root, 'large-workspace')
  await fs.mkdir(largeWorkspace)
  await fs.writeFile(path.join(largeWorkspace, 'index.html'), `<title>PRIVATE LARGE TITLE</title>${'x'.repeat(70 * 1024)}`)
  const large = await store.create({ workspace: largeWorkspace, prompt: 'large', mode: 'orbit' })
  large.lastValidation = { ok: true, index: 'index.html' }
  await store.transition(large, 'completed')
  const server = new WebCliServer({
    asset3d: {}, assetImage: {}, manager: {},
    auth: { status: async () => ({ signedIn: false }) },
    byok: {}, config: { get: async () => ({ mode: 'orbit' }) },
    credentials: { get: async () => null }, store, apiFactory: () => ({}), publishFactory: () => ({}), directories,
  })
  const started = await server.start({ open: false })
  t.after(() => server.close())
  const hash = new URLSearchParams(new URL(started.url).hash.slice(1))
  const headers = { Origin: started.origin, Authorization: `Bearer ${hash.get('token')}`, 'X-Orbit-CSRF': hash.get('csrf') }

  const bootstrap = await fetch(`${started.origin}/api/bootstrap`, { headers }).then((response) => response.json())
  const linkedView = bootstrap.runs.find((run) => run.id === linked.id)
  const largeView = bootstrap.runs.find((run) => run.id === large.id)
  assert.equal(linkedView.gameName, '')
  assert.equal(largeView.gameName, '')
  assert.doesNotMatch(JSON.stringify(bootstrap), /PRIVATE (?:OUTSIDE|LARGE) TITLE/)
})
