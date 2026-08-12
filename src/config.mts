import path from 'node:path'
import { appDirectories, readJson, writeJsonAtomic, type AppDirectories, type JsonRecord } from './util.mjs'
import { CODING_PROVIDER_IDS } from './constants.mjs'
import type { OrbitCliConfig } from './types.mjs'

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  mode: 'orbit',
  provider: 'openrouter',
  model: '',
  runtime: 'auto',
  cloudLogs: false,
})

export class ConfigStore {
  readonly directories: AppDirectories
  readonly file: string

  constructor({ directories = appDirectories() }: { directories?: AppDirectories } = {}) {
    this.directories = directories
    this.file = path.join(directories.config, 'config.json')
  }

  async get(): Promise<OrbitCliConfig> {
    const raw = await readJson<JsonRecord>(this.file, {})
    return normalizeConfig({ ...DEFAULT_CONFIG, ...(raw || {}) })
  }

  async update(patch: Partial<OrbitCliConfig>): Promise<OrbitCliConfig> {
    const next = normalizeConfig({ ...(await this.get()), ...patch, version: 1 })
    await writeJsonAtomic(this.file, next)
    return next
  }
}

function normalizeConfig(value: JsonRecord): OrbitCliConfig {
  const mode = value.mode === 'byok' ? 'byok' : 'orbit'
  const provider = CODING_PROVIDER_IDS.includes(value.provider as OrbitCliConfig['provider'])
    ? value.provider as OrbitCliConfig['provider']
    : 'openrouter'
  const runtime = ['auto', 'html', 'vanilla-ts', 'react-vite', 'react-three-fiber', 'three-vanilla', 'phaser'].includes(value.runtime)
    ? value.runtime
    : 'auto'
  return {
    version: 1,
    mode,
    provider,
    model: typeof value.model === 'string' ? value.model.slice(0, 120) : '',
    runtime,
    cloudLogs: value.cloudLogs === true,
  }
}
