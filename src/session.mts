import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { CODING_PROVIDER_IDS, PROVIDERS, RUNTIMES, VERSION } from './constants.mjs'
import { providerCredentialAccount } from './credentials.mjs'
import {
  ORBIT_MANAGED_DEFAULT_MODEL,
  managedOrbitModelFromCatalog,
  orbitCodingModelDisplay,
  type OrbitManagedModelDescriptor,
} from './model-display.mjs'
import { canonicalDirectory, publicError } from './util.mjs'
import type { RunProgressEvent } from './run-manager.mjs'
import type { OrbitCliConfig, OrbitRun } from './types.mjs'

type AskQuestion = (prompt: string) => string | undefined | Promise<string | undefined>

interface InteractiveSessionOptions {
  app: any
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  cwd?: string
  home?: string
  color?: boolean
  ask?: AskQuestion
}

const RESET = '\u001b[0m'
const BOLD = '\u001b[1m'
const DIM = '\u001b[2m'
const CYAN = '\u001b[36m'
const GREEN = '\u001b[32m'
const YELLOW = '\u001b[33m'

const COMMANDS = Object.freeze([
  { command: '/help', detail: 'Show the command palette' },
  { command: '/status', detail: 'Show the active workspace, model, and permissions' },
  { command: '/sessions', detail: 'List project sessions' },
  { command: '/session new [title]', detail: 'Start another session in this project' },
  { command: '/session <id>', detail: 'Continue a project session' },
  { command: '/new [path]', detail: 'Start work in another game workspace' },
  { command: '/resume [run-id]', detail: 'Resume a saved run; defaults to the latest resumable run' },
  { command: '/runs', detail: 'Show recent local runs' },
  { command: '/details [run-id]', detail: 'Expand the saved plan and tool timeline for a run' },
  { command: '/mode orbit|byok', detail: 'Switch between Orbit Cloud and your own provider key' },
  { command: '/provider <id>', detail: 'Select the BYOK coding provider' },
  { command: '/model <id|auto>', detail: 'Select a model or return to automatic selection' },
  { command: '/runtime <id>', detail: 'Select the game runtime' },
  { command: '/images on|off', detail: 'Enable or disable generated 2D assets' },
  { command: '/3d on|off', detail: 'Enable or disable generated 3D assets' },
  { command: '/permissions [shell on|off]', detail: 'Review or change local project command access' },
  { command: '/attach <image-path>', detail: 'Attach a private reference image to the next request' },
  { command: '/web', detail: 'Open the local Web CLI' },
  { command: '/login', detail: 'Sign in to Orbit Cloud' },
  { command: '/clear', detail: 'Clear the terminal' },
  { command: '/quit', detail: 'Leave the session; checkpoints stay on disk' },
] as const)

const COMMAND_NAMES = COMMANDS.map(({ command }) => command.split(' ')[0]!)
const RESUMABLE_STATES = new Set(['queued', 'running', 'recovering', 'interrupted', 'paused'])

function paint(value: string, code: string, color: boolean): string {
  return color ? `${code}${value}${RESET}` : value
}

function clip(value: unknown, width: number): string {
  const text = String(value)
  if (text.length <= width) return text
  return width > 1 ? `${text.slice(0, width - 1)}…` : '…'.slice(0, width)
}

function displayPath(directory: string, home?: string): string {
  const absolute = path.resolve(directory)
  return home && (absolute === home || absolute.startsWith(`${home}${path.sep}`))
    ? `~${absolute.slice(home.length)}`
    : absolute
}

function parseWords(line: string): string[] {
  const matches = line.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+/g) || []
  return matches.map((word) => {
    if ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"))) {
      return word.slice(1, -1).replace(/\\([\\"'])/g, '$1')
    }
    return word
  })
}

function enabled(value: string | undefined, label: string): boolean {
  if (value === 'on') return true
  if (value === 'off') return false
  throw new Error(`Usage: /${label} on|off`)
}

function sessionMode(
  config: OrbitCliConfig,
  managedModel: OrbitManagedModelDescriptor = ORBIT_MANAGED_DEFAULT_MODEL,
): string {
  const model = orbitCodingModelDisplay(config.mode, config.model, managedModel)
  if (config.mode === 'orbit') return `Orbit Cloud · ${model}`
  return `BYOK · ${config.provider} · ${model}`
}

export function renderSessionHeader({
  config,
  workspace,
  home,
  allowShell = false,
  generateImages = false,
  generate3d = false,
  columns = 88,
  color = true,
  managedModel = ORBIT_MANAGED_DEFAULT_MODEL,
}: {
  config: OrbitCliConfig
  workspace: string
  home?: string
  allowShell?: boolean
  generateImages?: boolean
  generate3d?: boolean
  columns?: number
  color?: boolean
  managedModel?: OrbitManagedModelDescriptor
}): string {
  const width = Math.max(60, Math.min(Number(columns) || 88, 100))
  const rail = [
    displayPath(workspace, home),
    sessionMode(config, managedModel),
    config.runtime,
    `shell ${allowShell ? 'on' : 'off'}`,
    generateImages ? 'images on' : '',
    generate3d ? '3d on' : '',
  ].filter(Boolean).join('  ·  ')
  return [
    `${paint('Orbit', BOLD, color)} ${paint(`v${VERSION}`, DIM, color)}`,
    paint(clip(rail, width), DIM, color),
    paint('Type a request, or /help for commands. Ctrl+C interrupts only the active run.', DIM, color),
  ].join('\n')
}

function renderCommandPalette(color: boolean): string {
  const commandWidth = Math.max(...COMMANDS.map(({ command }) => command.length)) + 2
  return [
    paint('Commands', BOLD, color),
    ...COMMANDS.map(({ command, detail }) => `  ${paint(command.padEnd(commandWidth), CYAN, color)}${detail}`),
  ].join('\n')
}

function runIdentifier(run: OrbitRun): string {
  return String(run.id || '').replace(/^run_/, '')
}

function runSummary(run: OrbitRun, color: boolean): string {
  const validation = run.lastValidation || run.result?.validation || {}
  if (run.state === 'completed') {
    const lines = [
      paint('✓ Game ready', GREEN, color),
      `  workspace   ${run.workspace}`,
      `  validation  ${validation.ok ? 'passed' : 'completed'}${validation.index ? ` · ${validation.index}` : ''}`,
      paint(`  run         ${run.id}`, DIM, color),
      paint(`  next        /details to inspect · /web to preview · orbit publish ${run.id} to publish`, DIM, color),
    ]
    return lines.join('\n')
  }
  const retry = run.unsafeResumeRequired ? ` /resume ${run.id} --retry-unsafe` : ` /resume ${run.id}`
  return [
    paint(`! Run ${run.state}`, YELLOW, color),
    `  ${run.lastError?.message || 'The checkpoint is ready to continue.'}`,
    paint(`  resume      ${retry.trim()}`, DIM, color),
    paint(`  run         ${run.id}`, DIM, color),
  ].join('\n')
}

function recentRuns(runs: OrbitRun[], color: boolean): string {
  if (!runs.length) return paint('No local runs yet.', DIM, color)
  const rows = [paint('Recent runs', BOLD, color)]
  for (const run of runs.slice(0, 8)) {
    const prompt = clip(String(run.prompt || run.operation || 'Orbit run').replace(/\s+/g, ' '), 44)
    rows.push(`  ${String(run.state).padEnd(12)} ${prompt}`)
    rows.push(paint(`  ${run.id}  ${run.workspace}`, DIM, color))
  }
  return rows.join('\n')
}

function runDetails(run: OrbitRun, events: Record<string, unknown>[], color: boolean): string {
  const rows = [
    paint('Run details', BOLD, color),
    `  state       ${run.state}`,
    `  workspace   ${run.workspace}`,
    `  request     ${clip(String(run.prompt || ''), 72)}`,
    paint(`  id          ${run.id}`, DIM, color),
  ]
  const todos = Array.isArray(run.plan?.todos) ? run.plan.todos : []
  if (todos.length) {
    rows.push('', paint('Plan', BOLD, color))
    for (const todo of todos) {
      const mark = todo?.status === 'completed' ? '✓' : todo?.status === 'in_progress' ? '·' : '○'
      rows.push(`  ${mark} ${todo?.title || todo?.id || 'Task'}`)
    }
  }
  const timeline = events.filter((event) => ['reference_analysis_completed', 'tool_completed', 'tool_failed', 'run_paused', 'run_interrupted'].includes(String(event.type))).slice(-20)
  if (timeline.length) {
    rows.push('', paint('Timeline', BOLD, color))
    for (const event of timeline) {
      const label = event.type === 'tool_completed'
        ? `completed ${event.toolName}`
        : event.type === 'tool_failed'
          ? `failed ${event.toolName}`
          : String(event.type).replaceAll('_', ' ')
      const duration = typeof event.durationMs === 'number' ? ` · ${(event.durationMs / 1_000).toFixed(1)}s` : ''
      rows.push(`  ${label}${duration}`)
    }
  }
  return rows.join('\n')
}

function progressLabel(event: RunProgressEvent): string | null {
  switch (event.type) {
    case 'run_started': return 'Starting the agent'
    case 'reference_analysis_completed': return 'References understood'
    case 'model_started': return `Thinking · pass ${event.iteration || 1}`
    case 'provider_retry': return 'Provider busy · retrying'
    case 'tool_started': {
      const labels: Record<string, string> = {
        update_agent_plan: 'Planning the build',
        list_files: 'Inspecting the workspace',
        grep_files: 'Searching the workspace',
        read_file: 'Reading project files',
        write_file: 'Writing project files',
        edit_file: 'Editing project files',
        apply_patch: 'Applying project changes',
        shell: 'Running a project command',
        generate_image: 'Generating game artwork',
        generate_3d_model: 'Generating a 3D asset',
        validate_project: 'Validating the game',
        finish: 'Preparing the summary',
      }
      return labels[String(event.toolName)] || `Running ${event.toolName || 'a tool'}`
    }
    default: return null
  }
}

class ProgressLine {
  readonly stdout: NodeJS.WriteStream
  readonly color: boolean
  startedAt = Date.now()
  message = 'Starting the agent'
  timer: NodeJS.Timeout | null = null

  constructor(stdout: NodeJS.WriteStream, color: boolean) {
    this.stdout = stdout
    this.color = color
  }

  start(): void {
    if (!this.stdout.isTTY) return
    this.startedAt = Date.now()
    this.render()
    this.timer = setInterval(() => this.render(), 1_000)
    this.timer.unref?.()
  }

  update(event: RunProgressEvent): void {
    const next = progressLabel(event)
    if (!next) return
    this.message = next
    this.render()
  }

  render(): void {
    if (!this.stdout.isTTY) return
    const elapsed = Math.max(0, Math.round((Date.now() - this.startedAt) / 1_000))
    const width = Math.max(30, Number(this.stdout.columns) || 88)
    const line = clip(`· ${this.message}  ${elapsed}s`, width - 1)
    this.stdout.write(`\r\u001b[2K${paint(line, DIM, this.color)}`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.stdout.isTTY) this.stdout.write('\r\u001b[2K')
  }
}

export async function runInteractiveSession({
  app,
  stdin = process.stdin,
  stdout = process.stdout,
  cwd = process.cwd(),
  home = process.env.HOME,
  color = !process.env.NO_COLOR && process.env.TERM !== 'dumb',
  ask,
}: InteractiveSessionOptions): Promise<number> {
  let interface_: readline.Interface | null = null
  let cancelled = false
  let activeRun = false
  const queuedInput: string[] = []
  let inputWaiter: ((value: string) => void) | null = null
  if (!ask) {
    interface_ = readline.createInterface({
      input: stdin,
      output: stdout,
      historySize: 200,
      removeHistoryDuplicates: true,
      completer: (line: string) => {
        const hits = COMMAND_NAMES.filter((command) => command.startsWith(line))
        return [hits.length ? hits : COMMAND_NAMES, line] as [string[], string]
      },
    })
    interface_.on('line', (line) => {
      if (inputWaiter) {
        const resolve = inputWaiter
        inputWaiter = null
        resolve(line)
        return
      }
      queuedInput.push(line)
      if (activeRun) stdout.write(`${paint('  ↳ queued for the next turn', DIM, color)}\n`)
    })
    interface_.on('SIGINT', () => {
      if (activeRun && process.listenerCount('SIGINT') > 0) {
        process.emit('SIGINT')
        return
      }
      cancelled = true
      const resolve = inputWaiter
      inputWaiter = null
      resolve?.('')
      interface_?.close()
    })
    ask = (prompt: string) => {
      const queued = queuedInput.shift()
      if (queued !== undefined) return queued
      stdout.write(prompt)
      return new Promise<string>((resolve) => { inputWaiter = resolve })
    }
  }

  let config = await app.config.get() as OrbitCliConfig
  let managedModel: OrbitManagedModelDescriptor = ORBIT_MANAGED_DEFAULT_MODEL
  let workspace = await canonicalDirectory(path.resolve(cwd), { create: true })
  let allowShell = false
  let generateImages = false
  let generate3d = false
  let attachments: string[] = []
  let projectThreads = await app.store.listThreads(workspace)
  let activeThread = projectThreads[0] || await app.store.createThread(workspace, 'New session')
  let lastRunId = String(activeThread.latestRunId || '')
  let operation: 'create' | 'edit' = lastRunId ? 'edit' : 'create'
  let webServer: any = null

  const refreshManagedModel = async (): Promise<void> => {
    if (config.mode !== 'orbit' || typeof app.apiFactory !== 'function') return
    const auth = await app.auth.status().catch(() => ({ signedIn: false }))
    if (!(auth.authenticated || auth.signedIn || auth.user)) return
    try {
      const api = app.apiFactory('cli')
      if (typeof api?.models === 'function') managedModel = managedOrbitModelFromCatalog(await api.models())
    } catch {}
  }

  const write = (value = '') => stdout.write(`${value}\n`)
  const showHeader = () => write(renderSessionHeader({
    config, workspace, home, allowShell, generateImages, generate3d, managedModel,
    columns: stdout.columns, color,
  }))

  const executeRun = async ({ prompt, resume = null, retryUnsafe = false }: { prompt?: string; resume?: OrbitRun | null; retryUnsafe?: boolean }): Promise<void> => {
    const progress = new ProgressLine(stdout, color)
    activeRun = true
    progress.start()
    try {
      const onProgress = (event: RunProgressEvent) => progress.update(event)
      const run = resume
        ? resume.kind === 'asset3d'
          ? await app.asset3d.resume(resume.id, { retryUnsafe })
          : resume.kind === 'assetimage'
            ? await app.assetImage.resume(resume.id, { retryUnsafe })
            : await app.manager.resume(resume.id, { retryUnsafe, allowShell, onProgress })
        : await app.manager.create({
            source: 'cli',
            prompt,
            workspace,
            operation,
            mode: config.mode,
            provider: config.provider,
            model: config.model,
            runtime: config.runtime,
            generateImages,
            generate3d,
            cloudLogs: config.cloudLogs,
            allowShell,
            referenceImages: attachments,
            threadId: activeThread.id,
            onProgress,
          })
      progress.stop()
      if (run.kind !== 'asset3d' && run.kind !== 'assetimage') {
        const nextWorkspace = await canonicalDirectory(run.workspace)
        const nextThreads = await app.store.listThreads(nextWorkspace)
        const link = typeof app.store.linkForRun === 'function' ? await app.store.linkForRun(run.id) : null
        const nextThread = link
          ? nextThreads.find((thread: any) => thread.id === link.threadId)
          : nextThreads.find((thread: any) => thread.id === activeThread.id) || (nextWorkspace === workspace ? activeThread : null)
        if (!nextThread) throw new Error(`Completed run ${run.id} has no session in its project`)
        workspace = nextWorkspace
        projectThreads = nextThreads
        activeThread = nextThread
        lastRunId = run.id
        operation = 'edit'
      } else lastRunId = run.id
      attachments = []
      write(runSummary(run, color))
    } finally {
      activeRun = false
      progress.stop()
    }
  }

  await refreshManagedModel()
  showHeader()
  try {
    while (!cancelled) {
      let input: string
      try {
        input = String(await ask('\n› ') || '').trim()
      } catch (error) {
        if (cancelled || (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_USE_AFTER_CLOSE')) break
        throw error
      }
      if (!input) continue

      if (!input.startsWith('/')) {
        try { await executeRun({ prompt: input }) } catch (error) {
          write(`${paint('! Could not start the run', YELLOW, color)}\n  ${publicError(error)}\n${paint('  Your request was not discarded; fix the issue and submit it again.', DIM, color)}`)
        }
        continue
      }

      const [rawCommand = '', ...args] = parseWords(input)
      const command = rawCommand.toLowerCase()
      try {
        if (command === '/' || command === '/help') write(renderCommandPalette(color))
        else if (command === '/quit' || command === '/exit') break
        else if (command === '/clear') {
          stdout.write('\u001b[2J\u001b[H')
          showHeader()
        } else if (command === '/status') {
          const auth = await app.auth.status().catch(() => ({ authenticated: false }))
          write([
            paint('Session status', BOLD, color),
            `  workspace   ${workspace}`,
            `  session     ${activeThread.title || 'Untitled'} · ${activeThread.id}`,
            `  mode        ${sessionMode(config, managedModel)}`,
            `  runtime     ${config.runtime}`,
            `  assets      images ${generateImages ? 'on' : 'off'} · 3d ${generate3d ? 'on' : 'off'}`,
            `  permission  shell ${allowShell ? 'on' : 'off'}`,
            `  account     ${auth.authenticated || auth.signedIn || auth.user ? 'signed in' : 'not signed in'}`,
            lastRunId ? paint(`  last run    ${lastRunId}`, DIM, color) : '',
          ].filter(Boolean).join('\n'))
        } else if (command === '/new' || command === '/workspace' || command === '/cd') {
          workspace = await canonicalDirectory(path.resolve(cwd, args.join(' ') || cwd), { create: true })
          projectThreads = await app.store.listThreads(workspace)
          activeThread = projectThreads[0] || await app.store.createThread(workspace, 'New session')
          lastRunId = String(activeThread.latestRunId || '')
          operation = lastRunId ? 'edit' : 'create'
          attachments = []
          write(`Workspace changed to ${workspace}`)
        } else if (command === '/sessions') {
          projectThreads = await app.store.listThreads(workspace)
          write([
            paint('Project sessions', BOLD, color),
            ...projectThreads.map((thread: any) => `  ${thread.id === activeThread.id ? '•' : ' '} ${thread.title || 'Untitled'}  ${thread.id}${thread.latestRunId ? `  ${thread.latestRunId}` : ''}`),
          ].join('\n'))
        } else if (command === '/session') {
          projectThreads = await app.store.listThreads(workspace)
          if (args[0] === 'new') {
            activeThread = await app.store.createThread(workspace, args.slice(1).join(' ') || 'New session')
          } else {
            const requested = args[0]
            if (!requested) throw new Error('Usage: /session new [title] | /session <id>')
            const matches = projectThreads.filter((thread: any) => thread.id === requested || thread.id.replace(/^thread_/, '').startsWith(requested))
            if (matches.length !== 1) throw new Error(matches.length ? `Session prefix is ambiguous: ${requested}` : `No session matches ${requested}`)
            activeThread = matches[0]
          }
          lastRunId = String(activeThread.latestRunId || '')
          operation = lastRunId ? 'edit' : 'create'
          attachments = []
          write(`Active session: ${activeThread.title || 'Untitled'} · ${activeThread.id}`)
        } else if (command === '/runs') {
          write(recentRuns(await app.store.list(), color))
        } else if (command === '/details') {
          const requested = args[0] || lastRunId
          if (!requested) throw new Error('Usage: /details [run-id]')
          const runs = await app.store.list() as OrbitRun[]
          const candidate = runs.find((run) => run.id === requested || runIdentifier(run).startsWith(requested))
          if (!candidate) throw new Error(`No run matches ${requested}`)
          write(runDetails(candidate, await app.store.events(candidate.id), color))
        } else if (command === '/resume') {
          const retryUnsafe = args.includes('--retry-unsafe')
          const requested = args.find((argument) => !argument.startsWith('--'))
          const runs = await app.store.list() as OrbitRun[]
          const candidate = requested
            ? runs.find((run) => run.id === requested || runIdentifier(run).startsWith(requested))
            : runs.find((run) => RESUMABLE_STATES.has(run.state))
          if (!candidate) throw new Error(requested ? `No run matches ${requested}` : 'No resumable local run was found')
          await executeRun({ resume: candidate, retryUnsafe })
        } else if (command === '/mode') {
          if (!['orbit', 'byok'].includes(args[0] || '')) throw new Error('Usage: /mode orbit|byok')
          config = await app.config.update({ mode: args[0] })
          await refreshManagedModel()
          write(`Mode set to ${sessionMode(config, managedModel)}`)
        } else if (command === '/provider') {
          if (!CODING_PROVIDER_IDS.includes(args[0] as any)) throw new Error(`Provider must be one of: ${CODING_PROVIDER_IDS.join(', ')}`)
          config = await app.config.update({ mode: 'byok', provider: args[0] })
          write(`Provider set to ${PROVIDERS[config.provider].label}`)
        } else if (command === '/model') {
          if (!args[0]) write(`Model: ${orbitCodingModelDisplay(config.mode, config.model, managedModel)}`)
          else {
            config = await app.config.update({ model: args[0] === 'auto' ? '' : args.join(' ') })
            write(`Model set to ${orbitCodingModelDisplay(config.mode, config.model, managedModel)}`)
          }
        } else if (command === '/runtime') {
          if (!RUNTIMES.has(args[0] || '')) throw new Error(`Runtime must be one of: ${[...RUNTIMES].join(', ')}`)
          config = await app.config.update({ runtime: args[0] })
          write(`Runtime set to ${config.runtime}`)
        } else if (command === '/images') {
          generateImages = enabled(args[0], 'images')
          write(`Image generation ${generateImages ? 'enabled' : 'disabled'}.`)
        } else if (command === '/3d') {
          generate3d = enabled(args[0], '3d')
          write(`3D generation ${generate3d ? 'enabled' : 'disabled'}.`)
        } else if (command === '/permissions') {
          if (!args.length) write(`Local project commands: ${allowShell ? 'enabled' : 'disabled'}\nUse /permissions shell on|off to change this session.`)
          else {
            if (args[0] !== 'shell') throw new Error('Usage: /permissions [shell on|off]')
            allowShell = enabled(args[1], 'permissions shell')
            write(`Local project commands ${allowShell ? 'enabled for this session' : 'disabled'}.`)
          }
        } else if (command === '/attach') {
          if (!args.length) throw new Error('Usage: /attach <image-path>')
          const attachment = path.resolve(cwd, args.join(' '))
          attachments.push(attachment)
          write(`Attached for the next request: ${attachment}`)
        } else if (command === '/web') {
          if (!webServer) {
            webServer = app.web()
            const started = await webServer.start({ open: true })
            write(`Web CLI is running at ${started.url}`)
          } else write('Web CLI is already running for this session.')
        } else if (command === '/login') {
          const result = await app.auth.login()
          await refreshManagedModel()
          write(result?.user?.email ? `Signed in as ${result.user.email}.` : 'Signed in to Orbit Cloud.')
        } else throw new Error(`Unknown command: ${rawCommand}. Type /help to see available commands.`)
      } catch (error) {
        write(`${paint('!', YELLOW, color)} ${publicError(error)}`)
      }
    }
  } finally {
    interface_?.close()
    if (webServer) await webServer.close().catch(() => undefined)
  }
  write(paint('Session closed. Local checkpoints were kept.', DIM, color))
  return 0
}
