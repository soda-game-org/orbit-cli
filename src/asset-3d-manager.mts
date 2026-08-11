import { boundedString, canonicalDirectory, publicError } from './util.mjs'
import { providerCredentialAccount } from './credentials.mjs'
import { ThreeDService } from './three-d.mjs'
import type { OrbitRun } from './types.mjs'

export class Asset3DManager {
  readonly store: any
  readonly config: any
  readonly auth: any
  readonly credentials: any
  readonly apiFactory: any
  readonly threeD: any
  readonly cloudLogs: any

  constructor({ store, config, auth, credentials, apiFactory, threeD, cloudLogs }: Record<string, any>) {
    Object.assign(this, { store, config, auth, credentials, apiFactory, threeD, cloudLogs })
  }

  async create(input: Record<string, any>): Promise<OrbitRun> {
    const config = await this.config.get()
    const mode = input.mode === 'byok' ? 'byok' : 'orbit'
    if (mode === 'orbit') await this.auth.accessToken()
    else if (!await this.credentials.get(providerCredentialAccount('replicate'))) throw new Error('Configure a Replicate API key before using BYOK 3D generation')
    const workspace = await canonicalDirectory(input.workspace, { create: true })
    const workspaceRelease = typeof this.store.acquireWorkspace === 'function'
      ? await this.store.acquireWorkspace(workspace)
      : async () => undefined
    let transferred = false
    try {
    const run = await this.store.create({
      source: input.source === 'cli_gui' ? 'cli_gui' : 'cli', operation: 'create', prompt: boundedString(input.prompt, '3D prompt', 8_000),
      workspace, mode,
      provider: mode === 'byok' ? 'replicate' : null, runtime: 'html', generate3d: true,
      cloudLogs: input.cloudLogs ?? config.cloudLogs, references: [],
      kind: 'asset3d', asset3d: {},
      assetOutput: typeof input.output === 'string' && input.output.trim() ? input.output.trim() : 'assets/models/generated.glb',
    })
    transferred = true
    return this.execute(run.id, { workspaceRelease })
    } finally {
      if (!transferred) await workspaceRelease()
    }
  }

  async resume(runId: string, { retryUnsafe = false }: { retryUnsafe?: boolean } = {}): Promise<OrbitRun> {
    const run = await this.store.load(runId)
    if (run.kind !== 'asset3d') throw new Error('The selected run is not a standalone 3D run')
    const ambiguousStart = run.mode === 'byok' && run.asset3d?.requestPending && !run.asset3d?.predictionId
    const terminalProviderFailure = ['failed', 'canceled', 'cancelled'].includes(run.asset3d?.status)
    if ((ambiguousStart || terminalProviderFailure) && !retryUnsafe) {
      run.unsafeResumeRequired = true
      run.lastError = {
        code: 'UNSAFE_RETRY_CONFIRMATION_REQUIRED',
        message: ambiguousStart
          ? 'The previous process stopped while starting a billable Replicate request. Confirm unsafe retry after checking the provider dashboard.'
          : 'The provider job ended without an asset. Use --retry-unsafe to explicitly start a new billable 3D request.',
      }
      await this.store.transition(run, 'paused')
      return run
    }
    if ((ambiguousStart || terminalProviderFailure) && retryUnsafe) {
      run.asset3d = { retryAttempt: Number(run.asset3d?.retryAttempt || 0) + 1 }
      await this.store.save(run)
    }
    run.unsafeResumeRequired = false
    return this.execute(runId)
  }

  async execute(runId: string, { workspaceRelease: suppliedWorkspaceRelease = null }: { workspaceRelease?: (() => Promise<void>) | null } = {}): Promise<OrbitRun> {
    let release: (() => Promise<void>) | null = null
    let workspaceRelease = suppliedWorkspaceRelease
    const controller = new AbortController()
    const interrupt = () => controller.abort(new Error('Interrupted by user'))
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)
    let run: OrbitRun | undefined
    try {
      if (!workspaceRelease && typeof this.store.acquireWorkspace === 'function') {
        const initial = await this.store.load(runId)
        workspaceRelease = await this.store.acquireWorkspace(initial.workspace)
      }
      release = await this.store.acquire(runId)
      run = await this.store.load(runId)
      if (!run) throw new Error(`Run checkpoint is missing: ${runId}`)
      if (run.state === 'completed') {
        if (run.lastError || run.unsafeResumeRequired) {
          run.lastError = null
          run.unsafeResumeRequired = false
          await this.store.save(run)
        }
        return run
      }
      await this.store.transition(run, run.startedAt ? 'recovering' : 'running')
      await this.#event(run, 'asset_3d_started')
      const service = run.mode === 'orbit'
        ? new ThreeDService({ api: this.apiFactory(run.source), credentials: this.credentials })
        : this.threeD
      const retryAttempt = Number(run.asset3d?.retryAttempt || 0)
      const output = await service.generate({
        mode: run.mode, workspace: run.workspace, prompt: run.prompt, output: run.assetOutput,
        state: run.asset3d, signal: controller.signal,
        clientRunId: retryAttempt ? `${run.id}.asset3d.retry.${retryAttempt}` : `${run.id}.asset3d`,
        requestKey: retryAttempt ? `asset3d_${run.id}_retry_${retryAttempt}` : `asset3d_${run.id}`,
        persist: async () => this.store.save(run),
        onProgress: async (value: Record<string, any>) => this.#event(run!, 'asset_3d_progress', { state: String(value.status || 'working') }),
      })
      run.result = output
      run.lastError = null
      run.unsafeResumeRequired = false
      await this.store.transition(run, 'completed')
      await this.#event(run, 'asset_3d_completed', { success: true })
      return run
    } catch (error) {
      if (!run) throw error
      run.lastError = { code: controller.signal.aborted ? 'LOCAL_PROCESS_INTERRUPTED' : 'ASSET_3D_PAUSED', message: publicError(error) }
      await this.store.transition(run, controller.signal.aborted ? 'interrupted' : 'paused')
      await this.#event(run, 'asset_3d_paused', { success: false, errorCode: run.lastError.code })
      return run
    } finally {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', interrupt)
      try { if (release) await release() } finally { if (workspaceRelease) await workspaceRelease() }
    }
  }

  async #event(run: OrbitRun, type: string, fields: Record<string, unknown> = {}): Promise<void> {
    const event = await this.store.appendEvent(run.id, type, fields)
    await this.cloudLogs?.emit(run, { ...event, ...fields })
    await this.store.save(run)
  }
}
