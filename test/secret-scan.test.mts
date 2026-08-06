import assert from 'node:assert/strict'
import test from 'node:test'
import { findHighConfidenceSecrets, redactHighConfidenceSecrets, scanSecretBytes, secretLikeFileName } from '../src/secret-scan.mjs'

test('detects common high-confidence credential formats without returning their values', () => {
  const samples = [
    { value: ['ghp_', 'A'.repeat(32)].join(''), label: 'GitHub token' },
    { value: ['sk-proj-', 'B'.repeat(32)].join(''), label: 'provider secret' },
    { value: ['AKIA', 'C'.repeat(16)].join(''), label: 'AWS access key' },
    { value: ['AIza', 'D'.repeat(35)].join(''), label: 'Google API key' },
    { value: ['npm_', 'E'.repeat(24)].join(''), label: 'npm token' },
  ]
  for (const sample of samples) {
    const findings = findHighConfidenceSecrets(`value=${sample.value}`)
    assert.equal(findings.includes(sample.label), true)
    assert.equal(findings.includes(sample.value), false)
  }
})

test('detects assigned credentials but permits environment references and placeholders', () => {
  assert.deepEqual(findHighConfidenceSecrets(['api', 'Key = "a-real-looking-credential-value"'].join('')), ['assigned credential'])
  assert.deepEqual(findHighConfidenceSecrets('apiKey = process.env.PROVIDER_API_KEY'), [])
  assert.deepEqual(findHighConfidenceSecrets('clientSecret = "replace-me-before-deploying"'), [])
})

test('shares filename policy and skips binary payloads', () => {
  assert.equal(secretLikeFileName('.env.production'), true)
  assert.equal(secretLikeFileName('service-account-prod.json'), true)
  assert.equal(secretLikeFileName('config.js'), false)
  assert.deepEqual(scanSecretBytes(Buffer.from([0, 1, 2, 3])), [])
})

test('redacts detected values instead of returning them in diagnostics', () => {
  const token = ['gho_', 'F'.repeat(32)].join('')
  const assigned = ['api', 'Key = "a-real-looking-credential-value"'].join('')
  const redacted = redactHighConfidenceSecrets(`request failed for ${token}; ${assigned}`)
  assert.doesNotMatch(redacted, new RegExp(token))
  assert.doesNotMatch(redacted, /a-real-looking-credential-value/)
  assert.match(redacted, /redacted-github-token/)
  assert.match(redacted, /redacted-assigned-credential/)
})
