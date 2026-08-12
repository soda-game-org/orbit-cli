import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RunStore } from '../src/run-store.mjs'
import { agentTools, ToolExecutor } from '../src/tools.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-tools-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const run = await store.create({ workspace, prompt: 'test', mode: 'byok', runtime: 'html' })
  run.plan = { schema: 'orbit.agent-plan.v1', summary: 'Test tool', todos: [{ id: 'test', title: 'Test tool', status: 'in_progress', kind: 'implementation' }], blockers: [] }
  return { workspace, store, run, executor: new ToolExecutor({ workspace, store, run, allowShell: true }) }
}

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } })

test('blocks empty edits, workspace escapes and symlink writes', async (t) => {
  const { workspace, executor } = await fixture(t)
  await fs.writeFile(path.join(workspace, 'index.html'), 'hello')
  await assert.rejects(executor.execute(call('edit_file', { path: 'index.html', old_string: '', new_string: 'x' })), /cannot be empty/)
  await assert.rejects(executor.execute(call('write_file', { path: '../outside.txt', content: 'x' })), /safe workspace-relative/)
  const outside = path.join(path.dirname(workspace), 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(workspace, 'linked'))
  await assert.rejects(executor.execute(call('write_file', { path: 'linked/file.txt', content: 'x' })), /unsafe directory/)
})

test('returns a non-empty protocol result for an empty workspace listing', async (t) => {
  const { executor } = await fixture(t)
  assert.equal(await executor.execute(call('list_files', {})), 'No files')
})

test('auto runtime is decided by the agent before mutation instead of prompt keywords', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-runtime-decision-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const run = await store.create({ workspace, prompt: 'Create a 2D shooter', mode: 'byok', runtime: 'auto' })
  const executor = new ToolExecutor({ workspace, store, run })
  const autoTools = agentTools({ mode: 'byok', runtime: 'auto', operation: 'create' })
  assert.equal(autoTools.some((item) => item.function.name === 'select_runtime'), true)
  assert.equal(JSON.stringify(autoTools).includes('orbit.agent-tool-capability'), false)
  await assert.rejects(executor.execute(call('write_file', { path: 'game.js', content: 'start()' })), /execution plan/)
  await executor.execute(call('update_agent_plan', { summary: 'Choose architecture', todos: [{ id: 'runtime', title: 'Choose runtime', status: 'in_progress', kind: 'plan' }] }))
  await assert.rejects(executor.execute(call('write_file', { path: 'game.js', content: 'start()' })), /select_runtime/)
  const selected = JSON.parse(await executor.execute(call('select_runtime', {
    runtime: 'html', dimension: '2d', rationale: 'Canvas 2D directly serves this flat playfield and touch input without framework overhead.',
  })))
  assert.equal(selected.runtimeDecision.runtime, 'html')
  assert.equal(run.requestedRuntime, 'auto')
  assert.equal(run.runtime, 'html')
  await executor.execute(call('write_file', { path: 'game.js', content: 'start()' }))
  assert.equal(await fs.readFile(path.join(workspace, 'game.js'), 'utf8'), 'start()')
  assert.equal(agentTools({ mode: 'byok', runtime: 'html', operation: 'create' }).some((item) => item.function.name === 'select_runtime'), false)
})

test('reads reference observations by canonical media identity and rejects arbitrary legacy paths', async (t) => {
  const { run, executor } = await fixture(t)
  run.inputItems = [{
    schema: 'orbit.agent-input-item.v1', id: 'turn-item-1', type: 'attachment',
    attachment: { id: 'attachment-1', kind: 'image', name: 'board.png', sourceRef: '.orbit/references/board.png' },
  }]
  run.references = [{ id: 'attachment-1', originalName: 'board.png', privatePath: '.orbit/references/board.png' }]
  run.mediaObservations = [{
    schema: 'orbit.agent-media-observation.v1', id: 'observation-1', attachmentId: 'attachment-1',
    kind: 'image', status: 'ready', summary: 'A blue board.', facts: [{ id: 'fact-1', text: 'The board is blue.' }],
  }]
  const byId = JSON.parse(await executor.execute(call('read_reference_media', { media_ids: ['turn-item-1'] })))
  assert.equal(byId.items[0].observation.id, 'observation-1')
  const byLegacyAlias = JSON.parse(await executor.execute(call('read_reference_media', { image_path: 'board.png' })))
  assert.equal(byLegacyAlias.items[0].attachmentId, 'attachment-1')
  await assert.rejects(executor.execute(call('read_reference_media', { image_path: '../secret.png' })), /uniquely match an attachment/)
  await assert.rejects(executor.execute(call('read_reference_media', {})), /requires media_ids/)
})

test('validates lifecycle implemented in local JavaScript, not only index HTML', async (t) => {
  const { workspace, executor } = await fixture(t)
  await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width"><script src="game.js"></script><button>Leaderboard</button>')
  await fs.writeFile(path.join(workspace, 'game.js'), `
    OrbitArcade.startGame()
    function end(){ OrbitArcade.endGame({score:1}) }
    function leaderboard(){ OrbitArcade.openLeaderboard() }
    addEventListener('orbit:leaderboard:update', () => {})
    addEventListener('pointerdown', () => {})
    addEventListener('keydown', () => {})
  `)
  const result = JSON.parse(await executor.execute(call('validate_project', {})))
  assert.equal(result.ok, true)
})

test('does not allow npm install lifecycle scripts through the shell tool', async (t) => {
  const { executor } = await fixture(t)
  await assert.rejects(executor.execute(call('shell', { command: 'npm install' })), /allowlist/)
  await assert.rejects(executor.execute(call('shell', { command: 'npm test' })), /allowlist/)
  await assert.rejects(executor.execute(call('shell', { command: 'npm run arbitrary' })), /allowlist/)
})

test('runs the explicit build target with an isolated home and filtered environment', async (t) => {
  const { workspace, executor } = await fixture(t)
  const canaryName = 'ORBIT_SHELL_ENV_CANARY'
  const previous = process.env[canaryName]
  process.env[canaryName] = 'must-not-reach-child'
  t.after(() => {
    if (previous === undefined) delete process.env[canaryName]
    else process.env[canaryName] = previous
  })
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({
    scripts: {
      build: `node -e "console.log(JSON.stringify({home:process.env.HOME,canary:process.env.${canaryName}}))"`,
    },
  }))
  const result = JSON.parse(await executor.execute(call('shell', { command: 'npm run build' })))
  assert.equal(result.exitCode, 0)
  assert.doesNotMatch(result.output, /must-not-reach-child/)
  assert.match(result.output, /\.orbit\/shell-home/)
})

test('offers image generation to explicit Orbit and BYOK game-agent runs and checkpoints tool output', async (t) => {
  const orbitTools = agentTools({ mode: 'orbit', generateImages: true, generate3d: false })
  assert.equal(orbitTools.some((item) => item.function.name === 'generate_image'), true)
  assert.equal(agentTools({ mode: 'orbit', generateImages: false }).some((item) => item.function.name === 'generate_image'), false)
  assert.equal(agentTools({ mode: 'byok', generateImages: true }).some((item) => item.function.name === 'generate_image'), true)

  const { workspace, store, run } = await fixture(t)
  run.mode = 'orbit'
  run.generateImages = true
  await store.save(run)
  let received
  const executor = new ToolExecutor({
    workspace, store, run, api: {},
    image: { generate: async (input) => {
      received = input
      input.state.output = { relativePath: input.output }
      await input.persist()
      return input.state.output
    } },
  })
  const toolCall = call('generate_image', { prompt: 'An original neon arcade icon', output_path: 'assets/images/icon.png', aspect_ratio: '1:1' })
  toolCall.id = 'image-call-1'
  const result = JSON.parse(await executor.execute(toolCall))
  assert.equal(result.relativePath, 'assets/images/icon.png')
  assert.equal(received.workspace, await fs.realpath(workspace))
  assert.equal((await store.load(run.id)).assetImages['image-call-1'].output.relativePath, 'assets/images/icon.png')
})

test('routes BYOK image tool calls through the same game-agent executor without an Orbit API', async (t) => {
  const { workspace, store, run } = await fixture(t)
  run.generateImages = true
  await store.save(run)
  let received
  const executor = new ToolExecutor({
    workspace, store, run,
    image: { generate: async (input) => {
      received = input
      input.state.output = { relativePath: input.output, model: 'google/nano-banana' }
      await input.persist()
      return input.state.output
    } },
  })
  const toolCall = call('generate_image', { prompt: 'Original game background', output_path: 'assets/images/background.png', aspect_ratio: '16:9' })
  toolCall.id = 'byok-image-call-1'
  const result = JSON.parse(await executor.execute(toolCall))
  assert.equal(received.mode, 'byok')
  assert.equal(received.api, undefined)
  assert.equal(result.relativePath, 'assets/images/background.png')
})

test('reuses a verified generated image across different model tool-call ids', async (t) => {
  const { workspace, store, run } = await fixture(t)
  run.mode = 'orbit'
  run.generateImages = true
  await store.save(run)
  let generated = 0
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
  const image = { generate: async (input) => {
    generated += 1
    const target = path.join(input.workspace, input.output)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, png)
    input.state.output = {
      path: target,
      relativePath: input.output,
      bytes: png.byteLength,
      sha256: '1b56b50ac4e976f488f128cabdcdffb2fc9331d6974bb9968131a415d14ade24',
      contentType: 'image/png',
      width: 1,
      height: 1,
      model: 'test',
      costUsd: 0.24,
    }
    await input.persist()
    return input.state.output
  } }
  const executor = new ToolExecutor({ workspace, store, run, api: {}, image })
  const first = call('generate_image', {
    prompt: 'First model wording for the target asset',
    output_path: 'assets/images/target.png',
    aspect_ratio: '1:1',
  })
  first.id = 'image-call-first'
  await executor.execute(first)
  const second = call('generate_image', {
    prompt: 'Different fallback model wording for the same target asset',
    output_path: 'assets/images/target.png',
    aspect_ratio: '1:1',
  })
  second.id = 'image-call-second'
  const reused = JSON.parse(await executor.execute(second))
  assert.equal(generated, 1)
  assert.equal(reused.reused, true)
  assert.equal(reused.relativePath, 'assets/images/target.png')
  assert.equal((await store.load(run.id)).assetImages['image-call-second'].reusedFromCallId, 'image-call-first')
})
