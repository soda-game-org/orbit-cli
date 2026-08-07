import { WEB_ORIGIN } from './constants.mjs'
import { openExternal } from './util.mjs'

export type CadeBalanceState = 'normal' | 'low' | 'exhausted' | 'unavailable'

export interface OrbitAccountOverview {
  signedIn: boolean
  userId: string | null
  email: string | null
  cadeBalance: number | null
  cadeBalanceState: CadeBalanceState
  nextExpiration: string | null
  hasActiveSubscription: boolean
  billingUrl: string | null
}

export class OrbitAccount {
  readonly auth: { status(): Promise<any> }
  readonly apiFactory: (source?: 'cli' | 'cli_gui') => { billingCatalog(locale?: string, timeoutMs?: number): Promise<any> }

  constructor(auth: OrbitAccount['auth'], apiFactory: OrbitAccount['apiFactory']) {
    this.auth = auth
    this.apiFactory = apiFactory
  }

  async status({ source = 'cli', timeoutMs = 5_000 }: { source?: 'cli' | 'cli_gui'; timeoutMs?: number } = {}): Promise<OrbitAccountOverview> {
    const auth = await this.auth.status()
    if (!auth?.signedIn) return signedOutOverview()
    const identity = {
      signedIn: true,
      userId: typeof auth.userId === 'string' ? auth.userId : null,
      email: typeof auth.email === 'string' ? auth.email : null,
    }
    try {
      return { ...identity, ...parseBillingCatalog(await this.apiFactory(source).billingCatalog(accountLocale(), timeoutMs)) }
    } catch {
      return {
        ...identity,
        cadeBalance: null,
        cadeBalanceState: 'unavailable',
        nextExpiration: null,
        hasActiveSubscription: false,
        billingUrl: null,
      }
    }
  }

  async openBilling(source: 'cli' | 'cli_gui' = 'cli'): Promise<OrbitAccountOverview> {
    const account = await this.status({ source })
    if (!account.signedIn) throw new Error('Sign in first with `orbit auth login`')
    if (!account.billingUrl) throw new Error('Orbit billing is temporarily unavailable')
    openExternal(account.billingUrl)
    return account
  }

  openProfile(): void {
    openExternal(new URL('/settings', WEB_ORIGIN).toString())
  }
}

function signedOutOverview(): OrbitAccountOverview {
  return {
    signedIn: false,
    userId: null,
    email: null,
    cadeBalance: null,
    cadeBalanceState: 'unavailable',
    nextExpiration: null,
    hasActiveSubscription: false,
    billingUrl: null,
  }
}

function parseBillingCatalog(value: any): Omit<OrbitAccountOverview, 'signedIn' | 'userId' | 'email'> {
  if (!value || value.contract_version !== 1 || !value.cade || !value.admission?.create) {
    throw new TypeError('Orbit billing catalog is invalid')
  }
  const balance = Number(value.cade.balance)
  if (!Number.isSafeInteger(balance) || balance < -1_000_000_000 || balance > 1_000_000_000) {
    throw new TypeError('Orbit Cade balance is invalid')
  }
  const allowed = value.admission.create.allowed
  if (typeof allowed !== 'boolean') throw new TypeError('Orbit Cade admission is invalid')
  const billingUrl = trustedBillingUrl(value.web_billing_url)
  return {
    cadeBalance: balance,
    cadeBalanceState: !allowed ? 'exhausted' : balance <= 20 ? 'low' : 'normal',
    nextExpiration: value.cade.next_expiration == null ? null : validIsoDate(value.cade.next_expiration),
    hasActiveSubscription: value.subscription != null,
    billingUrl,
  }
}

function trustedBillingUrl(value: unknown): string {
  const url = new URL(String(value || ''))
  if (url.protocol !== 'https:' || url.origin !== WEB_ORIGIN || url.pathname !== '/settings/billing'
    || url.username || url.password || url.hash) throw new TypeError('Orbit billing URL is invalid')
  return url.toString()
}

function validIsoDate(value: unknown): string {
  const text = String(value || '')
  if (!text || !Number.isFinite(Date.parse(text))) throw new TypeError('Orbit Cade expiration is invalid')
  return text
}

function accountLocale(): string {
  return /^zh\b/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '') ? 'zh' : 'en'
}
