import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const WECHAT_MINI_GAME_EXPORT_SCHEMA = 'orbit.wechat-mini-game-source-export.v1'
export const PLATFORM_MINI_GAME_EXPORT_SCHEMA = 'orbit.platform-mini-game-source-export.v1'
export const WECHAT_MINI_GAME_EXPORT_MAX_BYTES = 150 * 1024 * 1024

export const MINI_GAME_EXPORT_PLATFORMS = ['wechat', 'douyin', 'tiktok'] as const
export type MiniGameExportPlatform = (typeof MINI_GAME_EXPORT_PLATFORMS)[number]

export interface WechatMiniGameSourceExportResult {
  schema: typeof WECHAT_MINI_GAME_EXPORT_SCHEMA | typeof PLATFORM_MINI_GAME_EXPORT_SCHEMA
  platform: `${MiniGameExportPlatform}-mini-game`
  mode: 'native' | 'agent_assisted'
  workspace: string
  outputDirectory: string
  copiedFiles: number
  copiedBytes: number
  entry: 'game.js'
}

const EXCLUDED_NAMES = new Set(['.DS_Store', '.git', '.orbit', '.orbit-publish', 'agent.jsonl', 'node_modules', 'run.json'])

const PLATFORM = {
  wechat: { label: 'WeChat Mini Game', runtime: 'wx', developerTool: 'WeChat DevTools', appid: 'touristappid' },
  douyin: { label: 'Douyin Mini Game', runtime: 'tt', developerTool: 'Douyin Developer Tools', appid: 'tt-your-app-id' },
  tiktok: { label: 'TikTok Mini Game', runtime: 'TTMinis.game', developerTool: 'TikTok Mini Game DevTool', appid: '' },
} as const

export function normalizeMiniGameExportPlatform(value: unknown): MiniGameExportPlatform {
  const platform = String(value || '').trim().toLowerCase()
  if ((MINI_GAME_EXPORT_PLATFORMS as readonly string[]).includes(platform)) return platform as MiniGameExportPlatform
  throw new TypeError(`Mini Game export platform must be one of: ${MINI_GAME_EXPORT_PLATFORMS.join(', ')}`)
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function excluded(relative: string): boolean {
  const parts = relative.split(path.sep)
  if (parts.some((part) => EXCLUDED_NAMES.has(part))) return true
  return parts.some((part) => /^\.env(?:\.|$)/i.test(part) || /(?:secret|credential|private[-_.]?key)/i.test(part))
}

async function exists(value: string): Promise<boolean> {
  return fs.lstat(value).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

async function isRegularFile(value: string): Promise<boolean> {
  return fs.lstat(value).then(
    (stat) => stat.isFile() && !stat.isSymbolicLink(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
}

async function workspaceRoot(value: string): Promise<string> {
  const absolute = path.resolve(String(value || ''))
  const stat = await fs.lstat(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Workspace must be a real directory')
  return fs.realpath(absolute)
}

async function copySource(sourceRoot: string, destinationRoot: string, prefix: string) {
  let copiedFiles = 0
  let copiedBytes = 0
  async function visit(relative = ''): Promise<void> {
    const entries = await fs.readdir(relative ? path.join(sourceRoot, relative) : sourceRoot, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const child = relative ? path.join(relative, entry.name) : entry.name
      if (excluded(child)) continue
      if (entry.isSymbolicLink()) throw new Error(`Mini Game export refuses symbolic links: ${child}`)
      const source = path.join(sourceRoot, child)
      const destination = path.join(destinationRoot, prefix, child)
      if (entry.isDirectory()) {
        await fs.mkdir(destination, { recursive: true })
        await visit(child)
        continue
      }
      if (!entry.isFile()) throw new Error(`Mini Game export refuses non-file entries: ${child}`)
      const stat = await fs.lstat(source)
      copiedFiles += 1
      copiedBytes += stat.size
      if (copiedFiles > 8_000 || copiedBytes > WECHAT_MINI_GAME_EXPORT_MAX_BYTES) throw new Error('Mini Game source export exceeds the 8,000-file or 150 MiB safety limit')
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(source, destination)
    }
  }
  await visit()
  return { copiedFiles, copiedBytes }
}

const SKILL = `---
name: orbit-wechat-mini-game-adapter
description: Port an exported Orbit browser game into the WeChat Mini Game JavaScript runtime.
---

# Orbit WeChat Mini Game adaptation

Turn the reference project under \`orbit-source/\` into a real WeChat Mini Game source project. The submitted game must start from root \`game.js\` in WeChat DevTools. Do not ship an iframe, WebView, remote HTML page, or a placeholder screen.

## Runtime contract

- WeChat Mini Game has no browser DOM. Replace \`document\`, HTML layout, DOM events, \`localStorage\`, \`HTMLAudioElement\`, and browser-only loading code.
- Create the primary render surface with \`wx.createCanvas()\`. Use \`wx.onTouchStart\`, \`wx.onTouchMove\`, and \`wx.onTouchEnd\` for touch input.
- Use \`wx.createInnerAudioContext()\` for audio and \`wx.getStorageSync\` / \`wx.setStorageSync\` for local persistence.
- Keep runtime code and required assets inside the project or on explicitly configured WeChat download domains. Do not load gameplay code from a CDN.
- Preserve the original game loop, scoring, start/restart/end paths, portrait-first layout, and readable touch controls.
- Call \`notifyOrbitStart()\` once when a real run begins and \`notifyOrbitEnd({ score, outcome })\` exactly once when it ends.

## Workflow

1. Read the source entry, gameplay/state modules, rendering code, controls, audio, and required assets under \`orbit-source/\`.
2. Create an execution plan that separates reusable game logic from browser-only presentation.
3. Port reusable state/physics/scoring modules under root \`src/\`, then rebuild rendering and input against WeChat APIs.
4. Replace the root \`game.js\` placeholder with the real entry and keep \`game.json\` / \`project.config.json\` valid.
5. Validate JavaScript syntax and confirm there are no runtime dependencies on \`window.document\`, iframe, WebView, or remote HTML.
6. Open the exported root in WeChat DevTools and test start, touch input, restart, game over, score, resize, audio, and assets on a device.

## Completion gate

- Root \`game.js\` runs the actual game rather than an adaptation notice.
- No browser page is loaded at runtime.
- All required assets are included or use approved WeChat download domains.
- Touch controls work at phone sizes.
- Start and end lifecycle calls are wired to real gameplay.
`

function scaffold(platformId: MiniGameExportPlatform, title: string): Record<string, string> {
  const platform = PLATFORM[platformId]
  const platformSkill = SKILL
    .replaceAll('WeChat Mini Game', platform.label)
    .replaceAll('WeChat DevTools', platform.developerTool)
    .replaceAll('WeChat download domains', 'platform-approved download domains')
    .replaceAll('WeChat APIs', `${platform.label} APIs`)
    .replaceAll('wechat-mini-game', `${platformId}-mini-game`)
    .replaceAll('wx.', `${platform.runtime}.`)
  return {
    'game.js': `const runtime = ${platform.runtime}\nconst canvas = runtime.createCanvas()\nconst context = canvas.getContext('2d')\nconst info = runtime.getWindowInfo ? runtime.getWindowInfo() : runtime.getSystemInfoSync()\ncanvas.width = Math.max(1, Number(info.windowWidth || 375))\ncanvas.height = Math.max(1, Number(info.windowHeight || 667))\ncontext.fillStyle = '#0b0c10'\ncontext.fillRect(0, 0, canvas.width, canvas.height)\ncontext.fillStyle = '#fff'\ncontext.font = 'bold 20px sans-serif'\ncontext.fillText('Orbit ${platform.label} export', 24, 56)\ncontext.fillStyle = 'rgba(255,255,255,.68)'\ncontext.font = '14px sans-serif'\ncontext.fillText('Adapt orbit-source with SKILL.md before shipping.', 24, 92)\n`,
    'game.json': `${JSON.stringify({ deviceOrientation: 'portrait', showStatusBar: false, resizable: true }, null, 2)}\n`,
    'project.config.json': `${JSON.stringify({ ...(platform.appid ? { appid: platform.appid } : {}), projectname: title, compileType: 'game', miniprogramRoot: './', setting: { es6: true, minified: true, urlCheck: true } }, null, 2)}\n`,
    'src/orbit-lifecycle.js': `export function notifyOrbitStart() { console.info('[orbit] game start') }\nexport function notifyOrbitEnd(payload = {}) { console.info('[orbit] game end', payload) }\n`,
    'SKILL.md': `${platformSkill}${platformId === 'tiktok' ? '\n- TikTok H5 runtime is historical for new integrations; finish this current native-runtime package and debug it with the official @ttmg/cli tooling.\n' : ''}`,
    'AGENT_PROMPT.md': `Read SKILL.md first, then port the playable source under orbit-source/ into this ${platform.label} project. Replace the placeholder root game.js with working platform-runtime gameplay. Do not use an iframe, WebView, remote HTML page, runtime CDN, eval, or Function constructor.\n`,
    'README.md': `# ${title} — ${platform.label} source export\n\nThis is an agent-assisted source project. The original Orbit project is under \`orbit-source/\`; root \`game.js\` is intentionally a visible adaptation marker until a coding agent completes the DOM-free ${platform.label} runtime port described by \`SKILL.md\`.\n\nOpen this directory in ${platform.developerTool} after adaptation.${platformId === 'tiktok' ? ' Use the official @ttmg/cli DevTool flow and configure the real client key.' : ` Replace \`${platform.appid}\` with the real AppID before upload.`} Orbit does not publish or submit the project automatically.\n`,
  }
}

export async function exportPlatformMiniGameSource({ platform: rawPlatform, workspace, outputDirectory, title }: { platform: MiniGameExportPlatform; workspace: string; outputDirectory?: string; title?: string }): Promise<WechatMiniGameSourceExportResult> {
  const platform = normalizeMiniGameExportPlatform(rawPlatform)
  const descriptor = PLATFORM[platform]
  const sourceRoot = await workspaceRoot(workspace)
  const fallback = path.basename(sourceRoot).replace(/[^A-Za-z0-9._-]+/g, '-') || 'orbit-game'
  const output = path.resolve(outputDirectory || path.join(path.dirname(sourceRoot), `${fallback}-${platform}-mini-game`))
  if (contained(sourceRoot, output) || contained(output, sourceRoot)) throw new Error('Mini Game export output must be a separate sibling directory, not inside the source workspace')
  if (await exists(output)) throw new Error(`Mini Game export output already exists: ${output}`)
  const temp = path.join(path.dirname(output), `.${path.basename(output)}.tmp-${randomUUID()}`)
  await fs.mkdir(temp)
  try {
    const mode = await isRegularFile(path.join(sourceRoot, 'game.js')) && await isRegularFile(path.join(sourceRoot, 'game.json')) ? 'native' as const : 'agent_assisted' as const
    const copied = await copySource(sourceRoot, temp, mode === 'native' ? '' : 'orbit-source')
    if (mode === 'agent_assisted') {
      const normalizedTitle = String(title || fallback).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback
      for (const [relative, content] of Object.entries(scaffold(platform, normalizedTitle))) {
        const target = path.join(temp, relative)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content, { encoding: 'utf8', flag: 'wx' })
      }
    } else {
      await fs.writeFile(path.join(temp, 'ORBIT-EXPORT.md'), `# Orbit ${descriptor.label} source export\n\nOrbit preserved this existing native game.js/game.json project. Confirm its target, then test it in ${descriptor.developerTool} and on-device before submission.\n`, { flag: 'wx' })
    }
    const schema = platform === 'wechat' ? WECHAT_MINI_GAME_EXPORT_SCHEMA : PLATFORM_MINI_GAME_EXPORT_SCHEMA
    await fs.writeFile(path.join(temp, 'orbit-export.json'), `${JSON.stringify({ schema, platform: `${platform}-mini-game`, mode, entry: 'game.js', sourceDirectory: mode === 'native' ? './' : 'orbit-source/', requiresAgentAdaptation: mode === 'agent_assisted', generatedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' })
    await fs.rename(temp, output)
    return { schema, platform: `${platform}-mini-game`, mode, workspace: sourceRoot, outputDirectory: output, copiedFiles: copied.copiedFiles, copiedBytes: copied.copiedBytes, entry: 'game.js' }
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export function exportWechatMiniGameSource(input: Omit<Parameters<typeof exportPlatformMiniGameSource>[0], 'platform'>) {
  return exportPlatformMiniGameSource({ ...input, platform: 'wechat' })
}
