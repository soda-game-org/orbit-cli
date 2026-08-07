const ACTIVE_STATES = new Set(['running', 'recovering'])
const AVAILABLE_STATES = new Set(['queued', 'paused', 'interrupted'])
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled'])

const ERROR_CATEGORIES = new Map<string, string>([
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

export const FAILURE_CATEGORIES = Object.freeze([
  'none',
  'process_interrupted',
  'unsafe_retry',
  'provider_unavailable',
  'content_filter',
  'no_progress',
  'iteration_limit',
  'operation_error',
  'cancelled',
  'terminal_failure',
  'unknown',
])

export const RECOVERY_DISPOSITIONS = Object.freeze([
  'in_progress',
  'available',
  'confirmation_required',
  'terminal',
  'unavailable',
])

/**
 * Derive presentation-only recovery metadata from an orbit.cli-run.v1
 * checkpoint. The checkpoint remains the source of truth and is never
 * mutated or migrated by this function.
 */
export function deriveRecoveryView(checkpoint: Partial<OrbitRun> | null | undefined): { failureCategory: string; recoveryDisposition: string } {
  const state = typeof checkpoint?.state === 'string' ? checkpoint.state : ''
  const unsafe = checkpoint?.unsafeResumeRequired === true
  const errorCode = typeof checkpoint?.lastError?.code === 'string'
    ? checkpoint.lastError.code
    : ''

  let failureCategory = 'none'
  if (state === 'completed') failureCategory = 'none'
  else if (state === 'cancelled') failureCategory = 'cancelled'
  else if (unsafe || errorCode === 'UNSAFE_RETRY_CONFIRMATION_REQUIRED') failureCategory = 'unsafe_retry'
  else if (ERROR_CATEGORIES.has(errorCode)) failureCategory = ERROR_CATEGORIES.get(errorCode)!
  else if (state === 'interrupted') failureCategory = 'process_interrupted'
  else if (state === 'failed') failureCategory = 'terminal_failure'
  else if (checkpoint?.lastError) failureCategory = 'unknown'
  else if (state === 'paused') failureCategory = 'unknown'

  let recoveryDisposition = 'unavailable'
  if (TERMINAL_STATES.has(state)) recoveryDisposition = 'terminal'
  else if (ACTIVE_STATES.has(state)) recoveryDisposition = 'in_progress'
  else if (AVAILABLE_STATES.has(state)) recoveryDisposition = unsafe || errorCode === 'UNSAFE_RETRY_CONFIRMATION_REQUIRED'
    ? 'confirmation_required'
    : 'available'

  return { failureCategory, recoveryDisposition }
}

export function withRecoveryView<T extends Partial<OrbitRun>>(checkpoint: T): T & { failureCategory: string; recoveryDisposition: string } {
  return { ...checkpoint, ...deriveRecoveryView(checkpoint) }
}
import type { OrbitRun } from './types.mjs'
