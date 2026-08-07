const SECRET_SUFFIXES = ['.jks', '.key', '.keystore', '.p12', '.pem', '.pfx']

const TOKEN_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, 'private key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, 'private key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'GitHub token'],
  [/\bsb_secret_[A-Za-z0-9._-]{12,}\b/g, 'Supabase secret'],
  [/\borb_[A-Za-z0-9._-]{12,}\b/g, 'Orbit token'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, 'provider secret'],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g, 'Stripe secret'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AWS access key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'Google API key'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, 'Slack token'],
  [/\bnpm_[A-Za-z0-9]{20,}\b/g, 'npm token'],
  [/\br8_[A-Za-z0-9]{30,}\b/g, 'Replicate token'],
  [/\bhf_[A-Za-z0-9]{20,}\b/g, 'Hugging Face token'],
]

const ASSIGNED_SECRET = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?token|secret[_-]?key|service[_-]?password|password)\b\s*["'`]?\s*[:=]\s*["'`]([^"'`\r\n]{12,})["'`]/gi
const CREDENTIAL_URL = /\bhttps?:\/\/[^/\s:@]+:[^/\s@]{8,}@/gi

function placeholder(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (value.length < 16 || new Set(value).size < 6) return true
  return normalized.includes('${')
    || normalized.includes('process.env')
    || normalized.includes('import.meta.env')
    || /(?:example|placeholder|change[-_ ]?me|replace[-_ ]?me|dummy|your[-_ ]|\btest\b|\bfixture\b|\bsample\b)/i.test(normalized)
    || /^<[^>]+>$/.test(normalized)
    || /^x{12,}$/i.test(normalized)
}

export function secretLikeFileName(name: unknown): boolean {
  const lower = String(name || '').toLowerCase()
  if (lower === '.env' || lower.startsWith('.env.') || lower === '.dev.vars' || lower.startsWith('.dev.vars.')) return true
  if (lower === 'id_rsa' || lower === 'id_ed25519') return true
  if (SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true
  return lower.includes('service-account') && lower.endsWith('.json')
}

export function findHighConfidenceSecrets(value: unknown): string[] {
  const text = String(value || '')
  const findings = []
  for (const [pattern, label] of TOKEN_RULES) {
    pattern.lastIndex = 0
    if (pattern.test(text)) findings.push(label)
  }
  ASSIGNED_SECRET.lastIndex = 0
  for (const match of text.matchAll(ASSIGNED_SECRET)) {
    const candidate = match[1]
    if (candidate && !placeholder(candidate)) findings.push('assigned credential')
  }
  CREDENTIAL_URL.lastIndex = 0
  if (CREDENTIAL_URL.test(text)) findings.push('credential-bearing URL')
  return [...new Set(findings)]
}

export function redactHighConfidenceSecrets(value: unknown): string {
  let text = String(value || '')
  for (const [pattern, label] of TOKEN_RULES) {
    pattern.lastIndex = 0
    text = text.replace(pattern, `[redacted-${label.replaceAll(' ', '-').toLowerCase()}]`)
  }
  ASSIGNED_SECRET.lastIndex = 0
  text = text.replace(ASSIGNED_SECRET, (match: string, secret: string) => placeholder(secret) ? match : match.replace(secret, '[redacted-assigned-credential]'))
  CREDENTIAL_URL.lastIndex = 0
  return text.replace(CREDENTIAL_URL, '[redacted-credential-url]')
}

export function scanSecretBytes(bytes: Buffer | Uint8Array): string[] {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.includes(0)) return []
  try {
    return findHighConfidenceSecrets(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
  } catch {
    return []
  }
}
