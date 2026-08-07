import assert from 'node:assert/strict'
import test from 'node:test'
import { CredentialStore } from '../src/credentials.mjs'

class MemoryEntry {
  constructor(readonly values, readonly account, readonly maximum = Infinity) {}
  setPassword(value) {
    if (Buffer.byteLength(value, 'utf8') > this.maximum) throw new Error('blob too large')
    this.values.set(this.account, value)
  }
  getPassword() { return this.values.get(this.account) || null }
  deletePassword() { return this.values.delete(this.account) }
}

function fixture(maximum = Infinity) {
  const values = new Map()
  const store = new CredentialStore({
    entryFactory: (_service, account) => new MemoryEntry(values, account, maximum),
  })
  return { store, values }
}

test('round-trips short credentials in one operating-system entry', async () => {
  const { store, values } = fixture(2_560)
  await store.set('provider:test', 'short-secret')
  assert.equal(await store.get('provider:test'), 'short-secret')
  assert.equal(values.size, 1)
})

test('chunks a large OAuth session below the Windows Credential Manager limit', async () => {
  const { store, values } = fixture(2_560)
  const session = JSON.stringify({ access_token: 'a'.repeat(3_400), refresh_token: 'r'.repeat(800) })
  await store.set('orbit-session', session)
  assert.equal(await store.get('orbit-session'), session)
  assert.ok(values.size > 2)
  assert.ok([...values.values()].every((value) => Buffer.byteLength(value, 'utf8') <= 2_560))

  await store.delete('orbit-session')
  assert.equal(values.size, 0)
})

test('commits a replacement generation and removes the previous chunks', async () => {
  const { store, values } = fixture(2_560)
  await store.set('orbit-session', 'first'.repeat(900))
  const oldAccounts = new Set(values.keys())
  await store.set('orbit-session', 'second'.repeat(850))
  assert.equal(await store.get('orbit-session'), 'second'.repeat(850))
  assert.ok([...oldAccounts].filter((key) => key !== 'orbit-session').every((key) => !values.has(key)))
})
