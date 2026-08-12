import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { main } from '../src/cli.mjs'
import { VERSION } from '../src/constants.mjs'
import {
  collectCreateArguments,
  renderWelcomeScreen,
  runWelcomeMenu,
  welcomeActionArguments,
} from '../src/welcome.mjs'

test('welcome screen shows the installed state and real launcher actions', () => {
  const screen = renderWelcomeScreen({
    cwd: '/workspace/code/orbit-game',
    home: '/workspace',
    config: { mode: 'byok', provider: 'openrouter', runtime: 'phaser' },
    columns: 88,
    color: false,
  })

  assert.match(screen, new RegExp(`Orbit CLI v${VERSION.replaceAll('.', '\\.')}`))
  assert.match(screen, /mode\s+BYOK · openrouter/)
  assert.match(screen, /runtime\s+phaser/)
  assert.match(screen, /directory\s+~\/code\/orbit-game/)
  assert.match(screen, /› Create a game/)
  assert.match(screen, /Open Web CLI/)
  assert.match(screen, /Account & Cade/)
  assert.match(screen, /cade\s+sign in to view/)
  assert.match(screen, /List providers/)
  assert.match(screen, /↑↓ navigate/)
  assert.doesNotMatch(screen, /\u001b\[/)
})

test('welcome action arguments invoke existing CLI commands', () => {
  assert.deepEqual(welcomeActionArguments('web'), ['web'])
  assert.deepEqual(welcomeActionArguments('runs'), ['runs'])
  assert.deepEqual(welcomeActionArguments('account'), ['account'])
  assert.deepEqual(welcomeActionArguments('providers'), ['providers', 'list'])
  assert.deepEqual(welcomeActionArguments('doctor'), ['doctor'])
  assert.deepEqual(welcomeActionArguments('help'), ['help'])
  assert.equal(welcomeActionArguments('create'), null)
})

test('welcome screen gives an explicit upgrade command only when an update is available', () => {
  const screen = renderWelcomeScreen({
    color: false,
    update: {
      currentVersion: '0.2.1',
      latestVersion: '0.3.0',
      command: 'npm install -g @soda_game/orbit-cli@latest',
    },
  })
  assert.match(screen, /UPDATE AVAILABLE  v0\.2\.1 → v0\.3\.0/)
  assert.match(screen, /npm install -g @soda_game\/orbit-cli@latest/)
})

test('create action collects a prompt and resolves its workspace', async () => {
  const answers = ['Build a one-button space game', './games/space']
  const result = await collectCreateArguments({
    cwd: '/tmp/orbit-project',
    ask: async () => answers.shift(),
  })
  assert.deepEqual(result, [
    'generate',
    '--prompt',
    'Build a one-button space game',
    '--workspace',
    '/tmp/orbit-project/games/space',
  ])
})

test('interactive menu handles keyboard navigation and restores the terminal', async () => {
  const stdin = new EventEmitter()
  stdin.isTTY = true
  stdin.rawModes = []
  stdin.setRawMode = (value) => stdin.rawModes.push(value)
  stdin.resume = () => {}
  stdin.pause = () => {}
  const writes = []
  const stdout = {
    isTTY: true,
    columns: 88,
    write: (value) => writes.push(String(value)),
  }

  const selected = runWelcomeMenu({
    stdin,
    stdout,
    color: false,
    checkForUpdate: async () => ({
      currentVersion: '0.2.1',
      latestVersion: '0.3.0',
      command: 'npm install -g @soda_game/orbit-cli@latest',
    }),
  })
  setImmediate(() => {
    setImmediate(() => {
      stdin.emit('data', Buffer.from('\u001b[B'))
      setImmediate(() => stdin.emit('data', Buffer.from('\r')))
    })
  })

  assert.equal(await selected, 'web')
  assert.deepEqual(stdin.rawModes, [true, false])
  assert.match(writes.join(''), /Open Web CLI/)
  assert.match(writes.join(''), /UPDATE AVAILABLE/)
  assert.ok(writes.join('').endsWith('\u001b[?25h\u001b[2J\u001b[H'))
})

test('no-argument interactive startup dispatches the selected launcher action', async (t) => {
  const output = []
  t.mock.method(console, 'log', (...values) => output.push(values.join(' ')))
  const app = {
    store: { recoverInterrupted: async () => [] },
    config: { get: async () => ({ mode: 'orbit', runtime: 'html' }) },
  }
  const terminal = { isTTY: true }

  assert.equal(await main([], {
    app,
    stdin: terminal,
    stdout: terminal,
    runWelcomeMenu: async () => 'help',
  }), 0)
  assert.match(output.join('\n'), /orbit\s+Start an interactive game-building session/)
  assert.match(output.join('\n'), /orbit auth login\|status\|logout/)
})

test('start building enters the persistent interactive session', async () => {
  const app = {
    store: { recoverInterrupted: async () => [] },
    config: { get: async () => ({ mode: 'orbit', runtime: 'html' }) },
  }
  const terminal = { isTTY: true }
  let received

  assert.equal(await main([], {
    app,
    stdin: terminal,
    stdout: terminal,
    cwd: '/tmp/orbit-game',
    runWelcomeMenu: async () => 'create',
    runInteractiveSession: async (options) => { received = options; return 0 },
  }), 0)
  assert.equal(received.app, app)
  assert.equal(received.cwd, '/tmp/orbit-game')
})

test('version and help are instant paths that do not initialize local state', async (t) => {
  const output = []
  t.mock.method(console, 'log', (...values) => output.push(values.join(' ')))
  const app = { store: { recoverInterrupted: async () => { throw new Error('must not initialize') } } }

  assert.equal(await main(['--version'], { app }), 0)
  assert.equal(await main(['--help'], { app }), 0)
  assert.match(output[0], /^\d+\.\d+\.\d+$/)
  assert.match(output[1], /Start an interactive game-building session/)
})
