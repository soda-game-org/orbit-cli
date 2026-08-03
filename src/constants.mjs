export const VERSION = '0.1.0'
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
export const MAX_TOOL_OUTPUT_CHARS = 48_000
export const MAX_AGENT_ITERATIONS = 96
export const MODEL_OUTPUT_TOKENS = 16_000

export const PROVIDERS = Object.freeze({
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/free',
    vision: true,
  },
  zai: {
    label: 'Z.AI',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-5.2',
    vision: false,
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    vision: false,
  },
  ark: {
    label: 'Volcengine Ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-2-1-pro-260628',
    vision: false,
  },
  replicate: {
    label: 'Replicate',
    baseUrl: 'https://api.replicate.com/v1',
    defaultModel: 'tencent/hunyuan-3d-3.1',
    vision: false,
  },
})

export const CLIENT_SOURCES = new Set(['cli', 'cli_gui'])
export const RUNTIMES = new Set([
  'html', 'vanilla-ts', 'react-vite', 'react-three-fiber', 'three-vanilla', 'phaser',
])
