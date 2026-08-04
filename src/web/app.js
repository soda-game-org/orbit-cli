const hash = new URLSearchParams(location.hash.slice(1))
const token = hash.get('token') || sessionStorage.getItem('orbit.cli.token') || ''
const csrf = hash.get('csrf') || sessionStorage.getItem('orbit.cli.csrf') || ''
if (hash.get('token') && hash.get('csrf')) {
  sessionStorage.setItem('orbit.cli.token', token)
  sessionStorage.setItem('orbit.cli.csrf', csrf)
}
history.replaceState(null, '', `${location.pathname}${location.search}`)

const $ = (id) => document.getElementById(id)
let state = { runs: [], auth: { signedIn: false }, config: {} }
let publishRunId = null

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json', ...options.headers },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body
}

function status(message, error = false) {
  $('status').textContent = message
  $('status').classList.toggle('error', error)
}

function authView() {
  $('session-light').classList.toggle('online', state.auth.signedIn)
  $('session-label').textContent = state.auth.signedIn ? state.auth.email || 'Orbit account' : 'Signed out'
  $('auth-button').textContent = state.auth.signedIn ? 'Sign out' : 'Sign in'
}

function providerView() {
  const discoverable = state.providers?.some((provider) => provider.id === $('provider').value && provider.modelDiscovery)
  $('browse-models').disabled = !discoverable
  $('browse-models').title = discoverable ? 'Load tool-capable models from OpenRouter' : 'Enter a model ID from this provider'
  if (!discoverable) $('model-options').replaceChildren()
}

function providerOptions() {
  const option = (provider) => { const item = document.createElement('option'); item.value = provider.id; item.textContent = provider.label; return item }
  $('provider').replaceChildren(...(state.providers || []).filter((provider) => provider.purpose === 'coding').map(option))
  $('key-provider').replaceChildren(...(state.providers || []).map(option))
}

function runView() {
  $('runs').replaceChildren(...state.runs.map((run) => {
    const item = document.createElement('article'); item.className = 'run'
    const head = document.createElement('div'); head.className = 'run-head'
    const title = document.createElement('b'); title.textContent = `${run.kind === 'asset3d' ? '3D · ' : ''}${run.prompt?.slice(0, 62) || 'Untitled run'}`
    const badge = document.createElement('span'); badge.className = `state ${run.state}`; badge.textContent = run.state
    head.append(title, badge)
    const meta = document.createElement('code'); meta.textContent = `${run.id} · ${run.mode} · ${run.runtime}`
    const detail = document.createElement('p'); detail.textContent = run.lastError?.message || run.result?.workspace || run.workspace
    const actions = document.createElement('div'); actions.className = 'run-actions'
    if (['paused', 'interrupted'].includes(run.state)) actions.append(action('Resume', () => resume(run.id, false)), ...(run.unsafeResumeRequired ? [action('Retry unsafe step', () => resume(run.id, true))] : []))
    if (run.state === 'completed' && run.kind !== 'asset3d') {
      actions.append(action('Preview', () => preview(run.id)))
      actions.append(action('Publish', () => { publishRunId = run.id; $('publish-dialog').showModal() }))
    }
    item.append(head, meta, detail, actions)
    return item
  }))
  if (!state.runs.length) { const empty = document.createElement('p'); empty.textContent = 'No local checkpoints yet.'; $('runs').append(empty) }
}

function action(label, onClick) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', onClick); return button }

async function refresh() {
  const body = await api('/api/bootstrap')
  state = body; authView(); runView()
  providerOptions()
  $('cloudLogs').checked = Boolean(state.config.cloudLogs)
  const mode = document.querySelector(`input[name=mode][value=${state.config.mode || 'orbit'}]`); if (mode) mode.checked = true
  $('provider').value = state.config.provider || 'openrouter'; $('runtime').value = state.config.runtime || 'html'; $('model').value = state.config.model || ''; providerView()
}

async function files() {
  return Promise.all(Array.from($('references').files || []).map(async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    return { name: file.name, data: btoa(binary) }
  }))
}

$('references').addEventListener('change', () => { const names = Array.from($('references').files || []).map((file) => file.name); $('reference-list').textContent = names.length ? names.join(' · ') : 'No images selected' })
$('provider').addEventListener('change', providerView)
$('browse-models').addEventListener('click', async () => {
  try {
    status('Loading tool-capable OpenRouter models…')
    const body = await api(`/api/provider/models?provider=${encodeURIComponent($('provider').value)}`)
    $('model-options').replaceChildren(...body.models.map((model) => {
      const option = document.createElement('option'); option.value = model.id; option.label = `${model.name}${model.vision ? ' · vision' : ''}`; return option
    }))
    status(`Loaded ${body.models.length} model choices; you can also enter a model ID directly`)
    $('model').focus()
  } catch (error) { status(error.message, true) }
})
$('auth-button').addEventListener('click', async () => { try { status(state.auth.signedIn ? 'Signing out…' : 'Complete sign-in in your browser…'); if (state.auth.signedIn) await api('/api/auth/logout', { method: 'POST', body: '{}' }); else await api('/api/auth/login', { method: 'POST', body: '{}' }); await refresh(); status('Session updated') } catch (error) { status(error.message, true) } })
$('save-key').addEventListener('click', async () => { try { status('Saving key to the OS credential vault…'); await api('/api/provider', { method: 'POST', body: JSON.stringify({ provider: $('key-provider').value, apiKey: $('api-key').value }) }); $('api-key').value = ''; status('Provider key saved locally') } catch (error) { status(error.message, true) } })
$('asset-form').addEventListener('submit', async (event) => { event.preventDefault(); try { status('3D generation running with a durable local checkpoint…'); const body = await api('/api/assets/3d', { method: 'POST', body: JSON.stringify({ workspace: $('workspace').value, prompt: $('asset-prompt').value, output: $('asset-output').value, mode: $('asset-mode').value, cloudLogs: $('cloudLogs').checked }) }); status(`3D run ${body.run.state}: ${body.run.result?.relativePath || body.run.id}`); await refresh() } catch (error) { status(error.message, true) } })
$('refresh-runs').addEventListener('click', () => refresh().catch((error) => status(error.message, true)))

$('run-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const mode = document.querySelector('input[name=mode]:checked').value
    status('Agent running. Every tool step is checkpointed locally…')
    const body = await api('/api/runs', { method: 'POST', body: JSON.stringify({
      prompt: $('prompt').value, workspace: $('workspace').value, mode, provider: $('provider').value,
      model: $('model').value, runtime: $('runtime').value, generate3d: $('generate3d').checked,
      cloudLogs: $('cloudLogs').checked, allowShell: $('allowShell').checked, files: await files(),
    }) })
    await api('/api/config', { method: 'POST', body: JSON.stringify({ mode, provider: $('provider').value, model: $('model').value, runtime: $('runtime').value, cloudLogs: $('cloudLogs').checked }) })
    status(`Run ${body.run.state}: ${body.run.id}`)
    await refresh()
  } catch (error) { status(error.message, true) }
})

async function resume(runId, retryUnsafe) { try { status(`Resuming ${runId}…`); const body = await api(`/api/runs/${runId}/resume`, { method: 'POST', body: JSON.stringify({ retryUnsafe, allowShell: $('allowShell').checked }) }); status(`Run ${body.run.state}`); await refresh() } catch (error) { status(error.message, true) } }
async function preview(runId) { try { const body = await api(`/api/runs/${runId}/preview`, { method: 'POST', body: '{}' }); $('preview').src = body.url; $('preview-state').textContent = runId } catch (error) { status(error.message, true) } }

$('publish-dialog').addEventListener('close', async () => {
  if ($('publish-dialog').returnValue !== 'confirm' || !publishRunId) return
  try { status('Publishing validated files under your Orbit account…'); const result = await api(`/api/runs/${publishRunId}/publish`, { method: 'POST', body: JSON.stringify({ confirmed: true }) }); status(`Published ${result.game?.title || result.game?.id}`) } catch (error) { status(error.message, true) } finally { publishRunId = null }
})

document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') $('run-form').requestSubmit() })
refresh().then(() => status('Ready')).catch((error) => status(error.message, true))
