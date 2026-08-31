import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RENDERER_SETTINGS,
  RENDERER_SETTINGS_KEY,
  loadRendererSettings,
  saveRendererSettings,
  type StorageLike
} from '../../src/stores/settings-persistence'

function memoryStorage(initial?: string): StorageLike & { value?: string } {
  return {
    value: initial,
    getItem() { return this.value ?? null },
    setItem(_key, value) { this.value = value }
  }
}

describe('renderer settings persistence', () => {
  it('round-trips only versioned renderer settings', () => {
    const storage = memoryStorage()
    const settings = {
      quality: 'high',
      formats: { video: 'mov', audio: 'flac', image: 'webp' },
      outputDirectory: '/exports',
      performanceMode: false,
      concurrency: 4
    } as const

    expect(saveRendererSettings(storage, settings)).toBe(true)
    expect(JSON.parse(storage.value ?? '{}')).toEqual({ version: 1, settings })
    expect(storage.getItem).not.toBeUndefined()
    expect(loadRendererSettings(storage)).toEqual(settings)
    expect(storage.value).not.toContain('items')
  })

  it.each([
    null,
    '',
    'not json',
    JSON.stringify({ version: 99, settings: {} }),
    JSON.stringify({ version: 1, settings: { quality: 'ultra', concurrency: 8 } }),
    JSON.stringify({ version: 1, settings: { ...DEFAULT_RENDERER_SETTINGS, formats: { video: 'exe', audio: 'mp3', image: 'jpg' } } })
  ])('falls back safely for missing or invalid payload %s', (payload) => {
    expect(loadRendererSettings(memoryStorage(payload ?? undefined))).toEqual(DEFAULT_RENDERER_SETTINGS)
  })

  it('is safe when storage access is unavailable', () => {
    const storage: StorageLike = {
      getItem: vi.fn(() => { throw new Error('blocked') }),
      setItem: vi.fn(() => { throw new Error('quota') })
    }

    expect(loadRendererSettings(storage)).toEqual(DEFAULT_RENDERER_SETTINGS)
    expect(saveRendererSettings(storage, DEFAULT_RENDERER_SETTINGS)).toBe(false)
  })

  it('uses a stable namespaced key', () => {
    const setItem = vi.fn()
    saveRendererSettings({ getItem: () => null, setItem }, DEFAULT_RENDERER_SETTINGS)
    expect(setItem).toHaveBeenCalledWith(RENDERER_SETTINGS_KEY, expect.any(String))
  })
})
