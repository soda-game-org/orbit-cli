import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
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
  assert.match(stdout, /Public release audit passed: the checkout, reachable Git history and \d+ packaged files/)
})

test('public release audit rejects a credential removed from the current tree but retained in reachable history', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-audit-history-'))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const checkout = path.join(temporary, 'repo')
  await fs.cp(root, checkout, {
    recursive: true,
    filter: (source) => !['.git', 'node_modules', '.orbit-e2e'].includes(path.relative(root, source).split(path.sep)[0]),
  })
  const git = (...args) => execFileAsync('git', args, { cwd: checkout, encoding: 'utf8' })
  await git('init', '--initial-branch=main')
  await git('config', 'user.name', 'Orbit Audit Test')
  await git('config', 'user.email', 'audit@example.invalid')
  await git('config', 'commit.gpgsign', 'false')
  await git('add', '-A')
  await git('commit', '-m', 'safe baseline')
  const token = ['sk-proj-', 'Z'.repeat(32)].join('')
  await fs.writeFile(path.join(checkout, 'legacy.txt'), token)
  await git('add', 'legacy.txt')
  await git('commit', '-m', 'temporary credential')
  await fs.rm(path.join(checkout, 'legacy.txt'))
  await git('add', '-A')
  await git('commit', '-m', 'remove credential')
  await assert.rejects(execFileAsync(process.execPath, ['scripts/audit-public.mjs'], {
    cwd: checkout,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  }), (error) => {
    assert.match(error.stderr, /git history legacy\.txt: provider secret/)
    assert.doesNotMatch(error.stderr, new RegExp(token))
    return true
  })
})
