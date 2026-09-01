import {
  df_create,
  df_get_frame_length,
  df_process_frame,
  df_set_atten_lim,
  df_set_post_filter_beta,
  initAsync
} from './vendor/df-bindings.js'
import { DENOISE_MAX_CHANNELS, DENOISE_MAX_SPEECH_GAIN_DB, type DenoiseOptions } from '../types/denoise'

/** Frames of silence pushed through a state to clear it between jobs. */
const FLUSH_FRAMES = 8

/**
 * Frames the model's output lags its input by.
 *
 * DeepFilterNet3 looks ahead before it decides, so frame *n* of the output is the
 * cleaned version of frame *n − 3*: measured by cross-correlating the bundled
 * model's output against its input, which peaks at 0.9999 at 1440 samples (30 ms)
 * and is −0.09 at zero lag, at every attenuation limit from 1 dB to 100. Left
 * uncompensated it costs the end of the last word, puts 30 ms of silence at the
 * front, and drifts a cleaned soundtrack behind its picture, so `pipeline.ts`
 * skips this much output and flushes the same amount back out at the end.
 * `tests/integration/real-denoise.test.ts` re-measures it, so a model with a
 * different lookahead fails loudly rather than quietly.
 *
 * A limit of exactly 0 is the one exception: the wrapper then hands the input
 * straight back, correlation 1.0000 at lag 0, and there is nothing to compensate.
 * See {@link DeepFilterBank.delayFrames}.
 */
export const DENOISE_DELAY_FRAMES = 3

export function clampOptions(options: DenoiseOptions): DenoiseOptions {
  return {
    attenuationLimitDb: clamp(options.attenuationLimitDb, 0, 100),
    postFilterBeta: clamp(options.postFilterBeta, 0, 0.05),
    // The level stage is FFmpeg's, not the model's, but it is bounded in the same
    // place so there is one answer to "what values can reach a child process".
    speechGainDb: clamp(options.speechGainDb, 0, DENOISE_MAX_SPEECH_GAIN_DB),
    normalizeLoudness: options.normalizeLoudness === true
  }
}

/**
 * One DeepFilterNet3 state per channel, wrapped so callers work in frames.
 *
 * The states are created once and live for the process. wasm-bindgen exports no
 * usable destructor for them (see `vendor/df-bindings.js`), and each costs
 * roughly 28 MB of wasm heap for the first and 11 MB for each after, so
 * creating one per job would leak steadily. Instead `reset()` flushes a state
 * with silence between jobs, which is enough: the model emits exact zeros for a
 * silent input, leaving no audible history behind.
 */
export class DeepFilterBank {
  /** Samples the model consumes and emits per call — 480 at 48 kHz. */
  readonly frameLength: number

  private readonly states: number[] = []
  private readonly model: Uint8Array
  private options: DenoiseOptions

  /**
   * Frames its output lags its input by, for the settings it is prepared with.
   * See {@link DENOISE_DELAY_FRAMES} — a limit of zero is a bypass with no
   * lookahead to undo, so compensating it would shift the audio 30 ms early.
   */
  get delayFrames(): number {
    return this.options.attenuationLimitDb === 0 ? 0 : DENOISE_DELAY_FRAMES
  }

  private constructor(model: Uint8Array, firstState: number, frameLength: number, options: DenoiseOptions) {
    this.model = model
    this.states.push(firstState)
    this.frameLength = frameLength
    this.options = options
  }

  /**
   * Compiles the module and loads the model for a single channel. Additional
   * channels are added on demand by `prepare()`.
   */
  static async create(wasm: Uint8Array, model: Uint8Array, options: DenoiseOptions): Promise<DeepFilterBank> {
    const settings = clampOptions(options)
    await initAsync(wasm)

    const state = df_create(model, settings.attenuationLimitDb)
    if (!state) throw new Error('DeepFilterNet3 could not load the bundled model')
    df_set_post_filter_beta(state, settings.postFilterBeta)

    const frameLength = df_get_frame_length(state)
    if (!Number.isInteger(frameLength) || frameLength <= 0) {
      throw new Error('DeepFilterNet3 reported an unusable frame length')
    }
    return new DeepFilterBank(model, state, frameLength, settings)
  }

  /**
   * Readies the bank for a job: applies the options, makes sure a state exists
   * per channel, and clears whatever the previous job left behind.
   */
  prepare(channels: number, options: DenoiseOptions): void {
    if (!Number.isInteger(channels) || channels < 1 || channels > DENOISE_MAX_CHANNELS) {
      throw new Error(`Denoising supports 1 to ${DENOISE_MAX_CHANNELS} channels, not ${channels}`)
    }

    while (this.states.length < channels) {
      const state = df_create(this.model, this.options.attenuationLimitDb)
      if (!state) throw new Error('DeepFilterNet3 could not load a second model state')
      this.states.push(state)
    }

    this.options = clampOptions(options)
    for (const state of this.states) {
      df_set_atten_lim(state, this.options.attenuationLimitDb)
      df_set_post_filter_beta(state, this.options.postFilterBeta)
    }
    this.reset(channels)
  }

  /**
   * Denoises one frame of one channel. `frame` must be exactly `frameLength`
   * samples. The result is a fresh array, safe to keep.
   */
  processFrame(channel: number, frame: Float32Array): Float32Array {
    const state = this.states[channel]
    if (state === undefined) throw new Error(`Channel ${channel} has no model state`)
    if (frame.length !== this.frameLength) {
      throw new Error(`A frame must be ${this.frameLength} samples, got ${frame.length}`)
    }
    // The returned view aliases wasm memory and dies on the next call.
    return Float32Array.from(df_process_frame(state, frame))
  }

  /** Pushes silence through each state so no history crosses into the next job. */
  private reset(channels: number): void {
    const silence = new Float32Array(this.frameLength)
    for (let channel = 0; channel < channels; channel++) {
      for (let frame = 0; frame < FLUSH_FRAMES; frame++) {
        df_process_frame(this.states[channel] as number, silence)
      }
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
