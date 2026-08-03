import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CloudLogSink } from '../src/cloud-logs.mjs'

test('uploads only structured metadata with an explicit CLI GUI source', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-logs-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let uploaded
  const sink = new CloudLogSink((source) => ({ uploadLogs: async (body) => { uploaded = { source, body }; return { accepted_event_ids: body.events.map((event) => event.event_id) } } }), {
    directories: { config: path.join(root, 'config'), data: path.join(root, 'data') },
  })
  const run = { id: 'run_550e8400-e29b-41d4-a716-446655440000', source: 'cli_gui', cloudLogs: true, sequence: 0 }
  await sink.emit(run, {
    id: '550e8400-e29b-41d4-a716-446655440001', type: 'tool_completed', occurredAt: new Date().toISOString(),
    toolName: 'write_file', success: true, durationMs: 10, prompt: 'must not upload', path: '/private/path', arguments: { secret: true },
  })
  assert.equal(uploaded.source, 'cli_gui')
  assert.equal(uploaded.body.source, 'cli_gui')
  assert.equal(uploaded.body.schema, 'orbit.cli-log.v1')
  assert.deepEqual(Object.keys(uploaded.body.events[0]).sort(), ['client_run_id', 'duration_ms', 'event_id', 'event_type', 'level', 'occurred_at', 'sequence', 'success', 'tool_name'])
})
