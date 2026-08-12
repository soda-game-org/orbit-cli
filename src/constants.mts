import { CODING_PROVIDER_IDS, PROVIDER_IDS, PROVIDERS } from '@soda_game/orbit-provider-core'
import {
  ORBIT_AGENT_EXECUTION_POLICY,
  ORBIT_AGENT_MODEL_OUTPUT_LIMITS,
} from '@soda_game/orbit-agent-core'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageJson = [
  new URL('../package.json', import.meta.url),
  new URL('../../package.json', import.meta.url),
].find((candidate) => existsSync(candidate))

if (!packageJson) throw new Error('Orbit CLI package metadata is missing')

export const VERSION = String(require(fileURLToPath(packageJson)).version)
export const API_ORIGIN = 'https://api.orbit-spaces.com'
export const WEB_ORIGIN = 'https://orbit-arcade.com'
export const SUPABASE_URL = 'https://tidzpggdiaaweoasskqe.supabase.co'
// Supabase publishable/anon keys are public client identifiers, never service credentials.
export const SUPABASE_PUBLISHABLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpZHpwZ2dkaWFhd2VvYXNza3FlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1OTM1NDYsImV4cCI6MjA4NzE2OTU0Nn0.ws3Kq2EzO_z8g3SFXX0rbgtwtTBNPXsyoQ5vyooMbqI'

export const RUN_SCHEMA = 'orbit.cli-run.v1'
export const CLOUD_LOG_SCHEMA = 'orbit.cli-log.v1'
export const ENGINE_CONTRACT_VERSION = 1
export const ENGINE_LLM_CONTRACT_VERSION = 2
export const ENGINE_AGENT_CONTEXT_SCHEMA = 'orbit.engine-agent-context.v1'

export const MAX_REFERENCE_IMAGES = 8
export const MAX_REFERENCE_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_REFERENCE_IMAGE_BYTES_TOTAL = 16 * 1024 * 1024
export const MAX_CLOUD_LOG_QUEUE = 2_000
export const MAX_TOOL_OUTPUT_CHARS = ORBIT_AGENT_EXECUTION_POLICY.maxToolOutputChars
export const MAX_AGENT_ITERATIONS = ORBIT_AGENT_EXECUTION_POLICY.maxIterations
export const MODEL_OUTPUT_TOKENS = ORBIT_AGENT_MODEL_OUTPUT_LIMITS.agent

export { PROVIDERS, PROVIDER_IDS, CODING_PROVIDER_IDS }

export const CLIENT_SOURCES = new Set(['cli', 'cli_gui'])
export const RUNTIMES = new Set([
  'auto', 'html', 'vanilla-ts', 'react-vite', 'react-three-fiber', 'three-vanilla', 'phaser',
])
