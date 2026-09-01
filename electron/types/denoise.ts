/**
 * DeepFilterNet3 runs at a fixed 48 kHz. Everything entering the model is
 * resampled to this rate, one mono stream per channel.
 */
export const DENOISE_SAMPLE_RATE = 48_000

/** Highest channel count processed; extra channels are downmixed to stereo. */
export const DENOISE_MAX_CHANNELS = 2

/**
 * Highest post-model speech lift offered, in dB. The ceiling is deliberate: past
 * roughly 18 dB the lift is amplifying the model's own residue rather than voice.
 */
export const DENOISE_MAX_SPEECH_GAIN_DB = 18

/** Integrated loudness the normalizer targets, in LUFS — the streaming convention for speech. */
export const DENOISE_LOUDNESS_TARGET_LUFS = -16

/**
 * Highest attenuation limit offered, in dB.
 *
 * The limit is a dry/wet mix (see {@link originalShareForLimitDb}), so raising it
 * takes away the original signal that protects speech the model misjudged. Measured
 * against the bundled model on voice in noise, the written level stops changing past
 * here — 24 dB and 100 dB differ by 0.3 dB overall — while quiet speech keeps
 * falling: frames 35–50 dB below the loudest speech come back 1.5 dB down at 12,
 * 13 dB at 24, 19 dB at 30 and 49 dB at 60. Above this the setting costs
 * word-endings and buys nothing audible, so it is not offered.
 *
 * The engine still accepts the model's full 0–100 range, since that is the range
 * the model documents and what the integration suite drives it across.
 */
export const DENOISE_MAX_ATTENUATION_DB = 24

/**
 * The share of the original recording an attenuation limit keeps, 0 to 1.
 *
 * The limit is not a threshold or a noise gate. DeepFilterNet3 emits
 * `alpha * original + (1 - alpha) * enhanced` with `alpha = 10 ** (-dB / 20)`, so
 * the dial is a dry/wet mix on a logarithmic scale. Fitting that single parameter
 * against the bundled model reproduces its output exactly — agreement to five
 * decimals at every limit from 3 to 100 dB, with and without the post-filter, on
 * noise and on voice alike, which `tests/integration/real-denoise.test.ts` pins so
 * a model that means something different by the limit fails the build.
 *
 * This is the legible half of the same number: 6 dB keeps half the recording,
 * 12 dB a quarter, 24 dB a sixteenth, 60 dB a thousandth. Whatever the model got
 * wrong survives only in that share, which is why the aggressive settings are the
 * ones that erase the quiet end of a word.
 */
export function originalShareForLimitDb(attenuationLimitDb: number): number {
  if (!Number.isFinite(attenuationLimitDb) || attenuationLimitDb <= 0) return 1
  return 10 ** (-attenuationLimitDb / 20)
}

/**
 * Settings for one cleanup job. Two independent stages live here, which is worth
 * keeping straight: the model decides how much noise goes, and FFmpeg decides how
 * loud what is left ends up. DeepFilterNet3 has no level control of its own, so
 * the two cannot be collapsed into one dial.
 */
export interface DenoiseOptions {
  /**
   * Attenuation limit in dB, the model's own strength control. 0 passes audio
   * through untouched; 100 lets the model suppress as much as it wants.
   */
  attenuationLimitDb: number
  /**
   * Post-filter beta. Slightly sharpens the separation at the cost of some
   * roughness on already-clean speech. 0 disables it; useful range is 0–0.05.
   */
  postFilterBeta: number
  /**
   * Speech lift in dB, applied by FFmpeg after the model. 0 emits no filter at
   * all, so the default path is byte-for-byte what it was before this existed.
   */
  speechGainDb: number
  /**
   * Normalizes the finished soundtrack to {@link DENOISE_LOUDNESS_TARGET_LUFS}.
   * This sets the absolute output level, so it overrides how loud
   * {@link DenoiseOptions.speechGainDb} would otherwise leave the file.
   */
  normalizeLoudness: boolean
}

export type DenoiseKind = 'audio' | 'video'

/** Container a denoised audio file can be written to. */
export type DenoiseAudioFormat = 'wav' | 'flac' | 'mp3' | 'm4a'

export interface DenoiseRequest {
  id: string
  inputPath: string
  outputPath: string
  kind: DenoiseKind
  /** Probed duration, used for progress. Progress is coarse without it. */
  durationSeconds?: number
  /** Output format for an audio input. A video keeps its own container. */
  audioFormat?: DenoiseAudioFormat
  /** Only consulted by the lossy formats and by video soundtracks. */
  audioBitrateKbps?: number
  options: DenoiseOptions
}

export interface DenoisePreviewRequest {
  id: string
  inputPath: string
  startSeconds: number
  durationSeconds: number
  options: DenoiseOptions
}

/**
 * What the renderer sends to start a job. The destination filename is derived in
 * the main process, which is the only side that knows which container a given
 * video can be remuxed into.
 */
export interface DenoiseStartRequest {
  id: string
  inputPath: string
  outputDirectory: string
  audioFormat?: DenoiseAudioFormat
  audioBitrateKbps?: number
  options: DenoiseOptions
}

export interface DenoiseProgress {
  id: string
  percent: number
  processedSeconds: number
  /** Multiple of realtime, or null before the first measurable interval. */
  speed: number | null
}

export interface DenoiseResult {
  id: string
  outputPath: string
}

/** Two short WAV excerpts of the same window, for an A/B listen. */
export interface DenoisePreviewResult {
  id: string
  original: ArrayBuffer
  denoised: ArrayBuffer
}

export interface DenoiseEngineInfo {
  available: boolean
  /** Model frame size in samples once loaded, else null. */
  frameLength: number | null
  sampleRate: number
  /** Why the engine is unavailable, for the UI to show verbatim. */
  reason?: string
}
