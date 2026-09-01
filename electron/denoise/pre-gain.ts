/**
 * Automatic input level staging for the model.
 *
 * DeepFilterNet3 is not level invariant: the same recording, played quietly into
 * it, comes out worse. Measured on speech at a 10 dB SNR against the bundled
 * model, scale-invariant SDR of the cleaned speech was
 *
 *   input at -10 dBFS -> 19.7 dB     input at -30 dBFS -> 16.1 dB
 *   input at -20 dBFS -> 19.1 dB     input at -40 dBFS -> 14.4 dB
 *
 * so a phone recording peaking 35 dB below full scale loses roughly 5 dB of
 * speech quality for no reason other than its level. That shows up as exactly the
 * complaint you would expect: syllables the model decides are not speech.
 *
 * The fix is to lift the audio into the range the model behaves well in, then
 * divide the same factor back out of its output, so the written file has the level
 * it always had — the gain changes what the model sees, never what anyone hears.
 *
 * "The same factor" is the whole difficulty, because the factor changes as the file
 * goes by and the model answers three frames late. {@link createGainStager} is what
 * keeps the two ends paired: it remembers the gain each frame went in at and hands
 * it back when that frame's output arrives.
 */

/** Where a lifted recording is aimed: -12 dBFS, healthy but far from clipping. */
export const PRE_GAIN_TARGET_PEAK = 0.25
/** Never lift by more than this. Beyond it the input is silence, not quiet speech. */
const PRE_GAIN_MAX_DB = 30
/** Never pull a hot recording down: the measurements are flat above -10 dBFS. */
export const PRE_GAIN_MAX_FACTOR = 10 ** (PRE_GAIN_MAX_DB / 20)
/** Below this the window holds no signal worth measuring — about -54 dBFS. */
export const PRE_GAIN_SILENCE_PEAK = 0.002
/**
 * The most the model may be handed, as a sample value: +6 dBFS.
 *
 * The lift is chosen from the opening of a file, so a recording that starts on
 * room tone and then gets loud can be lifted far past full scale later on. The
 * model tolerates a fair amount of that, but not without limit — at limit 30, the
 * median gain it applied to the loudest speech frames was
 *
 *   model peak at   0 dBFS -> -0.3 dB     +12 dBFS -> -0.6 dB
 *   model peak at  +6 dBFS -> -0.3 dB     +20 dBFS -> -11.7 dB
 *
 * so it holds up to roughly +12 and then starts gating the speech it is supposed
 * to keep. The ceiling sits at +6, inside the flat region with room to spare.
 */
export const PRE_GAIN_MODEL_CEILING = 2

/**
 * Chooses the factor from a window of interleaved samples.
 *
 * Peak rather than RMS, deliberately: a stray click makes this under-lift, which
 * costs a little quality, where an RMS target would over-lift a quiet recording
 * with one loud moment and hand the model something clipped.
 */
export function preGainFor(peak: number): number {
  if (!Number.isFinite(peak) || peak <= PRE_GAIN_SILENCE_PEAK) return 1
  return Math.min(PRE_GAIN_MAX_FACTOR, Math.max(1, PRE_GAIN_TARGET_PEAK / peak))
}

/**
 * Lowers a gain so that audio peaking at `peak` stays under the ceiling.
 *
 * Called with the loudest sample seen so far, which only grows, so the gain only
 * falls — and never below 1, since the level as recorded is always safe. A change
 * here moves what the model sees; {@link createGainStager} is what makes sure it
 * does not also move what is written.
 */
export function clampGainForPeak(gain: number, peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return gain
  return Math.max(1, Math.min(gain, PRE_GAIN_MODEL_CEILING / peak))
}

/** Largest absolute float in a buffer of little-endian f32 samples. */
export function peakOf(samples: Buffer): number {
  let peak = 0
  for (let offset = 0; offset + 4 <= samples.length; offset += 4) {
    const value = Math.abs(samples.readFloatLE(offset))
    // A NaN or an infinity in decoded audio would poison every later frame.
    if (Number.isFinite(value) && value > peak) peak = value
  }
  return peak
}

/** The pair of factors for one frame: what it goes in at, what comes out is divided by. */
export interface StagedGain {
  /** Multiplied into the frame on the way into the model. */
  in: number
  /** Divided out of the frame coming back, which entered `delayFrames` ago. */
  out: number
}

export interface GainStager {
  /** Sets the base lift from a peak measured over the opening window. */
  calibrate: (peak: number) => void
  /** Advances one frame, taking that frame's own peak before any lift. */
  step: (framePeak: number) => StagedGain
}

/**
 * Pairs each frame's lift with the output it belongs to.
 *
 * The model answers `delayFrames` frames late, so the samples coming back from it
 * entered that many frames ago, at whatever lift was in force then — and the lift
 * moves, because it is held down as louder passages arrive. Dividing the current
 * lift out of them is what made a quiet passage just before a loud one come back up
 * to 11.5 dB too loud. So the lift each frame went in at is queued, and the frame's
 * output is divided by the value that comes back off the queue.
 *
 * The queue starts full of ones. Those cover the model's warm-up frames, which the
 * pump discards to undo the lookahead, so they are never divided into anything that
 * gets written.
 */
export function createGainStager(delayFrames: number): GainStager {
  const depth = Math.max(0, Math.trunc(delayFrames))
  const queued: number[] = new Array<number>(depth).fill(1)
  let base = 1
  /** Loudest sample seen so far, before any lift; only grows, so the lift only falls. */
  let loudest = 0

  return {
    calibrate: (peak) => { base = preGainFor(peak) },

    step: (framePeak) => {
      if (Number.isFinite(framePeak) && framePeak > loudest) loudest = framePeak
      const gainIn = clampGainForPeak(base, loudest)
      queued.push(gainIn)
      // Never empty: the queue is pre-filled to `depth` and one value is pushed per shift.
      return { in: gainIn, out: queued.shift() as number }
    }
  }
}
