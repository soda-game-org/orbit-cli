#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { createApplication } from './app.mjs'
import { CODING_PROVIDER_IDS, PROVIDER_IDS, PROVIDERS, RUNTIMES, VERSION } from './constants.mjs'
import { providerCredentialAccount } from './credentials.mjs'
import { withRecoveryView } from './recovery-view.mjs'
import { boundedString, publicError } from './util.mjs'

const HELP = `Orbit CLI ${VERSION}

Usage:
  orbit auth login|status|logout
  orbit providers list|set|remove|test <provider> [--model <id>] [--key-stdin]
  orbit providers models <provider>
  orbit generate --prompt <text> [--workspace <absolute>] [--mode orbit|byok]
                 [--provider <id>] [--model <id>] [--runtime <id>]
                 [--attach <absolute-image> ...] [--images] [--3d] [--allow-shell]
                 [--cloud-logs|--no-cloud-logs]
  orbit resume <run-id> [--retry-unsafe] [--allow-shell]
  orbit image --prompt <text> [--workspace <absolute>] [--output <relative.png>]
              [--aspect 1:1|9:16|16:9] [--resume <run-id>] [--retry-unsafe]
  orbit 3d --prompt <text> [--workspace <absolute>] [--output <relative.glb>]
           [--mode orbit|byok] [--resume <run-id>]
  orbit runs
  orbit capabilities
  orbit publish <run-id> [--title <text>] [--locale en|zh] [--yes]
  orbit logs enable|disable|flush
  orbit web [--no-open]
  orbit doctor

Official mode uses Google OAuth and the Orbit Worker. BYOK secrets are accepted
interactively or with --key-stdin and stored only in the operating-system vault.
Publishing never happens implicitly.`

function parse(argv) {
  const positionals = []
  const flags = Object.create(null)
  const repeat = new Set(['attach'])
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) { positionals.push(item); continue }
    const pair = item.slice(2).split('=', 2)
    const key = pair[0]
    if (!key) throw new Error('Invalid option')
    let value = pair.length === 2 ? pair[1] : true
    if (pair.length === 1 && index + 1 < argv.length && !argv[index + 1].startsWith('--')) value = argv[++index]
    if (repeat.has(key)) {
      flags[key] ||= []
      flags[key].push(value)
    } else if (Object.hasOwn(flags, key)) throw new Error(`Option --${key} was provided more than once`)
    else flags[key] = value
  }
  return { positionals, flags }
}

function booleanFlag(flags, key, fallback = false) {
  if (!Object.hasOwn(flags, key)) return fallback
  if (flags[key] !== true) throw new Error(`--${key} does not take a value`)
  return true
}

function oneOf(value, choices, label) {
  if (!choices.includes(value)) throw new Error(`${label} must be one of: ${choices.join(', ')}`)
  return value
}

async function readSecret({ stdin = process.stdin, stdout = process.stdout, piped = false } = {}) {
  if (piped) {
    if (stdin.isTTY) throw new Error('--key-stdin requires a piped secret')
    const chunks = []
    let size = 0
    for await (const chunk of stdin) {
      size += chunk.length
      if (size > 64 * 1024) throw new Error('Piped API key is too large')
      chunks.push(Buffer.from(chunk))
    }
    return boundedString(Buffer.concat(chunks).toString('utf8'), 'API key', 64 * 1024)
  }
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') throw new Error('Use --key-stdin in a non-interactive terminal')
  stdout.write('API key (stored in your OS credential vault): ')
  stdin.setRawMode(true)
  stdin.resume()
  let value = ''
  try {
    while (true) {
      const chunk = await new Promise((resolve) => stdin.once('data', resolve))
      for (const byte of Buffer.from(chunk)) {
        if (byte === 3) throw new Error('Cancelled')
        if (byte === 10 || byte === 13) { stdout.write('\n'); return boundedString(value, 'API key', 64 * 1024) }
        if (byte === 8 || byte === 127) { value = value.slice(0, -1); continue }
        if (byte >= 32 && byte <= 126) value += String.fromCharCode(byte)
        if (value.length > 64 * 1024) throw new Error('API key is too large')
      }
    }
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
  }
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false
  process.stdout.write(`${question} Type "publish" to continue: `)
  process.stdin.setEncoding('utf8')
  process.stdin.resume()
  const answer = await new Promise((resolve) => process.stdin.once('data', resolve))
  process.stdin.pause()
  return String(answer).trim() === 'publish'
}

function printRun(run) {
  const view = withRecoveryView(run)
  console.log(JSON.stringify({
    id: view.id, state: view.state, mode: view.mode, source: view.source, operation: view.operation,
    iteration: view.iteration, workspace: view.workspace, updatedAt: view.updatedAt,
    unsafeResumeRequired: view.unsafeResumeRequired, lastError: view.lastError, result: view.result,
    failureCategory: view.failureCategory, recoveryDisposition: view.recoveryDisposition,
  }, null, 2))
}

async function direct3d(app, flags) {
  const resumeId = typeof flags.resume === 'string' ? flags.resume : null
  if (resumeId) return app.asset3d.resume(resumeId, { retryUnsafe: booleanFlag(flags, 'retry-unsafe') })
  const config = await app.config.get()
  return app.asset3d.create({
    source: 'cli', mode: oneOf(String(flags.mode || config.mode), ['orbit', 'byok'], '3D mode'),
    workspace: path.resolve(String(flags.workspace || process.cwd())),
    prompt: boundedString(flags.prompt, '3D prompt', 8_000),
    output: typeof flags.output === 'string' ? flags.output : 'assets/models/generated.glb',
    cloudLogs: booleanFlag(flags, 'cloud-logs', config.cloudLogs),
  })
}

async function directImage(app, flags) {
  const resumeId = typeof flags.resume === 'string' ? flags.resume : null
  if (resumeId) return app.assetImage.resume(resumeId, { retryUnsafe: booleanFlag(flags, 'retry-unsafe') })
  const config = await app.config.get()
  return app.assetImage.create({
    source: 'cli',
    workspace: path.resolve(String(flags.workspace || process.cwd())),
    prompt: boundedString(flags.prompt, 'Image prompt', 8_000),
    output: typeof flags.output === 'string' ? flags.output : 'assets/images/generated.png',
    aspectRatio: oneOf(String(flags.aspect || '1:1'), ['1:1', '9:16', '16:9'], 'Image aspect ratio'),
    cloudLogs: booleanFlag(flags, 'cloud-logs', config.cloudLogs),
  })
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const app = dependencies.app || createApplication()
  const recovered = await app.store.recoverInterrupted()
  if (recovered.length) console.error(`Recovered ${recovered.length} interrupted local run(s). Use \`orbit resume <run-id>\`.`)
  const { positionals, flags } = parse(argv)
  const [command, action, target] = positionals
  if (command === 'version' || flags.version) { console.log(VERSION); return 0 }
  if (!command || command === 'help' || flags.help) { console.log(HELP); return 0 }

  if (command === 'auth') {
    if (action === 'login') console.log(JSON.stringify(await app.auth.login(), null, 2))
    else if (action === 'status') console.log(JSON.stringify(await app.auth.status(), null, 2))
    else if (action === 'logout') { await app.auth.logout(); console.log('Signed out.') }
    else throw new Error('Usage: orbit auth login|status|logout')
    return 0
  }
  if (command === 'providers') {
    if (action === 'list') {
      const rows = []
      for (const [provider, definition] of Object.entries(PROVIDERS)) rows.push({ provider, label: definition.label, purpose: definition.purpose, configured: Boolean(await app.credentials.get(providerCredentialAccount(provider))), vision: definition.vision, models: definition.modelsPath ? 'discoverable' : 'manual id' })
      console.table(rows)
    } else if (action === 'models') {
      const provider = oneOf(target, CODING_PROVIDER_IDS, 'Provider')
      const rows = await app.byok.models(provider)
      console.table(rows)
    } else if (['set', 'remove', 'test'].includes(action)) {
      const provider = oneOf(target, PROVIDER_IDS, 'Provider')
      if (action === 'set') {
        await app.credentials.set(providerCredentialAccount(provider), await readSecret({ piped: booleanFlag(flags, 'key-stdin') }))
        console.log(`${PROVIDERS[provider].label} key saved in the OS credential vault.`)
      } else if (action === 'remove') {
        await app.credentials.delete(providerCredentialAccount(provider)); console.log(`${PROVIDERS[provider].label} key removed.`)
      } else {
        if (provider === 'replicate') throw new Error('Replicate is tested by a real 3D request; no billable test is sent automatically')
        console.log(await app.byok.test(provider, typeof flags.model === 'string' ? flags.model : undefined) ? 'Provider connection passed.' : 'Provider response did not pass the check.')
      }
    } else throw new Error('Usage: orbit providers list|set|remove|test|models <provider>')
    return 0
  }
  if (command === 'generate') {
    const config = await app.config.get()
    const mode = oneOf(String(flags.mode || config.mode), ['orbit', 'byok'], 'Mode')
    const provider = oneOf(String(flags.provider || config.provider), CODING_PROVIDER_IDS, 'Provider')
    const runtime = oneOf(String(flags.runtime || config.runtime), [...RUNTIMES], 'Runtime')
    const cloudLogs = flags['no-cloud-logs'] === true ? false : booleanFlag(flags, 'cloud-logs', config.cloudLogs)
    const run = await app.manager.create({
      source: 'cli', prompt: boundedString(flags.prompt, 'Prompt', 32_000),
      workspace: path.resolve(String(flags.workspace || process.cwd())), operation: flags.edit === true ? 'edit' : 'create',
      mode, provider, model: typeof flags.model === 'string' ? flags.model : config.model, runtime,
      generateImages: booleanFlag(flags, 'images'), generate3d: booleanFlag(flags, '3d'), cloudLogs, allowShell: booleanFlag(flags, 'allow-shell'),
      referenceImages: Array.isArray(flags.attach) ? flags.attach.map((file) => path.resolve(String(file))) : [],
    })
    printRun(run)
    return run.state === 'completed' ? 0 : 2
  }
  if (command === 'resume') {
    if (!action) throw new Error('Usage: orbit resume <run-id>')
    const stored = await app.store.load(action)
    const run = stored.kind === 'asset3d'
      ? await app.asset3d.resume(action, { retryUnsafe: booleanFlag(flags, 'retry-unsafe') })
      : stored.kind === 'assetimage'
        ? await app.assetImage.resume(action, { retryUnsafe: booleanFlag(flags, 'retry-unsafe') })
        : await app.manager.resume(action, { retryUnsafe: booleanFlag(flags, 'retry-unsafe'), allowShell: booleanFlag(flags, 'allow-shell') })
    printRun(run)
    return run.state === 'completed' ? 0 : 2
  }
  if (command === 'image') {
    const run = await directImage(app, flags)
    printRun(run)
    return run.state === 'completed' ? 0 : 2
  }
  if (command === '3d') {
    const run = await direct3d(app, flags)
    printRun(run)
    return run.state === 'completed' ? 0 : 2
  }
  if (command === 'runs') {
    for (const checkpoint of await app.store.list()) {
      const run = withRecoveryView(checkpoint)
      console.log(`${run.id}\t${run.state}\t${run.mode}\t${run.updatedAt}\t${run.workspace}\t${run.failureCategory}\t${run.recoveryDisposition}`)
    }
    return 0
  }
  if (command === 'capabilities') {
    console.table([
      { capability: 'reference_images', status: 'supported', detail: 'PNG/JPEG/WebP; signature and path verified' },
      { capability: 'image_generation', status: 'supported', detail: 'Orbit OAuth Worker; explicit opt-in or standalone command' },
      { capability: 'documents', status: 'unsupported', detail: 'No silent fallback; use the desktop product' },
      { capability: 'gis', status: 'unsupported', detail: 'Intentionally unavailable in CLI and Web CLI' },
      { capability: '3d_models', status: 'supported', detail: 'Orbit OAuth Worker or user Replicate key' },
      { capability: 'publish', status: 'explicit_only', detail: 'OAuth and confirmation required' },
      { capability: 'cloud_logs', status: 'opt_in', detail: 'Structured metadata only; source is recorded' },
    ])
    return 0
  }
  if (command === 'publish') {
    if (!action) throw new Error('Usage: orbit publish <run-id> [--yes]')
    const run = await app.store.load(action)
    if (run.state !== 'completed' || !run.lastValidation?.ok) throw new Error('Only a completed and validated game run can be published')
    await app.auth.accessToken()
    if (!booleanFlag(flags, 'yes') && !await confirm(`Publish ${run.workspace} publicly to Orbit?`)) throw new Error('Publish cancelled; nothing was uploaded')
    const result = await app.publishFactory(app.apiFactory('cli')).publish({
      workspace: run.workspace, prompt: run.prompt, runtime: run.runtime,
      title: typeof flags.title === 'string' ? flags.title : undefined,
      locale: flags.locale === 'zh' ? 'zh' : 'en', gameId: typeof flags['game-id'] === 'string' ? flags['game-id'] : undefined,
    })
    console.log(JSON.stringify(result, null, 2))
    return 0
  }
  if (command === 'logs') {
    if (action === 'enable') { await app.config.update({ cloudLogs: true }); console.log('Cloud diagnostics enabled (structured metadata only).') }
    else if (action === 'disable') { await app.config.update({ cloudLogs: false }); console.log('Cloud diagnostics disabled.') }
    else if (action === 'flush') console.log(JSON.stringify(await app.cloudLogs.flush(), null, 2))
    else throw new Error('Usage: orbit logs enable|disable|flush')
    return 0
  }
  if (command === 'web') {
    const server = app.web()
    const started = await server.start({ open: !booleanFlag(flags, 'no-open') })
    console.log(`Orbit Web CLI: ${started.url}`)
    await new Promise((resolve) => {
      const stop = async () => { await server.close(); resolve() }
      process.once('SIGINT', stop); process.once('SIGTERM', stop)
    })
    return 0
  }
  if (command === 'doctor') {
    const config = await app.config.get()
    console.log(JSON.stringify({ version: VERSION, node: process.version, platform: process.platform, arch: process.arch, auth: await app.auth.status(), config, recoveredRuns: recovered.map((run) => run.id) }, null, 2))
    return 0
  }
  throw new Error(`Unknown command: ${command}\n\n${HELP}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => { process.exitCode = code }).catch((error) => { console.error(`orbit: ${publicError(error)}`); process.exitCode = 1 })
}
