import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { VERSION } from '../src/constants.mjs'

const execFileAsync = promisify(execFile)
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

test('compiled CLI starts through the symbolic link shape used by npm bins', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-cli-bin-'))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const entrypoint = path.join(temporary, 'orbit')
  await fs.symlink(path.join(root, 'dist', 'src', 'cli.mjs'), entrypoint)

  const { stdout, stderr } = await execFileAsync(process.execPath, [entrypoint, '--version'], {
    cwd: temporary,
    encoding: 'utf8',
  })
  assert.equal(stderr, '')
  assert.equal(stdout.trim(), VERSION)
})
