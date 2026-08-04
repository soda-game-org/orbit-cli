import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RunManager } from '../src/run-manager.mjs'
import { RunStore } from '../src/run-store.mjs'

const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

test('CLI GUI and terminal share the checkpointed agent loop through completion', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  let calls = 0
  const manager = new RunManager({
    store,
    config: { get: async () => ({ mode: 'byok', provider: 'openrouter', model: 'test-model', runtime: 'html', cloudLogs: false }) },
    credentials: { get: async () => 'configured' },
    auth: {}, apiFactory: () => { throw new Error('Official API must not be used in this BYOK test') },
    byok: { complete: async () => {
      calls += 1
      return { role: 'assistant', content: '', reasoning_content: 'provider reasoning', response_items: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }], tool_calls: [
        tool('1', 'update_agent_plan', { summary: 'Build', todos: [{ id: 'build', title: 'Build game', status: 'in_progress', kind: 'code' }] }),
        tool('2', 'write_file', { path: 'index.html', content: '<!doctype html><meta name="viewport" content="width=device-width"><button>Leaderboard</button><script src="game.js"></script>' }),
        tool('3', 'write_file', { path: 'game.js', content: 'OrbitArcade.startGame(); function finish(){ OrbitArcade.endGame({score:1}) }' }),
        tool('4', 'validate_project', {}),
        tool('5', 'finish', {}),
      ] }
    } },
    threeD: {}, cloudLogs: null,
  })
  const run = await manager.create({
    source: 'cli_gui', workspace, prompt: 'Build a test arcade game', mode: 'byok', provider: 'openrouter', model: 'test-model', runtime: 'html',
  })
  assert.equal(calls, 1)
  assert.equal(run.source, 'cli_gui')
  assert.equal(run.state, 'completed')
  assert.equal(run.lastValidation.ok, true)
  const checkpoint = await store.load(run.id)
  assert.equal(checkpoint.state, 'completed')
  const assistantCheckpoint = checkpoint.messages.find((message) => message.role === 'assistant')
  assert.equal(assistantCheckpoint.reasoning_content, 'provider reasoning')
  assert.deepEqual(assistantCheckpoint.response_items, [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }])
  assert.match(await fs.readFile(path.join(workspace, 'game.js'), 'utf8'), /endGame/)
})

test('repeated no-tool responses pause with a resumable checkpoint instead of failing', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-manager-pause-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const store = new RunStore({ directories: { config: path.join(root, 'config'), data: path.join(root, 'data') } })
  const manager = new RunManager({
    store,
    config: { get: async () => ({ mode: 'byok', provider: 'openrouter', model: 'test-model', runtime: 'html', cloudLogs: false }) },
    credentials: { get: async () => 'configured' }, auth: {}, apiFactory: () => ({}),
    byok: { complete: async () => ({ role: 'assistant', content: 'thinking' }) }, threeD: {}, cloudLogs: null,
  })
  const run = await manager.create({ workspace, prompt: 'Build a game', mode: 'byok', provider: 'openrouter', model: 'test-model', runtime: 'html' })
  assert.equal(run.state, 'paused')
  assert.equal(run.lastError.code, 'AGENT_NO_TOOL_PROGRESS')
  assert.equal(run.finishedAt, null)
})
