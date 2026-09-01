import {
  df_create,
  df_get_frame_length,
  df_process_frame,
  df_set_atten_lim,
  df_set_post_filter_beta,
  initAsync
} from './vendor/df-bindings.js'
import { DENOISE_MAX_CHANNELS, DENOISE_MAX_SPEECH_GAIN_DB, type DenoiseOptions } from '../types/denoise'
import { clamp } from '../utils/guards'

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
 * A bank serves exactly one job, and `prepare()` refuses a second. The states
 * carry recurrent history that nothing here can clear: wasm-bindgen exports no
 * usable destructor (see `vendor/df-bindings.js`), and pushing silence through a
 * used state does not put it back where a fresh one starts. This class used to
 * flush 80 ms of silence between jobs and call that enough; measured against a
 * genuinely fresh state on the same input, the second job then came out 10.9 dB
 * different, with its speech 2.4 dB quieter, and no flush length tried between
 * 80 ms and 10 s closed the gap. So the worker that owns a bank is replaced per
 * file instead, which is what makes the second file in a queue come out the way
 * the first one did — and what frees the wasm heap the states hold, roughly 28 MB
 * for the first and 11 MB for each after it.
 *
 * `tests/integration/real-denoise.test.ts` measures both halves of that: that a
 * fresh bank reproduces a run exactly, and that a used one does not.
 */
export class DeepFilterBank {
  /** Samples the model consumes and emits per call — 480 at 48 kHz. */
  readonly frameLength: number

  private readonly states: number[] = []
  private readonly model: Uint8Array
  private options: DenoiseOptions
  private prepared = false

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
   * Readies the bank for its one job: applies the options and makes sure a state
   * exists per channel.
   *
   * A second call throws. The states cannot be returned to their initial
   * condition (see the note on this class), so reusing a bank would render a file
   * differently from the way a fresh run renders it, quietly.
   *
   * The options are assigned before any state is created, so a state created here
   * is born with this job's attenuation limit rather than the one the bank was
   * loaded with. That limit and the post-filter beta are plain settings on a state
   * that has processed nothing, which is why a state created at load time and
   * re-pointed here matches one created with these options to begin with — the
   * integration suite measures that, since warming the model up before a job
   * arrives depends on it.
   */
  prepare(channels: number, options: DenoiseOptions): void {
    if (!Number.isInteger(channels) || channels < 1 || channels > DENOISE_MAX_CHANNELS) {
      throw new Error(`Denoising supports 1 to ${DENOISE_MAX_CHANNELS} channels, not ${channels}`)
    }
    if (this.prepared) {
      throw new Error('A DeepFilterNet3 bank serves one job; this one has already been used')
    }
    this.prepared = true
    this.options = clampOptions(options)

    while (this.states.length < channels) {
      const state = df_create(this.model, this.options.attenuationLimitDb)
      if (!state) throw new Error('DeepFilterNet3 could not load a second model state')
      this.states.push(state)
    }

    for (const state of this.states) {
      df_set_atten_lim(state, this.options.attenuationLimitDb)
      df_set_post_filter_beta(state, this.options.postFilterBeta)
    }
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
}
