import { appDirectories } from './util.mjs'
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

export function createApplication({ directories = appDirectories(), fetchImpl = fetch } = {}) {
  const credentials = new CredentialStore()
  const auth = new OrbitAuth(credentials)
  const config = new ConfigStore({ directories })
  const store = new RunStore({ directories })
  const apiFactory = (source = 'cli') => new OrbitApi(auth, { fetchImpl, source })
  const byok = new ByokProvider(credentials, { fetchImpl })
  const threeD = new ThreeDService({ api: apiFactory('cli'), credentials, fetchImpl })
  const cloudLogs = new CloudLogSink(apiFactory, { directories })
  const manager = new RunManager({ store, config, credentials, auth, apiFactory, byok, threeD, cloudLogs })
  const asset3d = new Asset3DManager({ store, config, auth, credentials, apiFactory, threeD, cloudLogs })
  const publishFactory = (api) => new PublishService(api)
  return {
    asset3d, auth, byok, cloudLogs, config, credentials, directories, manager, store, threeD, apiFactory, publishFactory,
    web: () => new WebCliServer({ asset3d, manager, auth, byok, config, credentials, store, apiFactory, publishFactory, directories }),
  }
}
