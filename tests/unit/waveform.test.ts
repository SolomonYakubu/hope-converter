import { describe, expect, it } from 'vitest'
import { computePeaks, formatClock, levelMatchGain, peaksToPath, rmsOf } from '../../src/utils/waveform'

const ramp = (length: number, map: (index: number) => number): Float32Array =>
  Float32Array.from({ length }, (_value, index) => map(index))

describe('computePeaks', () => {
  it('reduces samples to one min/max pair per column', () => {
    const samples = Float32Array.from([0.2, -0.4, 0.9, -0.1])
    const { min, max } = computePeaks([samples], 2)
    expect([...max]).toEqual([0.20000000298023224, 0.8999999761581421])
    expect([...min]).toEqual([-0.4000000059604645, -0.10000000149011612])
  })

  it('scans every channel, so a hard-panned sound still shows', () => {
    const left = Float32Array.from([0, 0, 0, 0])
    const right = Float32Array.from([0, 0.75, 0, -0.5])
    const { min, max } = computePeaks([left, right], 1)
    expect(max[0]).toBeCloseTo(0.75, 5)
    expect(min[0]).toBeCloseTo(-0.5, 5)
  })

  it('gives the last column the remainder rather than dropping it', () => {
    // 10 samples over 3 columns: the peak lives in the samples rounding would lose.
    const samples = ramp(10, (index) => (index === 9 ? 1 : 0.1))
    const { max } = computePeaks([samples], 3)
    expect(max).toHaveLength(3)
    expect(max[2]).toBe(1)
  })

  it('survives the edges a fresh or empty clip presents', () => {
    expect(computePeaks([], 4).max).toHaveLength(4)
    expect([...computePeaks([], 4).max]).toEqual([0, 0, 0, 0])
    expect(computePeaks([Float32Array.from([0.5])], 0).max).toHaveLength(0)
    expect(computePeaks([new Float32Array(0)], 3).max).toHaveLength(3)
    expect(computePeaks([Float32Array.from([0.5])], 2.7).max).toHaveLength(2)
    expect(computePeaks([Float32Array.from([0.5])], -3).max).toHaveLength(0)
  })

  it('asks for more columns than there are samples without repeating past the end', () => {
    const { max } = computePeaks([Float32Array.from([0.5, -0.5])], 6)
    expect(max).toHaveLength(6)
    expect(Math.max(...max)).toBeCloseTo(0.5, 5)
  })
})

describe('rmsOf', () => {
  it('is the root mean square across every channel', () => {
    expect(rmsOf([Float32Array.from([1, -1, 1, -1])])).toBeCloseTo(1, 6)
    expect(rmsOf([Float32Array.from([0.5, -0.5]), Float32Array.from([0.5, -0.5])])).toBeCloseTo(0.5, 6)
  })

  it('is zero for silence and for nothing at all', () => {
    expect(rmsOf([new Float32Array(64)])).toBe(0)
    expect(rmsOf([])).toBe(0)
    expect(rmsOf([new Float32Array(0)])).toBe(0)
  })
})

describe('levelMatchGain', () => {
  it('asks for the gain that makes the cleaned side as loud as the original', () => {
    const original = [Float32Array.from([0.5, -0.5, 0.5, -0.5])]
    const cleaned = [Float32Array.from([0.25, -0.25, 0.25, -0.25])]
    expect(levelMatchGain(original, cleaned)).toBeCloseTo(2, 5)
    expect(levelMatchGain(cleaned, original)).toBeCloseTo(0.5, 5)
  })

  it('is bounded, so a clip the model emptied does not blast the listener', () => {
    const loud = [Float32Array.from([0.9, -0.9])]
    const nearlySilent = [Float32Array.from([0.000_01, -0.000_01])]
    expect(levelMatchGain(loud, nearlySilent)).toBe(8)
    expect(levelMatchGain(nearlySilent, loud)).toBe(0.125)
  })

  it('leaves the gain alone when either side has no signal to measure', () => {
    const loud = [Float32Array.from([0.9, -0.9])]
    expect(levelMatchGain(loud, [new Float32Array(8)])).toBe(1)
    expect(levelMatchGain([new Float32Array(8)], loud)).toBe(1)
    expect(levelMatchGain([], [])).toBe(1)
  })
})

describe('peaksToPath', () => {
  it('draws out along the peaks and back along the troughs', () => {
    const path = peaksToPath({ min: Float32Array.from([-1, 0]), max: Float32Array.from([1, 0]) }, 100)
    // Out: column 0 at the top, column 1 at the middle. Back: column 1, column 0.
    expect(path).toBe('M0,0.00 L1,50.00 L1,50.00 L0,100.00 Z')
  })

  it('clamps samples past full scale instead of drawing outside the box', () => {
    const path = peaksToPath({ min: Float32Array.from([-4]), max: Float32Array.from([4]) }, 100)
    expect(path).toBe('M0,0.00 L0,100.00 Z')
  })

  it('is empty for an empty envelope, which renders as nothing', () => {
    expect(peaksToPath({ min: new Float32Array(0), max: new Float32Array(0) })).toBe('')
  })

  it('scales to whatever height it is given', () => {
    expect(peaksToPath({ min: Float32Array.from([0]), max: Float32Array.from([1]) }, 40))
      .toBe('M0,0.00 L0,20.00 Z')
  })
})

describe('formatClock', () => {
  it('reads as m:ss', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(7.9)).toBe('0:07')
    expect(formatClock(61)).toBe('1:01')
    expect(formatClock(600)).toBe('10:00')
  })

  it('shows a zero rather than a nonsense figure', () => {
    expect(formatClock(-5)).toBe('0:00')
    expect(formatClock(Number.NaN)).toBe('0:00')
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})
