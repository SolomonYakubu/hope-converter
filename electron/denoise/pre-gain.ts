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
 * divide the same factor back out of its output. Because it is one scalar applied
 * and undone, the written file has the level it always had — the gain changes
 * what the model sees, never what anyone hears.
 */

/** Where a lifted recording is aimed: -12 dBFS, healthy but far from clipping. */
export const PRE_GAIN_TARGET_PEAK = 0.25
/** Never lift by more than this. Beyond it the input is silence, not quiet speech. */
export const PRE_GAIN_MAX_DB = 30
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
 * falls — and never below 1, since the level as recorded is always safe. Because
 * the same factor is divided back out of the model's output, a change here moves
 * what the model sees and not what is written.
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
