import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkForCliUpdate,
  compareSemanticVersions,
  enforceLatestCli,
  shouldSkipCliUpdate,
} from '../src/update-check.mjs'

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

test('automatically installs the required update and restarts the original command', async () => {
  const commands: Array<{ command: string; arguments_: string[]; env?: NodeJS.ProcessEnv }> = []
  const output: string[] = []
  const result = await enforceLatestCli({
    argv: ['web', '--no-open'],
    currentVersion: '0.2.1',
    platform: 'linux',
    execPath: '/test/bin/node',
    entrypoint: '/test/lib/orbit-cli/dist/src/cli.mjs',
    env: { PATH: '/test/bin' },
    stdout: { write: (value) => { output.push(String(value)); return true } },
    stderr: { write: (value) => { output.push(String(value)); return true } },
    fetchImpl: async () => new Response(JSON.stringify({ name: '@soda_game/orbit-cli', version: '0.3.0' })),
    runCommand: async (command, arguments_, options) => {
      commands.push({ command, arguments_, env: options.env })
      return 0
    },
  })

  assert.equal(result.action, 'restarted')
  assert.deepEqual(commands.map(({ command, arguments_ }) => ({ command, arguments_ })), [
    { command: 'npm', arguments_: ['install', '--global', '@soda_game/orbit-cli@latest'] },
    { command: '/test/bin/node', arguments_: ['/test/lib/orbit-cli/dist/src/cli.mjs', 'web', '--no-open'] },
  ])
  assert.equal(commands[1]?.env?.ORBIT_CLI_AUTO_UPDATED_TO, '0.3.0')
  assert.match(output.join(''), /must update before continuing/)
  assert.match(output.join(''), /Restarting Orbit CLI/)
})

test('blocks the old CLI when automatic installation fails', async () => {
  const output: string[] = []
  const result = await enforceLatestCli({
    currentVersion: '0.2.1',
    stderr: { write: (value) => { output.push(String(value)); return true } },
    stdout: { write: (value) => { output.push(String(value)); return true } },
    fetchImpl: async () => new Response(JSON.stringify({ name: '@soda_game/orbit-cli', version: '0.3.0' })),
    runCommand: async () => 1,
  })
  assert.equal(result.action, 'blocked')
  assert.equal(result.exitCode, 1)
  assert.match(output.join(''), /could not update automatically/)
  assert.match(output.join(''), /npm install -g @soda_game\/orbit-cli@latest/)
})

test('prevents an automatic-update restart loop and keeps diagnostics available', async () => {
  let commandRuns = 0
  const result = await enforceLatestCli({
    currentVersion: '0.2.1',
    env: { ORBIT_CLI_AUTO_UPDATED_TO: '0.3.0' },
    stdout: { write: () => true },
    stderr: { write: () => true },
    fetchImpl: async () => new Response(JSON.stringify({ name: '@soda_game/orbit-cli', version: '0.3.0' })),
    runCommand: async () => { commandRuns += 1; return 0 },
  })
  assert.equal(result.action, 'blocked')
  assert.equal(commandRuns, 0)
  assert.equal(shouldSkipCliUpdate(['--version']), true)
  assert.equal(shouldSkipCliUpdate(['help']), true)
  assert.equal(shouldSkipCliUpdate(['generate', '--prompt', 'help']), false)
  assert.equal(shouldSkipCliUpdate(['generate', '--prompt', 'help me']), false)
})
