import assert from 'node:assert/strict'
import test from 'node:test'
import { checkForCliUpdate, compareSemanticVersions } from '../src/update-check.mjs'

test('compares release and prerelease versions using SemVer precedence', () => {
  assert.equal(compareSemanticVersions('0.2.2', '0.2.1'), 1)
  assert.equal(compareSemanticVersions('1.0.0', '1.0.0-beta.9'), 1)
  assert.equal(compareSemanticVersions('1.0.0-beta.10', '1.0.0-beta.9'), 1)
  assert.equal(compareSemanticVersions('0.2.1', '0.2.1'), 0)
  assert.equal(compareSemanticVersions('invalid', '0.2.1'), 0)
})

test('returns an explicit npm upgrade when the trusted package has a newer version', async () => {
  const update = await checkForCliUpdate({
    currentVersion: '0.2.1',
    fetchImpl: async (input) => {
      assert.equal(String(input), 'https://registry.npmjs.org/@soda_game%2Forbit-cli/latest')
      return new Response(JSON.stringify({ name: '@soda_game/orbit-cli', version: '0.3.0' }))
    },
  })
  assert.deepEqual(update, {
    currentVersion: '0.2.1',
    latestVersion: '0.3.0',
    command: 'npm install -g @soda_game/orbit-cli@latest',
  })
})

test('stays silent for current, invalid, untrusted, or unavailable registry metadata', async () => {
  for (const body of [
    { name: '@soda_game/orbit-cli', version: '0.2.1' },
    { name: '@soda_game/orbit-cli', version: 'not-semver' },
    { name: '@attacker/orbit-cli', version: '9.0.0' },
  ]) {
    assert.equal(await checkForCliUpdate({
      currentVersion: '0.2.1',
      fetchImpl: async () => new Response(JSON.stringify(body)),
    }), null)
  }
  assert.equal(await checkForCliUpdate({
    currentVersion: '0.2.1',
    fetchImpl: async () => { throw new Error('offline') },
  }), null)
})
