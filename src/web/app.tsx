import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Accordion } from '@heroui/react/accordion'
import { Button } from '@heroui/react/button'
import { Modal } from '@heroui/react/modal'
import { Spinner } from '@heroui/react/spinner'
import { Tooltip } from '@heroui/react/tooltip'
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleUserRound,
  Coins,
  Folder,
  FolderOpen,
  FolderPlus,
  Gamepad2,
  ImagePlus,
  KeyRound,
  LoaderCircle,
  LogOut,
  MessageSquarePlus,
  Monitor,
  Play,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  SquarePen,
  Square,
  Tablet,
  Upload,
  PackageOpen,
  PanelLeftClose,
  PanelLeftOpen,
  WandSparkles,
  X,
} from 'lucide-react'
import { ORBIT_WORDMARK_SRC } from './orbit-brand.js'
import './app.css'
import { mergeRunDelta } from './state.mjs'

type AnyRecord = Record<string, any>
type OrbitModel = { id: string; label: string; vision?: boolean }
type OrbitState = {
  runs: AnyRecord[]
  threads: AnyRecord[]
  auth: AnyRecord
  account: AnyRecord
  config: AnyRecord
  providers: AnyRecord[]
  managedModel: OrbitModel
  orbitModels: OrbitModel[]
  defaultWorkspace: string
}

const hash = new URLSearchParams(location.hash.slice(1))
const token = hash.get('token') || sessionStorage.getItem('orbit.cli.token') || ''
const csrf = hash.get('csrf') || sessionStorage.getItem('orbit.cli.csrf') || ''
if (hash.get('token') && hash.get('csrf')) {
  sessionStorage.setItem('orbit.cli.token', token)
  sessionStorage.setItem('orbit.cli.csrf', csrf)
}
history.replaceState(null, '', `${location.pathname}${location.search}`)

const EMPTY_STATE: OrbitState = {
  runs: [], threads: [], auth: { signedIn: false, checked: false },
  account: { signedIn: false, cadeBalance: null, cadeBalanceState: 'unavailable' },
  config: {}, providers: [], managedModel: { id: '', label: 'Orbit Cloud model' }, orbitModels: [], defaultWorkspace: '',
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shortId(value: unknown, prefix = ''): string {
  return String(value || '').replace(prefix, '').slice(0, 10)
}

function latestRun(runs: AnyRecord[]): AnyRecord | null {
  return [...runs].sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0] || null
}

function runStateLabel(value: unknown): string {
  const text = String(value || 'new')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function App() {
  const [state, setState] = useState<OrbitState>(EMPTY_STATE)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [running, setRunning] = useState(false)
  const [selectedWorkspace, setSelectedWorkspace] = useState('')
  const [selectedThreadId, setSelectedThreadId] = useState('')
  const [selectedRunId, setSelectedRunId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [references, setReferences] = useState<File[]>([])
  const [workspace, setWorkspace] = useState('')
  const [mode, setMode] = useState<'orbit' | 'byok'>('orbit')
  const [provider, setProvider] = useState('openrouter')
  const [model, setModel] = useState('')
  const [runtime, setRuntime] = useState('auto')
  const [generateImages, setGenerateImages] = useState(false)
  const [generate3d, setGenerate3d] = useState(false)
  const [allowShell, setAllowShell] = useState(false)
  const [cloudLogs, setCloudLogs] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newGameOpen, setNewGameOpen] = useState(false)
  const [newGameWorkspace, setNewGameWorkspace] = useState('')
  const [publishRun, setPublishRun] = useState<AnyRecord | null>(null)
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null)
  const [progress, setProgress] = useState('')
  const [preview, setPreview] = useState<{ runId: string; url: string } | null>(null)
  const [previewRatio, setPreviewRatio] = useState<'phone' | '4:3' | 'pc'>('phone')
  const [keyProvider, setKeyProvider] = useState('openrouter')
  const [apiKey, setApiKey] = useState('')
  const [imagePrompt, setImagePrompt] = useState('')
  const [imageAspect, setImageAspect] = useState('1:1')
  const [imageOutput, setImageOutput] = useState('assets/images/generated.png')
  const [assetPrompt, setAssetPrompt] = useState('')
  const [assetMode, setAssetMode] = useState<'orbit' | 'byok'>('orbit')
  const [assetOutput, setAssetOutput] = useState('assets/models/generated.glb')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('orbit.cli.sidebar.collapsed') === '1')
  const navigation = useRef(0)
  const toastTimer = useRef<number | null>(null)
  const accountMenuRef = useRef<HTMLDetailsElement | null>(null)
  const settingsAccessAttempted = useRef(false)

  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), error ? 8_000 : 3_600)
  }, [])

  const applyRunDelta = useCallback((delta: AnyRecord) => {
    setState((current) => mergeRunDelta(current, delta))
  }, [])

  const refresh = useCallback(async (preserveAccess = true) => {
    setRefreshing(true)
    try {
      const body = await api('/api/bootstrap') as OrbitState
      setState((current) => ({
        ...body,
        auth: preserveAccess && current.auth.checked ? current.auth : body.auth,
        account: preserveAccess && current.auth.checked ? current.account : body.account,
        managedModel: preserveAccess && current.auth.signedIn ? current.managedModel : body.managedModel,
        orbitModels: preserveAccess && current.orbitModels.length ? current.orbitModels : body.orbitModels || [],
        providers: (body.providers || []).map((item) => {
          const previous = current.providers.find((candidate) => candidate.id === item.id)
          return { ...item, configured: typeof previous?.configured === 'boolean' ? previous.configured : item.configured }
        }),
      }))
      if (loading) {
        setMode(body.config?.mode === 'byok' ? 'byok' : 'orbit')
        setProvider(body.config?.provider || 'openrouter')
        setKeyProvider(body.config?.provider || 'openrouter')
        setModel(body.config?.model || '')
        setRuntime(body.config?.runtime || 'auto')
        setCloudLogs(Boolean(body.config?.cloudLogs))
        setWorkspace(body.defaultWorkspace || '')
        setNewGameWorkspace(body.defaultWorkspace || '')
      }
      return body
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [loading])

  useEffect(() => {
    refresh(false).catch((error) => notify(errorMessage(error), true))
    return () => { if (toastTimer.current) window.clearTimeout(toastTimer.current) }
  }, [])

  useEffect(() => {
    const closeAccountMenu = (event: PointerEvent | KeyboardEvent) => {
      const menu = accountMenuRef.current
      if (!menu?.open) return
      if (event instanceof KeyboardEvent && event.key === 'Escape') {
        event.preventDefault()
        menu.removeAttribute('open')
        menu.querySelector<HTMLElement>('summary')?.focus()
        return
      }
      if (event instanceof PointerEvent && event.target instanceof Node && !menu.contains(event.target)) menu.removeAttribute('open')
    }
    document.addEventListener('pointerdown', closeAccountMenu, true)
    document.addEventListener('keydown', closeAccountMenu, true)
    return () => {
      document.removeEventListener('pointerdown', closeAccountMenu, true)
      document.removeEventListener('keydown', closeAccountMenu, true)
    }
  }, [])

  const threadRuns = useCallback((thread: AnyRecord): AnyRecord[] => {
    const ids = new Set(Array.isArray(thread?.runIds) ? thread.runIds : [])
    return state.runs.filter((run) => ids.has(run.id))
  }, [state.runs])

  const activeThread = state.threads.find((thread) => thread.id === selectedThreadId) || null
  const activeRuns = activeThread ? threadRuns(activeThread).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) : []
  const activeRun = activeRuns.find((run) => run.id === selectedRunId) || latestRun(activeRuns)

  const projects = useMemo(() => {
    const groups = new Map<string, AnyRecord[]>()
    for (const thread of state.threads) {
      if (!thread.workspace || thread.kind !== 'assets' && threadRuns(thread).length === 0) continue
      groups.set(thread.workspace, [...(groups.get(thread.workspace) || []), thread])
    }
    return [...groups.entries()].map(([projectWorkspace, threads]) => {
      const runs = threads.flatMap(threadRuns)
      const latest = latestRun(runs)
      return {
        workspace: projectWorkspace,
        folderName: latest?.folderName || projectWorkspace.split(/[\\/]/).filter(Boolean).at(-1) || 'Game',
        gameName: latest?.gameName || '', latest, threads: [...threads].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
      }
    }).sort((a, b) => String(b.latest?.updatedAt || '').localeCompare(String(a.latest?.updatedAt || '')))
  }, [state.threads, state.runs, threadRuns])

  const managedLabel = state.managedModel?.label || state.managedModel?.id || 'Orbit Cloud model'
  const configured = (id: string): boolean | null => {
    const value = state.providers.find((item) => item.id === id)?.configured
    return value === true ? true : value === false ? false : null
  }

  const refreshAccount = async () => {
    notify('Checking the saved Orbit session…')
    const body = await api('/api/access/status')
    setState((current) => ({ ...current, auth: body.auth, account: body.account, managedModel: body.managedModel || current.managedModel, orbitModels: body.orbitModels || [] }))
    if (body.auth?.signedIn) notify(`Loaded ${(body.orbitModels || []).length} Orbit models`)
    else notify('No saved Orbit session found')
    return body.auth?.signedIn === true
  }

  useEffect(() => {
    if (!settingsOpen || mode !== 'orbit' || state.auth.checked || settingsAccessAttempted.current) return
    settingsAccessAttempted.current = true
    notify('Checking the saved Orbit session once to load available models…')
    refreshAccount().catch((error) => notify(errorMessage(error), true))
  }, [settingsOpen, mode, state.auth.checked])

  const ensureOrbitAuth = async (): Promise<boolean> => {
    if (!state.auth.checked && await refreshAccount()) return true
    if (state.auth.signedIn) return true
    notify('Complete Orbit sign-in in your browser…')
    await api('/api/auth/login', { method: 'POST', body: '{}' })
    const signedIn = await refreshAccount()
    if (!signedIn) throw new Error('Orbit sign-in was not completed')
    return true
  }

  const closeAccountMenu = () => accountMenuRef.current?.removeAttribute('open')

  const signOut = async () => {
    closeAccountMenu()
    await api('/api/auth/logout', { method: 'POST', body: '{}' })
    setState((current) => ({ ...current, auth: { signedIn: false, checked: true }, account: EMPTY_STATE.account }))
    notify('Signed out')
  }

  const loadOrbitModels = async (force = true) => {
    if (!await ensureOrbitAuth()) return
    if (!force && state.orbitModels.length) return
    notify('Loading the Orbit model catalog…')
    const body = await api('/api/orbit/models')
    setState((current) => ({ ...current, managedModel: body.managedModel || current.managedModel, orbitModels: body.models || [] }))
    notify(`Loaded ${(body.models || []).length} Orbit models`)
  }

  const checkProvider = async (id: string): Promise<boolean> => {
    const existing = configured(id)
    if (existing !== null) return existing
    notify(`Checking the saved ${state.providers.find((item) => item.id === id)?.label || id} key…`)
    const body = await api(`/api/provider/status?provider=${encodeURIComponent(id)}`)
    setState((current) => ({ ...current, providers: current.providers.map((item) => item.id === id ? { ...item, configured: body.configured === true } : item) }))
    return body.configured === true
  }

  const loadByokModels = async () => {
    if (!await checkProvider(provider)) {
      setKeyProvider(provider); setSettingsOpen(true)
      throw new Error(`Add a ${state.providers.find((item) => item.id === provider)?.label || provider} key first`)
    }
    notify('Loading provider models…')
    const body = await api(`/api/provider/models?provider=${encodeURIComponent(provider)}`)
    setState((current) => ({ ...current, providers: current.providers.map((item) => item.id === provider ? { ...item, models: body.models || [] } : item) }))
    notify(`Loaded ${(body.models || []).length} provider models`)
  }

  const selectProject = async (projectWorkspace: string, thread: AnyRecord) => {
    navigation.current += 1
    setSelectedWorkspace(projectWorkspace)
    setSelectedThreadId(thread.id)
    const latest = latestRun(threadRuns(thread))
    setSelectedRunId(latest?.id || '')
    setWorkspace(projectWorkspace)
    setPrompt('')
    if (latest?.previewReady) await openPreview(latest.id, false)
    else setPreview(null)
  }

  const startNewTask = () => {
    if (!selectedWorkspace) return notify('Open a game before starting a new task', true)
    navigation.current += 1
    setSelectedThreadId('')
    setSelectedRunId('')
    setPrompt('')
    setPreview(null)
    notify('New task ready — it will edit the same game with fresh context')
  }

  const confirmNewGame = () => {
    const value = newGameWorkspace.trim()
    if (!value) return notify('Choose a local workspace for the new game', true)
    navigation.current += 1
    setSelectedWorkspace('')
    setSelectedThreadId('')
    setSelectedRunId('')
    setWorkspace(value)
    setPrompt('')
    setReferences([])
    setPreview(null)
    setNewGameOpen(false)
    notify('New game ready — describe what you want to build')
  }

  const filePayload = async () => Promise.all(references.map(async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    return { name: file.name, data: btoa(binary) }
  }))

  const ensureRunAccess = async (): Promise<boolean> => {
    if (mode === 'orbit') return ensureOrbitAuth()
    if (await checkProvider(provider)) return true
    setKeyProvider(provider); setSettingsOpen(true)
    notify('Add a provider key in Run settings to continue', true)
    return false
  }

  const progressLabel = (event: AnyRecord): string => {
    if (event.type === 'run_started') return 'Starting the local agent'
    if (event.type === 'reference_analysis_completed') return 'References understood'
    if (event.type === 'model_started') return `Thinking · pass ${event.iteration || 1}`
    if (event.type === 'provider_retry') return 'Provider busy · retrying'
    const labels: Record<string, string> = { update_agent_plan: 'Planning the build', list_files: 'Inspecting the workspace', grep_files: 'Searching project files', read_file: 'Reading project files', write_file: 'Writing project files', edit_file: 'Editing project files', apply_patch: 'Applying project changes', shell: 'Running a project command', generate_image: 'Generating game artwork', generate_3d_model: 'Generating a 3D asset', validate_project: 'Validating the build', finish: 'Preparing the summary' }
    if (event.type === 'tool_started') return labels[event.toolName] || `Running ${event.toolName || 'a tool'}`
    return 'Agent working'
  }

  const streamRun = async (payload: AnyRecord): Promise<AnyRecord> => {
    const response = await fetch('/api/runs/stream', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({})); throw new Error(body.error || `Request failed (${response.status})`)
    }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let completed: AnyRecord | null = null
    while (true) {
      const { done, value } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const lines = buffer.split('\n'); buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (message.type === 'progress') setProgress(progressLabel(message.event))
        else if (message.type === 'complete') completed = message
        else if (message.type === 'error') throw new Error(message.error || 'The local run failed')
      }
      if (done) break
    }
    if (buffer.trim()) {
      const message = JSON.parse(buffer)
      if (message.type === 'complete') completed = message
      if (message.type === 'error') throw new Error(message.error || 'The local run failed')
    }
    if (!completed) throw new Error('The local run ended without a final checkpoint')
    return completed
  }

  const submitRun = async () => {
    if (running) return
    if (!prompt.trim()) return notify('Describe the game or change you want', true)
    if (!workspace.trim()) { setSettingsOpen(true); return notify('Choose a local workspace first', true) }
    if (!await ensureRunAccess()) return
    const requestGeneration = navigation.current
    setRunning(true); setProgress('Starting the local agent')
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ mode, provider, model, runtime, cloudLogs }) })
      const delta = await streamRun({ prompt: prompt.trim(), workspace: workspace.trim(), operation: projects.some((project) => project.workspace === workspace.trim()) ? 'edit' : 'create', mode, provider, model, runtime, generateImages, generate3d, cloudLogs, allowShell, threadId: selectedThreadId || undefined, files: await filePayload() })
      const run = delta.run
      applyRunDelta(delta)
      setPrompt(''); setReferences([])
      if (requestGeneration === navigation.current) {
        setSelectedWorkspace(run.workspace || workspace.trim()); setWorkspace(run.workspace || workspace.trim()); setSelectedThreadId(delta.thread?.id || run.threadId || ''); setSelectedRunId(run.id)
      }
      notify(run.state === 'completed' ? 'Game ready' : `Run ${run.state}`)
      if (run.state === 'completed') window.setTimeout(() => openPreview(run.id, false).catch((error) => notify(errorMessage(error), true)), 0)
    } finally { setRunning(false); setProgress('') }
  }

  const resumeRun = async (run: AnyRecord, retryUnsafe = false) => {
    setRunning(true); setProgress(`Resuming ${shortId(run.id, 'run_')}`)
    try {
      const body = await api(`/api/runs/${run.id}/resume`, { method: 'POST', body: JSON.stringify({ retryUnsafe, allowShell }) })
      applyRunDelta(body); setSelectedRunId(body.run.id); notify(`Run ${body.run.state}`)
      if (body.run.state === 'completed') await openPreview(body.run.id, false)
    } finally { setRunning(false); setProgress('') }
  }

  async function openPreview(runId: string, announce = true) {
    const body = await api(`/api/runs/${runId}/preview`, { method: 'POST', body: '{}' })
    setPreview({ runId, url: body.url }); if (announce) notify('Preview ready')
  }

  const saveSettings = async () => {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ mode, provider, model, runtime, cloudLogs }) })
    setSettingsOpen(false); notify('Run settings saved')
  }

  const saveKey = async () => {
    if (!apiKey.trim()) return notify('Paste an API key first', true)
    await api('/api/provider', { method: 'POST', body: JSON.stringify({ provider: keyProvider, apiKey: apiKey.trim() }) })
    setApiKey('')
    setState((current) => ({ ...current, providers: current.providers.map((item) => item.id === keyProvider ? { ...item, configured: true } : item) }))
    notify('Provider key saved in the operating-system vault')
  }

  const generateImageAsset = async () => {
    if (!workspace.trim()) return notify('Choose a workspace first', true)
    if (!imagePrompt.trim()) return notify('Describe the image to generate', true)
    await ensureOrbitAuth(); notify('Generating image…')
    const body = await api('/api/assets/image', { method: 'POST', body: JSON.stringify({ workspace, prompt: imagePrompt.trim(), output: imageOutput, aspectRatio: imageAspect, cloudLogs }) })
    applyRunDelta(body); notify(`Image run ${body.run.state}`)
  }

  const generate3dAsset = async () => {
    if (!workspace.trim()) return notify('Choose a workspace first', true)
    if (!assetPrompt.trim()) return notify('Describe the 3D model to generate', true)
    if (assetMode === 'orbit') await ensureOrbitAuth()
    else if (!await checkProvider('replicate')) { setKeyProvider('replicate'); throw new Error('Add a Replicate key first') }
    notify('Generating 3D model…')
    const body = await api('/api/assets/3d', { method: 'POST', body: JSON.stringify({ workspace, prompt: assetPrompt.trim(), output: assetOutput, mode: assetMode, cloudLogs }) })
    applyRunDelta(body); notify(`3D run ${body.run.state}`)
  }

  const publish = async () => {
    if (!publishRun) return
    await ensureOrbitAuth(); notify('Publishing the validated build…')
    const result = await api(`/api/runs/${publishRun.id}/publish`, { method: 'POST', body: JSON.stringify({ confirmed: true }) })
    setPublishRun(null); notify(`Published ${result.game?.title || result.game?.id}`)
  }

  const exportMiniGame = async (run: AnyRecord, platform: 'wechat' | 'douyin' | 'tiktok') => {
    const result = await api(`/api/runs/${run.id}/export-mini-game`, {
      method: 'POST',
      body: JSON.stringify({ platform }),
    })
    const label = platform === 'wechat' ? 'WeChat' : platform === 'douyin' ? 'Douyin' : 'TikTok'
    notify(result.mode === 'native'
      ? `${label} source exported to ${result.outputDirectory}`
      : `${label} agent-assisted source exported to ${result.outputDirectory}`)
  }

  const authLabel = !state.auth.checked ? 'Check account' : state.auth.signedIn ? state.auth.email || 'Orbit account' : 'Sign in'
  const selectedTitle = activeRun?.gameName || activeRun?.folderName || (selectedWorkspace ? 'New task' : 'New game')
  const modelOptions = mode === 'orbit'
    ? state.orbitModels
    : state.providers.find((item) => item.id === provider)?.models || []

  const toggleSidebar = () => setSidebarCollapsed((collapsed) => {
    const next = !collapsed
    closeAccountMenu()
    localStorage.setItem('orbit.cli.sidebar.collapsed', next ? '1' : '0')
    return next
  })

  return <div className={`orbit-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
    <aside className="sidebar">
      <div className="brand"><img src={ORBIT_WORDMARK_SRC} alt="Orbit" draggable={false}/><small>CLI</small></div>
      <div className="sidebar-actions">
        <Button className="new-game-button" onPress={() => { setNewGameWorkspace(state.defaultWorkspace || workspace); setNewGameOpen(true) }}><SquarePen size={16}/><span>New game</span></Button>
        <Tooltip><Tooltip.Trigger><Button className="new-task-button" isIconOnly variant="ghost" isDisabled={!selectedWorkspace} aria-label="New task in this game" onPress={startNewTask}><MessageSquarePlus size={16}/></Button></Tooltip.Trigger><Tooltip.Content>New task in this game</Tooltip.Content></Tooltip>
      </div>
      <div className="sidebar-heading"><span>Games</span><Button isIconOnly variant="ghost" aria-label="Refresh games" onPress={() => refresh().then(() => notify('Games refreshed')).catch((error) => notify(errorMessage(error), true))}>{refreshing ? <LoaderCircle className="spin" size={14}/> : <RefreshCw size={14}/>}</Button></div>
      <nav className="project-tree" aria-label="Local games and tasks">
        {!projects.length ? <div className="empty-projects"><FolderPlus size={22}/><strong>No games yet</strong><span>Start a new game and its local tasks will appear here.</span></div> : projects.map((project) => {
          const active = project.workspace === selectedWorkspace
          return <section className={`project-branch${active ? ' active' : ''}`} key={project.workspace}>
            <button className="project-row" type="button" onClick={() => project.threads[0] && selectProject(project.workspace, project.threads[0]).catch((error) => notify(errorMessage(error), true))}>
              {active ? <FolderOpen size={16}/> : <Folder size={16}/>}<span><strong>{project.gameName || project.folderName}</strong><small>{project.folderName}{project.latest?.id ? ` · ${shortId(project.latest.id, 'run_')}` : ''}</small></span><ChevronDown size={13}/>
            </button>
            <div className="task-list">
              {project.threads.map((thread) => {
                const latest = latestRun(threadRuns(thread)); const selected = thread.id === selectedThreadId
                return <button className={`task-row${selected ? ' active' : ''}`} type="button" key={thread.id} onClick={() => selectProject(project.workspace, thread).catch((error) => notify(errorMessage(error), true))}>
                  <span className={`state-dot ${latest?.state || 'new'}`}/><span><strong>{latest?.prompt || thread.title || 'Task'}</strong><small>Task {shortId(thread.id, 'thread_')}{latest ? ` · ${runStateLabel(latest.state)}` : ''}</small></span>
                </button>
              })}
            </div>
          </section>
        })}
      </nav>
      <details className="account-menu" ref={accountMenuRef}>
        <summary className="account-card" aria-label={`${authLabel} menu`} aria-haspopup="menu">
          <span className={`account-dot${state.auth.signedIn ? ' online' : ''}`}/><span><strong>{authLabel}</strong><small>{state.account?.cadeBalance == null ? 'Orbit Cloud' : `${state.account.cadeBalance} Cade available`}</small></span>
          <ChevronUp className="account-menu-chevron" size={14}/>
        </summary>
        <div className="account-popover" role="menu" aria-label="Orbit account">
          {state.auth.signedIn ? <>
            <button type="button" role="menuitem" onClick={() => { closeAccountMenu(); api('/api/account/open', { method: 'POST', body: '{}' }).catch((error) => notify(errorMessage(error), true)) }}><CircleUserRound size={15}/><span><strong>Account</strong><small>Profile and Orbit settings</small></span></button>
            <button type="button" role="menuitem" onClick={() => { closeAccountMenu(); api('/api/account/billing', { method: 'POST', body: '{}' }).catch((error) => notify(errorMessage(error), true)) }}><Coins size={15}/><span><strong>Billing</strong><small>{state.account?.cadeBalance == null ? 'Cade and plan' : `${state.account.cadeBalance} Cade available`}</small></span></button>
            <span className="account-menu-divider"/>
            <button className="sign-out" type="button" role="menuitem" onClick={() => signOut().catch((error) => notify(errorMessage(error), true))}><LogOut size={15}/><span><strong>Sign out</strong><small>Keep local games on this computer</small></span></button>
          </> : <button type="button" role="menuitem" onClick={() => { closeAccountMenu(); ensureOrbitAuth().catch((error) => notify(errorMessage(error), true)) }}><CircleUserRound size={15}/><span><strong>Sign in to Orbit</strong><small>Use Orbit Cloud models and Cade</small></span></button>}
        </div>
      </details>
    </aside>

    <header className="topbar">
      <Tooltip><Tooltip.Trigger><Button className="sidebar-toggle" isIconOnly variant="ghost" aria-label={sidebarCollapsed ? 'Show navigation sidebar' : 'Hide navigation sidebar'} onPress={toggleSidebar}>{sidebarCollapsed ? <PanelLeftOpen size={15}/> : <PanelLeftClose size={15}/>}</Button></Tooltip.Trigger><Tooltip.Content>{sidebarCollapsed ? 'Show navigation' : 'Hide navigation'}</Tooltip.Content></Tooltip>
      <div><h1>{selectedTitle}</h1><p>{selectedWorkspace || 'Choose a workspace to start a local game'}</p></div>
    </header>

    <main className="conversation">
      <div className="transcript">
        {!activeRuns.length ? <div className="empty-conversation"><span className="empty-orbit"><WandSparkles size={26}/></span><h2>{selectedWorkspace ? 'What should Orbit change?' : 'Build a game from an idea'}</h2><p>{selectedWorkspace ? 'This is a fresh task in the same game workspace. Its context stays separate from earlier tasks.' : 'Choose a local workspace, describe the game, and Orbit will build and validate a preview-ready bundle.'}</p></div> : activeRuns.map((run) => <RunTurn key={run.id} run={run} onPreview={() => openPreview(run.id).catch((error) => notify(errorMessage(error), true))} onResume={(unsafe) => resumeRun(run, unsafe).catch((error) => notify(errorMessage(error), true))} onPublish={() => setPublishRun(run)} onExportMiniGame={(platform) => exportMiniGame(run, platform).catch((error) => notify(errorMessage(error), true))}/>) }
        {progress && <div className="live-progress"><Spinner size="sm"/><span>{progress}</span></div>}
      </div>

      <form className="composer" onSubmit={(event) => { event.preventDefault(); submitRun().catch((error) => notify(errorMessage(error), true)) }} noValidate>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submitRun().catch((error) => notify(errorMessage(error), true)) } }} placeholder={selectedWorkspace ? 'Describe the next change…' : 'Describe a game to create…'} aria-label="Task prompt" rows={3}/>
        <div className="composer-toolbar">
          <Tooltip><Tooltip.Trigger><label className="icon-control" aria-label="Add reference images"><ImagePlus size={17}/><input type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={(event) => setReferences(Array.from(event.target.files || []))}/></label></Tooltip.Trigger><Tooltip.Content>Add reference images</Tooltip.Content></Tooltip>
          {references.length ? <span className="attachment-count">{references.length} image{references.length === 1 ? '' : 's'}</span> : null}
          <Button variant="ghost" onPress={() => setSettingsOpen(true)}><Settings2 size={15}/>Run settings</Button>
          <span className="model-summary">{mode === 'orbit' ? 'Orbit Cloud' : state.providers.find((item) => item.id === provider)?.label || provider} · {model || managedLabel}</span>
          <Tooltip><Tooltip.Trigger><Button className="send-button" type="submit" isIconOnly aria-label={selectedWorkspace ? 'Send' : 'Create game'} isDisabled={running}>{running ? <LoaderCircle className="spin" size={16}/> : <Send size={16}/>}</Button></Tooltip.Trigger><Tooltip.Content>{selectedWorkspace ? 'Send' : 'Create game'}</Tooltip.Content></Tooltip>
        </div>
      </form>
    </main>

    <aside className="preview-pane">
      <div className="preview-toolbar"><div><strong>Preview</strong><small>{preview ? `Run ${shortId(preview.runId, 'run_')}` : 'Validated builds only'}</small></div><div>
        {([['phone', Smartphone, 'Phone'], ['4:3', Tablet, '4:3'], ['pc', Monitor, 'Desktop']] as const).map(([value, Icon, label]) => <Tooltip key={value}><Tooltip.Trigger><Button isIconOnly variant={previewRatio === value ? 'primary' : 'ghost'} aria-label={`${label} preview`} onPress={() => setPreviewRatio(value as 'phone' | '4:3' | 'pc')}><Icon size={15}/></Button></Tooltip.Trigger><Tooltip.Content>{label} preview</Tooltip.Content></Tooltip>)}
        <Button isIconOnly variant="ghost" aria-label="Refresh preview" onPress={() => preview && openPreview(preview.runId).catch((error) => notify(errorMessage(error), true))}><RefreshCw size={14}/></Button>
        <Button isIconOnly variant="ghost" aria-label="Open preview in a new tab" onPress={() => preview && window.open(preview.url, '_blank', 'noopener,noreferrer')}><ArrowUpRight size={14}/></Button>
      </div></div>
      <div className={`preview-stage ratio-${previewRatio.replace(':', '-')}`}>
        {preview ? <iframe key={preview.url} src={preview.url} title="Isolated game preview" sandbox="allow-scripts allow-pointer-lock allow-same-origin" referrerPolicy="no-referrer"/> : <div className="empty-preview"><Monitor size={28}/><strong>No preview selected</strong><span>Complete and validate a dist build to run it here.</span></div>}
      </div>
    </aside>

    <SettingsModal open={settingsOpen} setOpen={setSettingsOpen} state={state} workspace={workspace} setWorkspace={setWorkspace} mode={mode} setMode={setMode} provider={provider} setProvider={(value: string) => { setProvider(value); setKeyProvider(value) }} model={model} setModel={setModel} modelOptions={modelOptions} managedLabel={managedLabel} runtime={runtime} setRuntime={setRuntime} generateImages={generateImages} setGenerateImages={setGenerateImages} generate3d={generate3d} setGenerate3d={setGenerate3d} allowShell={allowShell} setAllowShell={setAllowShell} cloudLogs={cloudLogs} setCloudLogs={setCloudLogs} loadModels={() => (mode === 'orbit' ? loadOrbitModels() : loadByokModels()).catch((error) => notify(errorMessage(error), true))} keyProvider={keyProvider} setKeyProvider={setKeyProvider} apiKey={apiKey} setApiKey={setApiKey} saveKey={() => saveKey().catch((error) => notify(errorMessage(error), true))} save={() => saveSettings().catch((error) => notify(errorMessage(error), true))} image={{ prompt: imagePrompt, setPrompt: setImagePrompt, aspect: imageAspect, setAspect: setImageAspect, output: imageOutput, setOutput: setImageOutput, generate: () => generateImageAsset().catch((error) => notify(errorMessage(error), true)) }} asset={{ prompt: assetPrompt, setPrompt: setAssetPrompt, mode: assetMode, setMode: setAssetMode, output: assetOutput, setOutput: setAssetOutput, generate: () => generate3dAsset().catch((error) => notify(errorMessage(error), true)) }}/>

    <Modal isOpen={newGameOpen} onOpenChange={(open: boolean) => setNewGameOpen(open)}><Modal.Backdrop><Modal.Container size="md"><Modal.Dialog><Modal.CloseTrigger/><Modal.Header><Modal.Icon><FolderPlus/></Modal.Icon><Modal.Heading>Start a new game</Modal.Heading></Modal.Header><Modal.Body><p className="modal-copy">A game maps to one local workspace. Separate tasks inside it can edit the same files without mixing their conversation history.</p><label className="field"><span>Local workspace</span><input autoFocus value={newGameWorkspace} onChange={(event) => setNewGameWorkspace(event.target.value)} placeholder="/absolute/path/to/my-game"/></label></Modal.Body><Modal.Footer><Button variant="ghost" onPress={() => setNewGameOpen(false)}>Cancel</Button><Button onPress={confirmNewGame}><Sparkles size={15}/>Create game draft</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>

    <Modal isOpen={Boolean(publishRun)} onOpenChange={(open: boolean) => !open && setPublishRun(null)}><Modal.Backdrop><Modal.Container size="md"><Modal.Dialog><Modal.CloseTrigger/><Modal.Header><Modal.Icon><Upload/></Modal.Icon><Modal.Heading>Publish this game?</Modal.Heading></Modal.Header><Modal.Body><p className="modal-copy">Orbit will upload the validated dist bundle and sanitized source under your signed-in account. Local generation and preview never publish automatically.</p></Modal.Body><Modal.Footer><Button variant="ghost" onPress={() => setPublishRun(null)}>Cancel</Button><Button onPress={() => publish().catch((error) => notify(errorMessage(error), true))}><Upload size={15}/>Publish</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>

    {toast && <div className={`toast${toast.error ? ' error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleAlert size={15}/> : <Check size={15}/>}<span>{toast.message}</span><button type="button" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={13}/></button></div>}
  </div>
}

function RunTurn({ run, onPreview, onResume, onPublish, onExportMiniGame }: { run: AnyRecord; onPreview: () => void; onResume: (unsafe: boolean) => void; onPublish: () => void; onExportMiniGame: (platform: 'wechat' | 'douyin' | 'tiktok') => void }) {
  const trace = [run.plan?.todos?.length ? `Plan\n${run.plan.todos.map((todo: AnyRecord) => `${todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '·' : '○'} ${todo.title || todo.id}`).join('\n')}` : '', run.lastValidation ? `Validation\n${JSON.stringify(run.lastValidation, null, 2)}` : ''].filter(Boolean).join('\n\n')
  const completed = run.state === 'completed'
  const failed = run.state === 'failed'
  const summary = run.result?.summary || (completed
    ? run.previewReady ? 'The validated build is ready to preview.' : run.previewIssue
    : failed ? 'This run stopped before completion.' : 'The checkpoint is saved and can be continued.')
  const failure = String(run.lastError?.message || run.error || 'The local run failed.')
  return <article className={`turn${failed ? ' failed' : ''}`}><div className="user-message">{run.prompt}</div><div className="result-card"><header><div><strong>{run.result?.title || run.gameName || run.folderName || 'Orbit result'}</strong><small>{run.mode === 'orbit' ? 'Orbit Cloud' : run.provider} · {run.model || 'automatic model'} · {run.runtime || 'auto'}</small></div><span className={`run-state ${run.state}`}>{runStateLabel(run.state)}</span></header><div className="result-body"><p>{summary}</p>{failed && <details className="run-error-details"><summary><CircleAlert size={13}/><span>Run failed</span><small>Show details</small></summary><pre>{failure}</pre></details>}<div className="run-actions">{completed && run.previewReady && <Button size="sm" onPress={onPreview}><Play size={13}/>Preview</Button>}{completed && run.previewReady && <Button size="sm" variant="ghost" onPress={onPublish}><Upload size={13}/>Publish</Button>}{completed && run.previewReady && <details className="export-menu"><summary><PackageOpen size={13}/>Export<ChevronDown size={12}/></summary><div>{(['wechat', 'douyin', 'tiktok'] as const).map((platform) => <button key={platform} type="button" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); onExportMiniGame(platform) }}><PackageOpen size={13}/><span><strong>{platform === 'wechat' ? 'WeChat Mini Game' : platform === 'douyin' ? 'Douyin Mini Game' : 'TikTok Mini Game'}</strong><small>Agent-assisted platform source</small></span></button>)}</div></details>}{['paused', 'interrupted', 'queued'].includes(run.state) && <Button size="sm" onPress={() => onResume(false)}><RefreshCw size={13}/>Resume</Button>}{run.unsafeResumeRequired && <Button size="sm" variant="danger" onPress={() => onResume(true)}><ShieldCheck size={13}/>Confirm retry</Button>}</div>{trace && <Accordion className="trace"><Accordion.Item id={`trace-${run.id}`}><Accordion.Heading><Accordion.Trigger><span>Show work and validation</span><Accordion.Indicator><ChevronDown size={13}/></Accordion.Indicator></Accordion.Trigger></Accordion.Heading><Accordion.Panel><Accordion.Body><pre>{trace}</pre></Accordion.Body></Accordion.Panel></Accordion.Item></Accordion>}</div></div></article>
}

function SettingsModal(props: AnyRecord) {
  const codingProviders = props.state.providers.filter((item: AnyRecord) => item.purpose === 'coding')
  return <Modal isOpen={props.open} onOpenChange={props.setOpen}><Modal.Backdrop><Modal.Container size="2xl" scroll="inside"><Modal.Dialog><Modal.CloseTrigger/><Modal.Header><Modal.Icon><Settings2/></Modal.Icon><div><Modal.Heading>Run settings</Modal.Heading><p>These choices apply to the next task. Existing tasks keep their recorded model and runtime.</p></div></Modal.Header><Modal.Body>
    <section className="settings-section"><div className="section-title"><FolderOpen size={16}/><div><strong>Workspace</strong><span>The local folder Orbit reads and edits for this game.</span></div></div><label className="field"><span>Absolute path</span><input value={props.workspace} readOnly={Boolean(props.workspace && props.state.threads.some((thread: AnyRecord) => thread.workspace === props.workspace))} onChange={(event) => props.setWorkspace(event.target.value)} placeholder="/absolute/path/to/my-game"/></label></section>
    <section className="settings-section"><div className="section-title"><Sparkles size={16}/><div><strong>Model access</strong><span>Use Orbit credits or connect your own provider key.</span></div></div><div className="segmented"><button type="button" className={props.mode === 'orbit' ? 'active' : ''} onClick={() => props.setMode('orbit')}><Coins size={14}/><span><strong>Orbit Cloud</strong><small>Managed models · Cade billing</small></span></button><button type="button" className={props.mode === 'byok' ? 'active' : ''} onClick={() => props.setMode('byok')}><KeyRound size={14}/><span><strong>Use my API key</strong><small>Provider billing · local guidance</small></span></button></div><div className="settings-grid">{props.mode === 'byok' && <label className="field"><span>Provider</span><select value={props.provider} onChange={(event) => props.setProvider(event.target.value)}>{codingProviders.map((item: AnyRecord) => <option key={item.id} value={item.id}>{item.label}{item.configured ? ' · configured' : ''}</option>)}</select></label>}<label className="field"><span>Model</span><select value={props.model} onChange={(event) => props.setModel(event.target.value)}><option value="">Automatic · {props.mode === 'orbit' ? props.managedLabel : 'provider default'}</option>{props.modelOptions.map((item: AnyRecord) => <option key={item.id} value={item.id}>{item.label || item.name || item.id}{item.vision ? ' · vision' : ''}</option>)}</select></label><Button className="refresh-models" variant="ghost" onPress={props.loadModels}><RefreshCw size={14}/>Refresh models</Button></div></section>
    <section className="settings-section"><div className="section-title"><Gamepad2 size={16}/><div><strong>Build runtime</strong><span>Automatic chooses the lightest suitable stack; a fixed choice constrains the agent.</span></div></div><label className="field"><span>Runtime</span><select value={props.runtime} onChange={(event) => props.setRuntime(event.target.value)}><option value="auto">Agent decides</option><option value="html">HTML</option><option value="vanilla-ts">Vanilla TypeScript</option><option value="react-vite">React + Vite</option><option value="react-three-fiber">React Three Fiber</option><option value="three-vanilla">Three.js</option><option value="phaser">Phaser</option></select></label></section>
    <section className="settings-section"><div className="section-title"><ShieldCheck size={16}/><div><strong>Capabilities</strong><span>Explicitly allow paid media, local project commands, and cloud diagnostics.</span></div></div><div className="switch-grid"><SettingSwitch checked={props.generateImages} setChecked={props.setGenerateImages} icon={<ImagePlus size={15}/>} title="Generate images" detail="Use the selected billing route for game artwork."/><SettingSwitch checked={props.generate3d} setChecked={props.setGenerate3d} icon={<Square size={15}/>} title="Generate 3D" detail="Allow GLB generation when it materially helps."/><SettingSwitch checked={props.allowShell} setChecked={props.setAllowShell} icon={<Monitor size={15}/>} title="Project commands" detail="Allow dependency install, typecheck, and build scripts."/><SettingSwitch checked={props.cloudLogs} setChecked={props.setCloudLogs} icon={<ShieldCheck size={15}/>} title="Cloud diagnostics" detail="Share bounded run diagnostics with Orbit."/></div></section>
    {props.mode === 'byok' && <section className="settings-section key-section"><div className="section-title"><KeyRound size={16}/><div><strong>Provider key</strong><span>Saved in the operating-system credential vault. Orbit reads only the provider selected for a task.</span></div></div><div className="key-row"><select value={props.keyProvider} onChange={(event) => props.setKeyProvider(event.target.value)}>{props.state.providers.map((item: AnyRecord) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><input type="password" value={props.apiKey} onChange={(event) => props.setApiKey(event.target.value)} placeholder="Paste API key" autoComplete="new-password"/><Button onPress={props.saveKey}>Save key</Button></div></section>}
    <Accordion className="asset-accordion"><Accordion.Item id="assets"><Accordion.Heading><Accordion.Trigger><span><WandSparkles size={16}/><span><strong>Standalone asset tools</strong><small>Generate files without starting a coding task.</small></span></span><Accordion.Indicator><ChevronDown size={14}/></Accordion.Indicator></Accordion.Trigger></Accordion.Heading><Accordion.Panel><Accordion.Body><div className="asset-grid"><AssetPanel title="Generate an image" icon={<ImagePlus size={15}/>} prompt={props.image.prompt} setPrompt={props.image.setPrompt} placeholder="A transparent neon checkpoint icon…"><select value={props.image.aspect} onChange={(event) => props.image.setAspect(event.target.value)}><option>1:1</option><option>9:16</option><option>16:9</option></select><input value={props.image.output} onChange={(event) => props.image.setOutput(event.target.value)}/><Button onPress={props.image.generate}>Generate</Button></AssetPanel><AssetPanel title="Generate a GLB model" icon={<Square size={15}/>} prompt={props.asset.prompt} setPrompt={props.asset.setPrompt} placeholder="A stylized low-poly spacecraft…"><select value={props.asset.mode} onChange={(event) => props.asset.setMode(event.target.value)}><option value="orbit">Orbit Cloud</option><option value="byok">Replicate key</option></select><input value={props.asset.output} onChange={(event) => props.asset.setOutput(event.target.value)}/><Button onPress={props.asset.generate}>Generate</Button></AssetPanel></div></Accordion.Body></Accordion.Panel></Accordion.Item></Accordion>
  </Modal.Body><Modal.Footer><Button variant="ghost" onPress={() => props.setOpen(false)}>Cancel</Button><Button onPress={props.save}><Check size={15}/>Save settings</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>
}

function SettingSwitch({ checked, setChecked, icon, title, detail }: AnyRecord) {
  return <label className={`setting-switch${checked ? ' active' : ''}`}><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)}/><span className="switch-icon">{icon}</span><span><strong>{title}</strong><small>{detail}</small></span><span className="switch-control"><i/></span></label>
}

function AssetPanel({ title, icon, prompt, setPrompt, placeholder, children }: AnyRecord) {
  return <section className="asset-panel"><header>{icon}<strong>{title}</strong></header><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={placeholder}/><div>{children}</div></section>
}

createRoot(document.getElementById('root')!).render(<App/>)
