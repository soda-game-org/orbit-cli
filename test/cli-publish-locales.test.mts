import assert from 'node:assert/strict'
import test from 'node:test'
import { main } from '../src/cli.mjs'

const RUN_ID = 'run_11111111-1111-4111-8111-111111111111'

function buildApp(captured: { value: any }) {
  return {
    store: {
      recoverInterrupted: async () => [],
      load: async () => ({
        id: RUN_ID,
        state: 'completed',
        workspace: '/tmp/orbit-game',
        prompt: 'test',
        runtime: 'html',
        kind: 'game',
        lastValidation: { ok: true, index: 'index.html' },
      }),
    },
    auth: { accessToken: async () => 'token' },
    apiFactory: () => ({}),
    publishFactory: () => ({
      publish: async (input: any) => { captured.value = input; return { game: { id: 'g_test', title: 'T' } } },
    }),
  }
}

test('publish --locales forwards normalized extra_locales to the publish service', async () => {
  const captured: { value: any } = { value: null }
  const code = await main(['publish', RUN_ID, '--locales', 'zh-Hans,ja,en', '--yes'], { app: buildApp(captured) })
  assert.equal(code, 0)
  assert.deepEqual(captured.value.extraLocales, ['ja', 'zh-Hans'])
})

test('publish --locale zh falls back to a single zh-Hans extra locale', async () => {
  const captured: { value: any } = { value: null }
  const code = await main(['publish', RUN_ID, '--locale', 'zh', '--yes'], { app: buildApp(captured) })
  assert.equal(code, 0)
  assert.deepEqual(captured.value.extraLocales, ['zh-Hans'])
  assert.equal(captured.value.locale, 'zh')
})

test('publish without locale flags publishes English-only', async () => {
  const captured: { value: any } = { value: null }
  const code = await main(['publish', RUN_ID, '--yes'], { app: buildApp(captured) })
  assert.equal(code, 0)
  assert.deepEqual(captured.value.extraLocales, [])
  assert.equal(captured.value.locale, 'en')
})

test('publish --locales wins over --locale zh', async () => {
  const captured: { value: any } = { value: null }
  const code = await main(['publish', RUN_ID, '--locales', 'ja,fr', '--locale', 'zh', '--yes'], { app: buildApp(captured) })
  assert.equal(code, 0)
  assert.deepEqual(captured.value.extraLocales, ['fr', 'ja'])
  assert.equal(captured.value.locale, 'zh')
})
