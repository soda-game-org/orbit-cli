import { canonicalDirectory, id, publicError } from './util.mjs'
import { ingestReferenceImages, type ReferenceImageMetadata } from './attachments.mjs'
import { MAX_AGENT_ITERATIONS, MODEL_OUTPUT_TOKENS, PROVIDERS } from './constants.mjs'
import { agentTools, ToolExecutor } from './tools.mjs'
import { publicGenericSkill } from './provider.mjs'
import { providerCredentialAccount } from './credentials.mjs'
import { OrbitApiError } from './api.mjs'
import { asError, type OrbitMessage, type OrbitRun, type OrbitToolCall } from './types.mjs'
import type { OrbitCodingProviderId } from '../packages/orbit-provider-core/index.mjs'

type Dynamic = Record<string, any>

function modelFromCatalog(catalog: Dynamic, excluded: Set<string> = new Set(), excludedPrefixes: string[] = []): string | null {
  const models = Array.isArray(catalog?.models) ? catalog.models : []
  const allowed = (model: Dynamic) => model?.available !== false
    && !excluded.has(model?.id)
    && !excludedPrefixes.some((prefix) => String(model?.id || '').startsWith(prefix))
  const preferred = catalog?.default_model_id || catalog?.defaultModelId || catalog?.default || catalog?.defaults?.pro || catalog?.defaults?.standard
  if (preferred && models.some((model: Dynamic) => model?.id === preferred && allowed(model))) return preferred
  const candidates = models.filter(allowed)
  if (excluded.size || excludedPrefixes.length) {
    candidates.sort((left: Dynamic, right: Dynamic) => Number(right?.perf?.quality || 0) - Number(left?.perf?.quality || 0)
      || Number(right?.perf?.speed || 0) - Number(left?.perf?.speed || 0))
  }
  return candidates[0]?.id || null
}

function modelFamilyPrefix(modelId: unknown): string {
  const match = String(modelId || '').match(/^([A-Za-z0-9]+-)/)
  return match?.[1] || ''
}

function removeWithheldNoProgressTail(messages: OrbitMessage[]): OrbitMessage[] {
  const copy = [...messages]
  while (copy.length) {
    const last = copy.at(-1)
    const withheld = last?.role === 'assistant'
      && String(last.content || '').startsWith('The server withheld this')
    const nudge = last?.role === 'user'
      && last.content === 'Continue the task using the available tools. Validate the workspace and call finish only after validation passes.'
    if (!withheld && !nudge) break
    copy.pop()
  }
  return copy
}

function completePlan(plan: Dynamic | null): Dynamic | null {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.todos)) return plan
  const completed: Dynamic = {
    ...plan,
    summary: 'Task completed after validation passed.',
    blockers: [],
    todos: plan.todos.map((todo: unknown) => todo && typeof todo === 'object'
      ? { ...todo, status: 'completed' }
      : todo),
  }
  delete completed.currentTodoId
  return completed
}

function safeToolCall(call: unknown): call is OrbitToolCall {
  if (!call || typeof call !== 'object') return false
  const candidate = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
  return typeof candidate.id === 'string'
    && Boolean(candidate.function)
    && typeof candidate.function?.name === 'string'
    && typeof candidate.function.arguments === 'string'
}

function pendingToolRequiresUnsafeRetry(run: OrbitRun): boolean {
  const pending = run.pendingTool
  if (!pending) return false
  if (pending.name === 'shell') return true
  if (pending.name === 'generate_image') {
    const state = run.assetImages?.[pending.id]
    if (state?.output) return false
    if (run.mode === 'byok' && state?.predictionId) return false
    return state?.requestPending === true || run.mode === 'orbit'
  }
  if (pending.name === 'generate_3d_model') {
    return !(run.mode === 'byok' && run.asset3d?.predictionId)
  }
  return false
}

export class RunManager {
  readonly store: any
  readonly config: any
  readonly credentials: any
  readonly auth: any
  readonly apiFactory: any
  readonly byok: any
  readonly image: any
  readonly threeD: any
  readonly cloudLogs: any

  constructor({ store, config, credentials, auth, apiFactory, byok, image, threeD, cloudLogs }: Dynamic) {
    this.store = store
    this.config = config
    this.credentials = credentials
    this.auth = auth
    this.apiFactory = apiFactory
    this.byok = byok
    this.image = image
    this.threeD = threeD
    this.cloudLogs = cloudLogs
  }

  async create(input: Dynamic): Promise<OrbitRun> {
    const workspace = await canonicalDirectory(input.workspace, { create: true })
    const config = await this.config.get()
    const mode = input.mode || config.mode
    const provider = (input.provider || config.provider) as OrbitCodingProviderId
    const runtime = input.runtime || config.runtime
    const source = input.source === 'cli_gui' ? 'cli_gui' : 'cli'
    if (mode === 'orbit') await this.auth.accessToken()
    if (mode === 'byok' && !await this.credentials.get(providerCredentialAccount(provider))) {
      throw new Error(`Configure a ${PROVIDERS[provider]?.label || provider} API key first`)
    }
    if (mode === 'byok' && input.generateImages && !await this.credentials.get(providerCredentialAccount('replicate'))) {
      throw new Error('Configure a Replicate API key before enabling BYOK image generation')
    }
    if (mode === 'byok' && input.generate3d && !await this.credentials.get(providerCredentialAccount('replicate'))) {
      throw new Error('Configure a Replicate API key before enabling BYOK 3D generation')
    }
    const references = await ingestReferenceImages(workspace, input.referenceImages || [])
    const run = await this.store.create({
      source,
      operation: input.operation,
      prompt: input.prompt,
      workspace,
      mode,
      provider,
      model: input.model || config.model || '',
      runtime,
      generateImages: input.generateImages,
      generate3d: input.generate3d,
      cloudLogs: input.cloudLogs ?? config.cloudLogs,
      references,
    })
    return this.execute(run.id, { allowShell: input.allowShell === true, retryUnsafe: false })
  }

  async resume(runId: string, options: { allowShell?: boolean; retryUnsafe?: boolean } = {}): Promise<OrbitRun> {
    return this.execute(runId, { allowShell: options.allowShell === true, retryUnsafe: options.retryUnsafe === true })
  }

  async execute(runId: string, options: { allowShell: boolean; retryUnsafe: boolean }): Promise<OrbitRun> {
    const release = await this.store.acquire(runId)
    const controller = new AbortController()
    const interrupt = () => controller.abort(new Error('Interrupted by user'))
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)
    let run: OrbitRun | undefined
    try {
      run = await this.store.load(runId)
      if (!run) throw new Error(`Run checkpoint is missing: ${runId}`)
      if (run.state === 'completed') {
        const normalizedPlan = completePlan(run.plan)
        const planChanged = JSON.stringify(normalizedPlan) !== JSON.stringify(run.plan)
        if (planChanged) run.plan = normalizedPlan
        if (run.lastError || run.unsafeResumeRequired || planChanged) {
          run.lastError = null
          run.unsafeResumeRequired = false
          await this.store.save(run)
        }
        return run
      }
      if (run.state === 'cancelled' || run.state === 'failed') throw new Error(`Run ${run.id} is terminal (${run.state})`)
      if (run.unsafeResumeRequired && !options.retryUnsafe) {
        run.lastError = { code: 'UNSAFE_RETRY_CONFIRMATION_REQUIRED', message: 'Resume again with --retry-unsafe after reviewing possible duplicate provider or shell work.' }
        await this.store.transition(run, 'paused')
        return run
      }
      run.unsafeResumeRequired = false
      await this.store.transition(run, run.startedAt ? 'recovering' : 'running')
      await this.#event(run, 'run_started', { source: run.source, mode: run.mode })
      const api = run.mode === 'orbit' ? this.apiFactory(run.source) : null
      if (run.mode === 'orbit') await this.#ensureCloudRun(run, api)
      if (run.references.length && !run.referenceSummary) await this.#analyzeReferences(run, api, controller.signal)
      if (!run.messages.length) {
        run.messages.push({
          role: 'user',
          content: [
            run.prompt,
            run.referenceSummary ? `\nPrivate reference analysis (original files remain outside game source):\n${run.referenceSummary}` : '',
            '\nWork in the selected local workspace. Create an execution plan, implement the complete game, validate it, then call finish.',
          ].join(''),
        })
        await this.store.save(run)
      }
      const executor = new ToolExecutor({
        workspace: run.workspace, run, store: this.store, api, image: this.image, threeD: this.threeD,
        allowShell: options.allowShell, retryUnsafe: options.retryUnsafe, signal: controller.signal,
      })
      await this.#recoverPendingTool(run, executor, options)
      const tools = agentTools({ mode: run.mode, generateImages: run.generateImages, generate3d: run.generate3d })
      const system = run.mode === 'byok' ? await this.#systemPrompt(run) : ''
      let consecutiveNoTools = 0
      while (run.iteration < MAX_AGENT_ITERATIONS) {
        if (controller.signal.aborted) throw controller.signal.reason
        run.iteration += 1
        const requestKey = run.pendingModelCall?.requestKey || `model_${run.id}_${run.iteration}`
        run.pendingModelCall = { requestKey, iteration: run.iteration, startedAt: new Date().toISOString() }
        await this.store.save(run)
        await this.#event(run, 'model_started', { requestKey, iteration: run.iteration })
        let assistant: Dynamic
        let contentFiltered = false
        if (run.mode === 'orbit') {
          const result = await this.apiFactory(run.source).complete({
            cloudRunId: run.cloudRunId,
            requestKey,
            purpose: 'agent',
            messages: run.messages,
            tools,
            runtime: run.runtime,
            operation: run.operation,
            maxOutputTokens: MODEL_OUTPUT_TOKENS,
            signal: controller.signal,
          })
          assistant = result.assistant
          contentFiltered = result.finish_reason === 'content_filter'
        } else {
          const provider = run.provider
          if (!provider) throw new Error('BYOK run is missing a coding provider')
          assistant = await this.byok.complete({
            provider, model: run.model || PROVIDERS[provider].defaultModel,
            messages: run.messages, tools, system, signal: controller.signal,
            onRetry: async () => this.#event(run!, 'provider_retry', { iteration: run!.iteration }),
          })
        }
        run.pendingModelCall = null
        run.contentFilterStreak = contentFiltered ? Number(run.contentFilterStreak || 0) + 1 : 0
        if (!assistant || typeof assistant !== 'object') throw new Error('Model response is invalid')
        const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls.filter(safeToolCall) : []
        run.messages.push({
          role: 'assistant',
          content: typeof assistant.content === 'string' ? assistant.content : '',
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(typeof assistant.reasoning_content === 'string' ? { reasoning_content: assistant.reasoning_content } : {}),
          ...(typeof assistant.reasoning === 'string' ? { reasoning: assistant.reasoning } : {}),
          ...(Array.isArray(assistant.reasoning_details) ? { reasoning_details: assistant.reasoning_details } : {}),
          ...(Array.isArray(assistant.response_items) ? { response_items: assistant.response_items } : {}),
        })
        await this.store.save(run)
        await this.#event(run, 'model_completed', { success: true, iteration: run.iteration })
        if (!calls.length) {
          consecutiveNoTools += 1
          if (run.mode === 'orbit' && run.contentFilterStreak >= 3) {
            const failedModel = run.model
            if (failedModel && !run.failedModels?.includes(failedModel)) {
              run.failedModels = [...(Array.isArray(run.failedModels) ? run.failedModels : []), failedModel].slice(-12)
            }
            const prefix = modelFamilyPrefix(failedModel)
            if (prefix && !run.failedModelPrefixes?.includes(prefix)) {
              run.failedModelPrefixes = [...(Array.isArray(run.failedModelPrefixes) ? run.failedModelPrefixes : []), prefix].slice(-8)
            }
            if (run.cloudRunId) await api.settle(run.cloudRunId, 'fail', 'content_filter_no_progress').catch(() => undefined)
            run.cloudRunId = null
            run.cloudAttempt = Number(run.cloudAttempt || 1) + 1
            run.model = ''
            run.contentFilterStreak = 0
            run.messages = removeWithheldNoProgressTail(run.messages)
            run.lastError = {
              code: 'MODEL_CONTENT_FILTER_FALLBACK_READY',
              message: 'The current official model could not produce a safe local tool turn. Resume to continue with another model family.',
            }
            await this.store.transition(run, 'paused')
            return run
          }
          if (consecutiveNoTools >= 3) {
            run.lastError = { code: 'AGENT_NO_TOOL_PROGRESS', message: 'The agent stopped making tool progress. The checkpoint is preserved and can be resumed.' }
            await this.store.transition(run, 'paused')
            return run
          }
          run.messages.push({ role: 'user', content: 'Continue the task using the available tools. Validate the workspace and call finish only after validation passes.' })
          await this.store.save(run)
          continue
        }
        consecutiveNoTools = 0
        for (const call of calls) {
          const name = call.function.name
          run.pendingTool = { id: call.id, name, arguments: call.function.arguments, startedAt: new Date().toISOString() }
          if (['shell', 'generate_image', 'generate_3d_model'].includes(name)) run.unsafeResumeRequired = true
          await this.store.save(run)
          const started = Date.now()
          await this.#event(run, 'tool_started', { toolName: name, iteration: run.iteration })
          try {
            const content = await executor.execute(call)
            run.messages.push({ role: 'tool', tool_call_id: call.id, content })
            run.pendingTool = null
            run.unsafeResumeRequired = false
            await this.store.save(run)
            await this.#event(run, 'tool_completed', { toolName: name, success: true, durationMs: Date.now() - started })
            if (name === 'finish') {
              run.plan = completePlan(run.plan)
              run.result = { workspace: run.workspace, validation: run.lastValidation }
              run.lastError = null
              if (run.mode === 'orbit' && run.cloudRunId) await api.settle(run.cloudRunId, 'complete').catch(() => undefined)
              await this.store.transition(run, 'completed')
              return run
            }
          } catch (error) {
            const toolError = asError(error)
            if (['UNSAFE_IMAGE_RETRY_REQUIRED', 'IMAGE_PROVIDER_RESUME_REQUIRED'].includes(toolError.code || '')) {
              const unsafe = toolError.code === 'UNSAFE_IMAGE_RETRY_REQUIRED'
              run.unsafeResumeRequired = unsafe
              run.lastError = {
                code: unsafe ? 'UNSAFE_RETRY_CONFIRMATION_REQUIRED' : 'IMAGE_PROVIDER_RESUME_REQUIRED',
                message: publicError(error),
              }
              await this.store.transition(run, 'paused')
              await this.#event(run, 'run_paused', { errorCode: run.lastError.code })
              return run
            }
            const message = publicError(error)
            run.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: message }) })
            run.pendingTool = null
            run.unsafeResumeRequired = false
            await this.store.save(run)
            await this.#event(run, 'tool_failed', { toolName: name, success: false, durationMs: Date.now() - started, errorCode: asError(error).code || 'TOOL_FAILED' })
          }
        }
      }
      run.lastError = { code: 'ITERATION_BUDGET_PAUSED', message: 'The local iteration budget was reached. The run remains resumable.' }
      await this.store.transition(run, 'paused')
      return run
    } catch (error) {
      if (!run) throw error
      const interrupted = controller.signal.aborted
      const providerUnavailable = error instanceof OrbitApiError
        && error.code === 'ENGINE_MODEL_PROVIDER_UNAVAILABLE'
      if (run.pendingModelCall) {
        if (run.mode === 'byok' || !(error instanceof OrbitApiError)) {
          run.unsafeResumeRequired = true
        } else {
          // A structured Orbit response proves that the Worker received the
          // request and terminalized its request key. A later resume must use
          // a fresh key; only an ambiguous transport failure needs unsafe
          // duplicate-spend confirmation.
          run.pendingModelCall = null
        }
      }
      if (providerUnavailable) {
        if (run.model && !run.failedModels?.includes(run.model)) {
          run.failedModels = [...(Array.isArray(run.failedModels) ? run.failedModels : []), run.model].slice(-12)
        }
        if (run.cloudRunId) {
          await this.apiFactory(run.source).settle(run.cloudRunId, 'fail', 'model_provider_unavailable').catch(() => undefined)
        }
        run.cloudRunId = null
        run.cloudAttempt = Number(run.cloudAttempt || 1) + 1
        run.model = ''
        run.contentFilterStreak = 0
      }
      run.lastError = {
        code: interrupted
          ? 'LOCAL_PROCESS_INTERRUPTED'
          : providerUnavailable
            ? 'MODEL_PROVIDER_FALLBACK_READY'
            : asError(error).code || 'RUN_PAUSED',
        message: providerUnavailable
          ? 'The selected Orbit model provider is unavailable. Resume to continue with the next available official model.'
          : publicError(error),
      }
      await this.store.transition(run, interrupted ? 'interrupted' : 'paused')
      await this.#event(run, interrupted ? 'run_interrupted' : 'run_paused', { errorCode: run.lastError.code })
      return run
    } finally {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', interrupt)
      await release()
    }
  }

  async #ensureCloudRun(run: OrbitRun, api: any): Promise<void> {
    if (run.cloudRunId) {
      try { await api.heartbeat(run.cloudRunId); return } catch (error) {
        if (!(error instanceof OrbitApiError) || ![404, 409, 410].includes(error.status)) throw error
        run.cloudRunId = null
        run.cloudAttempt = Number(run.cloudAttempt || 1) + 1
      }
    }
    const catalog = await api.models()
    const selectedModel = run.model || modelFromCatalog(
      catalog,
      new Set(Array.isArray(run.failedModels) ? run.failedModels : []),
      Array.isArray(run.failedModelPrefixes) ? run.failedModelPrefixes : [],
    )
    if (!selectedModel) throw new Error('Orbit returned no available coding model')
    run.model = selectedModel
    const begun = await api.beginRun({
      clientRunId: `${run.id}.attempt.${run.cloudAttempt || 1}`,
      purpose: run.operation,
      modelId: run.model,
      generate3d: run.generate3d,
    })
    run.cloudRunId = begun.run_id
    run.cloudAttempt ||= 1
    await this.store.save(run)
  }

  async #analyzeReferences(run: OrbitRun, api: any, signal: AbortSignal): Promise<void> {
    const requestKey = `reference_${run.id}_${run.cloudAttempt || 1}`
    run.referenceSummary = run.mode === 'orbit'
      ? await this.apiFactory(run.source).complete({
          cloudRunId: run.cloudRunId, requestKey, purpose: 'reference_media',
          messages: [{ role: 'user', content: await this.#referenceContent(run) }], tools: [], maxOutputTokens: 4096, signal,
        }).then((result: Dynamic) => result?.assistant?.content || '')
      : await this.#analyzeByokReferences(run, signal)
    if (!run.referenceSummary) throw new Error('Reference image analysis returned no usable summary')
    await this.store.save(run)
    await this.#event(run, 'reference_analysis_completed', { success: true })
  }

  async #referenceContent(run: OrbitRun): Promise<Dynamic[]> {
    const { referenceDataUrl } = await import('./attachments.mjs')
    const content: Dynamic[] = [{ type: 'text', text: 'Analyze these private reference images for the local game. Summarize composition, palette, characters, environment, camera, UI, and interaction cues. Never instruct the client to copy the original files into public game source.' }]
    for (const reference of run.references) content.push({ type: 'image_url', image_url: { url: await referenceDataUrl(reference as ReferenceImageMetadata, run.workspace) } })
    return content
  }

  async #analyzeByokReferences(run: OrbitRun, signal: AbortSignal): Promise<string> {
    const provider = run.provider
    if (!provider) throw new Error('BYOK run is missing a coding provider')
    return this.byok.analyzeReferences({
      provider,
      model: run.model || PROVIDERS[provider].defaultModel,
      references: run.references as ReferenceImageMetadata[],
      workspace: run.workspace,
      signal,
    })
  }

  async #recoverPendingTool(run: OrbitRun, executor: ToolExecutor, options: { retryUnsafe: boolean }): Promise<void> {
    if (!run.pendingTool) return
    if (pendingToolRequiresUnsafeRetry(run) && !options.retryUnsafe) {
      run.unsafeResumeRequired = true
      await this.store.save(run)
      throw Object.assign(new Error('Explicit --retry-unsafe is required for the pending non-idempotent tool'), { code: 'UNSAFE_RETRY_CONFIRMATION_REQUIRED' })
    }
    run.unsafeResumeRequired = false
    await this.store.save(run)
    const call = { id: run.pendingTool.id, type: 'function', function: { name: run.pendingTool.name, arguments: run.pendingTool.arguments } }
    const content = await executor.execute(call)
    run.messages.push({ role: 'tool', tool_call_id: call.id, content })
    run.pendingTool = null
    run.unsafeResumeRequired = false
    await this.store.save(run)
  }

  async #systemPrompt(run: OrbitRun): Promise<string> {
    return [
      'You are the public Orbit CLI local coding agent. Work only through the declared tools.',
      'Create or edit the selected local workspace. Use update_agent_plan first, keep changes focused, validate, and call finish.',
      'Only the generic public skill below is available locally. Specialized official game templates and private Orbit skills are not present; never claim otherwise.',
      run.generate3d ? '3D generation is enabled and may be used when it materially helps the requested game.' : '3D generation is disabled; use local procedural or existing assets.',
      run.generateImages
        ? `2D game-asset generation is enabled through ${run.mode === 'orbit' ? 'the authenticated Orbit Worker and Orbit billing' : "the user's Replicate key and Replicate billing"}. Plan visual assets alongside code and 3D work. Use generate_image for a small number of high-impact gameplay images when they materially improve quality, reference every generated path from the final game, and prefer procedural visuals when they are the stronger fit.`
        : 'Image generation is disabled; use deliberate local CSS, SVG, canvas, procedural, or existing project assets and do not invent generated image paths.',
      await publicGenericSkill(),
    ].join('\n\n')
  }

  async #event(run: OrbitRun, type: string, fields: Record<string, unknown> = {}): Promise<void> {
    const event = await this.store.appendEvent(run.id, type, fields)
    await this.store.save(run)
    await this.cloudLogs?.emit(run, { ...event, ...fields })
  }
}
