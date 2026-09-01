/**
 * The two things that decide what the app looks like: light or dark, and which accent.
 *
 * Both are stored here rather than in a component so the value read at start-up is the
 * value written on change, and so the guards are testable without a DOM. The accent
 * names are the `[data-accent]` selectors in src/styles.css, the `--accent-*` token
 * prefixes in the same file, and the marks in src/assets — adding one means running
 * `npm run accents` for its palette and `npm run logos` for its mark, not just adding
 * a row below.
 */
import { isRecord, type StorageLike } from './settings-persistence'

export type Theme = 'dark' | 'light'
export type Accent = 'purple' | 'neon' | 'lime' | 'orange' | 'cyan' | 'rose'

export interface Appearance {
  theme: Theme
  accent: Accent
}

/** Order is the order the swatches appear in; `label` is what the button announces. */
export const ACCENT_OPTIONS: readonly { value: Accent; label: string }[] = [
  { value: 'purple', label: 'Purple' },
  { value: 'neon', label: 'Neon green' },
  { value: 'lime', label: 'Lime' },
  { value: 'orange', label: 'Orange' },
  { value: 'cyan', label: 'Cyan' },
  { value: 'rose', label: 'Rose' }
]

export const APPEARANCE_KEY = 'hope-converter:appearance'
/** The key App.tsx wrote before accents existed; still read once, so a stored theme survives. */
export const LEGACY_THEME_KEY = 'hope-converter-theme'
/** The palette is designed dark-first in the logo's violet, so that is where it starts. */
export const DEFAULT_APPEARANCE: Appearance = { theme: 'dark', accent: 'purple' }

const ACCENT_VALUES: ReadonlySet<string> = new Set(ACCENT_OPTIONS.map((option) => option.value))

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light'
}

function isAccent(value: unknown): value is Accent {
  return typeof value === 'string' && ACCENT_VALUES.has(value)
}

function parseAppearance(value: unknown): Appearance | null {
  if (!isRecord(value)) return null
  const { theme, accent } = value
  // A payload that names a theme but not a known accent still carries a usable
  // choice, so the unknown half falls back rather than dropping both.
  if (!isTheme(theme)) return null
  return { theme, accent: isAccent(accent) ? accent : DEFAULT_APPEARANCE.accent }
}

export function loadAppearance(storage: StorageLike | null): Appearance {
  if (!storage) return { ...DEFAULT_APPEARANCE }
  try {
    const raw = storage.getItem(APPEARANCE_KEY)
    if (raw) {
      const payload: unknown = JSON.parse(raw)
      if (isRecord(payload) && payload.version === 1) {
        return parseAppearance(payload.appearance) ?? { ...DEFAULT_APPEARANCE }
      }
      return { ...DEFAULT_APPEARANCE }
    }
    const legacy = storage.getItem(LEGACY_THEME_KEY)
    return isTheme(legacy) ? { ...DEFAULT_APPEARANCE, theme: legacy } : { ...DEFAULT_APPEARANCE }
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}

export function saveAppearance(storage: StorageLike | null, appearance: Appearance): boolean {
  if (!storage) return false
  try {
    storage.setItem(APPEARANCE_KEY, JSON.stringify({ version: 1, appearance }))
    return true
  } catch {
    return false
  }
}
