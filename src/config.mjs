import path from 'node:path'
import { appDirectories, readJson, writeJsonAtomic } from './util.mjs'
import { CODING_PROVIDER_IDS } from './constants.mjs'

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  mode: 'orbit',
  provider: 'openrouter',
  model: '',
  runtime: 'html',
  cloudLogs: false,
})

export class ConfigStore {
  constructor({ directories = appDirectories() } = {}) {
    this.directories = directories
    this.file = path.join(directories.config, 'config.json')
  }

  async get() {
    const raw = await readJson(this.file, {})
    return normalizeConfig({ ...DEFAULT_CONFIG, ...(raw || {}) })
  }

  async update(patch) {
    const next = normalizeConfig({ ...(await this.get()), ...patch, version: 1 })
    await writeJsonAtomic(this.file, next)
    return next
  }
}

function normalizeConfig(value) {
  const mode = value.mode === 'byok' ? 'byok' : 'orbit'
  const provider = CODING_PROVIDER_IDS.includes(value.provider)
    ? value.provider
    : 'openrouter'
  const runtime = ['html', 'vanilla-ts', 'react-vite', 'react-three-fiber', 'three-vanilla', 'phaser'].includes(value.runtime)
    ? value.runtime
    : 'html'
  return {
    version: 1,
    mode,
    provider,
    model: typeof value.model === 'string' ? value.model.slice(0, 120) : '',
    runtime,
    cloudLogs: value.cloudLogs === true,
  }
}
