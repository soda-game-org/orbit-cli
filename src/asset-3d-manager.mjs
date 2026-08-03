import { boundedString, canonicalDirectory, publicError } from './util.mjs'
import { providerCredentialAccount } from './credentials.mjs'
import { ThreeDService } from './three-d.mjs'

export class Asset3DManager {
  constructor({ store, config, auth, credentials, apiFactory, threeD, cloudLogs }) {
    Object.assign(this, { store, config, auth, credentials, apiFactory, threeD, cloudLogs })
  }

  async create(input) {
    const config = await this.config.get()
    const mode = input.mode === 'byok' ? 'byok' : 'orbit'
    if (mode === 'orbit') await this.auth.accessToken()
    else if (!await this.credentials.get(providerCredentialAccount('replicate'))) throw new Error('Configure a Replicate API key before using BYOK 3D generation')
    const run = await this.store.create({
      source: input.source === 'cli_gui' ? 'cli_gui' : 'cli', operation: 'create', prompt: boundedString(input.prompt, '3D prompt', 8_000),
      workspace: await canonicalDirectory(input.workspace, { create: true }), mode,
      provider: mode === 'byok' ? 'replicate' : null, runtime: 'html', generate3d: true,
      cloudLogs: input.cloudLogs ?? config.cloudLogs, references: [],
    })
    run.kind = 'asset3d'
    run.asset3d = {}
    run.assetOutput = typeof input.output === 'string' && input.output.trim() ? input.output.trim() : 'assets/models/generated.glb'
    await this.store.save(run)
    return this.execute(run.id)
  }

  async resume(runId, { retryUnsafe = false } = {}) {
    const run = await this.store.load(runId)
    if (run.kind !== 'asset3d') throw new Error('The selected run is not a standalone 3D run')
    if (run.mode === 'byok' && run.asset3d?.requestPending && !run.asset3d?.predictionId && !retryUnsafe) {
      run.unsafeResumeRequired = true
      run.lastError = { code: 'UNSAFE_RETRY_CONFIRMATION_REQUIRED', message: 'The previous process stopped while starting a billable Replicate request. Confirm unsafe retry after checking the provider dashboard.' }
      await this.store.transition(run, 'paused')
      return run
    }
    run.unsafeResumeRequired = false
    return this.execute(runId)
  }

  async execute(runId) {
    const release = await this.store.acquire(runId)
    const controller = new AbortController()
    const interrupt = () => controller.abort(new Error('Interrupted by user'))
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)
    let run
    try {
      run = await this.store.load(runId)
      if (run.state === 'completed') return run
      await this.store.transition(run, run.startedAt ? 'recovering' : 'running')
      await this.#event(run, 'asset_3d_started')
      const service = run.mode === 'orbit'
        ? new ThreeDService({ api: this.apiFactory(run.source), credentials: this.credentials })
        : this.threeD
      const output = await service.generate({
        mode: run.mode, workspace: run.workspace, prompt: run.prompt, output: run.assetOutput,
        state: run.asset3d, signal: controller.signal, clientRunId: `${run.id}.asset3d`,
        requestKey: `asset3d_${run.id}`, persist: async () => this.store.save(run),
        onProgress: async (value) => this.#event(run, 'asset_3d_progress', { state: String(value.status || 'working') }),
      })
      run.result = output
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
      await release()
    }
  }

  async #event(run, type, fields = {}) {
    const event = await this.store.appendEvent(run.id, type, fields)
    await this.cloudLogs?.emit(run, { ...event, ...fields })
    await this.store.save(run)
  }
}
