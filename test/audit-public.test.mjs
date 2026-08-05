import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

test('public release audit validates the final npm pack manifest', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/audit-public.mjs'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  assert.equal(stderr, '')
  assert.match(stdout, /Public release audit passed: \d+ packaged files/)
})
