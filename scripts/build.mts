import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const executable = process.platform === 'win32' ? 'tsc.cmd' : 'tsc'

await fs.rm(path.join(root, 'dist'), { recursive: true, force: true })
await fs.rm(path.join(root, 'packages/orbit-provider-core/dist'), { recursive: true, force: true })

async function runTypeScript(project: string): Promise<void> {
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(executable, ['-p', project], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`TypeScript compiler stopped with ${signal}`))
      else resolve(code ?? 1)
    })
  })
  if (exitCode !== 0) process.exit(exitCode)
}

await runTypeScript('packages/orbit-provider-core/tsconfig.json')
await runTypeScript('tsconfig.build.json')

await fs.copyFile(path.join(root, 'src/web/index.html'), path.join(root, 'dist/src/web/index.html'))
await fs.copyFile(path.join(root, 'src/web/app.css'), path.join(root, 'dist/src/web/app.css'))
