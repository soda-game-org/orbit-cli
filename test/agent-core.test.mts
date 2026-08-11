import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ORBIT_AGENT_EXECUTION_POLICY,
  ORBIT_AGENT_RENDER_SURFACE_CONTRACT,
  agentPlanOpenBlockingTodosForFinish,
  buildOrbitProAgentCoreModuleSource,
  completePublishTodosForFinish,
  createAgentExecutionState,
  normalizeAgentPlan,
  renderSurfaceActivityIssues,
  transitionAgentExecutionState,
} from '@soda_game/orbit-agent-core'

test('public CLI consumes the shared execution budget and streak state machine', () => {
  assert.equal(ORBIT_AGENT_EXECUTION_POLICY.maxIterations, 1_500)
  assert.equal(ORBIT_AGENT_EXECUTION_POLICY.maxToolCallsPerTurn, 16)

  let state = createAgentExecutionState()
  for (let index = 0; index < 2; index += 1) {
    const transition = transitionAgentExecutionState(state, { type: 'tool_batch', count: 0 })
    assert.equal(transition.stopReason, null)
    state = transition.state
  }
  assert.equal(
    transitionAgentExecutionState(state, { type: 'tool_batch', count: 0 }).stopReason,
    'no_tool_limit',
  )
})

test('public core exposes the target-neutral render contract and DPR confinement check', () => {
  assert.match(ORBIT_AGENT_RENDER_SURFACE_CONTRACT, /logical stage width and height in CSS pixels/i)
  assert.equal(ORBIT_AGENT_RENDER_SURFACE_CONTRACT.includes('3:4'), false)
  assert.match(renderSurfaceActivityIssues([{
    probeId: 'public-dpr-2',
    viewport: { width: 600, height: 800 },
    renderSurfaces: [{
      css: { width: 600, height: 800 },
      backing: { width: 1200, height: 1600 },
      activity: { detailSamples: 120, detailBounds: { right: 0.5, bottom: 0.5 } },
    }],
  }]).join('\n'), /upper-left of a higher-resolution backing store/i)
})

test('shared finish gate preserves implementation work and completes delivery work', () => {
  const plan = normalizeAgentPlan({
    summary: 'Build and validate',
    currentTodoId: 'code',
    todos: [
      { id: 'code', title: 'Implement the game', status: 'in_progress', kind: 'code' },
      { id: 'ship', title: 'Finish delivery', status: 'pending', kind: 'publish' },
    ],
  })
  assert.deepEqual(agentPlanOpenBlockingTodosForFinish(plan).map((todo) => todo.id), ['code'])

  const ready = normalizeAgentPlan({
    summary: 'Ready',
    todos: [
      { id: 'code', title: 'Implement the game', status: 'completed', kind: 'code' },
      { id: 'ship', title: 'Finish delivery', status: 'in_progress', kind: 'publish' },
    ],
  }, plan)
  assert.equal(agentPlanOpenBlockingTodosForFinish(ready).length, 0)
  assert.equal(completePublishTodosForFinish(ready)?.todos.find((todo) => todo.id === 'ship')?.status, 'completed')
})

test('generated cloud module keeps execution semantics byte-derived from the same core', async () => {
  const source = buildOrbitProAgentCoreModuleSource()
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  const generated: any = await import(url)
  const transition = generated.transitionAgentExecutionState(
    generated.createAgentExecutionState(),
    { type: 'model_failure' },
  )
  assert.equal(transition.state.consecutiveModelFailures, 1)
  assert.equal(transition.stopReason, null)
})
