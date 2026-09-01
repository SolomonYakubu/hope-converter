import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  ACCENT_OPTIONS,
  APPEARANCE_KEY,
  DEFAULT_APPEARANCE,
  LEGACY_THEME_KEY,
  loadAppearance,
  saveAppearance,
  type Appearance
} from '../../src/stores/appearance-persistence'
import { createAppearanceStore } from '../../src/stores/appearance-store'
import type { StorageLike } from '../../src/stores/settings-persistence'

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) }
  }
}

const stored = (storage: { map: Map<string, string> }) => JSON.parse(storage.map.get(APPEARANCE_KEY) ?? '{}') as unknown

describe('appearance persistence', () => {
  it('round-trips a versioned theme and accent', () => {
    const storage = memoryStorage()
    const appearance: Appearance = { theme: 'light', accent: 'cyan' }

    expect(saveAppearance(storage, appearance)).toBe(true)
    expect(stored(storage)).toEqual({ version: 1, appearance })
    expect(loadAppearance(storage)).toEqual(appearance)
  })

  it.each<Record<string, string>>([
    {},
    { [APPEARANCE_KEY]: 'not json' },
    { [APPEARANCE_KEY]: JSON.stringify({ version: 99, appearance: { theme: 'light', accent: 'cyan' } }) },
    { [APPEARANCE_KEY]: JSON.stringify({ version: 1, appearance: { theme: 'sepia', accent: 'cyan' } }) },
    { [APPEARANCE_KEY]: JSON.stringify({ version: 1, appearance: null }) }
  ])('falls back to the default for %s', (initial) => {
    expect(loadAppearance(memoryStorage(initial))).toEqual(DEFAULT_APPEARANCE)
  })

  // Half a usable choice is still a choice: an accent this build no longer ships
  // should not cost the person their theme as well.
  it('keeps a valid theme when the stored accent is unknown', () => {
    const storage = memoryStorage({
      [APPEARANCE_KEY]: JSON.stringify({ version: 1, appearance: { theme: 'light', accent: 'chartreuse' } })
    })
    expect(loadAppearance(storage)).toEqual({ theme: 'light', accent: DEFAULT_APPEARANCE.accent })
  })

  it('adopts the theme written before accents existed', () => {
    expect(loadAppearance(memoryStorage({ [LEGACY_THEME_KEY]: 'light' })))
      .toEqual({ theme: 'light', accent: DEFAULT_APPEARANCE.accent })
    expect(loadAppearance(memoryStorage({ [LEGACY_THEME_KEY]: 'neon' }))).toEqual(DEFAULT_APPEARANCE)
  })

  it('prefers the current key over the legacy one', () => {
    const storage = memoryStorage({
      [LEGACY_THEME_KEY]: 'light',
      [APPEARANCE_KEY]: JSON.stringify({ version: 1, appearance: { theme: 'dark', accent: 'rose' } })
    })
    expect(loadAppearance(storage)).toEqual({ theme: 'dark', accent: 'rose' })
  })

  it('is safe when storage access is unavailable', () => {
    const throwing: StorageLike = {
      getItem: vi.fn(() => { throw new Error('blocked') }),
      setItem: vi.fn(() => { throw new Error('quota') })
    }

    expect(loadAppearance(throwing)).toEqual(DEFAULT_APPEARANCE)
    expect(saveAppearance(throwing, DEFAULT_APPEARANCE)).toBe(false)
    expect(loadAppearance(null)).toEqual(DEFAULT_APPEARANCE)
    expect(saveAppearance(null, DEFAULT_APPEARANCE)).toBe(false)
  })

  it('uses a stable namespaced key', () => {
    const setItem = vi.fn()
    saveAppearance({ getItem: () => null, setItem }, DEFAULT_APPEARANCE)
    expect(setItem).toHaveBeenCalledWith(APPEARANCE_KEY, expect.any(String))
  })
})

describe('appearance store', () => {
  it('starts from storage and writes every change back', () => {
    const storage = memoryStorage({
      [APPEARANCE_KEY]: JSON.stringify({ version: 1, appearance: { theme: 'light', accent: 'lime' } })
    })
    const store = createAppearanceStore(storage)
    expect(store.getState()).toMatchObject({ theme: 'light', accent: 'lime' })

    store.getState().setAccent('rose')
    expect(store.getState().accent).toBe('rose')
    expect(stored(storage)).toEqual({ version: 1, appearance: { theme: 'light', accent: 'rose' } })

    store.getState().toggleTheme()
    expect(store.getState().theme).toBe('dark')
    // The accent has to survive a theme change, and vice versa.
    expect(stored(storage)).toEqual({ version: 1, appearance: { theme: 'dark', accent: 'rose' } })

    store.getState().setTheme('light')
    expect(stored(storage)).toEqual({ version: 1, appearance: { theme: 'light', accent: 'rose' } })
  })

  it('works with no storage at all', () => {
    const store = createAppearanceStore(null)
    store.getState().setAccent('orange')
    expect(store.getState()).toMatchObject({ theme: 'dark', accent: 'orange' })
  })
})

/**
 * The selector offers a name; the stylesheet is what makes it a colour. Nothing else
 * links the two, so this is the test that fails if a row is added to ACCENT_OPTIONS
 * without running `npm run accents` and pasting the palette in.
 */
describe('every offered accent has a palette', () => {
  const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')

  it.each(ACCENT_OPTIONS.map((option) => option.value))('%s has headline colours', (accent) => {
    for (const token of [`--accent-${accent}:`, `--accent-${accent}-lift:`, `--accent-${accent}-glint:`]) {
      expect(css).toContain(token)
    }
  })

  it.each(ACCENT_OPTIONS.map((option) => option.value).filter((accent) => accent !== DEFAULT_APPEARANCE.accent))(
    '%s has a dark and a light block',
    (accent) => {
      expect(css).toContain(`:root[data-accent='${accent}']`)
      expect(css).toContain(`:root[data-theme='light'][data-accent='${accent}']`)
    }
  )

  // The default accent is the palette the others are generated from, so it lives in
  // :root itself and must not also have a block that could shadow it.
  it('leaves the default accent to :root', () => {
    expect(css).not.toContain(`[data-accent='${DEFAULT_APPEARANCE.accent}']`)
  })
})

/**
 * The mark is real artwork per accent rather than a tint applied to one image, so what
 * ties an offered accent to its own logo is a file on disk. A missing line in logos.ts is
 * already a compile error, since ACCENT_LOGOS is typed as a total record; nothing but
 * this fails when an accent is added to the selector and `npm run logos` is not run.
 */
describe('every offered accent has a mark', () => {
  const assets = new URL('../../src/assets/', import.meta.url)
  const markOf = (accent: string) => accent === DEFAULT_APPEARANCE.accent ? 'logo.png' : `logo-${accent}.png`
  const others = ACCENT_OPTIONS.map((option) => option.value).filter((accent) => accent !== DEFAULT_APPEARANCE.accent)

  it.each(ACCENT_OPTIONS.map((option) => option.value))('%s has a mark on disk', (accent) => {
    expect(readFileSync(new URL(markOf(accent), assets)).byteLength).toBeGreaterThan(0)
  })

  // A generator that had fallen back to copying the source would pass the check above.
  it.each(others)('%s is turned rather than copied', (accent) => {
    const source = readFileSync(new URL('logo.png', assets))
    expect(readFileSync(new URL(markOf(accent), assets)).equals(source)).toBe(false)
  })

  it('names them the way logos.ts imports them', () => {
    const module = readFileSync(new URL('logos.ts', assets), 'utf8')
    for (const { value } of ACCENT_OPTIONS) expect(module).toContain(`from './${markOf(value)}'`)
  })
})
