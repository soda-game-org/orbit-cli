import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ORBIT_MANAGED_DEFAULT_MODEL,
  managedOrbitModelFromCatalog,
  orbitCodingModelDisplay,
} from '../src/model-display.mjs'

test('managed Orbit display follows the authenticated catalog default', () => {
  const model = managedOrbitModelFromCatalog({
    default: 'catalog-default',
    models: [
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'catalog-default', label: 'Catalog Default' },
    ],
  })
  assert.deepEqual(model, { id: 'catalog-default', label: 'Catalog Default' })
  assert.equal(orbitCodingModelDisplay('orbit', '', model), 'Catalog Default')
  assert.equal(orbitCodingModelDisplay('orbit', 'catalog-default', model), 'Catalog Default')
})

test('managed Orbit has a truthful DeepSeek V4 Pro fallback before catalog access', () => {
  assert.deepEqual(managedOrbitModelFromCatalog(null), ORBIT_MANAGED_DEFAULT_MODEL)
  assert.equal(orbitCodingModelDisplay('orbit', ''), 'DeepSeek V4 Pro')
})

test('BYOK keeps provider-owned automatic and explicit model semantics', () => {
  assert.equal(orbitCodingModelDisplay('byok', ''), 'auto model')
  assert.equal(orbitCodingModelDisplay('byok', 'deepseek-v4-pro'), 'deepseek-v4-pro')
  assert.equal(orbitCodingModelDisplay('byok', 'provider/model'), 'provider/model')
})
