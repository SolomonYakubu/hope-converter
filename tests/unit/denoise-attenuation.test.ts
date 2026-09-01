/**
 * The attenuation limit read as what it is: a dry/wet mix.
 *
 * These are the arithmetic half. That the bundled model actually behaves this way
 * is measured against the real model in `tests/integration/real-denoise.test.ts`,
 * which is what makes the numbers here a description rather than a hope.
 */
import { describe, expect, it } from 'vitest'
import { DENOISE_MAX_ATTENUATION_DB, originalShareForLimitDb } from '../../electron/types/denoise'

describe('originalShareForLimitDb', () => {
  it('keeps the whole recording at a limit of zero', () => {
    expect(originalShareForLimitDb(0)).toBe(1)
  })

  it('halves the kept share every 6 dB', () => {
    expect(originalShareForLimitDb(6)).toBeCloseTo(0.501, 3)
    expect(originalShareForLimitDb(12)).toBeCloseTo(0.251, 3)
    expect(originalShareForLimitDb(18)).toBeCloseTo(0.126, 3)
    expect(originalShareForLimitDb(24)).toBeCloseTo(0.0631, 4)
  })

  it('has nothing left to protect speech with at the settings the UI withholds', () => {
    expect(originalShareForLimitDb(30)).toBeCloseTo(0.0316, 4)
    expect(originalShareForLimitDb(60)).toBeCloseTo(0.001, 4)
    expect(originalShareForLimitDb(100)).toBeLessThan(0.0001)
  })

  it('is monotonic across the offered range', () => {
    for (let limit = 1; limit <= DENOISE_MAX_ATTENUATION_DB; limit++) {
      expect(originalShareForLimitDb(limit)).toBeLessThan(originalShareForLimitDb(limit - 1))
    }
  })

  it('treats a nonsensical limit as no attenuation rather than as silence', () => {
    // A share of 0 would mean "trust the model completely", which is the wrong way
    // to fail; clampOptions already rejects these before the engine sees them.
    expect(originalShareForLimitDb(-6)).toBe(1)
    expect(originalShareForLimitDb(Number.NaN)).toBe(1)
    expect(originalShareForLimitDb(Number.POSITIVE_INFINITY)).toBe(1)
    expect(originalShareForLimitDb(Number.NEGATIVE_INFINITY)).toBe(1)
  })

  it('stops the offered range where the noise reduction stops paying for itself', () => {
    // 24 dB and 100 dB differ by 0.3 dB of measured noise reduction on voice, and by
    // 36 dB of damage to the quietest speech. The engine still accepts 100.
    expect(DENOISE_MAX_ATTENUATION_DB).toBe(24)
  })
})
