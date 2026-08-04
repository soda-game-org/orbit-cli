import { canonicalDirectory, id, publicError } from './util.mjs'
import { ingestReferenceImages } from './attachments.mjs'
import { MAX_AGENT_ITERATIONS, MODEL_OUTPUT_TOKENS, PROVIDERS } from './constants.mjs'
import { agentTools, ToolExecutor } from './tools.mjs'
import { publicGenericSkill } from './provider.mjs'
import { providerCredentialAccount } from './credentials.mjs'
import { OrbitApiError } from './api.mjs'

function modelFromCatalog(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : []
  const preferred = catalog?.default_model_id || catalog?.defaults?.pro || catalog?.defaults?.standard
  if (preferred && models.some((model) => model?.id === preferred)) return preferred
  return models.find((model) => model?.available !== false)?.id || null
}

function safeToolCall(call) {
  return call && typeof call === 'object'
    && typeof call.id === 'string'
    && call.function && typeof call.function.name === 'string'
    && typeof call.function.arguments === 'string'
}

export class RunManager {
  constructor({ store, config, credentials, auth, apiFactory, byok, threeD, cloudLogs }) {
    this.store = store
    this.config = config
    this.credentials = credentials
    this.auth = auth
    this.apiFactory = apiFactory
    this.byok = byok
    this.threeD = threeD
    this.cloudLogs = cloudLogs
  }

  async create(input) {
    const workspace = await canonicalDirectory(input.workspace, { create: true })
    const config = await this.config.get()
    const mode = input.mode || config.mode
    const provider = input.provider || config.provider
    const runtime = input.runtime || config.runtime
    const source = input.source === 'cli_gui' ? 'cli_gui' : 'cli'
    if (mode === 'orbit') await this.auth.accessToken()
    if (mode === 'byok' && !await this.credentials.get(providerCredentialAccount(provider))) {
      throw new Error(`Configure a ${PROVIDERS[provider]?.label || provider} API key first`)
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
      generate3d: input.generate3d,
      cloudLogs: input.cloudLogs ?? config.cloudLogs,
      references,
    })
    return this.execute(run.id, { allowShell: input.allowShell === true, retryUnsafe: false })
  }

  async resume(runId, options = {}) {
    return this.execute(runId, { allowShell: options.allowShell === true, retryUnsafe: options.retryUnsafe === true })
  }

  async execute(runId, options) {
    const release = await this.store.acquire(runId)
    const controller = new AbortController()
    const interrupt = () => controller.abort(new Error('Interrupted by user'))
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)
    let run
    try {
      run = await this.store.load(runId)
      if (run.state === 'completed') return run
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
        workspace: run.workspace, run, store: this.store, api, threeD: this.threeD,
        allowShell: options.allowShell, signal: controller.signal,
      })
      await this.#recoverPendingTool(run, executor, options)
      const tools = agentTools({ mode: run.mode, generate3d: run.generate3d })
      const system = run.mode === 'byok' ? await this.#systemPrompt(run) : ''
      let consecutiveNoTools = 0
      while (run.iteration < MAX_AGENT_ITERATIONS) {
        if (controller.signal.aborted) throw controller.signal.reason
        run.iteration += 1
        const requestKey = run.pendingModelCall?.requestKey || `model_${run.id}_${run.iteration}`
        run.pendingModelCall = { requestKey, iteration: run.iteration, startedAt: new Date().toISOString() }
        await this.store.save(run)
        await this.#event(run, 'model_started', { requestKey, iteration: run.iteration })
        let assistant
        if (run.mode === 'orbit') {
          assistant = await this.apiFactory(run.source).complete({
            cloudRunId: run.cloudRunId,
            requestKey,
            purpose: 'agent',
            messages: run.messages,
            tools,
            runtime: run.runtime,
            operation: run.operation,
            maxOutputTokens: MODEL_OUTPUT_TOKENS,
            signal: controller.signal,
          }).then((result) => result.assistant)
        } else {
          assistant = await this.byok.complete({
            provider: run.provider, model: run.model || PROVIDERS[run.provider].defaultModel,
            messages: run.messages, tools, system, signal: controller.signal,
            onRetry: async () => this.#event(run, 'provider_retry', { iteration: run.iteration }),
          })
        }
        run.pendingModelCall = null
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
          if (['shell', 'generate_3d_model'].includes(name)) run.unsafeResumeRequired = true
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
              run.result = { workspace: run.workspace, validation: run.lastValidation }
              if (run.mode === 'orbit' && run.cloudRunId) await api.settle(run.cloudRunId, 'complete').catch(() => undefined)
              await this.store.transition(run, 'completed')
              return run
            }
          } catch (error) {
            const message = publicError(error)
            run.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: message }) })
            run.pendingTool = null
            run.unsafeResumeRequired = false
            await this.store.save(run)
            await this.#event(run, 'tool_failed', { toolName: name, success: false, durationMs: Date.now() - started, errorCode: error?.code || 'TOOL_FAILED' })
          }
        }
      }
      run.lastError = { code: 'ITERATION_BUDGET_PAUSED', message: 'The local iteration budget was reached. The run remains resumable.' }
      await this.store.transition(run, 'paused')
      return run
    } catch (error) {
      if (!run) throw error
      const interrupted = controller.signal.aborted
      run.lastError = { code: interrupted ? 'LOCAL_PROCESS_INTERRUPTED' : error?.code || 'RUN_PAUSED', message: publicError(error) }
      await this.store.transition(run, interrupted ? 'interrupted' : 'paused')
      await this.#event(run, interrupted ? 'run_interrupted' : 'run_paused', { errorCode: run.lastError.code })
      return run
    } finally {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', interrupt)
      await release()
    }
  }

  async #ensureCloudRun(run, api) {
    if (run.cloudRunId) {
      try { await api.heartbeat(run.cloudRunId); return } catch (error) {
        if (!(error instanceof OrbitApiError) || ![404, 409, 410].includes(error.status)) throw error
        run.cloudRunId = null
        run.cloudAttempt = Number(run.cloudAttempt || 1) + 1
      }
    }
    const catalog = await api.models()
    run.model ||= modelFromCatalog(catalog)
    if (!run.model) throw new Error('Orbit returned no available coding model')
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

  async #analyzeReferences(run, api, signal) {
    const requestKey = `reference_${run.id}_${run.cloudAttempt || 1}`
    run.referenceSummary = run.mode === 'orbit'
      ? await this.apiFactory(run.source).complete({
          cloudRunId: run.cloudRunId, requestKey, purpose: 'reference_media',
          messages: [{ role: 'user', content: await this.#referenceContent(run) }], tools: [], maxOutputTokens: 4096, signal,
        }).then((result) => result?.assistant?.content || '')
      : await this.byok.analyzeReferences({ provider: run.provider, model: run.model || PROVIDERS[run.provider].defaultModel, references: run.references, signal })
    if (!run.referenceSummary) throw new Error('Reference image analysis returned no usable summary')
    await this.store.save(run)
    await this.#event(run, 'reference_analysis_completed', { success: true })
  }

  async #referenceContent(run) {
    const { referenceDataUrl } = await import('./attachments.mjs')
    const content = [{ type: 'text', text: 'Analyze these private reference images for the local game. Summarize composition, palette, characters, environment, camera, UI, and interaction cues. Never instruct the client to copy the original files into public game source.' }]
    for (const reference of run.references) content.push({ type: 'image_url', image_url: { url: await referenceDataUrl(reference) } })
    return content
  }

  async #recoverPendingTool(run, executor, options) {
    if (!run.pendingTool) return
    if (['shell', 'generate_3d_model'].includes(run.pendingTool.name) && !options.retryUnsafe) {
      run.unsafeResumeRequired = true
      await this.store.save(run)
      throw Object.assign(new Error('Explicit --retry-unsafe is required for the pending non-idempotent tool'), { code: 'UNSAFE_RETRY_CONFIRMATION_REQUIRED' })
    }
    const call = { id: run.pendingTool.id, type: 'function', function: { name: run.pendingTool.name, arguments: run.pendingTool.arguments } }
    const content = await executor.execute(call)
    run.messages.push({ role: 'tool', tool_call_id: call.id, content })
    run.pendingTool = null
    run.unsafeResumeRequired = false
    await this.store.save(run)
  }

  async #systemPrompt(run) {
    return [
      'You are the public Orbit CLI local coding agent. Work only through the declared tools.',
      'Create or edit the selected local workspace. Use update_agent_plan first, keep changes focused, validate, and call finish.',
      'Only the generic public skill below is available locally. Specialized official game templates and private Orbit skills are not present; never claim otherwise.',
      run.generate3d ? '3D generation is enabled and may be used when it materially helps the requested game.' : '3D generation is disabled; use local procedural or existing assets.',
      await publicGenericSkill(),
    ].join('\n\n')
  }

  async #event(run, type, fields = {}) {
    const event = await this.store.appendEvent(run.id, type, fields)
    await this.store.save(run)
    await this.cloudLogs?.emit(run, { ...event, ...fields })
  }
}
