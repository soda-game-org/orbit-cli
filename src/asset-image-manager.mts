import { boundedString, canonicalDirectory, publicError } from './util.mjs'
import { asError, type OrbitRun } from './types.mjs'

export class AssetImageManager {
  readonly store: any
  readonly config: any
  readonly auth: any
  readonly apiFactory: any
  readonly image: any
  readonly cloudLogs: any

  constructor({ store, config, auth, apiFactory, image, cloudLogs }: Record<string, any>) {
    Object.assign(this, { store, config, auth, apiFactory, image, cloudLogs })
  }

  async create(input: Record<string, any>): Promise<OrbitRun> {
    await this.auth.accessToken()
    const config = await this.config.get()
    const workspace = await canonicalDirectory(input.workspace, { create: true })
    const workspaceRelease = typeof this.store.acquireWorkspace === 'function'
      ? await this.store.acquireWorkspace(workspace)
      : async () => undefined
    let transferred = false
    try {
    const run = await this.store.create({
      source: input.source === 'cli_gui' ? 'cli_gui' : 'cli',
      operation: 'create',
      prompt: boundedString(input.prompt, 'Image prompt', 8_000),
      workspace,
      mode: 'orbit',
      provider: null,
      runtime: 'html',
      generateImages: true,
      cloudLogs: input.cloudLogs ?? config.cloudLogs,
      references: [],
      kind: 'assetimage',
      assetImage: {},
      assetOutput: typeof input.output === 'string' && input.output.trim() ? input.output.trim() : 'assets/images/generated.png',
      assetAspectRatio: ['1:1', '9:16', '16:9'].includes(input.aspectRatio) ? input.aspectRatio : '1:1',
    })
    transferred = true
    return this.execute(run.id, { retryUnsafe: false, workspaceRelease })
    } finally {
      if (!transferred) await workspaceRelease()
    }
  }

  async resume(runId: string, { retryUnsafe = false }: { retryUnsafe?: boolean } = {}): Promise<OrbitRun> {
    const run = await this.store.load(runId)
    if (run.kind !== 'assetimage') throw new Error('The selected run is not a standalone image run')
    if (run.assetImage?.requestPending && !run.assetImage?.output && !retryUnsafe) {
      run.unsafeResumeRequired = true
      run.lastError = {
        code: 'UNSAFE_RETRY_CONFIRMATION_REQUIRED',
        message: 'The previous process stopped during a billable image request. Confirm unsafe retry after checking Orbit usage.',
      }
      await this.store.transition(run, 'paused')
      return run
    }
    run.unsafeResumeRequired = false
    return this.execute(runId, { retryUnsafe })
  }

  async execute(runId: string, { retryUnsafe = false, workspaceRelease: suppliedWorkspaceRelease = null }: { retryUnsafe?: boolean; workspaceRelease?: (() => Promise<void>) | null } = {}): Promise<OrbitRun> {
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
      await this.#event(run, 'asset_image_started')
      const output = await this.image.generate({
        api: this.apiFactory(run.source),
        workspace: run.workspace,
        prompt: run.prompt,
        output: run.assetOutput,
        aspectRatio: run.assetAspectRatio,
        state: run.assetImage,
        retryUnsafe,
        signal: controller.signal,
        clientRunId: `${run.id}.assetimage`,
        requestKey: `assetimage_${run.id}`,
        persist: async () => this.store.save(run),
      })
      run.result = output
      run.lastError = null
      run.unsafeResumeRequired = false
      await this.store.transition(run, 'completed')
      await this.#event(run, 'asset_image_completed', { success: true })
      return run
    } catch (error) {
      if (!run) throw error
      const unsafe = asError(error).code === 'UNSAFE_IMAGE_RETRY_REQUIRED'
      run.unsafeResumeRequired = unsafe
      run.lastError = {
        code: controller.signal.aborted ? 'LOCAL_PROCESS_INTERRUPTED' : unsafe ? 'UNSAFE_RETRY_CONFIRMATION_REQUIRED' : 'ASSET_IMAGE_PAUSED',
        message: publicError(error),
      }
      await this.store.transition(run, controller.signal.aborted ? 'interrupted' : 'paused')
      await this.#event(run, 'asset_image_paused', { success: false, errorCode: run.lastError.code })
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
