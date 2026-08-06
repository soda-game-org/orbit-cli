/**
 * Curated BCP47-style locale choices offered by the CLI / Web CLI multi-select.
 *
 * This list is a UX convenience only — the backend accepts any
 * well-formed BCP47 string. Do not treat this as a hardcoded language
 * policy mapping; it exists purely so the chip row shows readable
 * labels for the most common choices. English is always implicit
 * (the backend always receives `STRINGS.en`) and therefore never
 * appears as a toggleable chip.
 */
export const LOCALE_CHOICES: ReadonlyArray<{ tag: string; label: string }> = Object.freeze([
  { tag: 'zh-Hans', label: '简体中文' },
  { tag: 'zh-Hant', label: '繁體中文' },
  { tag: 'ja', label: '日本語' },
  { tag: 'ko', label: '한국어' },
  { tag: 'es', label: 'Español' },
  { tag: 'es-MX', label: 'Español (México)' },
  { tag: 'fr', label: 'Français' },
  { tag: 'de', label: 'Deutsch' },
  { tag: 'it', label: 'Italiano' },
  { tag: 'pt-BR', label: 'Português (Brasil)' },
  { tag: 'ru', label: 'Русский' },
  { tag: 'ar', label: 'العربية' },
  { tag: 'hi', label: 'हिन्दी' },
  { tag: 'th', label: 'ไทย' },
  { tag: 'vi', label: 'Tiếng Việt' },
])

/**
 * Normalize an arbitrary input (string, array of strings, comma-separated
 * string) into a de-duplicated, sorted list of locale tags excluding `en`
 * (en is always implicit). Returns `[]` when the input is empty or invalid.
 *
 * This mirrors the orbit-world `normalizeExtraLocales` contract so the
 * CLI and the web app agree on what reaches the backend.
 */
export function normalizeExtraLocales(value: unknown): string[] {
  if (value == null) return []
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,]+/).map((s) => s.trim()).filter(Boolean)
      : []
  const out = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = item.trim()
    if (!tag || tag === 'en') continue
    out.add(tag)
  }
  return [...out].sort()
}

/** Human-readable label for a BCP47-style tag, falling back to the tag itself. */
export function arcadeLocaleLabel(tag: string): string {
  const found = LOCALE_CHOICES.find((c) => c.tag === tag)
  return found ? found.label : tag
}
