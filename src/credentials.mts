import { Entry } from '@napi-rs/keyring'
import { createHash, randomBytes } from 'node:crypto'
import { PROVIDER_IDS } from './constants.mjs'
import type { OrbitProviderId } from '../packages/orbit-provider-core/index.mjs'

const SERVICE = 'com.orbit-arcade.cli'
const CHUNK_SCHEMA = 'orbit-cli-keyring-chunks.v1'
const CHUNK_PREFIX = `${CHUNK_SCHEMA}:`
// Windows Credential Manager limits a generic credential blob to 2560 bytes.
// 1024 ASCII characters stays below that limit even for conservative native
// bridges that temporarily widen strings while marshalling them.
const CHUNK_CHARACTERS = 1024
const MAX_PARTS = 128

type KeyringEntry = Pick<Entry, 'setPassword' | 'getPassword' | 'deletePassword'>

interface ChunkManifest {
  schema: typeof CHUNK_SCHEMA
  generation: string
  parts: number
  bytes: number
  sha256: string
}

/**
 * Secrets are stored only in the operating-system credential vault through
 * macOS Keychain, Windows Credential Manager, or the Linux Secret Service.
 * There is intentionally no plaintext file fallback.
 */
export class CredentialStore {
  readonly entryFactory: (service: string, account: string) => KeyringEntry

  constructor({ entryFactory = (service, account) => new Entry(service, account) }: { entryFactory?: (service: string, account: string) => KeyringEntry } = {}) {
    this.entryFactory = entryFactory
  }

  async set(account: string, secret: string): Promise<void> {
    validateAccount(account)
    if (typeof secret !== 'string' || !secret.trim() || secret.length > 64 * 1024) {
      throw new TypeError('Credential is invalid')
    }
    const previous = await this.#raw(account)
    const encoded = Buffer.from(secret, 'utf8').toString('base64')
    if (encoded.length <= CHUNK_CHARACTERS) {
      try {
        await this.entryFactory(SERVICE, account).setPassword(secret)
        await this.#deleteManifestParts(account, parseManifest(previous))
        return
      } catch {
        throw new Error('The operating-system credential store is unavailable; no secret was saved')
      }
    }

    const parts = encoded.match(new RegExp(`.{1,${CHUNK_CHARACTERS}}`, 'g')) || []
    if (!parts.length || parts.length > MAX_PARTS) throw new TypeError('Credential is too large')
    const generation = randomBytes(12).toString('hex')
    const written: string[] = []
    const manifest: ChunkManifest = {
      schema: CHUNK_SCHEMA,
      generation,
      parts: parts.length,
      bytes: Buffer.byteLength(secret, 'utf8'),
      sha256: createHash('sha256').update(secret, 'utf8').digest('hex'),
    }
    try {
      for (const [index, part] of parts.entries()) {
        const partAccount = chunkAccount(account, generation, index)
        await this.entryFactory(SERVICE, partAccount).setPassword(part)
        written.push(partAccount)
      }
      // The manifest is the commit point. Readers either observe the complete
      // previous generation or the complete new generation.
      await this.entryFactory(SERVICE, account).setPassword(`${CHUNK_PREFIX}${JSON.stringify(manifest)}`)
      await this.#deleteManifestParts(account, parseManifest(previous))
    } catch {
      await Promise.all(written.map((partAccount) => this.#deleteRaw(partAccount)))
      throw new Error('The operating-system credential store is unavailable; no secret was saved')
    }
  }

  async get(account: string): Promise<string | null> {
    validateAccount(account)
    const value = await this.#raw(account)
    const manifest = parseManifest(value)
    if (!manifest) return value?.startsWith(CHUNK_PREFIX) ? null : value
    try {
      const parts = await Promise.all(Array.from({ length: manifest.parts }, async (_, index) => {
        const part = await this.#raw(chunkAccount(account, manifest.generation, index))
        if (!part) throw new Error('Credential part is missing')
        return part
      }))
      const decoded = Buffer.from(parts.join(''), 'base64')
      if (decoded.byteLength !== manifest.bytes
        || createHash('sha256').update(decoded).digest('hex') !== manifest.sha256) return null
      return decoded.toString('utf8')
    } catch {
      return null
    }
  }

  async delete(account: string): Promise<void> {
    validateAccount(account)
    const manifest = parseManifest(await this.#raw(account))
    await this.#deleteRaw(account)
    await this.#deleteManifestParts(account, manifest)
  }

  async #raw(account: string): Promise<string | null> {
    try {
      const value = await this.entryFactory(SERVICE, account).getPassword()
      return typeof value === 'string' && value ? value : null
    } catch {
      return null
    }
  }

  async #deleteRaw(account: string): Promise<void> {
    try {
      await this.entryFactory(SERVICE, account).deletePassword()
    } catch {
      // Deleting a missing credential is idempotent.
    }
  }

  async #deleteManifestParts(account: string, manifest: ChunkManifest | null): Promise<void> {
    if (!manifest) return
    await Promise.all(Array.from({ length: manifest.parts }, (_, index) => (
      this.#deleteRaw(chunkAccount(account, manifest.generation, index))
    )))
  }
}

function parseManifest(value: string | null): ChunkManifest | null {
  if (!value?.startsWith(CHUNK_PREFIX)) return null
  try {
    const parsed = JSON.parse(value.slice(CHUNK_PREFIX.length)) as Partial<ChunkManifest>
    if (parsed.schema !== CHUNK_SCHEMA
      || !/^[a-f0-9]{24}$/.test(String(parsed.generation || ''))
      || !Number.isSafeInteger(parsed.parts) || Number(parsed.parts) < 2 || Number(parsed.parts) > MAX_PARTS
      || !Number.isSafeInteger(parsed.bytes) || Number(parsed.bytes) < 1 || Number(parsed.bytes) > 64 * 1024
      || !/^[a-f0-9]{64}$/.test(String(parsed.sha256 || ''))) return null
    return parsed as ChunkManifest
  } catch {
    return null
  }
}

function chunkAccount(account: string, generation: string, index: number): string {
  const value = `${account}:part:${generation}:${index}`
  validateAccount(value)
  return value
}

function validateAccount(account: string): void {
  if (!/^[a-z0-9._:-]{1,120}$/i.test(account)) throw new TypeError('Credential account is invalid')
}

export function providerCredentialAccount(provider: OrbitProviderId): string {
  if (!PROVIDER_IDS.includes(provider)) {
    throw new TypeError('Unsupported provider')
  }
  return `provider:${provider}`
}
