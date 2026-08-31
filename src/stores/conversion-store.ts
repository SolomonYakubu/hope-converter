import { createStore } from 'zustand/vanilla'
import type { ConversionProgress, MediaKind, MediaMetadata } from '../../electron/types/conversion'
import type { InputFile } from '../types/hope-converter'
import {
  getBrowserStorage,
  loadRendererSettings,
  saveRendererSettings,
  type Concurrency,
  type OutputFormats,
  type QualityPreset,
  type RendererSettings,
  type StorageLike
} from './settings-persistence'

export type QueueStatus = 'queued' | 'converting' | 'paused' | 'completed' | 'error' | 'cancelled'
export type { Concurrency, OutputFormats, QualityPreset }

export interface QueueItem extends InputFile {
  id: string
  status: QueueStatus
  progress: number
  outputPath?: string
  error?: string
  metadata?: MediaMetadata
}

export interface ConversionState extends RendererSettings {
  items: QueueItem[]
  queuePaused: boolean
  addFiles: (files: InputFile[]) => void
  removeItem: (id: string) => void
  setOutputDirectory: (directory: string | null) => void
  setQuality: (quality: QualityPreset) => void
  setPerformanceMode: (enabled: boolean) => void
  setConcurrency: (concurrency: Concurrency) => void
  setFormat: (kind: MediaKind, format: string) => void
  setQueuePaused: (paused: boolean) => void
  setStatus: (id: string, status: QueueStatus, error?: string) => void
  setMetadata: (id: string, metadata: MediaMetadata) => void
  updateProgress: (progress: ConversionProgress) => void
  completeItem: (id: string, outputPath: string) => void
  clearFinished: () => void
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `conversion-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function settingsFromState(state: ConversionState): RendererSettings {
  return {
    quality: state.quality,
    formats: state.formats,
    outputDirectory: state.outputDirectory,
    performanceMode: state.performanceMode,
    concurrency: state.concurrency
  }
}

export function createConversionStore(storage: StorageLike | null = getBrowserStorage()) {
  const initialSettings = loadRendererSettings(storage)
  return createStore<ConversionState>((set) => {
    const setAndPersist = (update: Partial<RendererSettings> | ((state: ConversionState) => Partial<RendererSettings>)) => set((state) => {
      const changes = typeof update === 'function' ? update(state) : update
      const next = { ...state, ...changes }
      saveRendererSettings(storage, settingsFromState(next))
      return changes
    })

    return {
      ...initialSettings,
      formats: { ...initialSettings.formats },
      items: [],
      queuePaused: false,
      addFiles: (files) => set((state) => {
        const paths = new Set(state.items.map((item) => item.path))
        const additions = files.reduce<QueueItem[]>((result, file) => {
          if (!file.path || paths.has(file.path)) return result
          paths.add(file.path)
          result.push({ ...file, id: createId(), status: 'queued', progress: 0 })
          return result
        }, [])
        return { items: [...state.items, ...additions] }
      }),
      removeItem: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
      setOutputDirectory: (outputDirectory) => setAndPersist({ outputDirectory }),
      setQuality: (quality) => setAndPersist({ quality }),
      setPerformanceMode: (performanceMode) => setAndPersist({ performanceMode }),
      setConcurrency: (concurrency) => setAndPersist({ concurrency }),
      setFormat: (kind, format) => setAndPersist((state) => ({
        formats: { ...state.formats, [kind]: format } as OutputFormats
      })),
      setQueuePaused: (queuePaused) => set({ queuePaused }),
      setStatus: (id, status, error) => set((state) => ({
        items: state.items.map((item) => item.id === id
          ? { ...item, status, error, progress: status === 'queued' ? 0 : item.progress }
          : item)
      })),
      setMetadata: (id, metadata) => set((state) => ({
        items: state.items.map((item) => item.id === id ? { ...item, metadata } : item)
      })),
      updateProgress: ({ id, percent }) => set((state) => ({
        items: state.items.map((item) => item.id === id
          ? { ...item, status: item.status === 'paused' ? 'paused' : 'converting', progress: Math.max(0, Math.min(100, percent)) }
          : item)
      })),
      completeItem: (id, outputPath) => set((state) => ({
        items: state.items.map((item) => item.id === id
          ? { ...item, status: 'completed', progress: 100, outputPath, error: undefined }
          : item)
      })),
      clearFinished: () => set((state) => ({
        items: state.items.filter((item) => !['completed', 'cancelled', 'error'].includes(item.status))
      }))
    }
  })
}

export const conversionStore = createConversionStore()
