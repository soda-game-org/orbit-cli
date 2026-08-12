import fs from 'node:fs/promises'
import path from 'node:path'
import {
  normalizeAgentStoreMediaManifest,
  type OrbitAgentStoreMediaManifest,
} from '@soda_game/orbit-agent-core'
import { writeJsonAtomic } from './util.mjs'
import type { OrbitRun } from './types.mjs'

type Dynamic = Record<string, any>

export const LOCAL_STORE_MEDIA_PATHS = Object.freeze({
  manifest: '.orbit/artifacts/store/manifest.json',
  listingCover: '.orbit/artifacts/store/listing-cover.png',
  appIcon: '.orbit/artifacts/store/app-icon.png',
})

async function regularFile(workspace: string, relative: string): Promise<boolean> {
  const stat = await fs.lstat(path.join(workspace, relative)).catch(() => null)
  return Boolean(stat?.isFile() && !stat.isSymbolicLink())
}

function generatedAsset(result: Dynamic, role: 'listing_cover' | 'app_icon'): Dynamic {
  return {
    role,
    state: 'generated',
    location: String(result.relativePath || ''),
    mediaType: String(result.contentType || 'image/png'),
    digest: String(result.sha256 || ''),
    width: Number(result.width) || undefined,
    height: Number(result.height) || undefined,
  }
}

export async function ensureLocalStoreMedia(input: {
  run: OrbitRun
  image: Dynamic
  api?: Dynamic
  persist: () => Promise<void>
  retryUnsafe?: boolean
}): Promise<OrbitAgentStoreMediaManifest> {
  const { run } = input
  run.storeMediaGeneration ||= {}
  const assets: Dynamic = {}
  const requests = [
    {
      role: 'listing_cover' as const,
      key: 'listingCover',
      output: LOCAL_STORE_MEDIA_PATHS.listingCover,
      aspectRatio: '3:4',
      prompt: `Create a textless 3:4 portrait game store cover for this original Orbit Arcade game. Show the core playable fantasy, characters, action, and visual identity clearly. No logos, title text, controls, UI instructions, borders, or app-store branding. Game request: ${run.prompt}`,
    },
    {
      role: 'app_icon' as const,
      key: 'appIcon',
      output: LOCAL_STORE_MEDIA_PATHS.appIcon,
      aspectRatio: '1:1',
      prompt: `Create a textless square arcade game icon for this original Orbit Arcade game. Use one bold readable game symbol or character silhouette, strong color separation, and no words, logos, UI, borders, or corporate branding. Game request: ${run.prompt}`,
    },
  ]

  for (const request of requests) {
    const previous = run.storeMedia?.assets?.[request.role]
    if (await regularFile(run.workspace, request.output)) {
      assets[request.role] = previous?.state === 'generated'
        ? previous
        : { role: request.role, state: 'provided', location: request.output, mediaType: 'image/png' }
      continue
    }
    if (!run.generateImages || !input.image || (run.mode === 'orbit' && !input.api)) {
      assets[request.role] = {
        role: request.role,
        state: 'skipped',
        reason: 'capability_unavailable',
      }
      continue
    }
    const state = run.storeMediaGeneration[request.role] ||= {}
    try {
      const result = await input.image.generate({
        mode: run.mode,
        api: input.api,
        workspace: run.workspace,
        prompt: request.prompt,
        output: request.output,
        aspectRatio: request.aspectRatio,
        state,
        retryUnsafe: input.retryUnsafe === true,
        clientRunId: `${run.id}.store.${request.key}`,
        requestKey: `store_${run.id}_${request.key}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 160),
        persist: input.persist,
      })
      assets[request.role] = generatedAsset(result, request.role)
    } catch (error) {
      assets[request.role] = {
        role: request.role,
        state: 'failed',
        reason: String((error as Error)?.message || error).slice(0, 1_000),
      }
    }
  }

  const manifest = normalizeAgentStoreMediaManifest({
    projectId: run.threadId || run.id,
    updatedAt: new Date().toISOString(),
    assets,
  })
  run.storeMedia = manifest
  await writeJsonAtomic(path.join(run.workspace, LOCAL_STORE_MEDIA_PATHS.manifest), manifest)
  await input.persist()
  return manifest
}
