import { createStore } from 'zustand/vanilla'
import type { MediaMetadata } from '../../electron/types/conversion'
import {
  DENOISE_MAX_ATTENUATION_DB,
  DENOISE_MAX_SPEECH_GAIN_DB,
  DENOISE_POST_FILTER_BETA,
  type DenoiseAudioFormat,
  type DenoiseOptions,
  type DenoiseProgress
} from '../../electron/types/denoise'
import type { InputFile } from '../types/hope-converter'
import { createId, isFinishedStatus, NO_ADDITIONS, type AddFilesResult } from './queue-additions'

export type DenoiseStatus = 'queued' | 'processing' | 'completed' | 'error' | 'cancelled'

export interface DenoiseItem extends InputFile {
  id: string
  status: DenoiseStatus
  /** Percent done, or null while working on a file whose duration is unknown. */
  progress: number | null
  /** Multiple of realtime while the file is being processed. */
  speed: number | null
  /**
   * Audio processed so far, in seconds. Shown in place of the percentage on a file
   * with no probed duration, where it is the only honest measure of progress there is.
   */
  processedSeconds?: number
  outputPath?: string
  error?: string
  metadata?: MediaMetadata
}

export interface DenoiseSettings {
  /**
   * The model's attenuation limit in dB, and equally the share of the original
   * recording left mixed underneath the result — the two are the same number seen
   * from either end (`originalShareForLimitDb`). Whatever the model misjudged
   * survives only in that share, quiet word-endings included, so the offered range
   * stops at {@link DENOISE_MAX_ATTENUATION_DB}. 0 passes the audio through untouched.
   */
  strength: number
  /** Enables the post-filter, which sharpens separation at a small cost in roughness. */
  postFilter: boolean
  /**
   * Speech lift in dB, applied after the model. A separate stage from `strength`:
   * the model decides how much noise goes, this decides how loud the voice lands.
   * At 0 no level filter runs at all, so the encoder is handed the model's own
   * samples.
   */
  speechGainDb: number
  /** Normalizes the finished file to the fixed loudness target (−16 LUFS). */
  normalizeLoudness: boolean
  /** Container for denoised audio. Video keeps its own container. */
  audioFormat: DenoiseAudioFormat
}

/**
 * The three answers the panel offers to "how loud should the result be", which is
 * the one question a person actually has about the two level stages.
 *
 * The stages themselves stay independent — `speechnorm` evens out a file, `loudnorm`
 * sets its absolute loudness, and both can run — so this is a reading of the pair
 * rather than a fourth setting. {@link levelModeFor} derives it, and the fine dB
 * controls remain reachable underneath.
 */
export type DenoiseLevelMode = 'as-recorded' | 'lift-speech' | 'match-loudness'

/** The lift picking "Lift quiet voice" starts from, in dB: audible, and short of the model's residue. */
export const DENOISE_LIFT_SPEECH_DB = 6

/**
 * Which of the three the current settings amount to. Normalizing wins when both
 * are on because the absolute target has the last word on how loud the file lands,
 * so that is what the panel should be claiming.
 */
export function levelModeFor(settings: Pick<DenoiseSettings, 'speechGainDb' | 'normalizeLoudness'>): DenoiseLevelMode {
  if (settings.normalizeLoudness) return 'match-loudness'
  return settings.speechGainDb > 0 ? 'lift-speech' : 'as-recorded'
}

export interface DenoiseState extends DenoiseSettings {
  items: DenoiseItem[]
  /** Adds files, reviving finished rows whose file was picked again. */
  addFiles: (files: InputFile[]) => AddFilesResult
  removeItem: (id: string) => void
  setStrength: (strength: number) => void
  setPostFilter: (enabled: boolean) => void
  setSpeechGainDb: (gain: number) => void
  setNormalizeLoudness: (enabled: boolean) => void
  /** Sets both level stages at once, from the three-way control the panel shows. */
  setLevelMode: (mode: DenoiseLevelMode) => void
  setAudioFormat: (format: DenoiseAudioFormat) => void
  setStatus: (id: string, status: DenoiseStatus, error?: string) => void
  setMetadata: (id: string, metadata: MediaMetadata) => void
  updateProgress: (progress: DenoiseProgress) => void
  completeItem: (id: string, outputPath: string) => void
  clearFinished: () => void
}

/**
 * The level controls start off, so a queue run writes exactly what it wrote
 * before they existed until someone asks for something different.
 *
 * 12 dB is the default limit because it is the last setting that keeps a quarter of
 * the original recording under the result. That quarter is what carries a breath or
 * a trailing consonant the model did not hold as speech: measured on the bundled
 * model, speech 35–50 dB below the loudest speech comes back 1.5 dB down here and
 * 13 dB down at 24, while the noise the setting is meant to remove is already gone.
 */
export const DENOISE_DEFAULTS: DenoiseSettings = {
  strength: 12,
  postFilter: true,
  speechGainDb: 0,
  normalizeLoudness: false,
  audioFormat: 'flac'
}

/**
 * The engine settings the current panel state amounts to.
 *
 * Kept here rather than inside the component so it can be tested without a DOM: it
 * is the one place where a UI switch becomes a number the model is given, and
 * `postFilter` is the switch that hides a constant behind a boolean.
 */
export function denoiseOptionsFrom(settings: DenoiseSettings): DenoiseOptions {
  return {
    attenuationLimitDb: settings.strength,
    postFilterBeta: settings.postFilter ? DENOISE_POST_FILTER_BETA : 0,
    speechGainDb: settings.speechGainDb,
    normalizeLoudness: settings.normalizeLoudness
  }
}

export function createDenoiseStore() {
  return createStore<DenoiseState>((set) => ({
    ...DENOISE_DEFAULTS,
    items: [],
    // Images have no soundtrack, so they never reach this queue.
    addFiles: (files) => {
      let outcome = NO_ADDITIONS
      set((state) => {
        const existing = new Map(state.items.map((item) => [item.path, item]))
        const additions: DenoiseItem[] = []
        const revive = new Set<string>()
        const blocked = new Set<string>()

        for (const file of files) {
          if (!file.path || file.kind === 'image') continue
          const match = existing.get(file.path)
          if (!match) {
            const item: DenoiseItem = { ...file, id: createId('denoise'), status: 'queued', progress: 0, speed: null }
            existing.set(item.path, item)
            additions.push(item)
          } else if (isFinishedStatus(match.status)) revive.add(match.id)
          else blocked.add(file.path)
        }

        outcome = { added: additions.length, requeued: revive.size, alreadyQueued: blocked.size }
        // Nothing to change, so the queue keeps its identity and does not re-render.
        if (!additions.length && !revive.size) return {}
        return {
          items: [
            ...state.items.map((item) => revive.has(item.id)
              ? {
                  ...item,
                  status: 'queued' as const,
                  progress: 0,
                  speed: null,
                  processedSeconds: undefined,
                  outputPath: undefined,
                  error: undefined
                }
              : item),
            ...additions
          ]
        }
      })
      return outcome
    },
    removeItem: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
    setStrength: (strength) => set({
      strength: Math.min(DENOISE_MAX_ATTENUATION_DB, Math.max(0, Math.round(strength)))
    }),
    setPostFilter: (postFilter) => set({ postFilter }),
    setSpeechGainDb: (gain) => set({
      speechGainDb: Math.min(DENOISE_MAX_SPEECH_GAIN_DB, Math.max(0, Math.round(gain)))
    }),
    setNormalizeLoudness: (normalizeLoudness) => set({ normalizeLoudness }),
    // A lift already set by hand is kept rather than overwritten, so the fine
    // control under Advanced is not silently undone by picking the mode it implies.
    setLevelMode: (mode) => set((state) => ({
      normalizeLoudness: mode === 'match-loudness',
      speechGainDb: mode === 'as-recorded'
        ? 0
        : mode === 'lift-speech' && state.speechGainDb === 0 ? DENOISE_LIFT_SPEECH_DB : state.speechGainDb
    })),
    setAudioFormat: (audioFormat) => set({ audioFormat }),
    setStatus: (id, status, error) => set((state) => ({
      items: state.items.map((item) => item.id === id
        ? {
            ...item,
            status,
            error,
            progress: status === 'queued' || status === 'processing' ? 0 : item.progress,
            processedSeconds: status === 'queued' || status === 'processing' ? undefined : item.processedSeconds,
            speed: null
          }
        : item)
    })),
    setMetadata: (id, metadata) => set((state) => ({
      items: state.items.map((item) => item.id === id ? { ...item, metadata } : item)
    })),
    updateProgress: ({ id, percent, speed, processedSeconds }) => set((state) => ({
      items: state.items.map((item) => item.id === id
        ? {
            ...item,
            status: 'processing',
            // null is not a missing measurement to round to zero: it means the file's
            // duration is unknown, and the row shows an indeterminate bar instead.
            progress: percent === null ? null : Math.max(0, Math.min(100, percent)),
            processedSeconds,
            speed
          }
        : item)
    })),
    completeItem: (id, outputPath) => set((state) => ({
      items: state.items.map((item) => item.id === id
        ? { ...item, status: 'completed', progress: 100, speed: null, outputPath, error: undefined }
        : item)
    })),
    clearFinished: () => set((state) => ({
      items: state.items.filter((item) => !isFinishedStatus(item.status))
    }))
  }))
}

export const denoiseStore = createDenoiseStore()
