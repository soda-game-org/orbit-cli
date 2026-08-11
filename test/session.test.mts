import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { renderSessionHeader, runInteractiveSession } from '../src/session.mjs'

const baseConfig = {
  version: 1,
  mode: 'orbit',
  provider: 'openrouter',
  model: '',
  runtime: 'html',
  cloudLogs: false,
}

function outputStream() {
  const writes = []
  return {
    writes,
    stream: {
      isTTY: false,
      columns: 88,
      write: (value) => { writes.push(String(value)); return true },
    },
  }
}

test('session header keeps the active workspace and permissions visible', () => {
  const header = renderSessionHeader({
    config: baseConfig,
    workspace: '/opt/player/games/runner',
    home: '/opt/player',
    allowShell: true,
    generateImages: true,
    columns: 88,
    color: false,
  })
  assert.match(header, /Orbit v/)
  assert.match(header, /~\/games\/runner/)
  assert.match(header, /Orbit Cloud · DeepSeek V4 Pro/)
  assert.match(header, /shell on/)
  assert.match(header, /images on/)
  assert.match(header, /Ctrl\+C interrupts only the active run/)
  assert.doesNotMatch(header, /\u001b\[/)
})

test('session header leaves BYOK automatic model selection provider-owned', () => {
  const header = renderSessionHeader({
    config: { ...baseConfig, mode: 'byok' },
    workspace: '/opt/player/games/runner',
    color: false,
  })
  assert.match(header, /BYOK · openrouter · auto model/)
  assert.doesNotMatch(header, /DeepSeek V4 Pro/)
})

test('interactive session keeps accepting follow-up requests and prints summaries instead of JSON', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-session-'))
  t.after(() => fs.rm(cwd, { recursive: true, force: true }))
  const answers = ['/images on', 'Build a one-button runner', 'Make the obstacles faster', '/status', '/quit']
  const calls = []
  let config = { ...baseConfig }
  const app = {
    config: {
      get: async () => config,
      update: async (patch) => { config = { ...config, ...patch }; return config },
    },
    store: {
      list: async () => [],
      listThreads: async () => [],
      createThread: async () => ({ id: 'thread_11111111-1111-4111-8111-111111111111', title: 'New session', latestRunId: null }),
    },
    auth: { status: async () => ({ authenticated: true }) },
    manager: {
      create: async (input) => {
        calls.push(input)
        await input.onProgress({ runId: `run-${calls.length}`, type: 'tool_started', occurredAt: new Date().toISOString(), toolName: 'validate_project' })
        return {
          id: `run-${calls.length}`,
          state: 'completed',
          workspace: input.workspace,
          lastValidation: { ok: true, index: 'index.html' },
        }
      },
    },
  }
  const output = outputStream()

  assert.equal(await runInteractiveSession({
    app,
    cwd,
    home: '/tmp',
    stdout: output.stream,
    color: false,
    ask: async () => answers.shift(),
  }), 0)

  assert.equal(calls.length, 2)
  assert.equal(calls[0].prompt, 'Build a one-button runner')
  assert.equal(calls[0].operation, 'create')
  assert.equal(calls[1].prompt, 'Make the obstacles faster')
  assert.equal(calls[1].operation, 'edit')
  assert.equal(calls[0].generateImages, true)
  assert.equal(calls[1].generateImages, true)
  assert.equal(calls[0].threadId, calls[1].threadId)
  const rendered = output.writes.join('')
  assert.match(rendered, /✓ Game ready/)
  assert.match(rendered, /Session status/)
  assert.match(rendered, /last run\s+run-2/)
  assert.match(rendered, /Session closed/)
  assert.doesNotMatch(rendered, /"state":\s*"completed"/)
})

test('slash commands update persistent model settings and resume the latest checkpoint', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-session-resume-'))
  t.after(() => fs.rm(cwd, { recursive: true, force: true }))
  const answers = ['/mode byok', '/provider deepseek', '/model deepseek-chat', '/runtime phaser', '/permissions shell on', '/resume', '/quit']
  let config = { ...baseConfig }
  const checkpoint = {
    id: 'run_11111111-1111-4111-8111-111111111111',
    state: 'paused',
    workspace: cwd,
    mode: 'byok',
  }
  const resumes = []
  const app = {
    config: {
      get: async () => config,
      update: async (patch) => { config = { ...config, ...patch }; return config },
    },
    store: {
      list: async () => [checkpoint],
      listThreads: async () => [{ id: 'thread_22222222-2222-4222-8222-222222222222', title: 'Existing session', latestRunId: checkpoint.id }],
      linkForRun: async () => ({ threadId: 'thread_22222222-2222-4222-8222-222222222222' }),
    },
    auth: { status: async () => ({ authenticated: false }) },
    manager: {
      resume: async (id, options) => {
        resumes.push({ id, options })
        return { ...checkpoint, state: 'completed', lastValidation: { ok: true, index: 'index.html' } }
      },
    },
  }
  const output = outputStream()

  await runInteractiveSession({
    app,
    cwd,
    stdout: output.stream,
    color: false,
    ask: async () => answers.shift(),
  })

  assert.equal(config.mode, 'byok')
  assert.equal(config.provider, 'deepseek')
  assert.equal(config.model, 'deepseek-chat')
  assert.equal(config.runtime, 'phaser')
  assert.equal(resumes.length, 1)
  assert.equal(resumes[0].id, checkpoint.id)
  assert.equal(resumes[0].options.allowShell, true)
  assert.equal(typeof resumes[0].options.onProgress, 'function')
})
