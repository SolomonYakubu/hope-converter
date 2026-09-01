import { describe, expect, it } from 'vitest'
import {
  PRE_GAIN_MAX_FACTOR,
  PRE_GAIN_MODEL_CEILING,
  PRE_GAIN_SILENCE_PEAK,
  PRE_GAIN_TARGET_PEAK,
  clampGainForPeak,
  createGainStager,
  peakOf,
  preGainFor
} from '../../electron/denoise/pre-gain'

/** Interleaves nothing — just lays the samples out the way a decoder does. */
function floats(values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4))
  return buffer
}

describe('preGainFor', () => {
  it('lifts a quiet recording to the target peak', () => {
    expect(preGainFor(0.025)).toBeCloseTo(PRE_GAIN_TARGET_PEAK / 0.025, 6)
    expect(0.025 * preGainFor(0.025)).toBeCloseTo(PRE_GAIN_TARGET_PEAK, 6)
  })

  it('never pulls a hot recording down', () => {
    // The model measures flat above -10 dBFS, so there is nothing to gain by it
    // and a peak already past the target would only be attenuated for no reason.
    expect(preGainFor(PRE_GAIN_TARGET_PEAK)).toBe(1)
    expect(preGainFor(0.9)).toBe(1)
    expect(preGainFor(1)).toBe(1)
  })

  it('stops lifting at the ceiling', () => {
    // 0.25 / 0.005 would be 50x; nothing that quiet is speech worth lifting that far.
    expect(preGainFor(0.005)).toBe(PRE_GAIN_MAX_FACTOR)
    expect(PRE_GAIN_MAX_FACTOR).toBeCloseTo(31.62, 2)
  })

  it('leaves silence alone rather than amplifying room tone', () => {
    expect(preGainFor(0)).toBe(1)
    expect(preGainFor(PRE_GAIN_SILENCE_PEAK)).toBe(1)
    expect(preGainFor(PRE_GAIN_SILENCE_PEAK * 1.001)).toBeGreaterThan(1)
  })

  it('treats an unusable measurement as no gain', () => {
    expect(preGainFor(Number.NaN)).toBe(1)
    expect(preGainFor(Number.POSITIVE_INFINITY)).toBe(1)
    expect(preGainFor(Number.NEGATIVE_INFINITY)).toBe(1)
  })
})

describe('clampGainForPeak', () => {
  it('leaves a gain alone while the audio stays under the ceiling', () => {
    expect(clampGainForPeak(8, 0.2)).toBe(8) // 1.6, inside the ceiling
    expect(clampGainForPeak(8, PRE_GAIN_MODEL_CEILING / 8)).toBe(8)
  })

  it('holds the lift down once a louder passage arrives', () => {
    // Calibrated on a quiet opening, then the speaker gets loud: 20x on a 0.5 peak
    // would hand the model 10, far past where it stops keeping speech.
    expect(clampGainForPeak(20, 0.5)).toBe(PRE_GAIN_MODEL_CEILING / 0.5)
    expect(clampGainForPeak(20, 0.5) * 0.5).toBe(PRE_GAIN_MODEL_CEILING)
  })

  it('never attenuates: the level as recorded is always safe to process', () => {
    // A file already peaking above the ceiling is left exactly as it is.
    expect(clampGainForPeak(1, 4)).toBe(1)
    expect(clampGainForPeak(3, 4)).toBe(1)
  })

  it('has nothing to clamp before any signal has been seen', () => {
    expect(clampGainForPeak(6, 0)).toBe(6)
    expect(clampGainForPeak(6, Number.NaN)).toBe(6)
  })
})

describe('peakOf', () => {
  it('finds the largest magnitude regardless of sign', () => {
    expect(peakOf(floats([0.1, -0.7, 0.3]))).toBeCloseTo(0.7, 6)
  })

  it('is zero for silence and for nothing at all', () => {
    expect(peakOf(floats([0, 0, 0]))).toBe(0)
    expect(peakOf(Buffer.alloc(0))).toBe(0)
  })

  it('ignores a trailing partial sample, which a pipe can hand over', () => {
    const buffer = Buffer.concat([floats([0.4]), Buffer.of(0xff, 0xff, 0xff)])
    expect(peakOf(buffer)).toBeCloseTo(0.4, 6)
  })

  it('skips values that would poison every later frame', () => {
    expect(peakOf(floats([0.2, Number.NaN, 0.3, Number.POSITIVE_INFINITY]))).toBeCloseTo(0.3, 6)
  })
})

describe('createGainStager', () => {
  /** Steps a stager through frame peaks, collecting both halves of each pair. */
  function run(delayFrames: number, calibratePeak: number, framePeaks: number[]) {
    const stager = createGainStager(delayFrames)
    stager.calibrate(calibratePeak)
    const staged = framePeaks.map((peak) => stager.step(peak))
    return { in: staged.map((pair) => pair.in), out: staged.map((pair) => pair.out) }
  }

  it('divides out the gain the samples went in at, not the one now in force', () => {
    // A quiet opening, then a loud passage: the lift is pulled down at frame 4,
    // while the samples coming back then went in at the old lift three frames ago.
    const peaks = [0.02, 0.02, 0.02, 0.02, 0.6, 0.6, 0.6, 0.6]
    const staged = run(3, 0.02, peaks)

    expect(staged.out.slice(3)).toEqual(staged.in.slice(0, 5))
    // Dividing by the current lift instead — 3.33 where 12.5 was applied — is what
    // wrote that boundary 3.75x, or 11.5 dB, too loud.
    expect(staged.in[0]).toBeCloseTo(12.5, 6)
    expect(staged.in[4]).toBeCloseTo(PRE_GAIN_MODEL_CEILING / 0.6, 6)
  })

  it('starts the queue at 1, which only ever divides the warm-up frames the pump discards', () => {
    expect(run(3, 0.02, [0.02, 0.02, 0.02]).out).toEqual([1, 1, 1])
  })

  it('never lifts more again once a louder passage has been seen', () => {
    const staged = run(2, 0.01, [0.01, 0.5, 0.01, 0.02])
    // The peak it clamps against only grows, so a quiet frame after a loud one
    // keeps the reduced lift rather than climbing back up.
    expect(staged.in[1]).toBeLessThan(staged.in[0] as number)
    expect(staged.in.slice(1)).toEqual([staged.in[1], staged.in[1], staged.in[1]])
  })

  it('holds every frame it hands the model under the ceiling', () => {
    const peaks = [0.005, 0.05, 0.3, 0.9, 1]
    const staged = run(3, 0.005, peaks)
    peaks.forEach((peak, index) => {
      expect(peak * (staged.in[index] as number)).toBeLessThanOrEqual(PRE_GAIN_MODEL_CEILING + 1e-9)
    })
  })

  it('lifts nothing at all when there is nothing but room tone', () => {
    expect(run(3, PRE_GAIN_SILENCE_PEAK / 2, [0, 0, 0, 0]).in).toEqual([1, 1, 1, 1])
  })

  it('pairs a frame with itself when the model has no lookahead to undo', () => {
    const staged = run(0, 0.02, [0.02, 0.6])
    expect(staged.out).toEqual(staged.in)
  })

  it('never asks for more than the maximum lift, however quiet the opening', () => {
    // Just above the room-tone floor, so this is a real measurement rather than
    // one the silence rule declines to act on.
    const barelyAudible = PRE_GAIN_SILENCE_PEAK * 1.01
    expect(run(3, barelyAudible, [barelyAudible]).in[0]).toBeCloseTo(PRE_GAIN_MAX_FACTOR, 6)
  })
})
