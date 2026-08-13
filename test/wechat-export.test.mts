import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { exportPlatformMiniGameSource, exportWechatMiniGameSource } from '../src/wechat-export.mjs'

test('exports browser source into an honest agent-assisted WeChat project', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-public-wechat-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'browser')
  const output = path.join(root, 'wechat')
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
  await fs.writeFile(path.join(workspace, 'src', 'game.js'), 'document.body.textContent = "play"\n')
  await fs.writeFile(path.join(workspace, '.env'), 'SECRET=no\n')
  const result = await exportWechatMiniGameSource({ workspace, outputDirectory: output })
  assert.equal(result.mode, 'agent_assisted')
  assert.match(await fs.readFile(path.join(output, 'SKILL.md'), 'utf8'), /no browser DOM/i)
  assert.equal(await fs.stat(path.join(output, '.env')).then(() => true, () => false), false)
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'orbit-export.json'), 'utf8')).requiresAgentAdaptation, true)
})

test('preserves an existing native WeChat project', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-public-wechat-native-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'native')
  const output = path.join(root, 'export')
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'game.js'), 'wx.createCanvas()\n')
  await fs.writeFile(path.join(workspace, 'game.json'), '{}\n')
  const result = await exportWechatMiniGameSource({ workspace, outputDirectory: output })
  assert.equal(result.mode, 'native')
  assert.equal(await fs.readFile(path.join(output, 'game.js'), 'utf8'), 'wx.createCanvas()\n')
})

for (const [platform, runtime] of [['douyin', 'tt'], ['tiktok', 'TTMinis.game']] as const) {
  test(`exports ${platform} agent-assisted native-runtime source`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `orbit-public-${platform}-`))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const workspace = path.join(root, 'browser')
    const output = path.join(root, 'export')
    await fs.mkdir(workspace)
    await fs.writeFile(path.join(workspace, 'index.html'), '<canvas></canvas>\n')
    const result = await exportPlatformMiniGameSource({ platform, workspace, outputDirectory: output })
    assert.equal(result.platform, `${platform}-mini-game`)
    assert.match(await fs.readFile(path.join(output, 'game.js'), 'utf8'), new RegExp(runtime.replace('.', '\\.')))
    assert.equal(JSON.parse(await fs.readFile(path.join(output, 'orbit-export.json'), 'utf8')).requiresAgentAdaptation, true)
  })
}
