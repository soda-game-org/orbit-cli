import { VERSION } from './constants.mjs'
import { collectStream } from './util.mjs'

const NPM_LATEST_URL = 'https://registry.npmjs.org/@soda_game%2Forbit-cli/latest'
const MAX_RESPONSE_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 2_000

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
      command: 'npm install -g @soda_game/orbit-cli@latest',
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
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
