import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FAILURE_CATEGORIES,
  RECOVERY_DISPOSITIONS,
  deriveRecoveryView,
  withRecoveryView,
} from '../src/recovery-view.mjs'

test('derives a recovery disposition for every v1 checkpoint state', () => {
  const expected = new Map([
    ['queued', 'available'],
    ['running', 'in_progress'],
    ['recovering', 'in_progress'],
    ['interrupted', 'available'],
    ['paused', 'available'],
    ['completed', 'terminal'],
    ['failed', 'terminal'],
    ['cancelled', 'terminal'],
  ])

  for (const [state, recoveryDisposition] of expected) {
    const view = deriveRecoveryView({ state, lastError: null, unsafeResumeRequired: false })
    assert.equal(view.recoveryDisposition, recoveryDisposition, state)
    assert.ok(FAILURE_CATEGORIES.includes(view.failureCategory), state)
    assert.ok(RECOVERY_DISPOSITIONS.includes(view.recoveryDisposition), state)
  }
})

test('requires confirmation only for resumable checkpoints with unsafe work', () => {
  for (const state of ['queued', 'paused', 'interrupted']) {
    assert.deepEqual(
      deriveRecoveryView({ state, unsafeResumeRequired: true, lastError: null }),
      { failureCategory: 'unsafe_retry', recoveryDisposition: 'confirmation_required' },
      state,
    )
  }

  assert.equal(deriveRecoveryView({ state: 'running', unsafeResumeRequired: true }).recoveryDisposition, 'in_progress')
  assert.equal(deriveRecoveryView({ state: 'completed', unsafeResumeRequired: true }).recoveryDisposition, 'terminal')
})

test('classifies known v1 error codes without inspecting error messages', () => {
  const categories = new Map([
    ['LOCAL_PROCESS_INTERRUPTED', 'process_interrupted'],
    ['UNSAFE_RETRY_CONFIRMATION_REQUIRED', 'unsafe_retry'],
    ['MODEL_PROVIDER_FALLBACK_READY', 'provider_unavailable'],
    ['MODEL_CONTENT_FILTER_FALLBACK_READY', 'content_filter'],
    ['AGENT_NO_TOOL_PROGRESS', 'no_progress'],
    ['ITERATION_BUDGET_PAUSED', 'iteration_limit'],
    ['RUN_PAUSED', 'operation_error'],
    ['ASSET_IMAGE_PAUSED', 'operation_error'],
    ['ASSET_3D_PAUSED', 'operation_error'],
  ])

  for (const [code, failureCategory] of categories) {
    const view = deriveRecoveryView({
      state: code === 'LOCAL_PROCESS_INTERRUPTED' ? 'interrupted' : 'paused',
      unsafeResumeRequired: false,
      lastError: { code, message: 'This text is intentionally irrelevant.' },
    })
    assert.equal(view.failureCategory, failureCategory, code)
    assert.equal(
      view.recoveryDisposition,
      code === 'UNSAFE_RETRY_CONFIRMATION_REQUIRED' ? 'confirmation_required' : 'available',
      code,
    )
  }
})

test('falls back conservatively for incomplete, terminal, and future checkpoints', () => {
  assert.deepEqual(
    deriveRecoveryView({ state: 'interrupted', unsafeResumeRequired: false }),
    { failureCategory: 'process_interrupted', recoveryDisposition: 'available' },
  )
  assert.deepEqual(
    deriveRecoveryView({ state: 'paused', lastError: { code: 'FUTURE_ERROR', message: 'future' } }),
    { failureCategory: 'unknown', recoveryDisposition: 'available' },
  )
  assert.deepEqual(
    deriveRecoveryView({ state: 'failed', lastError: { code: 'FUTURE_ERROR' } }),
    { failureCategory: 'terminal_failure', recoveryDisposition: 'terminal' },
  )
  assert.deepEqual(
    deriveRecoveryView({ state: 'cancelled' }),
    { failureCategory: 'cancelled', recoveryDisposition: 'terminal' },
  )
  assert.deepEqual(
    deriveRecoveryView({ state: 'future_state', lastError: { code: 'FUTURE_ERROR' } }),
    { failureCategory: 'unknown', recoveryDisposition: 'unavailable' },
  )
})

test('creates a derived view without mutating or trusting presentation fields on the checkpoint', () => {
  const checkpoint = {
    schema: 'orbit.cli-run.v1',
    state: 'paused',
    unsafeResumeRequired: false,
    lastError: { code: 'AGENT_NO_TOOL_PROGRESS', message: 'paused' },
    failureCategory: 'forged',
    recoveryDisposition: 'terminal',
  }
  const before = structuredClone(checkpoint)

  const view = withRecoveryView(checkpoint)

  assert.deepEqual(checkpoint, before)
  assert.notEqual(view, checkpoint)
  assert.equal(view.schema, 'orbit.cli-run.v1')
  assert.equal(view.failureCategory, 'no_progress')
  assert.equal(view.recoveryDisposition, 'available')
})
