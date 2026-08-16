import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeRunDelta } from '../src/web/state.mjs'

test('merges run responses into one thread without replacing its existing history', () => {
  const state = {
    runs: [{ id: 'run_old', state: 'completed', displayName: 'Old title' }],
    threads: [{
      id: 'thread_1', title: 'Existing task', workspace: '/tmp/game',
      runIds: ['run_old'], latestRunId: 'run_old', createdAt: '2026-01-01T00:00:00.000Z',
    }],
    config: { mode: 'orbit' },
  }
  const merged = mergeRunDelta(state, {
    run: { id: 'run_new', state: 'completed', workspace: '/tmp/game' },
    thread: {
      id: 'thread_1', title: 'Existing task', workspace: '/tmp/game',
      runIds: ['run_new'], latestRunId: 'run_new', createdAt: '2026-02-01T00:00:00.000Z',
    },
  })

  assert.deepEqual(merged.threads[0].runIds, ['run_old', 'run_new'])
  assert.equal(merged.threads[0].latestRunId, 'run_new')
  assert.equal(merged.threads[0].createdAt, '2026-01-01T00:00:00.000Z')
  assert.deepEqual(merged.runs.map((run) => run.id), ['run_new', 'run_old'])
  assert.deepEqual(merged.config, state.config)
})

test('updates an existing run from a resume delta without duplicating it', () => {
  const state = {
    runs: [{ id: 'run_1', state: 'interrupted', prompt: 'Keep me' }],
    threads: [{ id: 'thread_1', runIds: ['run_1'], latestRunId: 'run_1' }],
  }
  const merged = mergeRunDelta(state, {
    run: { id: 'run_1', state: 'completed' },
    thread: { id: 'thread_1', runIds: ['run_1'], latestRunId: 'run_1' },
  })

  assert.equal(merged.runs.length, 1)
  assert.deepEqual(merged.runs[0], { id: 'run_1', state: 'completed', prompt: 'Keep me' })
  assert.deepEqual(merged.threads[0].runIds, ['run_1'])
})
