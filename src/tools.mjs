import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { MAX_TOOL_OUTPUT_CHARS } from './constants.mjs'
import { canonicalDirectory, isContained, sha256, sleep } from './util.mjs'

function tool(name, description, parameters) {
  return { type: 'function', function: { name, description, parameters } }
}

const BASE_TOOLS = [
  tool('update_agent_plan', 'Create or update the execution plan.', {
    type: 'object', additionalProperties: false, required: ['summary', 'todos'],
    properties: {
      summary: { type: 'string' }, currentTodoId: { type: 'string' }, blockers: { type: 'array', items: { type: 'string' } },
      todos: { type: 'array', minItems: 1, maxItems: 12, items: {
        type: 'object', additionalProperties: false, required: ['id', 'title', 'status', 'kind'],
        properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, kind: { type: 'string' }, detail: { type: 'string' }, evidence: { type: 'string' } },
      } },
    },
  }),
  tool('write_file', 'Write one workspace file.', { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } }),
  tool('edit_file', 'Replace one exact substring in one workspace file.', { type: 'object', additionalProperties: false, required: ['path', 'old_string', 'new_string'], properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } } }),
  tool('apply_patch', 'Apply multiple exact substring replacements.', { type: 'object', additionalProperties: false, required: ['edits'], properties: { edits: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'object', additionalProperties: false, required: ['path', 'old_string', 'new_string'], properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } } } } } }),
  tool('read_file', 'Read a workspace file by line range.', { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } } }),
  tool('list_files', 'List workspace files.', { type: 'object', additionalProperties: false, properties: {} }),
  tool('grep_files', 'Search workspace text files.', { type: 'object', additionalProperties: false, required: ['pattern'], properties: { pattern: { type: 'string' }, case_sensitive: { type: 'boolean' } } }),
  tool('read_reference_media', 'Read the already-produced private reference analysis.', { type: 'object', additionalProperties: false, properties: { focus: { type: 'string' }, image_path: { type: 'string' } } }),
  tool('shell', 'Run an allowlisted build or validation command when local shell execution was explicitly enabled.', { type: 'object', additionalProperties: false, required: ['command'], properties: { command: { type: 'string' }, timeout_ms: { type: 'integer' } } }),
  tool('validate_project', 'Validate source contracts, build output, paths, and local preview readiness.', { type: 'object', additionalProperties: false, properties: {} }),
  tool('finish', 'Finish only after validation passes.', { type: 'object', additionalProperties: false, properties: {} }),
]

const OFFICIAL_3D_TOOL = tool('generate_humanoid_character', 'Generate one original rigged humanoid through the authenticated Orbit Worker when 3D generation was enabled.', {
  type: 'object', additionalProperties: false, required: ['prompt'], properties: { prompt: { type: 'string', minLength: 8, maxLength: 1024 } },
})

const BYOK_3D_TOOL = tool('generate_3d_model', 'Generate one original GLB model with the user-configured Replicate key when 3D generation was enabled.', {
  type: 'object', additionalProperties: false, required: ['prompt', 'output_path'],
  properties: { prompt: { type: 'string', minLength: 8, maxLength: 8000 }, output_path: { type: 'string' }, face_count: { type: 'integer' }, enable_pbr: { type: 'boolean' } },
})

function imageTool(mode) {
  return tool('generate_image', mode === 'orbit'
    ? 'Generate one original game image through the authenticated Orbit Worker. Use it only when a high-impact 2D asset materially improves the game, wire the returned local path into the game, and do not generate decorative assets that the final build does not use.'
    : 'Generate one original game image with the user-configured Replicate key. Use it only when a high-impact 2D asset materially improves the game, wire the returned local path into the game, and do not generate decorative assets that the final build does not use. The user\'s Replicate account may be billed.', {
  type: 'object', additionalProperties: false, required: ['prompt', 'output_path'],
  properties: {
    prompt: { type: 'string', minLength: 8, maxLength: 8000 },
    output_path: { type: 'string', description: 'Safe workspace-relative .png path.' },
    aspect_ratio: { type: 'string', enum: ['1:1', '9:16', '16:9'] },
  },
  })
}

export function agentTools({ mode, generateImages = false, generate3d }) {
  const tools = [...BASE_TOOLS]
  if (generateImages) tools.splice(tools.length - 3, 0, imageTool(mode))
  if (generate3d) tools.splice(tools.length - 3, 0, mode === 'orbit' ? OFFICIAL_3D_TOOL : BYOK_3D_TOOL)
  return tools
}

function relativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
    || normalized === '.orbit' || normalized.startsWith('.orbit/')
    || normalized === '.git' || normalized.startsWith('.git/')) {
    throw new Error('Tool path must be a safe workspace-relative path')
  }
  return normalized
}

async function resolveForRead(root, value) {
  const relative = relativePath(value)
  const absolute = path.resolve(root, relative)
  if (!isContained(root, absolute)) throw new Error('Tool path escaped the workspace')
  const canonical = await fs.realpath(absolute)
  if (!isContained(root, canonical) || canonical !== absolute) throw new Error('Tool path traversed a symbolic link')
  const stat = await fs.lstat(absolute)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Tool path is not a regular file')
  return { relative, absolute, stat }
}

async function resolveForWrite(root, value) {
  const relative = relativePath(value)
  const absolute = path.resolve(root, relative)
  if (!isContained(root, absolute)) throw new Error('Tool path escaped the workspace')
  const parts = relative.split('/')
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part)
    const existing = await fs.lstat(current).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (!existing) await fs.mkdir(current)
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) throw new Error('Tool path contains an unsafe directory')
  }
  const existing = await fs.lstat(absolute).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || await fs.realpath(absolute) !== absolute)) throw new Error('Tool destination is unsafe')
  return { relative, absolute }
}

async function verifiedGeneratedImage(root, output, expectedRelative) {
  if (!output || typeof output !== 'object'
    || output.relativePath !== expectedRelative
    || output.contentType !== 'image/png'
    || typeof output.sha256 !== 'string') return null
  const resolved = await resolveForRead(root, output.relativePath).catch(() => null)
  if (!resolved || resolved.stat.size !== Number(output.bytes)) return null
  const bytes = await fs.readFile(resolved.absolute)
  if (bytes.byteLength < 8
    || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    || sha256(bytes) !== output.sha256) return null
  return { ...output, path: resolved.absolute, relativePath: resolved.relative }
}

async function reusableGeneratedImage(run, root, expectedRelative) {
  const entries = Object.entries(run.assetImages || {}).reverse()
  for (const [callId, state] of entries) {
    const output = await verifiedGeneratedImage(root, state?.output, expectedRelative)
    if (output) return { callId, output }
  }
  return null
}

async function atomicWrite(root, value, content) {
  const resolved = await resolveForWrite(root, value)
  const bytes = Buffer.from(String(content), 'utf8')
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Tool file exceeds the 8 MiB write limit')
  const temporary = `${resolved.absolute}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 })
  await fs.rename(temporary, resolved.absolute)
  return { path: resolved.relative, bytes: bytes.byteLength, sha256: sha256(bytes) }
}

async function listFiles(root) {
  const output = []
  async function visit(directory, prefix = '') {
    if (output.length >= 2_000) return
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (['.git', '.orbit', 'node_modules'].includes(entry.name)) continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) { output.push(`${relative} [symlink blocked]`); continue }
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative)
      else if (entry.isFile()) output.push(relative)
      if (output.length >= 2_000) return
    }
  }
  await visit(root)
  return output
}

function parseAllowedCommand(command) {
  const text = String(command || '').trim()
  if (!text || text.length > 500 || /[;&|><`$\n\r]/.test(text)) throw new Error('Shell command is outside the safe allowlist')
  const parts = text.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, '')) || []
  const joined = parts.join(' ')
  const nodeCheck = /^node --check ([A-Za-z0-9_./-]+)$/.exec(joined)
  const allowed = /^npm (?:install --ignore-scripts|test|run [A-Za-z0-9:_-]+)$/.test(joined)
    || Boolean(nodeCheck)
  if (!allowed) throw new Error('Shell command is outside the safe allowlist')
  if (nodeCheck && !/\.(?:js|mjs|cjs)$/.test(relativePath(nodeCheck[1]))) throw new Error('node --check requires a workspace JavaScript file')
  return { command: parts[0], args: parts.slice(1) }
}

function runCommand(root, command, timeoutMs) {
  const parsed = parseAllowedCommand(command)
  return new Promise((resolve, reject) => {
    const child = spawn(parsed.command, parsed.args, {
      cwd: root,
      shell: false,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        Path: process.env.Path,
        PATHEXT: process.env.PATHEXT,
        SystemRoot: process.env.SystemRoot,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        npm_config_audit: 'false',
        npm_config_update_notifier: 'false',
        NO_COLOR: '1',
      },
    })
    const chunks = []
    let length = 0
    const collect = (chunk) => {
      if (length >= MAX_TOOL_OUTPUT_CHARS) return
      const slice = Buffer.from(chunk).subarray(0, MAX_TOOL_OUTPUT_CHARS - length)
      chunks.push(slice); length += slice.length
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.once('error', reject)
    const timer = setTimeout(() => child.kill('SIGTERM'), Math.min(300_000, Math.max(1_000, timeoutMs || 120_000)))
    timer.unref?.()
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, signal: signal || null, output: Buffer.concat(chunks).toString('utf8') })
    })
  })
}

async function validateProject(root, allowShell) {
  const files = await listFiles(root)
  let index = null
  for (const candidate of ['dist/index.html', 'index.html']) {
    if (files.includes(candidate)) { index = candidate; break }
  }
  if (!index && files.includes('package.json') && allowShell) {
    const build = await runCommand(root, 'npm run build', 300_000)
    if (build.exitCode !== 0) return { ok: false, issues: [`Build failed:\n${build.output.slice(0, 8_000)}`] }
    if ((await listFiles(root)).includes('dist/index.html')) index = 'dist/index.html'
  }
  if (!index) return { ok: false, issues: ['No playable index.html or dist/index.html was found.'] }
  const html = await fs.readFile(path.join(root, index), 'utf8')
  const sourceParts = [html]
  let sourceBytes = Buffer.byteLength(html)
  for (const file of files) {
    if (!/\.(?:html|js|mjs|cjs|jsx|ts|tsx)$/i.test(file) || file.startsWith('node_modules/')) continue
    const resolved = await resolveForRead(root, file)
    if (resolved.stat.size > 2 * 1024 * 1024 || sourceBytes + resolved.stat.size > 8 * 1024 * 1024) continue
    sourceParts.push(await fs.readFile(resolved.absolute, 'utf8'))
    sourceBytes += resolved.stat.size
  }
  const source = sourceParts.join('\n')
  const issues = []
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) issues.push('Missing mobile viewport metadata.')
  if (!/OrbitArcade\s*\.\s*startGame|orbit:game:start/.test(source)) issues.push('Orbit start lifecycle is missing.')
  if (!/OrbitArcade\s*\.\s*endGame|orbit:game:end/.test(source)) issues.push('Orbit end lifecycle is missing.')
  if (!/leaderboard/i.test(source)) issues.push('A reachable leaderboard action is missing.')
  if (/(?:https?:)?\/\/(?:unpkg|cdn\.jsdelivr|cdnjs|esm\.sh)/i.test(source)) issues.push('External CDN dependencies are not allowed.')
  return { ok: issues.length === 0, index, issues }
}

export class ToolExecutor {
  constructor({ workspace, run, store, api, image, threeD, allowShell = false, retryUnsafe = false, signal }) {
    this.workspace = workspace
    this.run = run
    this.store = store
    this.api = api
    this.image = image
    this.threeD = threeD
    this.allowShell = allowShell
    this.retryUnsafe = retryUnsafe
    this.signal = signal
  }

  async execute(call) {
    const name = String(call?.function?.name || '')
    let args
    try { args = JSON.parse(call?.function?.arguments || '{}') } catch { throw new Error(`Invalid JSON arguments for ${name}`) }
    const root = await canonicalDirectory(this.workspace)
    if (name === 'update_agent_plan') {
      this.run.plan = args
      await this.store.save(this.run)
      return JSON.stringify({ ok: true, plan: args }).slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    if (name === 'write_file') return JSON.stringify(await atomicWrite(root, args.path, args.content))
    if (name === 'read_file') {
      const file = await resolveForRead(root, args.path)
      if (file.stat.size > 2 * 1024 * 1024) throw new Error('File is too large to read')
      const lines = (await fs.readFile(file.absolute, 'utf8')).split(/\r?\n/)
      const offset = Math.max(0, Number(args.offset) || 0)
      const limit = Math.min(2_000, Math.max(1, Number(args.limit) || 400))
      return lines.slice(offset, offset + limit).map((line, index) => `${offset + index}: ${line}`).join('\n').slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    if (name === 'edit_file') {
      const file = await resolveForRead(root, args.path)
      const source = await fs.readFile(file.absolute, 'utf8')
      const oldText = String(args.old_string)
      const newText = String(args.new_string)
      if (!oldText) throw new Error('edit_file old_string cannot be empty')
      const occurrences = source.split(oldText).length - 1
      if (occurrences === 0 && source.includes(newText)) return JSON.stringify({ ok: true, recovered: true, path: file.relative })
      if (occurrences !== 1) throw new Error(`edit_file expected one match, found ${occurrences}`)
      return JSON.stringify(await atomicWrite(root, file.relative, source.replace(oldText, newText)))
    }
    if (name === 'apply_patch') {
      if (!Array.isArray(args.edits) || !args.edits.length) throw new Error('apply_patch requires edits')
      const working = new Map()
      for (const edit of args.edits) {
        const file = await resolveForRead(root, edit.path)
        const source = working.has(file.relative) ? working.get(file.relative) : await fs.readFile(file.absolute, 'utf8')
        const oldText = String(edit.old_string)
        const newText = String(edit.new_string)
        if (!oldText) throw new Error('apply_patch old_string cannot be empty')
        const count = source.split(oldText).length - 1
        if (count === 0 && source.includes(newText)) { working.set(file.relative, source); continue }
        if (count !== 1) throw new Error(`apply_patch expected one match in ${file.relative}, found ${count}`)
        working.set(file.relative, source.replace(oldText, newText))
      }
      const results = []
      for (const [file, content] of working) results.push(await atomicWrite(root, file, content))
      return JSON.stringify({ ok: true, files: results })
    }
    if (name === 'list_files') return ((await listFiles(root)).join('\n') || 'No files').slice(0, MAX_TOOL_OUTPUT_CHARS)
    if (name === 'grep_files') {
      const pattern = String(args.pattern || '')
      if (!pattern || pattern.length > 300) throw new Error('grep pattern is invalid')
      const needle = args.case_sensitive ? pattern : pattern.toLowerCase()
      const matches = []
      for (const file of await listFiles(root)) {
        if (matches.length >= 300 || !/\.(?:html|css|js|mjs|cjs|jsx|ts|tsx|json|md)$/i.test(file)) continue
        const resolved = await resolveForRead(root, file)
        if (resolved.stat.size > 2 * 1024 * 1024) continue
        const lines = (await fs.readFile(resolved.absolute, 'utf8')).split(/\r?\n/)
        lines.forEach((line, index) => {
          if (matches.length < 300 && (args.case_sensitive ? line : line.toLowerCase()).includes(needle)) matches.push(`${file}:${index + 1}:${line}`)
        })
      }
      return (matches.join('\n') || 'No matches').slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    if (name === 'read_reference_media') {
      if (!this.run.referenceSummary) throw new Error('No reference analysis is available')
      return String(this.run.referenceSummary).slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    if (name === 'shell') {
      if (!this.allowShell) throw new Error('Shell execution is disabled. Restart with --allow-shell after reviewing the risk.')
      return JSON.stringify(await runCommand(root, args.command, args.timeout_ms)).slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    if (name === 'validate_project') {
      const result = await validateProject(root, this.allowShell)
      this.run.lastValidation = result
      await this.store.save(this.run)
      return JSON.stringify(result).slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    if (name === 'finish') {
      if (!this.run.lastValidation?.ok) throw new Error('finish requires a passing validate_project result')
      return JSON.stringify({ ok: true, finished: true, validation: this.run.lastValidation })
    }
    if (name === 'generate_image') {
      if (!this.run.generateImages || (this.run.mode === 'orbit' && !this.api)) throw new Error('Image generation was not enabled for this run')
      const outputPath = relativePath(args.output_path)
      this.run.assetImages ||= {}
      this.run.assetImages[call.id] ||= {}
      const reusable = await reusableGeneratedImage(this.run, root, outputPath)
      if (reusable) {
        this.run.assetImages[call.id] = {
          ...this.run.assetImages[call.id],
          outputPath,
          output: reusable.output,
          reusedFromCallId: reusable.callId,
        }
        await this.store.save(this.run)
        return JSON.stringify({ ...reusable.output, reused: true }).slice(0, MAX_TOOL_OUTPUT_CHARS)
      }
      this.run.assetImages[call.id].outputPath = outputPath
      await this.store.save(this.run)
      const result = await this.image.generate({
        mode: this.run.mode,
        api: this.api,
        workspace: root,
        prompt: args.prompt,
        output: outputPath,
        aspectRatio: args.aspect_ratio || '1:1',
        state: this.run.assetImages[call.id],
        retryUnsafe: this.retryUnsafe,
        signal: this.signal,
        clientRunId: `${this.run.id}.image.${String(call.id).replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80)}`,
        requestKey: `image_${String(call.id).replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 120)}`,
        persist: async () => this.store.save(this.run),
      })
      return JSON.stringify(result).slice(0, MAX_TOOL_OUTPUT_CHARS)
    }
    if (name === 'generate_3d_model') {
      if (!this.run.generate3d) throw new Error('3D generation was not enabled for this run')
      this.run.asset3d ||= {}
      const result = await this.threeD.generate({
        mode: 'byok', workspace: root, prompt: args.prompt, output: args.output_path,
        faceCount: args.face_count, enablePbr: args.enable_pbr, state: this.run.asset3d,
        signal: this.signal, persist: async () => this.store.save(this.run),
      })
      return JSON.stringify(result)
    }
    if (name === 'generate_humanoid_character') {
      if (!this.run.generate3d || !this.run.cloudRunId) throw new Error('Official 3D generation is unavailable for this run')
      const requestKey = `humanoid_${call.id}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128)
      let envelope = await this.api.startHumanoid(this.run.cloudRunId, requestKey, String(args.prompt).slice(0, 1024))
      const deadline = Date.now() + 20 * 60_000
      while (true) {
        const job = envelope.job
        const status = String(job?.status || '')
        const jobId = String(job?.job_id || '')
        if (status === 'succeeded') return JSON.stringify({ ...job.manifest, generationJobRef: `job:${jobId}`, cadeCharged: Number(job.cade_charged || 0) }).slice(0, MAX_TOOL_OUTPUT_CHARS)
        if (status === 'failed' || status === 'canceled') throw new Error(String(job?.error?.code || `ENGINE_HUMANOID_${status.toUpperCase()}`))
        if (!jobId || Date.now() >= deadline) throw new Error('ENGINE_HUMANOID_GENERATION_TIMEOUT')
        await sleep(Math.max(1_000, Math.min(5_000, Number(envelope.poll_after_ms) || 5_000)), this.signal)
        envelope = await this.api.humanoidStatus(this.run.cloudRunId, jobId)
      }
    }
    throw new Error(`Unsupported tool: ${name}`)
  }
}
