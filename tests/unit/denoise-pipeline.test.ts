/**
 * The pump inside the denoise pipeline, with both FFmpeg processes faked.
 *
 * What matters here is arithmetic the real-FFmpeg tests cannot see cheaply: that
 * the output is the same length as the input, lines up with it sample for sample
 * despite the model's lookahead, and comes out at the level it went in at even
 * when a pre-gain was applied on the way through the model.
 */
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDenoisePipeline } from '../../electron/denoise/pipeline'
import { PRE_GAIN_MODEL_CEILING, PRE_GAIN_TARGET_PEAK } from '../../electron/denoise/pre-gain'
import { temporaryOutputPath } from '../../electron/ffmpeg/converter'
import type { DeepFilterBank } from '../../electron/denoise/engine'
import type { Spawn } from '../../electron/ffmpeg/probe'

const FRAME_LENGTH = 480

let workspace = ''

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'hope-pump-'))
})

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

/** A child process that behaves the way the pipeline expects, without ffmpeg. */
class FakeChild extends EventEmitter {
  stdout: Readable | null = null
  stdin: PassThrough | null = null
  readonly stderr = new PassThrough()
  kill(): boolean { return true }
}

interface Recording {
  /** Every sample the model was handed, in order, after any pre-gain. */
  seen: number[]
}

/**
 * Fakes the pair of FFmpeg processes: the first hands `input` to the pump in
 * awkwardly sized chunks, the second writes whatever it receives straight to the
 * `.part` file so the pipeline can rename it into place.
 */
function fakeSpawn(input: Buffer, partPath: string, chunkBytes: number): Spawn {
  let call = 0
  return ((): unknown => {
    const child = new FakeChild()
    if (call++ === 0) {
      const chunks: Buffer[] = []
      for (let offset = 0; offset < input.length; offset += chunkBytes) {
        chunks.push(input.subarray(offset, Math.min(offset + chunkBytes, input.length)))
      }
      const stdout = Readable.from(chunks.length > 0 ? chunks : [Buffer.alloc(0)])
      child.stdout = stdout
      stdout.once('end', () => setImmediate(() => child.emit('close', 0)))
    } else {
      const stdin = new PassThrough()
      const written: Buffer[] = []
      child.stdin = stdin
      stdin.on('data', (chunk: Buffer) => written.push(chunk))
      stdin.once('finish', () => {
        void writeFile(partPath, Buffer.concat(written)).then(() => { child.emit('close', 0) })
      })
    }
    return child
  }) as unknown as Spawn
}

/**
 * Stands in for the model. `delayFrames` makes it lag its input the way
 * DeepFilterNet3 does, so the pipeline's compensation is exercised without the
 * 17 MB download.
 */
function stubBank(delayFrames: number, recording?: Recording): DeepFilterBank {
  const queues = new Map<number, Float32Array[]>()
  return {
    frameLength: FRAME_LENGTH,
    delayFrames,
    processFrame: (channel: number, frame: Float32Array): Float32Array => {
      if (recording) for (const sample of frame) recording.seen.push(sample)
      const output = Float32Array.from(frame)
      if (delayFrames === 0) return output
      const queue = queues.get(channel)
        ?? Array.from({ length: delayFrames }, () => new Float32Array(FRAME_LENGTH))
      queue.push(output)
      queues.set(channel, queue)
      return queue.shift() as Float32Array
    }
  } as unknown as DeepFilterBank
}

function toFloats(buffer: Buffer): number[] {
  const values: number[] = []
  for (let offset = 0; offset + 4 <= buffer.length; offset += 4) values.push(buffer.readFloatLE(offset))
  return values
}

function fromFloats(values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4))
  return buffer
}

/**
 * A tone that is not periodic at any small lag, so alignment is unambiguous.
 * Rounded to f32 so a round trip through the pipeline is exact and the
 * assertions can compare samples rather than tolerances.
 */
function testSignal(samples: number, amplitude: number): number[] {
  const values: number[] = []
  let seed = 12345
  for (let index = 0; index < samples; index++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    values.push(Math.fround(((seed / 0x7fffffff) * 2 - 1) * amplitude))
  }
  return values
}

/** `Math.max(...samples)` overflows the stack on a second of audio. */
function peak(samples: number[]): number {
  let largest = 0
  for (const value of samples) largest = Math.max(largest, Math.abs(value))
  return largest
}

/**
 * The worst factor by which any one written sample differs from the one that was
 * read, in either direction. 1 means the file came back at the level it went in at
 * everywhere, which is the claim; a peak comparison alone would miss a wrongly
 * scaled stretch anywhere below the peak.
 *
 * Samples too small to divide by are skipped: a pass through f32 leaves rounding
 * error there that says nothing about the gain staging.
 */
function worstRatio(output: number[], input: number[]): number {
  let worst = 1
  for (let index = 0; index < input.length; index++) {
    const source = Math.abs(input[index] as number)
    if (source < 1e-4) continue
    const ratio = Math.abs(output[index] as number) / source
    worst = Math.max(worst, ratio, 1 / ratio)
  }
  return worst
}

interface RunOptions {
  input: number[]
  delayFrames: number
  channels?: number
  chunkBytes?: number
  recording?: Recording
}

async function pumpThrough(name: string, options: RunOptions): Promise<number[]> {
  const outputPath = join(workspace, `${name}.raw`)
  await runDenoisePipeline({
    id: name,
    inputPath: join(workspace, 'in.raw'),
    outputPath,
    kind: 'audio',
    channels: options.channels ?? 1,
    bank: stubBank(options.delayFrames, options.recording),
    ffmpegPath: '/nonexistent/ffmpeg',
    spawn: fakeSpawn(fromFloats(options.input), temporaryOutputPath(outputPath), options.chunkBytes ?? 999)
  })
  return toFloats(await readFile(outputPath))
}

/** Lag, in samples, at which `estimate` best matches `reference`. */
function bestLag(estimate: number[], reference: number[], maxLag: number): number {
  let best = -1
  let bestScore = -Infinity
  for (let lag = 0; lag <= maxLag; lag++) {
    let dot = 0
    for (let index = 0; index + lag < reference.length && index < estimate.length; index++) {
      dot += (estimate[index] as number) * (reference[index + lag] as number)
    }
    if (dot > bestScore) { bestScore = dot; best = lag }
  }
  return best
}

describe('the denoise pump', () => {
  it('writes exactly as many samples as it read', async () => {
    // Deliberately ragged: not a whole number of frames, and split across chunk
    // boundaries that fall mid-sample.
    const input = testSignal(FRAME_LENGTH * 7 + 133, 0.5)
    const output = await pumpThrough('length', { input, delayFrames: 3 })
    expect(output).toHaveLength(input.length)
  })

  it('handles a file shorter than one frame', async () => {
    const input = testSignal(200, 0.5)
    const output = await pumpThrough('short', { input, delayFrames: 3 })
    expect(output).toHaveLength(200)
  })

  it('undoes the model lookahead, so the output lines up with the input', async () => {
    const input = testSignal(FRAME_LENGTH * 12, 0.5)
    const output = await pumpThrough('aligned', { input, delayFrames: 3 })

    expect(bestLag(output, input, FRAME_LENGTH * 4)).toBe(0)
    // A pass-through model plus a gain of 1 leaves the samples untouched, so the
    // first samples out are the first samples in rather than 30 ms of silence.
    expect(output.slice(0, 8)).toEqual(input.slice(0, 8))
    expect(output.at(-1)).toBe(input.at(-1))
  })

  it('flushes the tail the model is still holding', async () => {
    const input = testSignal(FRAME_LENGTH * 5, 0.5)
    const output = await pumpThrough('tail', { input, delayFrames: 3 })
    // Without the flush the last three frames would be missing or silent.
    const tail = output.slice(-FRAME_LENGTH * 3)
    expect(tail).toEqual(input.slice(-FRAME_LENGTH * 3))
  })

  it('keeps a model with no lookahead byte for byte identical', async () => {
    const input = testSignal(FRAME_LENGTH * 3 + 17, 0.5)
    const output = await pumpThrough('nodelay', { input, delayFrames: 0 })
    expect(output).toEqual(input)
  })

  it('hands the model a healthy level but writes the level it was given', async () => {
    // A phone recording: peaking about 34 dB below full scale.
    const input = testSignal(FRAME_LENGTH * 20, 0.02)
    const recording: Recording = { seen: [] }
    const output = await pumpThrough('pregain', { input, delayFrames: 3, recording })

    const peakIn = peak(input)
    const peakSeen = peak(recording.seen)

    expect(peakSeen).toBeGreaterThan(peakIn * 5)
    expect(peakSeen).toBeCloseTo(PRE_GAIN_TARGET_PEAK, 2)
    // The lift is divided back out, so nothing about the written level changed.
    expect(peak(output)).toBeCloseTo(peakIn, 5)
    expect(output).toHaveLength(input.length)
  })

  it('leaves an already loud recording at the level it arrived', async () => {
    const input = testSignal(FRAME_LENGTH * 20, 0.8)
    const recording: Recording = { seen: [] }
    await pumpThrough('loud', { input, delayFrames: 3, recording })
    expect(peak(recording.seen)).toBeCloseTo(peak(input), 6)
  })

  it('waits past a silent opening before choosing a level', async () => {
    // Two seconds of room tone, then speech: calibrating on the silence would
    // measure nothing and leave a quiet recording quiet.
    const opening = new Array<number>(48_000 * 2).fill(0)
    const speech = testSignal(FRAME_LENGTH * 20, 0.02)
    const input = [...opening, ...speech]
    const recording: Recording = { seen: [] }
    const output = await pumpThrough('silent-opening', { input, delayFrames: 3, recording })

    expect(peak(recording.seen)).toBeGreaterThan(0.1)
    expect(output).toHaveLength(input.length)
  })

  it('holds the lift down when the recording gets louder than its opening', async () => {
    // Room tone for the first two seconds, then someone speaks up: the lift chosen
    // from that opening would hand the model roughly 7x full scale, where it starts
    // gating the speech it is meant to keep.
    const opening = testSignal(48_000 * 2, 0.02)
    const loud = testSignal(FRAME_LENGTH * 20, 0.6)
    const input = [...opening, ...loud]
    const recording: Recording = { seen: [] }
    const output = await pumpThrough('overdrive', { input, delayFrames: 3, recording })

    expect(peak(recording.seen)).toBeLessThanOrEqual(PRE_GAIN_MODEL_CEILING + 1e-6)
    // Still lifted: the clamp is a ceiling, not a retreat to no gain at all.
    expect(peak(recording.seen)).toBeGreaterThan(peak(loud))
    // And the written level is the level that arrived — every sample of it, not
    // merely the loudest. A peak-only check cannot see a wrongly scaled stretch
    // in the quiet part, which is exactly what this used to write.
    expect(worstRatio(output, input)).toBeLessThanOrEqual(1 + 1e-5)
    expect(output).toHaveLength(input.length)
  })

  it('scales the samples just before a loud passage by the lift they went in at', async () => {
    // The regression this case is named for: the lift falls as the loud passage
    // arrives, but the samples coming back from the model then entered three frames
    // earlier at the older, larger lift. Dividing the new one out of them wrote the
    // 100 ms before the boundary up to 3.745x — 11.5 dB — too loud.
    const quiet = testSignal(48_000 * 2, 0.02)
    const loud = testSignal(48_000, 0.6)
    const input = [...quiet, ...loud]
    const output = await pumpThrough('gain-boundary', { input, delayFrames: 3, recording: { seen: [] } })

    expect(output).toHaveLength(input.length)
    expect(worstRatio(output, input)).toBeLessThanOrEqual(1 + 1e-5)

    // Sample by sample across the boundary itself, where the ratio was worst.
    const boundary = quiet.length
    for (let index = boundary - FRAME_LENGTH * 12; index < boundary + FRAME_LENGTH * 4; index++) {
      expect(output[index]).toBeCloseTo(input[index] as number, 6)
    }
  })

  it('processes a file that is silent throughout without amplifying it', async () => {
    const input = new Array<number>(FRAME_LENGTH * 4).fill(0)
    const output = await pumpThrough('silence', { input, delayFrames: 3 })
    expect(output).toHaveLength(input.length)
    expect(peak(output)).toBe(0)
  })

  it('keeps interleaved channels in their own model states', async () => {
    const left = testSignal(FRAME_LENGTH * 4, 0.5)
    const right = testSignal(FRAME_LENGTH * 4, 0.3).map((value) => -value)
    const input: number[] = []
    for (let index = 0; index < left.length; index++) {
      input.push(left[index] as number, right[index] as number)
    }

    const output = await pumpThrough('stereo', { input, delayFrames: 3, channels: 2 })
    expect(output).toHaveLength(input.length)
    expect(output.slice(0, 4)).toEqual(input.slice(0, 4))
  })
})
