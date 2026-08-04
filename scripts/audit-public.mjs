import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const ignored = new Set(['.git', 'node_modules', 'coverage'])
const allowedTopLevel = new Set(['.github', '.gitignore', 'LICENSE', 'NOTICE.md', 'README.md', 'README.zh-CN.md', 'SECURITY.md', 'bin', 'package-lock.json', 'package.json', 'packages', 'scripts', 'skills', 'src', 'test'])
const forbiddenNames = new Set(['.env', '.dev.vars', 'id_rsa', 'id_ed25519'])
const privateSkillFiles = []
const findings = []

const forbiddenContent = [
  [/\bSUPABASE_SERVICE_(?:KEY|ROLE)\b/g, 'service credential name'],
  [/\bsb_secret_[A-Za-z0-9._-]+/g, 'Supabase secret'],
  [/\bgh[opsu]_[A-Za-z0-9]{20,}/g, 'GitHub token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, 'private key'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, 'provider secret'],
  [/(?:^|["'])\/(?:Users|home)\/[^\s"']+/gm, 'absolute developer path'],
  [/\b(?:codex|opencode|devin|cline|aider)\b/gi, 'third-party agent comparison'],
  [/\bclaude[ _-]?code\b/gi, 'third-party agent comparison'],
  [/\bpi[ _-]?agent\b/gi, 'third-party agent comparison'],
  [/\bmariozechner\b/gi, 'third-party agent implementation reference'],
  [/\bCursor\b/g, 'third-party editor comparison'],
]

async function visit(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolute = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) { findings.push(`${relative}: symbolic link`); continue }
    if (entry.isDirectory()) { await visit(absolute, relative); continue }
    if (!entry.isFile()) { findings.push(`${relative}: non-regular file`); continue }
    if (forbiddenNames.has(entry.name) || /\.(?:jks|key|keystore|p12|pem|pfx|tgz)$/i.test(entry.name)) findings.push(`${relative}: forbidden file type`)
    if (relative.startsWith('skills/') && relative !== 'skills/generic-html-game/SKILL.md') privateSkillFiles.push(relative)
    const stat = await fs.stat(absolute)
    if (stat.size > 12 * 1024 * 1024) { findings.push(`${relative}: unexpectedly large file`); continue }
    const bytes = await fs.readFile(absolute)
    if (bytes.includes(0)) continue
    const text = bytes.toString('utf8')
    if (relative !== 'scripts/audit-public.mjs') {
      for (const [pattern, label] of forbiddenContent) {
        pattern.lastIndex = 0
        if (pattern.test(text)) findings.push(`${relative}: ${label}`)
      }
    }
  }
}

for (const entry of await fs.readdir(root)) {
  if (!ignored.has(entry) && !allowedTopLevel.has(entry)) findings.push(`${entry}: unexpected top-level release entry`)
}
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
if (Object.keys(packageJson.dependencies || {}).some((name) => name.startsWith('@orbit/'))) findings.push('Private Orbit packages cannot be dependencies')
await visit(root)
if (privateSkillFiles.length) findings.push(`Only the generic skill may ship: ${privateSkillFiles.join(', ')}`)
if (findings.length) {
  console.error(`Public release audit failed:\n${[...new Set(findings)].map((finding) => `- ${finding}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log('Public release audit passed: no private trees, credentials, private skills, third-party agent comparisons or symbolic links found.')
}
