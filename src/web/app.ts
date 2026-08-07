const hash = new URLSearchParams(location.hash.slice(1))
const token = hash.get('token') || sessionStorage.getItem('orbit.cli.token') || ''
const csrf = hash.get('csrf') || sessionStorage.getItem('orbit.cli.csrf') || ''
if (hash.get('token') && hash.get('csrf')) {
  sessionStorage.setItem('orbit.cli.token', token)
  sessionStorage.setItem('orbit.cli.csrf', csrf)
}
history.replaceState(null, '', `${location.pathname}${location.search}`)

const $ = (id: string): any => document.getElementById(id)
let state: any = { runs: [], auth: { signedIn: false }, account: { signedIn: false, cadeBalance: null, cadeBalanceState: 'unavailable' }, config: {}, providers: [], defaultWorkspace: '' }
let selectedWorkspace = ''
let selectedRunId = ''
let activePreviewRunId = ''
let activePreviewUrl = ''
let publishRunId: string | null = null
let refreshPromise: Promise<any> | null = null
let configHydrated = false
let running = false
let toastTimer: ReturnType<typeof setTimeout> | null = null
let progressNode: HTMLElement | null = null
const viewKeys = { providers: '', runs: '' }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function api(path: string, options: RequestInit = {}): Promise<any> {
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json', ...options.headers },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body
}

function status(message: string, error = false): void {
  $('status').textContent = message
  $('status').classList.toggle('error', error)
  $('status').classList.add('visible')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => $('status').classList.remove('visible'), error ? 8_000 : 3_600)
}

function authView(): void {
  $('session-light').classList.toggle('online', state.auth.signedIn)
  const cade = state.account?.cadeBalance
  $('session-label').textContent = state.auth.signedIn
    ? `${state.auth.email || 'Orbit account'}${cade == null ? '' : ` · ${cade} Cade`}`
    : 'Signed out'
  $('auth-button').textContent = state.auth.signedIn ? 'Sign out' : 'Sign in'
  $('account-button').hidden = !state.auth.signedIn
  $('billing-button').hidden = !state.auth.signedIn
  $('billing-button').classList.toggle('warning', ['low', 'exhausted'].includes(state.account?.cadeBalanceState))
}

function configured(providerId: string): boolean {
  return Boolean(state.providers?.find((provider: any) => provider.id === providerId)?.configured)
}

function providerView(): void {
  const providerId = $('provider').value
  const definition = state.providers?.find((provider: any) => provider.id === providerId)
  const discoverable = $('mode').value === 'byok' && definition?.modelDiscovery
  $('browse-models').disabled = !discoverable
  $('browse-models').title = discoverable ? 'Load tool-capable models from this provider' : 'Enter a model ID or use automatic selection'
  if (!discoverable) $('model-options').replaceChildren()
  document.body.classList.toggle('byok-mode', $('mode').value === 'byok')
  launchView()
}

function providerOptions(): void {
  const providers = state.providers || []
  const key = JSON.stringify(providers.map(({ id, label, purpose, configured: hasKey }: any) => [id, label, purpose, hasKey]))
  if (viewKeys.providers === key) return
  viewKeys.providers = key
  const codingValue = $('provider').value
  const keyValue = $('key-provider').value
  const option = (provider: any) => {
    const item = document.createElement('option')
    item.value = provider.id
    item.textContent = `${provider.label}${provider.configured ? ' · configured' : ''}`
    return item
  }
  $('provider').replaceChildren(...providers.filter((provider: any) => provider.purpose === 'coding').map(option))
  $('key-provider').replaceChildren(...providers.map(option))
  if (providers.some((provider: any) => provider.id === codingValue && provider.purpose === 'coding')) $('provider').value = codingValue
  else $('provider').value = state.config.provider || 'openrouter'
  if (providers.some((provider: any) => provider.id === keyValue)) $('key-provider').value = keyValue
  else $('key-provider').value = $('provider').value
}

function latestRun(runs: any[]): any | null {
  return [...runs].sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))[0] || null
}

function gameProjects(): Array<{ workspace: string; runs: any[]; latest: any }> {
  const byWorkspace = new Map<string, any[]>()
  for (const run of state.runs || []) {
    if (run.kind === 'asset3d' || run.kind === 'assetimage' || !run.workspace) continue
    const runs = byWorkspace.get(run.workspace) || []
    runs.push(run)
    byWorkspace.set(run.workspace, runs)
  }
  return [...byWorkspace.entries()]
    .map(([workspace, runs]) => ({ workspace, runs, latest: latestRun(runs) }))
    .sort((left, right) => String(right.latest?.updatedAt || '').localeCompare(String(left.latest?.updatedAt || '')))
}

function shortRunId(value: unknown): string {
  return String(value || '').replace(/^run_/, '').slice(0, 12)
}

function renderProjects(): void {
  const projects = gameProjects()
  const fragment = document.createDocumentFragment()
  if (!projects.length) {
    const empty = document.createElement('p')
    empty.className = 'project-empty'
    empty.textContent = 'Generated projects will stay here as local checkpoints.'
    fragment.append(empty)
  }
  for (const project of projects) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `workspace${project.workspace === selectedWorkspace ? ' active' : ''}`
    const top = document.createElement('span')
    top.className = 'workspace-top'
    const title = document.createElement('strong')
    title.textContent = project.latest.displayName || project.latest.folderName || project.latest.id
    const projectState = document.createElement('span')
    projectState.className = `project-state ${project.latest.state}`
    projectState.textContent = project.latest.state
    top.append(title, projectState)
    const id = document.createElement('span')
    id.className = 'project-id'
    id.textContent = `ID ${shortRunId(project.latest.id)} · ${project.latest.folderName || project.latest.runtime || 'html'}`
    const prompt = document.createElement('span')
    prompt.className = 'project-prompt'
    prompt.textContent = project.latest.prompt || project.workspace
    button.append(top, id, prompt)
    button.addEventListener('click', () => selectProject(project.workspace, project.latest.id))
    fragment.append(button)
  }
  $('projects').replaceChildren(fragment)
}

function recoveryDisposition(run: any): string | null {
  return run.recoveryDisposition || (run.unsafeResumeRequired
    ? 'confirmation_required'
    : ['queued', 'paused', 'interrupted'].includes(run.state) ? 'available' : null)
}

function action(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}

function detailsText(run: any): string {
  const details: string[] = []
  const todos = Array.isArray(run.plan?.todos) ? run.plan.todos : []
  if (todos.length) {
    details.push('Plan')
    for (const todo of todos) details.push(`${todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '·' : '○'} ${todo.title || todo.id || 'Task'}`)
  }
  if (run.result?.summary) details.push('', 'Summary', String(run.result.summary))
  if (run.lastValidation) details.push('', 'Validation', JSON.stringify(run.lastValidation, null, 2))
  return details.filter((line, index) => line || index > 0).join('\n')
}

function renderTurn(run: any): HTMLElement {
  const turn = document.createElement('article')
  turn.className = 'chat-turn'
  const prompt = document.createElement('div')
  prompt.className = 'message user'
  prompt.textContent = run.prompt || (run.kind === 'asset3d' ? 'Generate a 3D asset' : run.kind === 'assetimage' ? 'Generate an image' : 'Orbit run')

  const card = document.createElement('section')
  card.className = 'output-card'
  const head = document.createElement('div')
  head.className = 'output-card-head'
  const heading = document.createElement('div')
  const title = document.createElement('strong')
  title.textContent = run.state === 'completed' ? 'Game ready' : run.state === 'failed' ? 'Run failed' : run.state === 'paused' || run.state === 'interrupted' ? 'Run paused' : 'Local run'
  const subtitle = document.createElement('span')
  subtitle.textContent = `${run.mode || 'orbit'} · ${run.model || 'automatic model'} · ${run.runtime || 'html'}`
  heading.append(title, subtitle)
  const badge = document.createElement('b')
  badge.className = `state ${run.state}`
  badge.textContent = run.state
  head.append(heading, badge)

  const body = document.createElement('div')
  body.className = 'output-card-body'
  const summary = document.createElement('p')
  if (run.lastError?.message) summary.textContent = run.lastError.message
  else if (run.state === 'completed') summary.textContent = run.lastValidation?.ok ? 'Validation passed. The local build is ready to preview.' : 'The run completed and its checkpoint is available.'
  else summary.textContent = 'The local checkpoint is saved and will update when the run finishes.'
  const meta = document.createElement('p')
  meta.className = 'result-meta'
  meta.textContent = `${run.workspace || ''}\nID ${run.id}`
  const actions = document.createElement('div')
  actions.className = 'actions'
  const recovery = recoveryDisposition(run)
  if (recovery === 'available') actions.append(action('Resume', () => resume(run.id, false)))
  if (recovery === 'confirmation_required') actions.append(action('Retry unsafe step', () => resume(run.id, true)))
  actions.append(action('Relocate project', () => relocate(run.id, run.workspace)))
  if (run.state === 'completed' && !['asset3d', 'assetimage'].includes(run.kind)) {
    actions.append(action('Preview', () => preview(run.id)))
    actions.append(action('Publish', () => { publishRunId = run.id; $('publish-dialog').showModal() }))
  }
  body.append(summary, meta, actions)
  const expanded = detailsText(run)
  if (expanded) {
    const details = document.createElement('details')
    details.className = 'completed-trace'
    const detailsSummary = document.createElement('summary')
    detailsSummary.textContent = 'Show completed process'
    const pre = document.createElement('pre')
    pre.textContent = expanded
    details.append(detailsSummary, pre)
    body.append(details)
  }
  card.append(head, body)
  turn.append(prompt, card)
  return turn
}

function renderThread(): void {
  const runs = selectedWorkspace
    ? (state.runs || []).filter((run: any) => run.workspace === selectedWorkspace)
    : []
  runs.sort((left: any, right: any) => String(left.createdAt || left.updatedAt || '').localeCompare(String(right.createdAt || right.updatedAt || '')))
  if (!runs.length) {
    const empty = document.createElement('div')
    empty.className = 'empty-thread'
    const title = document.createElement('h2')
    title.textContent = 'Start by describing a game.'
    const detail = document.createElement('p')
    detail.textContent = 'The result, validation, local files, and preview will appear here.'
    empty.append(title, detail)
    $('thread').replaceChildren(empty)
    progressNode = null
    return
  }
  $('thread').replaceChildren(...runs.map(renderTurn))
  progressNode = null
  $('thread').scrollTop = $('thread').scrollHeight
}

function renderSelection(): void {
  const selectedRuns = selectedWorkspace ? (state.runs || []).filter((run: any) => run.workspace === selectedWorkspace) : []
  const selected = selectedRuns.find((run: any) => run.id === selectedRunId) || latestRun(selectedRuns)
  $('thread-title').textContent = selected ? selected.displayName || selected.folderName || 'Local game' : 'New game'
  $('thread-meta').textContent = selected
    ? `${selected.mode || 'orbit'} · ${selected.model || 'automatic model'} · ${selected.runtime || 'html'}`
    : accessLabel()
  $('prompt').placeholder = selected ? 'Describe a change to make…' : 'Describe a game to generate…'
  $('workspace').readOnly = Boolean(selectedWorkspace)
  launchView()
}

function runView(): void {
  const key = JSON.stringify({ runs: state.runs || [], selectedWorkspace, selectedRunId })
  if (viewKeys.runs === key) return
  viewKeys.runs = key
  if (selectedWorkspace && !(state.runs || []).some((run: any) => run.workspace === selectedWorkspace)) {
    selectedWorkspace = ''
    selectedRunId = ''
  }
  renderProjects()
  renderThread()
  renderSelection()
}

function accessLabel(): string {
  if ($('mode')?.value === 'byok') {
    const provider = state.providers?.find((item: any) => item.id === $('provider').value)
    return provider?.configured ? `BYOK · ${provider.label}` : `BYOK · ${provider?.label || 'provider'} key required`
  }
  return state.auth.signedIn ? 'Orbit Cloud · automatic model' : 'Orbit Cloud · sign in required'
}

function launchView(): void {
  if (!$('launch')) return
  const editing = Boolean(selectedWorkspace)
  let label = editing ? 'Apply' : 'Generate'
  let needsAccess = false
  if ($('mode').value === 'orbit' && !state.auth.signedIn) {
    label = editing ? 'Sign in to apply' : 'Sign in to generate'
    needsAccess = true
  } else if ($('mode').value === 'byok' && !configured($('provider').value)) {
    label = `Add ${state.providers?.find((provider: any) => provider.id === $('provider').value)?.label || 'provider'} key`
    needsAccess = true
  }
  $('launch').textContent = running ? 'Working…' : label
  $('launch').disabled = running
  $('launch').classList.toggle('needs-access', needsAccess)
  if (!selectedWorkspace) $('thread-meta').textContent = accessLabel()
}

function selectProject(workspace: string, runId = ''): void {
  selectedWorkspace = workspace
  selectedRunId = runId
  $('workspace').value = workspace
  viewKeys.runs = ''
  runView()
  const completed = latestRun((state.runs || []).filter((run: any) => run.workspace === workspace && run.state === 'completed' && !['asset3d', 'assetimage'].includes(run.kind)))
  if (completed) preview(completed.id).catch((error) => status(errorMessage(error), true))
}

function newGame(): void {
  selectedWorkspace = ''
  selectedRunId = ''
  $('workspace').value = state.defaultWorkspace || ''
  $('prompt').value = ''
  $('references').value = ''
  $('reference-list').textContent = 'No images'
  activePreviewRunId = ''
  activePreviewUrl = ''
  $('preview').removeAttribute('src')
  $('preview').dataset.url = ''
  $('preview-stage').classList.remove('has-preview')
  $('preview-state').textContent = 'Select a completed project'
  viewKeys.runs = ''
  runView()
  $('prompt').focus()
}

async function refresh(): Promise<any> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    const body = await api('/api/bootstrap')
    state = body
    authView()
    providerOptions()
    if (!configHydrated) {
      $('cloudLogs').checked = Boolean(state.config.cloudLogs)
      $('mode').value = state.config.mode || 'orbit'
      $('provider').value = state.config.provider || 'openrouter'
      $('key-provider').value = state.config.provider || 'openrouter'
      $('runtime').value = state.config.runtime || 'html'
      $('model').value = state.config.model || ''
      if (!$('workspace').value) $('workspace').value = state.defaultWorkspace || ''
      configHydrated = true
    }
    providerView()
    viewKeys.runs = ''
    runView()
  })().finally(() => { refreshPromise = null })
  return refreshPromise
}

async function files(): Promise<Array<{ name: string; data: string }>> {
  return Promise.all(Array.from<File>($('references').files || []).map(async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    return { name: file.name, data: btoa(binary) }
  }))
}

async function ensureOrbitAuth(): Promise<boolean> {
  if (state.auth.signedIn) return true
  status('Complete Orbit sign-in in your browser…')
  await api('/api/auth/login', { method: 'POST', body: '{}' })
  await refresh()
  if (!state.auth.signedIn) throw new Error('Orbit sign-in did not complete')
  return true
}

async function ensureRunAccess(): Promise<boolean> {
  if ($('mode').value === 'orbit') return ensureOrbitAuth()
  const providerId = $('provider').value
  if (configured(providerId)) return true
  $('settings').open = true
  $('key-provider').value = providerId
  $('api-key').focus()
  status(`Add a ${state.providers?.find((provider: any) => provider.id === providerId)?.label || providerId} key to continue`, true)
  return false
}

function progressLabel(event: any): string {
  if (event.type === 'run_started') return 'Starting the local agent'
  if (event.type === 'reference_analysis_completed') return 'References understood'
  if (event.type === 'model_started') return `Thinking · pass ${event.iteration || 1}`
  if (event.type === 'provider_retry') return 'Provider busy · retrying'
  if (event.type === 'tool_started') {
    const labels: Record<string, string> = {
      update_agent_plan: 'Planning the build', list_files: 'Inspecting the workspace', grep_files: 'Searching the workspace',
      read_file: 'Reading project files', write_file: 'Writing project files', edit_file: 'Editing project files',
      apply_patch: 'Applying project changes', shell: 'Running a project command', generate_image: 'Generating game artwork',
      generate_3d_model: 'Generating a 3D asset', validate_project: 'Validating the game', finish: 'Preparing the summary',
    }
    return labels[String(event.toolName)] || `Running ${event.toolName || 'a tool'}`
  }
  return 'Agent working'
}

function updateProgress(message: string): void {
  if (!progressNode) {
    progressNode = document.createElement('div')
    progressNode.className = 'activity live-progress'
    $('thread').append(progressNode)
  }
  progressNode.textContent = message
  $('thread').scrollTop = $('thread').scrollHeight
}

async function streamRun(payload: Record<string, unknown>): Promise<any> {
  const response = await fetch('/api/runs/stream', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `Request failed (${response.status})`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed: any = null
  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.type === 'progress') updateProgress(progressLabel(message.event))
      else if (message.type === 'complete') completed = message.run
      else if (message.type === 'error') throw new Error(message.error || 'The local run failed')
    }
    if (done) break
  }
  if (buffer.trim()) {
    const message = JSON.parse(buffer)
    if (message.type === 'complete') completed = message.run
    if (message.type === 'error') throw new Error(message.error || 'The local run failed')
  }
  if (!completed) throw new Error('The local run ended without a final checkpoint')
  return completed
}

async function submitRun(): Promise<void> {
  if (!await ensureRunAccess()) return
  const mode = $('mode').value
  running = true
  launchView()
  updateProgress('Starting the local agent')
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ mode, provider: $('provider').value, model: $('model').value, runtime: $('runtime').value, cloudLogs: $('cloudLogs').checked }) })
    const run = await streamRun({
      prompt: $('prompt').value,
      workspace: $('workspace').value,
      operation: selectedWorkspace ? 'edit' : 'create',
      mode,
      provider: $('provider').value,
      model: $('model').value,
      runtime: $('runtime').value,
      generateImages: $('generateImages').checked,
      generate3d: $('generate3d').checked,
      cloudLogs: $('cloudLogs').checked,
      allowShell: $('allowShell').checked,
      files: await files(),
    })
    selectedWorkspace = run.workspace || $('workspace').value
    selectedRunId = run.id
    $('prompt').value = ''
    $('references').value = ''
    $('reference-list').textContent = 'No images'
    await refresh()
    status(run.state === 'completed' ? 'Game ready' : `Run ${run.state}`)
    if (run.state === 'completed') await preview(run.id)
  } finally {
    running = false
    progressNode?.remove()
    progressNode = null
    launchView()
  }
}

async function resume(runId: string, retryUnsafe: boolean): Promise<void> {
  try {
    running = true
    launchView()
    updateProgress(`Resuming ${shortRunId(runId)}`)
    const body = await api(`/api/runs/${runId}/resume`, { method: 'POST', body: JSON.stringify({ retryUnsafe, allowShell: $('allowShell').checked }) })
    selectedWorkspace = body.run.workspace || selectedWorkspace
    selectedRunId = body.run.id
    await refresh()
    status(`Run ${body.run.state}`)
  } catch (error) {
    status(errorMessage(error), true)
  } finally {
    running = false
    progressNode?.remove()
    progressNode = null
    launchView()
  }
}

async function relocate(runId: string, currentWorkspace: string): Promise<void> {
  const workspace = window.prompt('New absolute path for this moved workspace:', currentWorkspace || '')
  if (!workspace || workspace === currentWorkspace) return
  if (!window.confirm('Update every local checkpoint that points to this workspace? No project files will be moved.')) return
  try {
    const result = await api(`/api/runs/${runId}/relocate`, { method: 'POST', body: JSON.stringify({ workspace }) })
    selectedWorkspace = result.workspace
    $('workspace').value = result.workspace
    await refresh()
    status(`Updated ${result.updatedRunIds.length} checkpoint(s)`)
  } catch (error) {
    status(errorMessage(error), true)
  }
}

async function preview(runId: string): Promise<void> {
  const body = await api(`/api/runs/${runId}/preview`, { method: 'POST', body: '{}' })
  activePreviewRunId = runId
  activePreviewUrl = body.url
  if ($('preview').dataset.url !== body.url) {
    $('preview').src = body.url
    $('preview').dataset.url = body.url
  }
  $('preview-stage').classList.add('has-preview')
  $('preview-state').textContent = `Run ${shortRunId(runId)}`
}

$('new-chat').addEventListener('click', newGame)
$('references').addEventListener('change', () => {
  const names = Array.from<File>($('references').files || []).map((file) => file.name)
  $('reference-list').textContent = names.length ? names.join(' · ') : 'No images'
})
$('mode').addEventListener('change', providerView)
$('provider').addEventListener('change', () => {
  $('key-provider').value = $('provider').value
  providerView()
})
$('browse-models').addEventListener('click', async () => {
  try {
    status('Loading available models…')
    const body = await api(`/api/provider/models?provider=${encodeURIComponent($('provider').value)}`)
    $('model-options').replaceChildren(...body.models.map((model: any) => {
      const option = document.createElement('option')
      option.value = model.id
      option.label = `${model.name}${model.vision ? ' · vision' : ''}`
      return option
    }))
    status(`Loaded ${body.models.length} model choices`)
    $('model').focus()
  } catch (error) { status(errorMessage(error), true) }
})
$('auth-button').addEventListener('click', async () => {
  try {
    if (state.auth.signedIn) await api('/api/auth/logout', { method: 'POST', body: '{}' })
    else await ensureOrbitAuth()
    await refresh()
    status(state.auth.signedIn ? 'Signed in' : 'Signed out')
  } catch (error) { status(errorMessage(error), true) }
})
$('account-button').addEventListener('click', async () => {
  try {
    await api('/api/account/open', { method: 'POST', body: '{}' })
    status('Opened Orbit account center')
  } catch (error) { status(errorMessage(error), true) }
})
$('billing-button').addEventListener('click', async () => {
  try {
    await api('/api/account/billing', { method: 'POST', body: '{}' })
    status('Opened Orbit billing')
  } catch (error) { status(errorMessage(error), true) }
})
$('save-key').addEventListener('click', async () => {
  try {
    await api('/api/provider', { method: 'POST', body: JSON.stringify({ provider: $('key-provider').value, apiKey: $('api-key').value }) })
    $('api-key').value = ''
    await refresh()
    status('Provider key saved in the OS credential vault')
  } catch (error) { status(errorMessage(error), true) }
})
$('refresh-runs').addEventListener('click', () => refresh().then(() => status('Projects refreshed')).catch((error) => status(errorMessage(error), true)))

$('run-form').addEventListener('submit', async (event: Event) => {
  event.preventDefault()
  if (running) return
  try { await submitRun() } catch (error) { status(errorMessage(error), true) }
})

$('generate-image-asset').addEventListener('click', async () => {
  try {
    await ensureOrbitAuth()
    status('Generating image…')
    const body = await api('/api/assets/image', { method: 'POST', body: JSON.stringify({ workspace: $('workspace').value, prompt: $('image-prompt').value, output: $('image-output').value, aspectRatio: $('image-aspect').value, cloudLogs: $('cloudLogs').checked }) })
    status(`Image run ${body.run.state}`)
    await refresh()
  } catch (error) { status(errorMessage(error), true) }
})

$('generate-3d-asset').addEventListener('click', async () => {
  try {
    const mode = $('asset-mode').value
    if (mode === 'orbit') await ensureOrbitAuth()
    else if (!configured('replicate')) {
      $('key-provider').value = 'replicate'
      $('settings').open = true
      $('api-key').focus()
      throw new Error('Add a Replicate key before generating a BYOK 3D model')
    }
    status('Generating 3D model…')
    const body = await api('/api/assets/3d', { method: 'POST', body: JSON.stringify({ workspace: $('workspace').value, prompt: $('asset-prompt').value, output: $('asset-output').value, mode, cloudLogs: $('cloudLogs').checked }) })
    status(`3D run ${body.run.state}`)
    await refresh()
  } catch (error) { status(errorMessage(error), true) }
})

for (const button of document.querySelectorAll<HTMLElement>('[data-preview-ratio]')) {
  button.addEventListener('click', () => {
    const ratio = ['phone', '4:3', 'pc'].includes(button.dataset.previewRatio || '') ? button.dataset.previewRatio! : 'phone'
    $('preview-stage').dataset.ratio = ratio
    for (const item of document.querySelectorAll<HTMLElement>('[data-preview-ratio]')) item.classList.toggle('active', item === button)
  })
}
$('refresh-preview').addEventListener('click', () => {
  if (!activePreviewRunId) return status('Select a completed project first', true)
  preview(activePreviewRunId).then(() => status('Preview refreshed')).catch((error) => status(errorMessage(error), true))
})
$('open-preview').addEventListener('click', () => {
  if (!activePreviewUrl) return status('Select a completed project first', true)
  window.open(activePreviewUrl, '_blank', 'noopener,noreferrer')
})

$('publish-dialog').addEventListener('close', async () => {
  if ($('publish-dialog').returnValue !== 'confirm' || !publishRunId) return
  try {
    await ensureOrbitAuth()
    status('Publishing validated files…')
    const result = await api(`/api/runs/${publishRunId}/publish`, { method: 'POST', body: JSON.stringify({ confirmed: true }) })
    status(`Published ${result.game?.title || result.game?.id}`)
  } catch (error) { status(errorMessage(error), true) } finally { publishRunId = null }
})

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') $('run-form').requestSubmit()
})

refresh().then(() => status('Ready')).catch((error) => status(errorMessage(error), true))
