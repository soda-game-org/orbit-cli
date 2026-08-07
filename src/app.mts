import { appDirectories, type AppDirectories } from './util.mjs'
import { CredentialStore } from './credentials.mjs'
import { OrbitAuth } from './auth.mjs'
import { ConfigStore } from './config.mjs'
import { RunStore } from './run-store.mjs'
import { OrbitApi } from './api.mjs'
import { ByokProvider } from './provider.mjs'
import { ThreeDService } from './three-d.mjs'
import { CloudLogSink } from './cloud-logs.mjs'
import { RunManager } from './run-manager.mjs'
import { PublishService } from './publish.mjs'
import { WebCliServer } from './web/server.mjs'
import { Asset3DManager } from './asset-3d-manager.mjs'
import { AssetImageManager } from './asset-image-manager.mjs'
import { ImageService } from './image.mjs'
import type { OrbitClientSource } from './types.mjs'
import { OrbitAccount } from './account.mjs'

export function createApplication({ directories = appDirectories(), fetchImpl = fetch }: { directories?: AppDirectories; fetchImpl?: typeof fetch } = {}) {
  const credentials = new CredentialStore()
  const auth = new OrbitAuth(credentials)
  const config = new ConfigStore({ directories })
  const store = new RunStore({ directories })
  const apiFactory = (source: OrbitClientSource = 'cli') => new OrbitApi(auth, { fetchImpl, source })
  const account = new OrbitAccount(auth, apiFactory)
  const byok = new ByokProvider(credentials, { fetchImpl })
  const threeD = new ThreeDService({ api: apiFactory('cli'), credentials, fetchImpl })
  const image = new ImageService({ credentials, fetchImpl })
  const cloudLogs = new CloudLogSink(apiFactory, { directories })
  const manager = new RunManager({ store, config, credentials, auth, apiFactory, byok, threeD, image, cloudLogs })
  const asset3d = new Asset3DManager({ store, config, auth, credentials, apiFactory, threeD, cloudLogs })
  const assetImage = new AssetImageManager({ store, config, auth, apiFactory, image, cloudLogs })
  const publishFactory = (api: OrbitApi) => new PublishService(api)
  return {
    account, asset3d, assetImage, auth, byok, cloudLogs, config, credentials, directories, image, manager, store, threeD, apiFactory, publishFactory,
    web: () => new WebCliServer({ account, asset3d, assetImage, manager, auth, byok, config, credentials, store, apiFactory, publishFactory, directories }),
  }
}
