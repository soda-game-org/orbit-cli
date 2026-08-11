import assert from 'node:assert/strict'
import test from 'node:test'
import { ORBIT_AGENT_MODEL_OUTPUT_LIMITS } from '@soda_game/orbit-agent-core'
import { OrbitApi } from '../src/api.mjs'

test('managed completion defaults to the shared full agent output budget', async () => {
  let requestBody: any = null
  const api = new OrbitApi({ accessToken: async () => 'token' }, {
    origin: 'https://orbit.invalid',
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body || '{}'))
      return new Response(JSON.stringify({ assistant: { role: 'assistant', content: 'ok' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  await api.complete({ cloudRunId: 'cloud-run', requestKey: 'request-1', messages: [{ role: 'user', content: 'Build' }] })
  assert.equal(requestBody.max_output_tokens, ORBIT_AGENT_MODEL_OUTPUT_LIMITS.agent)
})
