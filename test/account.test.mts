import assert from 'node:assert/strict'
import test from 'node:test'
import { OrbitAccount } from '../src/account.mjs'

function catalog(balance, allowed = true) {
  return {
    contract_version: 1,
    web_billing_url: 'https://orbit-arcade.com/settings/billing?source=orbit-engine',
    cade: { balance, next_expiration: null },
    subscription: null,
    admission: { create: { allowed } },
  }
}

test('returns the authenticated Cade balance and low-balance warning state', async () => {
  const account = new OrbitAccount(
    { status: async () => ({ signedIn: true, userId: 'user-1', email: 'user@example.com' }) },
    () => ({ billingCatalog: async () => catalog(12) }),
  )
  assert.deepEqual(await account.status(), {
    signedIn: true,
    userId: 'user-1',
    email: 'user@example.com',
    cadeBalance: 12,
    cadeBalanceState: 'low',
    nextExpiration: null,
    hasActiveSubscription: false,
    billingUrl: 'https://orbit-arcade.com/settings/billing?source=orbit-engine',
  })
})

test('does not confuse an unavailable balance with zero', async () => {
  const account = new OrbitAccount(
    { status: async () => ({ signedIn: true, userId: 'user-1' }) },
    () => ({ billingCatalog: async () => { throw new Error('offline') } }),
  )
  const result = await account.status()
  assert.equal(result.signedIn, true)
  assert.equal(result.cadeBalance, null)
  assert.equal(result.cadeBalanceState, 'unavailable')
})

test('rejects a non-Orbit billing destination', async () => {
  const account = new OrbitAccount(
    { status: async () => ({ signedIn: true }) },
    () => ({ billingCatalog: async () => ({ ...catalog(50), web_billing_url: 'https://attacker.invalid/pay' }) }),
  )
  assert.equal((await account.status()).billingUrl, null)
})
