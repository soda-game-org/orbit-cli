import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

export function appDirectories(env = process.env) {
  const configBase = process.platform === 'win32'
    ? env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  const dataBase = process.platform === 'win32'
    ? env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return {
    config: path.join(configBase, 'orbit-cli'),
    data: path.join(dataBase, 'orbit-cli'),
  }
}

export async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700)
  return directory
}

export async function writeJsonAtomic(file, value) {
  await ensurePrivateDirectory(path.dirname(file))
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  if (process.platform !== 'win32') await fs.chmod(temporary, 0o600)
  await fs.rename(temporary, file)
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function boundedString(value, label, maximum = 16_000) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > maximum) throw new TypeError(`${label} is invalid`)
  return text
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function id(prefix = '') {
  return `${prefix}${randomUUID()}`
}

export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('Aborted'))
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(done, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason || new Error('Aborted'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export function openExternal(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('External URL must use HTTP(S)')
  }
  const command = process.platform === 'darwin'
    ? ['open', [parsed.toString()]]
    : process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', parsed.toString()]]
      : ['xdg-open', [parsed.toString()]]
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

export async function collectStream(stream, maximum) {
  if (!stream) throw new Error('Response body is missing')
  const chunks = []
  let total = 0
  const add = (value) => {
    const chunk = Buffer.from(value)
    total += chunk.byteLength
    if (total > maximum) throw new Error('Response exceeds the allowed size')
    chunks.push(chunk)
  }
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        add(value)
      }
    } catch (error) {
      await reader.cancel('response rejected').catch(() => undefined)
      throw error
    } finally {
      reader.releaseLock()
    }
  } else if (typeof stream[Symbol.asyncIterator] === 'function') {
    for await (const value of stream) add(value)
  } else {
    throw new TypeError('Unsupported response body stream')
  }
  return Buffer.concat(chunks, total)
}

export function redactDiagnostic(value) {
  return String(value || '')
    .replace(/(?:sk|orb|gho|sb_secret)_[A-Za-z0-9._-]{12,}/g, '[redacted-token]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z]:\\[^\s"']+|\/(?:Users|home)\/[^\s"']+/g, '[local-path]')
    .slice(0, 800)
}

export function publicError(error) {
  if (error instanceof Error) return redactDiagnostic(error.message)
  return redactDiagnostic(String(error))
}

export async function canonicalDirectory(directory, { create = false } = {}) {
  if (!path.isAbsolute(directory)) throw new TypeError('Workspace must be an absolute path')
  const resolved = path.resolve(directory)
  if (resolved === path.parse(resolved).root) throw new TypeError('Workspace cannot be a filesystem root')
  if (create) await fs.mkdir(resolved, { recursive: true })
  const stat = await fs.lstat(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('Workspace must be a real directory')
  return fs.realpath(resolved)
}

export function isContained(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}
