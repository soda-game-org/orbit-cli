import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { VERSION } from '../src/constants.mjs'

const require = createRequire(import.meta.url)

test('CLI version follows the package release version', () => {
  assert.equal(VERSION, require('../package.json').version)
})
