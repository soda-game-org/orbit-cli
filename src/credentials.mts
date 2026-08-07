import { Entry } from '@napi-rs/keyring'
import { PROVIDER_IDS } from './constants.mjs'
import type { OrbitProviderId } from '../packages/orbit-provider-core/index.mjs'

const SERVICE = 'com.orbit-arcade.cli'

/**
 * Secrets are stored only in the operating-system credential vault through
 * macOS Keychain, Windows Credential Manager, or the Linux Secret Service.
 * There is intentionally no plaintext file fallback.
 */
export class CredentialStore {
  readonly entryFactory: (service: string, account: string) => Entry

  constructor({ entryFactory = (service, account) => new Entry(service, account) }: { entryFactory?: (service: string, account: string) => Entry } = {}) {
    this.entryFactory = entryFactory
  }

  async set(account: string, secret: string): Promise<void> {
    validateAccount(account)
    if (typeof secret !== 'string' || !secret.trim() || secret.length > 64 * 1024) {
      throw new TypeError('Credential is invalid')
    }
    try {
      await this.entryFactory(SERVICE, account).setPassword(secret)
    } catch {
      throw new Error('The operating-system credential store is unavailable; no secret was saved')
    }
  }

  async get(account: string): Promise<string | null> {
    validateAccount(account)
    try {
      const value = await this.entryFactory(SERVICE, account).getPassword()
      return typeof value === 'string' && value ? value : null
    } catch {
      return null
    }
  }

  async delete(account: string): Promise<void> {
    validateAccount(account)
    try {
      await this.entryFactory(SERVICE, account).deletePassword()
    } catch {
      // Deleting a missing credential is idempotent.
    }
  }
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
