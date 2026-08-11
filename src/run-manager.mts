import { canonicalDirectory, id, publicError } from './util.mjs'
import { ingestReferenceImages, type ReferenceImageMetadata } from './attachments.mjs'
import { MAX_AGENT_ITERATIONS, MODEL_OUTPUT_TOKENS, PROVIDERS } from './constants.mjs'
import {
  ORBIT_AGENT_EXECUTION_POLICY,
  ORBIT_AGENT_RENDER_SURFACE_CONTRACT,
  assertAgentTranscriptProtocol,
  closeAgentToolBatchJournal,
  compactAgentMessagesIfNeeded,
  createAgentToolBatchJournal,
  createAgentExecutionState,
  deferAgentToolBatchMessage,
  normalizeAgentToolBatchJournal,
  projectAgentMessagesForProvider,
  recordAgentToolBatchResult,
  transitionAgentExecutionState,
  type OrbitAgentToolResult,
} from '@soda_game/orbit-agent-core'
import { agentTools, ToolExecutor } from './tools.mjs'
import { publicGenericSkill } from './provider.mjs'
import { providerCredentialAccount } from './credentials.mjs'
import { OrbitApiError } from './api.mjs'
import { asError, type OrbitMessage, type OrbitRun, type OrbitToolBatchControl, type OrbitToolCall } from './types.mjs'
import type { OrbitCodingProviderId } from '@soda_game/orbit-provider-core'

type Dynamic = Record<string, any>

export interface RunProgressEvent extends Record<string, unknown> {
  runId: string
  type: string
  occurredAt: string
}

export type RunProgressListener = (event: RunProgressEvent) => void | Promise<void>

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

function safeToolCall(call: unknown): call is OrbitToolCall {
  if (!call || typeof call !== 'object') return false
  const candidate = call as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }
  return typeof candidate.id === 'string'
    && Boolean(candidate.id.trim())
    && candidate.id === candidate.id.trim()
    && candidate.type === 'function'
    && Boolean(candidate.function)
    && typeof candidate.function?.name === 'string'
    && Boolean(candidate.function.name.trim())
    && typeof candidate.function.arguments === 'string'
}

function sameToolCall(left: OrbitToolCall, right: OrbitToolCall): boolean {
  return left.id === right.id
    && left.type === right.type
    && left.function.name === right.function.name
    && left.function.arguments === right.function.arguments
}

function assertPendingToolBatchBinding(run: OrbitRun): void {
  const journal = normalizeAgentToolBatchJournal(run.pendingToolBatch)
  if (!journal || journal.status !== 'open') throw new Error('Saved tool-batch journal is invalid')
  assertAgentTranscriptProtocol(run.messages, { allowIncompleteTail: true })
  const assistant = run.messages.at(-1)
  const calls = Array.isArray(assistant?.tool_calls) ? assistant.tool_calls : []
  if (assistant?.role !== 'assistant'
    || calls.length !== journal.calls.length
    || calls.some((call) => !safeToolCall(call))
    || journal.calls.some((call) => !safeToolCall(call))) {
    throw new Error('Saved tool-batch journal is not bound to the transcript tail')
  }
  for (const [index, call] of calls.entries()) {
    if (!sameToolCall(call, journal.calls[index] as OrbitToolCall)) {
      throw new Error('Saved tool-batch journal does not match the transcript tool calls')
    }
  }
  if (journal.limit > ORBIT_AGENT_EXECUTION_POLICY.maxToolCallsPerTurn) {
    throw new Error('Saved tool-batch journal exceeds the shared execution limit')
  }
  if (run.pendingTool) {
    const pending = journal.calls.find((call) => call.id === run.pendingTool!.id)
    if (!pending || !safeToolCall(pending)
      || journal.results.some((result) => result.tool_call_id === run.pendingTool!.id)
      || pending.function.name !== run.pendingTool.name
      || pending.function.arguments !== run.pendingTool.arguments) {
      throw new Error('Saved pending tool does not match its tool-batch journal')
    }
  }
}

function pendingToolRequiresUnsafeRetry(run: OrbitRun): boolean {
  const pending = run.pendingTool
  if (!pending) return false
  if (pending.name === 'shell') return true
  if (pending.name === 'generate_image') {
    if (run.lastError?.code === 'IMAGE_PROVIDER_RESUME_REQUIRED') return false
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
  readonly progressListeners = new Map<string, RunProgressListener>()

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
    return this.execute(run.id, {
      allowShell: input.allowShell === true,
      retryUnsafe: false,
      onProgress: input.onProgress,
    })
  }

  async resume(runId: string, options: { allowShell?: boolean; retryUnsafe?: boolean; onProgress?: RunProgressListener } = {}): Promise<OrbitRun> {
    return this.execute(runId, {
      allowShell: options.allowShell === true,
      retryUnsafe: options.retryUnsafe === true,
      onProgress: options.onProgress,
    })
  }

  async execute(runId: string, options: { allowShell: boolean; retryUnsafe: boolean; onProgress?: RunProgressListener }): Promise<OrbitRun> {
    const release = await this.store.acquire(runId)
    if (options.onProgress) this.progressListeners.set(runId, options.onProgress)
    const controller = new AbortController()
    const interrupt = () => controller.abort(new Error('Interrupted by user'))
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)
    let run: OrbitRun | undefined
    try {
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
      const tools = agentTools({ mode: run.mode, generateImages: run.generateImages, generate3d: run.generate3d })
      const system = run.mode === 'byok' ? await this.#systemPrompt(run) : ''
      let executionState = createAgentExecutionState(run.executionState || {})
      await this.#migrateLegacyToolBatch(run)
      if (run.pendingToolBatch) {
        const recovered = await this.#drainToolBatch(run, executor, executionState, api, { ...options, signal: controller.signal })
        executionState = recovered.executionState
        if (recovered.finished) return run
      }
      while (run.iteration < MAX_AGENT_ITERATIONS) {
        if (controller.signal.aborted) throw controller.signal.reason
        assertAgentTranscriptProtocol(run.messages)
        const compacted = compactAgentMessagesIfNeeded(run.messages, {
          profile: 'cli-local',
          plan: run.plan,
          summaryLabel: 'Public Orbit CLI context compacted before the next model call.',
        })
        if (compacted.compacted) {
          assertAgentTranscriptProtocol(run.messages)
          await this.store.save(run)
          await this.#event(run, 'context_compacted', { before: compacted.before, after: compacted.after })
        }
        run.iteration += 1
        const requestKey = run.pendingModelCall?.requestKey || `model_${run.id}_${run.iteration}`
        run.pendingModelCall = { requestKey, iteration: run.iteration, startedAt: new Date().toISOString() }
        await this.store.save(run)
        await this.#event(run, 'model_started', { requestKey, iteration: run.iteration })
        const providerMessages = projectAgentMessagesForProvider(run.messages)
        let assistant: Dynamic
        let contentFiltered = false
        if (run.mode === 'orbit') {
          const result = await this.apiFactory(run.source).complete({
            cloudRunId: run.cloudRunId,
            requestKey,
            purpose: 'agent',
            messages: providerMessages,
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
            messages: providerMessages, tools, system, signal: controller.signal,
            onRetry: async () => this.#event(run!, 'provider_retry', { iteration: run!.iteration }),
          })
        }
        run.pendingModelCall = null
        run.contentFilterStreak = contentFiltered ? Number(run.contentFilterStreak || 0) + 1 : 0
        if (!assistant || typeof assistant !== 'object') throw new Error('Model response is invalid')
        const rawCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : []
        const calls = rawCalls.filter(safeToolCall)
        if (calls.length !== rawCalls.length) throw new Error('Model returned an invalid tool call')
        const toolBatch = transitionAgentExecutionState(executionState, { type: 'tool_batch', count: calls.length })
        executionState = toolBatch.state
        run.executionState = executionState
        const assistantMessage = {
          role: 'assistant',
          content: typeof assistant.content === 'string' ? assistant.content : '',
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(typeof assistant.reasoning_content === 'string' ? { reasoning_content: assistant.reasoning_content } : {}),
          ...(typeof assistant.reasoning === 'string' ? { reasoning: assistant.reasoning } : {}),
          ...(Array.isArray(assistant.reasoning_details) ? { reasoning_details: assistant.reasoning_details } : {}),
          ...(Array.isArray(assistant.response_items) ? { response_items: assistant.response_items } : {}),
        } as OrbitMessage
        if (calls.length) {
          run.pendingToolBatch = createAgentToolBatchJournal(assistantMessage, ORBIT_AGENT_EXECUTION_POLICY)
          run.pendingToolBatchControl = { errors: [], validationFailures: [], validationObserved: false, finishRequested: false }
        }
        run.messages.push(assistantMessage)
        await this.store.save(run)
        await this.#event(run, 'model_completed', { success: true, iteration: run.iteration })
        if (!calls.length) {
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
          if (toolBatch.stopReason === 'no_tool_limit') {
            run.lastError = { code: 'AGENT_NO_TOOL_PROGRESS', message: 'The agent stopped making tool progress. The checkpoint is preserved and can be resumed.' }
            await this.store.transition(run, 'paused')
            return run
          }
          run.messages.push({ role: 'user', content: 'Continue the task using the available tools. Validate the workspace and call finish only after validation passes.' })
          await this.store.save(run)
          continue
        }
        const drained = await this.#drainToolBatch(run, executor, executionState, api, { ...options, signal: controller.signal })
        executionState = drained.executionState
        if (drained.finished) return run
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
      this.progressListeners.delete(runId)
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

  async #migrateLegacyToolBatch(run: OrbitRun): Promise<void> {
    if (run.pendingToolBatch) {
      assertPendingToolBatchBinding(run)
      return
    }
    try {
      assertAgentTranscriptProtocol(run.messages)
      return
    } catch {
      // A pre-ledger checkpoint may contain a partially written tool batch.
    }
    let assistantIndex = -1
    for (let index = run.messages.length - 1; index >= 0; index -= 1) {
      if (run.messages[index]?.role === 'assistant' && Array.isArray(run.messages[index]?.tool_calls) && run.messages[index]!.tool_calls!.length) {
        assistantIndex = index
        break
      }
    }
    if (assistantIndex < 0) throw new Error('Saved transcript is invalid and has no recoverable tool batch')
    const assistant = run.messages[assistantIndex]!
    let journal = createAgentToolBatchJournal(assistant, ORBIT_AGENT_EXECUTION_POLICY)
    const ids = new Set(journal.calls.map((call: Dynamic) => String(call.id || '')))
    let cursor = assistantIndex + 1
    while (cursor < run.messages.length) {
      const message = run.messages[cursor]!
      if (message.role === 'assistant') throw new Error('Saved transcript contains an unrecoverable nested assistant tool batch')
      if (message.role === 'tool') {
        if (!ids.has(String(message.tool_call_id || ''))) throw new Error('Saved transcript contains a tool result for another batch')
        if (typeof message.tool_call_id !== 'string' || typeof message.content !== 'string') {
          throw new Error('Saved transcript contains an invalid tool result')
        }
        journal = recordAgentToolBatchResult(journal, message as OrbitAgentToolResult)
      } else {
        journal = deferAgentToolBatchMessage(journal, message)
      }
      cursor += 1
    }
    run.messages.splice(assistantIndex + 1, cursor - assistantIndex - 1)
    run.pendingToolBatch = journal
    run.pendingToolBatchControl = { errors: [], validationFailures: [], validationObserved: false, finishRequested: false }
    if (run.pendingTool && journal.results.some((result: Dynamic) => result.tool_call_id === run.pendingTool!.id)) run.pendingTool = null
    await this.store.save(run)
  }

  async #drainToolBatch(
    run: OrbitRun,
    executor: ToolExecutor,
    executionStateInput: ReturnType<typeof createAgentExecutionState>,
    api: any,
    options: { retryUnsafe: boolean; signal: AbortSignal },
  ): Promise<{ executionState: ReturnType<typeof createAgentExecutionState>; finished: boolean }> {
    let executionState = createAgentExecutionState(executionStateInput)
    let journal = normalizeAgentToolBatchJournal(run.pendingToolBatch)
    if (!journal || journal.status !== 'open') throw new Error('Pending tool-batch journal is invalid')
    if (run.pendingTool && pendingToolRequiresUnsafeRetry(run) && !options.retryUnsafe) {
      run.unsafeResumeRequired = true
      run.lastError = {
        code: 'UNSAFE_RETRY_CONFIRMATION_REQUIRED',
        message: 'Explicit --retry-unsafe is required for the pending non-idempotent tool.',
      }
      await this.store.transition(run, 'paused')
      await this.#event(run, 'run_paused', { errorCode: run.lastError.code })
      return { executionState, finished: true }
    }
    run.unsafeResumeRequired = false
    const rawControl: Partial<OrbitToolBatchControl> = run.pendingToolBatchControl || {}
    const control: OrbitToolBatchControl = {
      errors: Array.isArray(rawControl.errors)
        ? rawControl.errors.filter((entry) => entry && typeof entry.key === 'string' && typeof entry.name === 'string')
        : [],
      validationFailures: Array.isArray(rawControl.validationFailures)
        ? rawControl.validationFailures.filter((value): value is string => typeof value === 'string')
        : [],
      validationObserved: rawControl.validationObserved === true,
      finishRequested: rawControl.finishRequested === true,
    }
    const completedIds = new Set(journal.results.map((result: Dynamic) => result.tool_call_id))

    for (const [index, call] of journal.calls.entries()) {
      if (options.signal.aborted) throw options.signal.reason || new Error('Interrupted by user')
      const typedCall = call as OrbitToolCall
      if (completedIds.has(typedCall.id)) continue
      if (index >= journal.limit || control.finishRequested) break
      const name = typedCall.function.name
      if (run.pendingTool && run.pendingTool.id !== typedCall.id) throw new Error('Saved pending tool does not match its tool-batch journal')
      run.pendingTool = { id: typedCall.id, name, arguments: typedCall.function.arguments, startedAt: new Date().toISOString() }
      if (['shell', 'generate_image', 'generate_3d_model'].includes(name)) run.unsafeResumeRequired = true
      await this.store.save(run)
      const started = Date.now()
      await this.#event(run, 'tool_started', { toolName: name, iteration: run.iteration })
      if (options.signal.aborted) throw options.signal.reason || new Error('Interrupted by user')
      try {
        const content = await executor.execute(typedCall)
        journal = recordAgentToolBatchResult(journal, { role: 'tool', tool_call_id: typedCall.id, content })
        run.pendingToolBatch = journal
        if (name === 'validate_project') {
          control.validationObserved = true
          if (run.lastValidation?.ok === true) {
            control.validationFailures = []
          } else {
            const signature = JSON.stringify(run.lastValidation || {}).slice(0, 1_200)
            control.validationFailures = signature ? [signature] : []
          }
        }
        if (name === 'finish') control.finishRequested = true
        run.pendingTool = null
        run.unsafeResumeRequired = false
        run.pendingToolBatchControl = control
        await this.store.save(run)
        await this.#event(run, 'tool_completed', { toolName: name, success: true, durationMs: Date.now() - started })
      } catch (error) {
        if (options.signal.aborted) throw options.signal.reason || error
        const toolError = asError(error)
        if (['UNSAFE_IMAGE_RETRY_REQUIRED', 'IMAGE_PROVIDER_RESUME_REQUIRED'].includes(toolError.code || '')) {
          const unsafe = toolError.code === 'UNSAFE_IMAGE_RETRY_REQUIRED'
          run.unsafeResumeRequired = unsafe
          run.lastError = {
            code: unsafe ? 'UNSAFE_RETRY_CONFIRMATION_REQUIRED' : 'IMAGE_PROVIDER_RESUME_REQUIRED',
            message: publicError(error),
          }
          run.pendingToolBatch = journal
          run.pendingToolBatchControl = control
          await this.store.transition(run, 'paused')
          await this.#event(run, 'run_paused', { errorCode: run.lastError.code })
          return { executionState, finished: true }
        }
        const message = publicError(error)
        const key = `${name}:${message.slice(0, 500)}`
        journal = recordAgentToolBatchResult(journal, {
          role: 'tool', tool_call_id: typedCall.id, content: JSON.stringify({ ok: false, error: message }),
        })
        if (!control.errors.some((entry) => entry.key === key)) control.errors.push({ key, name })
        run.pendingToolBatch = journal
        run.pendingToolBatchControl = control
        run.pendingTool = null
        run.unsafeResumeRequired = false
        await this.store.save(run)
        await this.#event(run, 'tool_failed', { toolName: name, success: false, durationMs: Date.now() - started, errorCode: toolError.code || 'TOOL_FAILED' })
      }
    }

    const errors = control.errors
    const repeatedKey = executionState.lastToolErrorKey && errors.some((entry) => entry.key === executionState.lastToolErrorKey)
      ? executionState.lastToolErrorKey
      : errors[0]?.key
    const toolTransition = transitionAgentExecutionState(executionState, {
      type: 'tool_batch_result', ok: errors.length === 0, ...(repeatedKey ? { key: repeatedKey } : {}),
    })
    executionState = toolTransition.state
    if (toolTransition.warning === 'repeated_tool_error') {
      const name = errors.find((entry) => entry.key === repeatedKey)?.name || 'tool'
      journal = deferAgentToolBatchMessage(journal, {
        role: 'user',
        content: `The same ${name} error repeated across ${executionState.repeatedToolErrors} model turns. Change strategy: inspect a precise source anchor, make a smaller edit, or switch to a narrower diagnostic.`,
      })
    }

    let stopReason = toolTransition.stopReason
    if (control.validationObserved) {
      const signatures = control.validationFailures.filter((value: unknown) => typeof value === 'string' && value)
      const signature = executionState.lastValidationFailure && signatures.includes(executionState.lastValidationFailure)
        ? executionState.lastValidationFailure
        : signatures[0]
      const validationTransition = transitionAgentExecutionState(executionState, {
        type: 'validation_result', ok: signatures.length === 0, ...(signature ? { signature } : {}),
      })
      executionState = validationTransition.state
      stopReason ||= validationTransition.stopReason
    }

    const closeReason = control.finishRequested
      ? 'finish completed before the remaining sibling calls were executed'
      : journal.calls.length > journal.limit
        ? `the per-turn execution limit is ${journal.limit}`
        : stopReason || 'the host closed this tool batch'
    const closed = closeAgentToolBatchJournal(journal, closeReason)
    run.messages.push(...closed.messages as OrbitMessage[])
    run.pendingToolBatch = null
    run.pendingToolBatchControl = null
    run.pendingTool = null
    run.unsafeResumeRequired = false
    run.executionState = executionState
    assertAgentTranscriptProtocol(run.messages)

    if (control.finishRequested) {
      run.result = { workspace: run.workspace, validation: run.lastValidation }
      run.lastError = null
      if (run.mode === 'orbit' && run.cloudRunId) await api.settle(run.cloudRunId, 'complete').catch(() => undefined)
      await this.store.transition(run, 'completed')
      return { executionState, finished: true }
    }
    if (stopReason === 'repeated_validation_failure_limit') {
      run.lastError = { code: 'REPEATED_VALIDATION_FAILURE', message: 'The same validation failure repeated without progress. The checkpoint is preserved for inspection.' }
      await this.store.transition(run, 'paused')
      return { executionState, finished: true }
    }
    if (stopReason === 'repeated_tool_error_limit') {
      run.lastError = { code: 'REPEATED_TOOL_ERROR', message: 'The same tool error repeated across model turns without a strategy change. The checkpoint is preserved for inspection.' }
      await this.store.transition(run, 'paused')
      return { executionState, finished: true }
    }
    await this.store.save(run)
    return { executionState, finished: false }
  }

  async #systemPrompt(run: OrbitRun): Promise<string> {
    return [
      'You are the public Orbit CLI local coding agent. Work only through the declared tools.',
      'Create or edit the selected local workspace. Use update_agent_plan first, keep changes focused, validate, and call finish.',
      ORBIT_AGENT_RENDER_SURFACE_CONTRACT,
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
    const listener = this.progressListeners.get(run.id)
    if (listener) {
      await Promise.resolve(listener({ ...event, ...fields, runId: run.id } as RunProgressEvent)).catch(() => undefined)
    }
    await this.cloudLogs?.emit(run, { ...event, ...fields })
  }
}
