const hash = new URLSearchParams(location.hash.slice(1))
const token = hash.get('token') || sessionStorage.getItem('orbit.cli.token') || ''
const csrf = hash.get('csrf') || sessionStorage.getItem('orbit.cli.csrf') || ''
if (hash.get('token') && hash.get('csrf')) {
  sessionStorage.setItem('orbit.cli.token', token)
  sessionStorage.setItem('orbit.cli.csrf', csrf)
}
history.replaceState(null, '', `${location.pathname}${location.search}`)

const $ = (id: string): any => document.getElementById(id)
let state: any = { runs: [], auth: { signedIn: false }, config: {} }
let publishRunId: string | null = null
const PUBLISH_LOCALE_CHOICES: ReadonlyArray<{ tag: string; label: string }> = Object.freeze([
  { tag: 'zh-Hans', label: '简体中文' },
  { tag: 'zh-Hant', label: '繁體中文' },
  { tag: 'ja', label: '日本語' },
  { tag: 'ko', label: '한국어' },
  { tag: 'es', label: 'Español' },
  { tag: 'es-MX', label: 'Español (México)' },
  { tag: 'fr', label: 'Français' },
  { tag: 'de', label: 'Deutsch' },
  { tag: 'it', label: 'Italiano' },
  { tag: 'pt-BR', label: 'Português (Brasil)' },
  { tag: 'ru', label: 'Русский' },
  { tag: 'ar', label: 'العربية' },
  { tag: 'hi', label: 'हिन्दी' },
  { tag: 'th', label: 'ไทย' },
  { tag: 'vi', label: 'Tiếng Việt' },
])
let publishLocales: string[] = []

function renderPublishLocaleChips(): void {
  const host = $('publish-locales')
  if (!host) return
  host.replaceChildren()
  const enChip = document.createElement('span')
  enChip.className = 'locale-chip locale-chip-en'
  enChip.textContent = 'English'
  host.append(enChip)
  const selected = new Set(publishLocales)
  for (const { tag, label } of PUBLISH_LOCALE_CHOICES) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'locale-chip'
    chip.textContent = label
    chip.dataset.tag = tag
    chip.setAttribute('aria-pressed', selected.has(tag) ? 'true' : 'false')
    chip.addEventListener('click', () => {
      const next = new Set(publishLocales)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      publishLocales = [...next].sort()
      renderPublishLocaleChips()
    })
    host.append(chip)
  }
}
let refreshPromise: Promise<any> | null = null
let configHydrated = false
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
}

function authView(): void {
  $('session-light').classList.toggle('online', state.auth.signedIn)
  $('session-label').textContent = state.auth.signedIn ? state.auth.email || 'Orbit account' : 'Signed out'
  $('auth-button').textContent = state.auth.signedIn ? 'Sign out' : 'Sign in'
}

function providerView(): void {
  const discoverable = state.providers?.some((provider: any) => provider.id === $('provider').value && provider.modelDiscovery)
  $('browse-models').disabled = !discoverable
  $('browse-models').title = discoverable ? 'Load tool-capable models from OpenRouter' : 'Enter a model ID from this provider'
  if (!discoverable) $('model-options').replaceChildren()
}

function providerOptions(): void {
  const providers = state.providers || []
  const key = JSON.stringify(providers.map(({ id, label, purpose }: any) => [id, label, purpose]))
  if (viewKeys.providers === key) return
  viewKeys.providers = key
  const codingValue = $('provider').value
  const keyValue = $('key-provider').value
  const option = (provider: any) => { const item = document.createElement('option'); item.value = provider.id; item.textContent = provider.label; return item }
  $('provider').replaceChildren(...providers.filter((provider: any) => provider.purpose === 'coding').map(option))
  $('key-provider').replaceChildren(...providers.map(option))
  if (providers.some((provider: any) => provider.id === codingValue && provider.purpose === 'coding')) $('provider').value = codingValue
  if (providers.some((provider: any) => provider.id === keyValue)) $('key-provider').value = keyValue
}

function runView(): void {
  const key = JSON.stringify(state.runs || [])
  if (viewKeys.runs === key) return
  viewKeys.runs = key
  $('runs').replaceChildren(...state.runs.map((run: any) => {
    const recoveryDisposition = run.recoveryDisposition || (run.unsafeResumeRequired
      ? 'confirmation_required'
      : ['queued', 'paused', 'interrupted'].includes(run.state) ? 'available' : null)
    const item = document.createElement('article'); item.className = 'run'
    const head = document.createElement('div'); head.className = 'run-head'
    const title = document.createElement('b'); title.textContent = `${run.kind === 'asset3d' ? '3D · ' : run.kind === 'assetimage' ? 'IMAGE · ' : ''}${run.displayName || run.folderName || run.id}`
    const badge = document.createElement('span'); badge.className = `state ${run.state}`; badge.textContent = run.state
    head.append(title, badge)
    const recoveryMeta = [run.failureCategory, recoveryDisposition].filter((value: any) => value && value !== 'none').join(' · ')
    const meta = document.createElement('code'); meta.textContent = `ID ${run.id} · ${run.mode} · ${run.runtime}${recoveryMeta ? ` · ${recoveryMeta}` : ''}`
    const detail = document.createElement('p'); detail.textContent = run.lastError?.message || run.result?.workspace || run.workspace
    const actions = document.createElement('div'); actions.className = 'run-actions'
    if (recoveryDisposition === 'available') actions.append(action('Resume', () => resume(run.id, false)))
    if (recoveryDisposition === 'confirmation_required') actions.append(action('Retry unsafe step', () => resume(run.id, true)))
    actions.append(action('Relocate folder', () => relocate(run.id, run.workspace)))
    if (run.state === 'completed' && !['asset3d', 'assetimage'].includes(run.kind)) {
      actions.append(action('Preview', () => preview(run.id)))
      actions.append(action('Publish', () => { publishRunId = run.id; $('publish-dialog').showModal(); renderPublishLocaleChips() }))
    }
    item.append(head, meta, detail, actions)
    return item
  }))
  if (!state.runs.length) { const empty = document.createElement('p'); empty.textContent = 'No local checkpoints yet.'; $('runs').append(empty) }
}

function action(label: string, onClick: () => void): HTMLButtonElement { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', onClick); return button }

for (const button of document.querySelectorAll<HTMLElement>('[data-preview-ratio]')) {
  button.addEventListener('click', () => {
    const ratio = button.dataset.previewRatio === '4:3' ? '4:3' : 'auto'
    $('preview-stage').dataset.ratio = ratio
    for (const item of document.querySelectorAll<HTMLElement>('[data-preview-ratio]')) item.classList.toggle('active', item === button)
  })
}

async function refresh(): Promise<any> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    const body = await api('/api/bootstrap')
    state = body
    authView()
    providerOptions()
    runView()
    if (!configHydrated) {
      $('cloudLogs').checked = Boolean(state.config.cloudLogs)
      const mode = document.querySelector<HTMLInputElement>(`input[name=mode][value=${state.config.mode || 'orbit'}]`)
      if (mode) mode.checked = true
      $('provider').value = state.config.provider || 'openrouter'
      $('runtime').value = state.config.runtime || 'html'
      $('model').value = state.config.model || ''
      configHydrated = true
    }
    providerView()
  })().finally(() => { refreshPromise = null })
  return refreshPromise
}

async function files(): Promise<Array<{ name: string; data: string }>> {
  return Promise.all(Array.from<File>($('references').files || []).map(async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    return { name: file.name, data: btoa(binary) }
  }))
}

$('references').addEventListener('change', () => { const names = Array.from<File>($('references').files || []).map((file) => file.name); $('reference-list').textContent = names.length ? names.join(' · ') : 'No images selected' })
$('provider').addEventListener('change', providerView)
$('browse-models').addEventListener('click', async () => {
  try {
    status('Loading tool-capable OpenRouter models…')
    const body = await api(`/api/provider/models?provider=${encodeURIComponent($('provider').value)}`)
    $('model-options').replaceChildren(...body.models.map((model: any) => {
      const option = document.createElement('option'); option.value = model.id; option.label = `${model.name}${model.vision ? ' · vision' : ''}`; return option
    }))
    status(`Loaded ${body.models.length} model choices; you can also enter a model ID directly`)
    $('model').focus()
  } catch (error) { status(errorMessage(error), true) }
})
$('auth-button').addEventListener('click', async () => { try { status(state.auth.signedIn ? 'Signing out…' : 'Complete sign-in in your browser…'); if (state.auth.signedIn) await api('/api/auth/logout', { method: 'POST', body: '{}' }); else await api('/api/auth/login', { method: 'POST', body: '{}' }); await refresh(); status('Session updated') } catch (error) { status(errorMessage(error), true) } })
$('save-key').addEventListener('click', async () => { try { status('Saving key to the OS credential vault…'); await api('/api/provider', { method: 'POST', body: JSON.stringify({ provider: $('key-provider').value, apiKey: $('api-key').value }) }); $('api-key').value = ''; status('Provider key saved locally') } catch (error) { status(errorMessage(error), true) } })
$('image-form').addEventListener('submit', async (event: Event) => { event.preventDefault(); try { status('Image generation running with a durable local checkpoint…'); const body = await api('/api/assets/image', { method: 'POST', body: JSON.stringify({ workspace: $('workspace').value, prompt: $('image-prompt').value, output: $('image-output').value, aspectRatio: $('image-aspect').value, cloudLogs: $('cloudLogs').checked }) }); status(`Image run ${body.run.state}: ${body.run.result?.relativePath || body.run.id}`); await refresh() } catch (error) { status(errorMessage(error), true) } })
$('asset-form').addEventListener('submit', async (event: Event) => { event.preventDefault(); try { status('3D generation running with a durable local checkpoint…'); const body = await api('/api/assets/3d', { method: 'POST', body: JSON.stringify({ workspace: $('workspace').value, prompt: $('asset-prompt').value, output: $('asset-output').value, mode: $('asset-mode').value, cloudLogs: $('cloudLogs').checked }) }); status(`3D run ${body.run.state}: ${body.run.result?.relativePath || body.run.id}`); await refresh() } catch (error) { status(errorMessage(error), true) } })
$('refresh-runs').addEventListener('click', () => refresh().catch((error) => status(errorMessage(error), true)))

$('run-form').addEventListener('submit', async (event: Event) => {
  event.preventDefault()
  try {
    const mode = document.querySelector<HTMLInputElement>('input[name=mode]:checked')?.value || 'orbit'
    status('Agent running. Every tool step is checkpointed locally…')
    const body = await api('/api/runs', { method: 'POST', body: JSON.stringify({
      prompt: $('prompt').value, workspace: $('workspace').value, mode, provider: $('provider').value,
      model: $('model').value, runtime: $('runtime').value, generateImages: $('generateImages').checked, generate3d: $('generate3d').checked,
      cloudLogs: $('cloudLogs').checked, allowShell: $('allowShell').checked, files: await files(),
    }) })
    await api('/api/config', { method: 'POST', body: JSON.stringify({ mode, provider: $('provider').value, model: $('model').value, runtime: $('runtime').value, cloudLogs: $('cloudLogs').checked }) })
    status(`Run ${body.run.state}: ${body.run.id}`)
    await refresh()
  } catch (error) { status(errorMessage(error), true) }
})

async function resume(runId: string, retryUnsafe: boolean): Promise<void> { try { status(`Resuming ${runId}…`); const body = await api(`/api/runs/${runId}/resume`, { method: 'POST', body: JSON.stringify({ retryUnsafe, allowShell: $('allowShell').checked }) }); status(`Run ${body.run.state}`); await refresh() } catch (error) { status(errorMessage(error), true) } }
async function relocate(runId: string, currentWorkspace: string): Promise<void> {
  const workspace = window.prompt('New absolute path for this moved workspace:', currentWorkspace || '')
  if (!workspace || workspace === currentWorkspace) return
  if (!window.confirm('Update every local checkpoint that points to this workspace? No project files will be moved.')) return
  try {
    status(`Relocating ${runId}…`)
    const result = await api(`/api/runs/${runId}/relocate`, { method: 'POST', body: JSON.stringify({ workspace }) })
    $('workspace').value = result.workspace
    status(`Updated ${result.updatedRunIds.length} checkpoint(s) to ${result.workspace}`)
    await refresh()
  } catch (error) { status(errorMessage(error), true) }
}
async function preview(runId: string): Promise<void> { try { const body = await api(`/api/runs/${runId}/preview`, { method: 'POST', body: '{}' }); if ($('preview').dataset.url !== body.url) { $('preview').src = body.url; $('preview').dataset.url = body.url } $('preview-state').textContent = runId } catch (error) { status(errorMessage(error), true) } }

$('publish-dialog').addEventListener('close', async () => {
  if ($('publish-dialog').returnValue !== 'confirm' || !publishRunId) return
  try { status('Publishing validated files under your Orbit account…'); const result = await api(`/api/runs/${publishRunId}/publish`, { method: 'POST', body: JSON.stringify({ confirmed: true, extraLocales: publishLocales }) }); status(`Published ${result.game?.title || result.game?.id}`) } catch (error) { status(errorMessage(error), true) } finally { publishRunId = null }
})

document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') $('run-form').requestSubmit() })
refresh().then(() => status('Ready')).catch((error) => status(errorMessage(error), true))
