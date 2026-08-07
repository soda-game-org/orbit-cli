import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

const execute = promisify(execFile)

test('an awaited polling sleep keeps a standalone CLI process alive', async () => {
  const moduleUrl = new URL('../dist/src/util.mjs', import.meta.url).href
  const script = `import(${JSON.stringify(moduleUrl)}).then(({ sleep }) => sleep(25).then(() => process.stdout.write('done')))`
  const { stdout } = await execute(process.execPath, ['--input-type=module', '--eval', script])
  assert.equal(stdout, 'done')
})
