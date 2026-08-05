import { boundedString, canonicalDirectory, publicError } from './util.mjs'

export class AssetImageManager {
  constructor({ store, config, auth, apiFactory, image, cloudLogs }) {
    Object.assign(this, { store, config, auth, apiFactory, image, cloudLogs })
  }

  async create(input) {
    await this.auth.accessToken()
    const config = await this.config.get()
    const run = await this.store.create({
      source: input.source === 'cli_gui' ? 'cli_gui' : 'cli',
      operation: 'create',
      prompt: boundedString(input.prompt, 'Image prompt', 8_000),
      workspace: await canonicalDirectory(input.workspace, { create: true }),
      mode: 'orbit',
      provider: null,
      runtime: 'html',
      generateImages: true,
      cloudLogs: input.cloudLogs ?? config.cloudLogs,
      references: [],
    })
    run.kind = 'assetimage'
    run.assetImage = {}
    run.assetOutput = typeof input.output === 'string' && input.output.trim() ? input.output.trim() : 'assets/images/generated.png'
    run.assetAspectRatio = ['1:1', '9:16', '16:9'].includes(input.aspectRatio) ? input.aspectRatio : '1:1'
    await this.store.save(run)
    return this.execute(run.id, { retryUnsafe: false })
  }

  async resume(runId, { retryUnsafe = false } = {}) {
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

  async execute(runId, { retryUnsafe = false } = {}) {
    const release = await this.store.acquire(runId)
    const controller = new AbortController()
    const interrupt = () => controller.abort(new Error('Interrupted by user'))
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)
    let run
    try {
      run = await this.store.load(runId)
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
      const unsafe = error?.code === 'UNSAFE_IMAGE_RETRY_REQUIRED'
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
      await release()
    }
  }

  async #event(run, type, fields = {}) {
    const event = await this.store.appendEvent(run.id, type, fields)
    await this.cloudLogs?.emit(run, { ...event, ...fields })
    await this.store.save(run)
  }
}
