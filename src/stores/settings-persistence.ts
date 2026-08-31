export type QualityPreset = 'high' | 'balanced' | 'small'
export type Concurrency = 1 | 2 | 3 | 4

export interface OutputFormats {
  video: 'mp4' | 'webm' | 'mov'
  audio: 'mp3' | 'wav' | 'flac' | 'm4a'
  image: 'jpg' | 'png' | 'webp'
}

export interface RendererSettings {
  quality: QualityPreset
  formats: OutputFormats
  outputDirectory: string | null
  performanceMode: boolean
  concurrency: Concurrency
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const RENDERER_SETTINGS_KEY = 'hope-converter:renderer-settings'
export const DEFAULT_RENDERER_SETTINGS: RendererSettings = {
  quality: 'balanced',
  formats: { video: 'mp4', audio: 'mp3', image: 'jpg' },
  outputDirectory: null,
  performanceMode: true,
  concurrency: 2
}

const QUALITY_VALUES = new Set(['high', 'balanced', 'small'])
const VIDEO_FORMATS = new Set(['mp4', 'webm', 'mov'])
const AUDIO_FORMATS = new Set(['mp3', 'wav', 'flac', 'm4a'])
const IMAGE_FORMATS = new Set(['jpg', 'png', 'webp'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSettings(value: unknown): RendererSettings | null {
  if (!isRecord(value) || !isRecord(value.formats)) return null
  const { quality, formats, outputDirectory, performanceMode, concurrency } = value
  if (!QUALITY_VALUES.has(String(quality)) ||
      !VIDEO_FORMATS.has(String(formats.video)) ||
      !AUDIO_FORMATS.has(String(formats.audio)) ||
      !IMAGE_FORMATS.has(String(formats.image)) ||
      !(outputDirectory === null || typeof outputDirectory === 'string') ||
      typeof performanceMode !== 'boolean' ||
      !Number.isInteger(concurrency) || Number(concurrency) < 1 || Number(concurrency) > 4) return null

  return {
    quality: quality as QualityPreset,
    formats: formats as unknown as OutputFormats,
    outputDirectory,
    performanceMode,
    concurrency: concurrency as Concurrency
  }
}

export function loadRendererSettings(storage: StorageLike | null): RendererSettings {
  if (!storage) return { ...DEFAULT_RENDERER_SETTINGS, formats: { ...DEFAULT_RENDERER_SETTINGS.formats } }
  try {
    const raw = storage.getItem(RENDERER_SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_RENDERER_SETTINGS, formats: { ...DEFAULT_RENDERER_SETTINGS.formats } }
    const payload: unknown = JSON.parse(raw)
    if (!isRecord(payload) || payload.version !== 1) return { ...DEFAULT_RENDERER_SETTINGS, formats: { ...DEFAULT_RENDERER_SETTINGS.formats } }
    return parseSettings(payload.settings) ?? { ...DEFAULT_RENDERER_SETTINGS, formats: { ...DEFAULT_RENDERER_SETTINGS.formats } }
  } catch {
    return { ...DEFAULT_RENDERER_SETTINGS, formats: { ...DEFAULT_RENDERER_SETTINGS.formats } }
  }
}

export function saveRendererSettings(storage: StorageLike | null, settings: RendererSettings): boolean {
  if (!storage) return false
  try {
    storage.setItem(RENDERER_SETTINGS_KEY, JSON.stringify({ version: 1, settings }))
    return true
  } catch {
    return false
  }
}

export function getBrowserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
