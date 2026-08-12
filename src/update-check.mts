import { spawn } from 'node:child_process'
import { VERSION } from './constants.mjs'
import { collectStream } from './util.mjs'

const NPM_LATEST_URL = 'https://registry.npmjs.org/@soda_game%2Forbit-cli/latest'
const MAX_RESPONSE_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 2_000
const PACKAGE_SPEC = '@soda_game/orbit-cli@latest'
const AUTO_UPDATE_MARKER = 'ORBIT_CLI_AUTO_UPDATED_TO'

export interface OrbitCliUpdate {
  currentVersion: string
  latestVersion: string
  command: string
}

interface CheckForCliUpdateOptions {
  currentVersion?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

type RunCommand = (
  command: string,
  arguments_: string[],
  options: { env?: NodeJS.ProcessEnv; stdio: 'inherit'; shell?: boolean },
) => Promise<number>

interface EnforceLatestCliOptions extends CheckForCliUpdateOptions {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  execPath?: string
  entrypoint?: string
  stdout?: Pick<NodeJS.WriteStream, 'write'>
  stderr?: Pick<NodeJS.WriteStream, 'write'>
  runCommand?: RunCommand
}

export interface CliUpdateGateResult {
  action: 'continue' | 'restarted' | 'blocked'
  exitCode: number
  update?: OrbitCliUpdate
}

/**
 * Check npm without making local startup depend on the registry. Every network,
 * response, and parsing failure is intentionally treated as "no update info".
 */
export async function checkForCliUpdate({
  currentVersion = VERSION,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: CheckForCliUpdateOptions = {}): Promise<OrbitCliUpdate | null> {
  const controller = new AbortController()
  const boundedTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, 10_000)
    : DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), boundedTimeout)
  timer.unref?.()
  try {
    const response = await fetchImpl(NPM_LATEST_URL, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) return null
    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > MAX_RESPONSE_BYTES) return null
    const text = Buffer.from(await collectStream(response.body, MAX_RESPONSE_BYTES)).toString('utf8')
    const metadata = JSON.parse(text) as { name?: unknown; version?: unknown }
    if (metadata.name !== '@soda_game/orbit-cli' || typeof metadata.version !== 'string') return null
    if (compareSemanticVersions(metadata.version, currentVersion) <= 0) return null
    return {
      currentVersion,
      latestVersion: metadata.version,
      command: `npm install -g ${PACKAGE_SPEC}`,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Require an installed CLI to match npm before it executes product commands.
 * A successful update is followed by a fresh `orbit` process so the current
 * invocation continues on the newly installed code.
 */
export async function enforceLatestCli({
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  entrypoint = process.argv[1] || '',
  stdout = process.stdout,
  stderr = process.stderr,
  runCommand = runInheritedCommand,
  ...checkOptions
}: EnforceLatestCliOptions = {}): Promise<CliUpdateGateResult> {
  const update = await checkForCliUpdate(checkOptions)
  if (!update) return { action: 'continue', exitCode: 0 }

  const required = `Orbit CLI must update before continuing (v${update.currentVersion} → v${update.latestVersion}).`
  if (env[AUTO_UPDATE_MARKER] === update.latestVersion) {
    stderr.write(`${required}\nThe automatic update finished, but this command still resolved to the old installation.\nRun: ${update.command}\n`)
    return { action: 'blocked', exitCode: 1, update }
  }

  stdout.write(`${required}\nUpdating automatically...\n`)
  const installExitCode = await runCommand('npm', ['install', '--global', PACKAGE_SPEC], {
    stdio: 'inherit',
    // npm is exposed as npm.cmd on Windows. Only the fixed install command
    // crosses cmd.exe; no user-provided value is included in this invocation.
    shell: platform === 'win32',
  })
  if (installExitCode !== 0) {
    stderr.write(`Orbit CLI could not update automatically.\nRun: ${update.command}\n`)
    return { action: 'blocked', exitCode: installExitCode || 1, update }
  }

  stdout.write(`Updated to v${update.latestVersion}. Restarting Orbit CLI...\n`)
  if (!entrypoint) {
    stderr.write(`Orbit CLI was updated but could not restart automatically.\nRun: orbit ${argv.join(' ')}\n`)
    return { action: 'blocked', exitCode: 1, update }
  }
  const restartExitCode = await runCommand(execPath, [entrypoint, ...argv], {
    env: { ...env, [AUTO_UPDATE_MARKER]: update.latestVersion },
    stdio: 'inherit',
  })
  return { action: 'restarted', exitCode: restartExitCode, update }
}

export function shouldSkipCliUpdate(argv: string[]): boolean {
  return argv[0] === 'version'
    || argv[0] === 'help'
    || argv.includes('--version')
    || argv.includes('--help')
}

function runInheritedCommand(
  command: string,
  arguments_: string[],
  options: { env?: NodeJS.ProcessEnv; stdio: 'inherit'; shell?: boolean },
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, arguments_, {
      env: options.env,
      stdio: options.stdio,
      windowsHide: true,
      shell: options.shell ?? false,
    })
    child.once('error', () => resolve(1))
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1))
  })
}

export function compareSemanticVersions(left: string, right: string): number {
  const a = parseSemanticVersion(left)
  const b = parseSemanticVersion(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index]! > b.core[index]!) return 1
    if (a.core[index]! < b.core[index]!) return -1
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart > rightPart ? 1 : -1
  }
  return 0
}

function parseSemanticVersion(value: string): { core: [bigint, bigint, bigint]; prerelease: string[] } | null {
  if (value.length > 128) return null
  const match = value.match(/^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  if (!match) return null
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease: match[4] ? match[4].split('.') : [],
  }
}
