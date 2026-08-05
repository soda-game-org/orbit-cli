import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { findHighConfidenceSecrets, secretLikeFileName } from '../src/secret-scan.mjs'

const execFileAsync = promisify(execFile)
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
// Local E2E evidence is deliberately kept beside the checkout so failures can
// be inspected, but it is gitignored and excluded by package.json `files`.
const ignored = new Set(['.git', '.orbit-e2e', 'node_modules', 'coverage'])
const allowedTopLevel = new Set(['.github', '.gitignore', 'CONTRIBUTING.md', 'LICENSE', 'NOTICE.md', 'README.md', 'README.zh-CN.md', 'RELEASES.md', 'SECURITY.md', 'assets', 'bin', 'package-lock.json', 'package.json', 'packages', 'scripts', 'skills', 'src', 'test'])
const privateSkillFiles = []
const findings = []

const PUBLIC_GENERIC_SKILL = 'skills/generic-html-game/SKILL.md'
const PUBLIC_README_ASSET = 'assets/readme/orbit-cli-hero.jpg'
const PACK_ALLOWED_EXACT = new Set([
  'LICENSE',
  'NOTICE.md',
  'README.md',
  'README.zh-CN.md',
  'RELEASES.md',
  'SECURITY.md',
  'bin/orbit.mjs',
  'package.json',
  PUBLIC_GENERIC_SKILL,
])
const PACK_ALLOWED_PREFIXES = ['src/', 'packages/orbit-provider-core/']
const PACK_FORBIDDEN_SEGMENTS = new Set([
  '.git',
  '.github',
  '.orbit-e2e',
  'engine',
  'private',
  'scripts',
  'test',
  'tests',
])
const PACK_ALLOWED_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.mts'])
const PACK_ALLOWED_EXTENSIONLESS = new Set(['LICENSE'])
const MAX_SCANNED_FILE_BYTES = 12 * 1024 * 1024

function isContained(rootDirectory, candidate) {
  const relative = path.relative(rootDirectory, candidate)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function scanText(relative, text) {
  for (const label of findHighConfidenceSecrets(text)) findings.push(`${relative}: ${label}`)
  if (/(?:^|["'])\/(?:Users|home)\/[^\s"']+/m.test(text)) findings.push(`${relative}: absolute developer path`)
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

async function visit(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolute = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) { findings.push(`${relative}: symbolic link`); continue }
    if (entry.isDirectory()) { await visit(absolute, relative); continue }
    if (!entry.isFile()) { findings.push(`${relative}: non-regular file`); continue }
    if (secretLikeFileName(entry.name) || /\.tgz$/i.test(entry.name)) findings.push(`${relative}: forbidden file type`)
    if (relative.startsWith('assets/') && relative !== PUBLIC_README_ASSET) findings.push(`${relative}: unexpected public asset`)
    if (relative.startsWith('skills/') && relative !== PUBLIC_GENERIC_SKILL) privateSkillFiles.push(relative)
    const stat = await fs.stat(absolute)
    if (stat.size > MAX_SCANNED_FILE_BYTES) { findings.push(`${relative}: unexpectedly large file`); continue }
    const bytes = await fs.readFile(absolute)
    const text = decodeUtf8(bytes)
    if (text !== null) scanText(relative, text)
  }
}

async function auditReachableGitHistory() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-list', '--objects', '--all'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
    const seen = new Set()
    for (const line of stdout.split(/\r?\n/)) {
      const separator = line.indexOf(' ')
      if (separator < 1) continue
      const object = line.slice(0, separator)
      const relative = line.slice(separator + 1)
      if (!relative || seen.has(object)) continue
      seen.add(object)
      if (secretLikeFileName(path.posix.basename(relative))) findings.push(`git history ${relative}: forbidden file type`)
      const { stdout: type } = await execFileAsync('git', ['cat-file', '-t', object], { cwd: root, encoding: 'utf8', windowsHide: true })
      if (type.trim() !== 'blob') continue
      const { stdout: bytes } = await execFileAsync('git', ['cat-file', 'blob', object], {
        cwd: root,
        encoding: 'buffer',
        maxBuffer: MAX_SCANNED_FILE_BYTES + 1,
        windowsHide: true,
      })
      if (bytes.byteLength > MAX_SCANNED_FILE_BYTES) { findings.push(`git history ${relative}: unexpectedly large file`); continue }
      const text = decodeUtf8(bytes)
      if (text !== null) scanText(`git history ${relative}`, text)
    }
  } catch (error) {
    findings.push(`reachable git history could not be audited: ${String(error?.message || error).slice(0, 500)}`)
  }
}

function allowedPackPath(relative) {
  return PACK_ALLOWED_EXACT.has(relative)
    || PACK_ALLOWED_PREFIXES.some((prefix) => relative.startsWith(prefix))
}

function normalizePackPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) return null
  const segments = value.split('/')
  if (value.startsWith('/') || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

async function npmPackManifest() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-cli-public-audit-'))
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  try {
    const { stdout } = await execFileAsync(npm, [
      'pack',
      '--dry-run',
      '--json',
      '--ignore-scripts',
      '--cache', path.join(temporary, 'npm-cache'),
      '--loglevel', 'error',
    ], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    })
    const parsed = JSON.parse(stdout)
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || !Array.isArray(parsed[0].files)) {
      throw new Error('npm returned an invalid pack manifest')
    }
    return parsed[0]
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().slice(0, 1_000)
    findings.push(`npm pack manifest could not be audited: ${detail || 'unknown error'}`)
    return null
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function auditPackManifest(manifest, packageJson) {
  if (!manifest) return 0
  if (manifest.name !== packageJson.name || manifest.version !== packageJson.version) {
    findings.push('npm pack identity does not match package.json')
  }
  if (Array.isArray(manifest.bundled) && manifest.bundled.length) {
    findings.push('npm pack must not contain bundled dependencies')
  }
  if (Number(manifest.entryCount) !== manifest.files.length) {
    findings.push('npm pack entry count does not match its file manifest')
  }

  const seen = new Set()
  const seenCaseInsensitive = new Set()
  for (const entry of manifest.files) {
    const relative = normalizePackPath(entry?.path)
    if (!relative) {
      findings.push(`npm pack contains an invalid path: ${String(entry?.path || '(missing)')}`)
      continue
    }
    const folded = relative.toLowerCase()
    if (seen.has(relative) || seenCaseInsensitive.has(folded)) {
      findings.push(`${relative}: duplicate or case-colliding npm pack path`)
      continue
    }
    seen.add(relative)
    seenCaseInsensitive.add(folded)

    const segments = relative.split('/')
    const forbiddenSegment = segments.find((segment) => PACK_FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))
    if (forbiddenSegment) findings.push(`${relative}: forbidden npm pack directory (${forbiddenSegment})`)
    if (segments[0] === 'skills' && relative !== PUBLIC_GENERIC_SKILL) {
      findings.push(`${relative}: only the generic public skill may be packed`)
    }
    if (!allowedPackPath(relative)) findings.push(`${relative}: unexpected npm pack entry`)

    const basename = path.posix.basename(relative)
    const extension = path.posix.extname(relative).toLowerCase()
    if (!PACK_ALLOWED_EXTENSIONLESS.has(basename) && !PACK_ALLOWED_EXTENSIONS.has(extension)) {
      findings.push(`${relative}: unknown npm pack file extension`)
    }

    const absolute = path.resolve(root, ...segments)
    if (!isContained(root, absolute)) {
      findings.push(`${relative}: npm pack path escaped the repository`)
      continue
    }
    const stat = await fs.lstat(absolute).catch(() => null)
    if (!stat) { findings.push(`${relative}: npm pack source is missing`); continue }
    if (stat.isSymbolicLink()) { findings.push(`${relative}: npm pack source is a symbolic link`); continue }
    if (!stat.isFile()) { findings.push(`${relative}: npm pack source is not a regular file`); continue }
    const canonical = await fs.realpath(absolute).catch(() => null)
    if (!canonical || canonical !== absolute || !isContained(root, canonical)) {
      findings.push(`${relative}: npm pack source traversed a symbolic link or boundary`)
      continue
    }
    if (Number(entry.size) !== stat.size) findings.push(`${relative}: npm pack size does not match the source file`)
    if (stat.size > MAX_SCANNED_FILE_BYTES) { findings.push(`${relative}: unexpectedly large npm pack file`); continue }
    const bytes = await fs.readFile(absolute)
    const text = decodeUtf8(bytes)
    if (text === null || bytes.includes(0)) {
      findings.push(`${relative}: binary or invalid UTF-8 content is not allowed in the public npm package`)
      continue
    }
    scanText(relative, text)
  }
  return manifest.files.length
}

for (const entry of await fs.readdir(root)) {
  if (!ignored.has(entry) && !allowedTopLevel.has(entry)) findings.push(`${entry}: unexpected top-level release entry`)
}
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
if (Object.keys(packageJson.dependencies || {}).some((name) => name.startsWith('@orbit/'))) findings.push('Private Orbit packages cannot be dependencies')
await visit(root)
await auditReachableGitHistory()
if (privateSkillFiles.length) findings.push(`Only the generic skill may ship: ${privateSkillFiles.join(', ')}`)
const packedFileCount = await auditPackManifest(await npmPackManifest(), packageJson)
if (findings.length) {
  console.error(`Public release audit failed:\n${[...new Set(findings)].map((finding) => `- ${finding}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`Public release audit passed: the checkout, reachable Git history and ${packedFileCount} packaged files contain no high-confidence credentials, private skills, symbolic links, boundary escapes or unexpected package entries.`)
}
