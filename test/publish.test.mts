import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { PublishService } from '../src/publish.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-publish-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'dist'))
  await fs.writeFile(path.join(root, 'dist', 'index.html'), '<!doctype html><title>Safe game</title>')
  await fs.writeFile(path.join(root, 'source.js'), 'console.log("safe")')
  return root
}

test('prepares a bounded USTAR source archive and excludes local Orbit state', async (t) => {
  const root = await fixture(t)
  const nested = path.join(root, 'a'.repeat(70), 'b'.repeat(50))
  await fs.mkdir(nested, { recursive: true })
  await fs.writeFile(path.join(nested, 'source.js'), 'export default 1')
  await fs.mkdir(path.join(root, '.orbit'))
  await fs.writeFile(path.join(root, '.orbit', 'checkpoint.json'), 'private')
  const prepared = await new PublishService({}).prepare({ workspace: root, runtime: 'html' })
  const tar = gunzipSync(prepared.archive)
  assert.equal(tar.subarray(257, 262).toString('ascii'), 'ustar')
  assert.equal(tar.includes(Buffer.from('checkpoint.json')), false)
  assert.equal(prepared.title, 'Safe game')
})

test('rejects secret-like files in dist instead of silently uploading them', async (t) => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'dist', '.env.production'), 'SECRET=value')
  await assert.rejects(new PublishService({}).prepare({ workspace: root }), /Secret-like files/)
})

test('rejects embedded credentials in ordinary source and dist files without echoing them', async (t) => {
  const root = await fixture(t)
  const providerKey = ['sk', 'proj', 'A'.repeat(32)].join('-')
  await fs.writeFile(path.join(root, 'config.js'), `export const apiKey = "${providerKey}"`)
  await assert.rejects(new PublishService({}).prepare({ workspace: root }), (error) => {
    assert.match(error.message, /Secret-like content cannot be published: config\.js/)
    assert.doesNotMatch(error.message, new RegExp(providerKey))
    return true
  })

  await fs.rm(path.join(root, 'config.js'))
  const githubToken = ['ghp', 'B'.repeat(32)].join('_')
  await fs.writeFile(path.join(root, 'dist', 'bundle.js'), `window.token = "${githubToken}"`)
  await assert.rejects(new PublishService({}).prepare({ workspace: root }), (error) => {
    assert.match(error.message, /Secret-like content cannot be published: bundle\.js/)
    assert.doesNotMatch(error.message, new RegExp(githubToken))
    return true
  })
})

test('allows environment references and obvious placeholders in published source', async (t) => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'config.js'), [
    'export const apiKey = process.env.PROVIDER_API_KEY',
    'export const clientSecret = "replace-me-before-deploying"',
  ].join('\n'))
  await new PublishService({}).prepare({ workspace: root })
})

test('rejects symbolic links anywhere in publish input', async (t) => {
  const root = await fixture(t)
  await fs.symlink(path.join(root, 'source.js'), path.join(root, 'linked.js'))
  await assert.rejects(new PublishService({}).prepare({ workspace: root }), /Symbolic links/)
})

test('publish forwards extra_locales[] (sorted, deduped, en filtered)', async (t) => {
  const root = await fixture(t)
  let captured: FormData | undefined
  const service = new PublishService({
    publish: async (form: FormData) => { captured = form; return { game: { id: 'g_test', title: 'T' } } },
  })
  await service.publish({ workspace: root, extraLocales: ['zh-Hans', 'ja', 'en', 'ja'] })
  const meta = JSON.parse(String(captured!.get('meta')))
  assert.deepEqual(meta.extra_locales, ['ja', 'zh-Hans'])
  const cloud = JSON.parse(await fs.readFile(path.join(root, '.orbit', 'cloud.json'), 'utf8'))
  assert.deepEqual(cloud.extraLocales, ['ja', 'zh-Hans'])
})

test('publish falls back to zh-Hans when legacy --locale zh is used', async (t) => {
  const root = await fixture(t)
  let captured: FormData | undefined
  const service = new PublishService({
    publish: async (form: FormData) => { captured = form; return { game: { id: 'g_test', title: 'T' } } },
  })
  await service.publish({ workspace: root, locale: 'zh' })
  const meta = JSON.parse(String(captured!.get('meta')))
  assert.deepEqual(meta.extra_locales, ['zh-Hans'])
  assert.equal(meta.content_locale, 'zh')
})

test('publish omits extra_locales key when no extra locales are selected', async (t) => {
  const root = await fixture(t)
  let captured: FormData | undefined
  const service = new PublishService({
    publish: async (form: FormData) => { captured = form; return { game: { id: 'g_test', title: 'T' } } },
  })
  await service.publish({ workspace: root })
  const meta = JSON.parse(String(captured!.get('meta')))
  assert.equal(Object.hasOwn(meta, 'extra_locales'), false)
})
