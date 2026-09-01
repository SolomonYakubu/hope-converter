import { spawn as spawnChild } from 'node:child_process'
import { rename, rm } from 'node:fs/promises'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import {
  DENOISE_SAMPLE_RATE,
  type DenoiseAudioFormat,
  type DenoiseKind,
  type DenoiseProgress
} from '../types/denoise'
import { temporaryOutputPath } from '../ffmpeg/converter'
import { mapFFmpegError } from '../ffmpeg/errors'
import type { Spawn } from '../ffmpeg/probe'
import { toError } from '../utils/guards'
import { buildDecodeArgs, buildEncodeArgs } from './command-builder'
import { DenoiseCancelledError } from './errors'
import { PRE_GAIN_SILENCE_PEAK, createGainStager, peakOf } from './pre-gain'
import type { StagedGain } from './pre-gain'
import type { DeepFilterBank } from './engine'

const BYTES_PER_SAMPLE = 4
/** Keeps the renderer informed without flooding IPC on a fast machine. */
const PROGRESS_INTERVAL_MS = 200
const MAX_ERROR_OUTPUT = 16_384
const EMPTY = Buffer.alloc(0)
/**
 * Audio held back to choose the pre-gain from — one second, in samples per
 * channel. Long enough to catch the level of a first word, short enough that a
 * preview is not mostly warm-up.
 */
const CALIBRATION_SAMPLES = DENOISE_SAMPLE_RATE
/**
 * How long to keep waiting for something audible before giving up and processing
 * at the level as recorded. Rooms are often silent for a few seconds before anyone
 * speaks, and calibrating on that silence would tell us nothing.
 */
const MAX_CALIBRATION_SAMPLES = DENOISE_SAMPLE_RATE * 10

const DECODE_SPAWN: SpawnOptions = { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
const ENCODE_SPAWN: SpawnOptions = { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }
const PLAIN_SPAWN: SpawnOptions = { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }

export interface DenoisePipelineOptions {
  id: string
  inputPath: string
  outputPath: string
  kind: DenoiseKind
  channels: number
  bank: DeepFilterBank
  ffmpegPath: string
  /** Expected length of the processed audio, for percentages. */
  totalSeconds?: number
  /** Window to process. A whole-file job leaves both unset; the preview does not. */
  startSeconds?: number
  limitSeconds?: number
  audioFormat?: DenoiseAudioFormat
  audioBitrateKbps?: number
  /** Post-model level stage, applied inside the encoder. */
  speechGainDb?: number
  normalizeLoudness?: boolean
  spawn?: Spawn
  signal?: AbortSignal
  onProgress?: (progress: DenoiseProgress) => void
}

/**
 * Streams one file through the model. FFmpeg decodes the first audio track to
 * raw 48 kHz floats, every frame passes through DeepFilterNet3, and a second
 * FFmpeg writes the result — muxing the original, untouched video stream
 * alongside it when the input is a video.
 *
 * Nothing is held beyond a frame or two, so a two-hour file costs the same
 * memory as a ten-second one. The output goes to a `.part` sibling and is
 * renamed into place only once both processes have exited cleanly.
 */
export async function runDenoisePipeline(options: DenoisePipelineOptions): Promise<void> {
  const spawn = options.spawn ?? spawnChild
  const partPath = temporaryOutputPath(options.outputPath)

  // Both argument lists are validated before anything is spawned or deleted.
  const decodeArgs = buildDecodeArgs({
    inputPath: options.inputPath,
    channels: options.channels,
    startSeconds: options.startSeconds,
    durationSeconds: options.limitSeconds
  })
  const encodeArgs = buildEncodeArgs({
    outputPath: partPath,
    channels: options.channels,
    kind: options.kind,
    originalPath: options.kind === 'video' ? options.inputPath : undefined,
    audioFormat: options.audioFormat,
    audioBitrateKbps: options.audioBitrateKbps,
    speechGainDb: options.speechGainDb,
    normalizeLoudness: options.normalizeLoudness
  })

  await rm(partPath, { force: true })

  const decode = spawn(options.ffmpegPath, decodeArgs, DECODE_SPAWN)
  const encode = spawn(options.ffmpegPath, encodeArgs, ENCODE_SPAWN)
  const decodeErrors = collectStderr(decode)
  const encodeErrors = collectStderr(encode)

  let failure: Error | null = null
  const stop = (error: Error): void => {
    failure ??= error
    encode.stdin?.destroy()
    decode.kill('SIGKILL')
    encode.kill('SIGKILL')
  }
  const abort = (): void => stop(new DenoiseCancelledError(options.id))

  try {
    const source = decode.stdout
    const sink = encode.stdin
    if (!source || !sink) throw new Error('FFmpeg did not open the pipes the denoiser needs')

    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()

    // Every task tears the others down on failure, and allSettled waits for the
    // teardown to finish so nothing is still writing when the `.part` is removed.
    await Promise.allSettled([
      guard(() => pump({ ...options, source, sink, isStopped: () => failure !== null }), stop),
      guard(() => waitForExit(decode, decodeErrors), stop),
      guard(() => waitForExit(encode, encodeErrors), stop)
    ])
    if (failure) throw failure

    await rename(partPath, options.outputPath)
  } catch (cause) {
    await rm(partPath, { force: true }).catch(() => undefined)
    throw toError(cause)
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}

/** Runs an FFmpeg command that needs no piping, used for the untouched preview half. */
export async function runFFmpeg(ffmpegPath: string, args: string[], spawn: Spawn = spawnChild): Promise<void> {
  const child = spawn(ffmpegPath, args, PLAIN_SPAWN)
  await waitForExit(child, collectStderr(child))
}

interface PumpOptions {
  id: string
  source: Readable
  sink: Writable
  bank: DeepFilterBank
  channels: number
  totalSeconds?: number
  onProgress?: (progress: DenoiseProgress) => void
  /** True once a sibling task has failed, at which point the pump gives up quietly. */
  isStopped: () => boolean
}

/**
 * Moves the audio across, with the two corrections the model needs to sound
 * right:
 *
 * - the first second is held back to choose a pre-gain, so the model is handed a
 *   healthy level even when the recording was made at a quiet one (see
 *   `pre-gain.ts`), and each frame's output is divided by the lift that frame went
 *   in at. The lift is then held down as the file goes by, so a recording that opens
 *   on room tone and later gets loud does not arrive at the model over-driven;
 * - the model's output lags its input by `bank.delayFrames`, so that much is
 *   dropped from the front and the same amount is flushed out at the end. Without
 *   it a file loses the tail of its last word and a video's cleaned soundtrack
 *   runs 30 ms behind the picture.
 *
 * The two corrections are the same correction seen from both ends: because the model
 * answers late, the lift to undo is the one from `delayFrames` ago rather than the
 * one now in force, which is what `createGainStager` keeps track of.
 *
 * What reaches the encoder is therefore exactly as many samples as came in, at the
 * level they came in at.
 */
function pump(options: PumpOptions): Promise<void> {
  const { source, sink, bank, channels } = options
  const frameSamples = bank.frameLength * channels
  const frameBytes = frameSamples * BYTES_PER_SAMPLE
  const scratch = Array.from({ length: channels }, () => new Float32Array(bank.frameLength))
  const startedAt = Date.now()

  let carry: Buffer = EMPTY
  const stager = createGainStager(bank.delayFrames)
  let calibrated = false
  /** Model output still to be discarded to undo the lookahead, in samples. */
  let skipSamples = bank.delayFrames * frameSamples
  /** Bytes read from the decoder, which decide how many samples are written back. */
  let inputBytes = 0
  let writtenSamples = 0
  /** The sample count to stop at, known only once the decoder is done. */
  let total: number | null = null
  let processedSamples = 0
  let reportedAt = 0
  let settled = false
  /** True once the decoder has handed over everything, so its close is expected. */
  let ended = false

  return new Promise<void>((resolve, reject) => {
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }

    const report = (force: boolean): void => {
      const now = Date.now()
      if (!options.onProgress || (!force && now - reportedAt < PROGRESS_INTERVAL_MS)) return
      reportedAt = now
      const processedSeconds = processedSamples / DENOISE_SAMPLE_RATE
      const elapsedSeconds = (now - startedAt) / 1_000
      options.onProgress({
        id: options.id,
        percent: percentOf(processedSeconds, options.totalSeconds),
        processedSeconds,
        // Too short an interval makes the figure jump around meaninglessly.
        speed: elapsedSeconds >= 0.25 ? processedSeconds / elapsedSeconds : null
      })
    }

    // The encoder is slower than the model on lossy formats, so honour its backpressure.
    const push = (block: Buffer): void => {
      if (sink.write(block)) return
      source.pause()
      sink.once('drain', () => { if (!settled) source.resume() })
    }

    /** Writes model output, minus the delay at the front and anything past the end. */
    const emit = (block: Buffer): void => {
      let out = block
      if (skipSamples > 0) {
        const skipped = Math.min(skipSamples, out.length / BYTES_PER_SAMPLE)
        skipSamples -= skipped
        out = out.subarray(skipped * BYTES_PER_SAMPLE)
      }
      if (total !== null) {
        const allowed = Math.max(0, total - writtenSamples) * BYTES_PER_SAMPLE
        if (out.length > allowed) out = out.subarray(0, allowed)
      }
      if (!out.length) return
      writtenSamples += out.length / BYTES_PER_SAMPLE
      push(out)
    }

    /**
     * Chooses the pre-gain once there is enough audio to judge, and reports whether
     * the frames waiting in `carry` may now be processed. Silence is not enough to
     * judge by, so a quiet opening keeps the decision waiting rather than settling
     * it on room tone.
     */
    const calibrate = (atEnd: boolean): boolean => {
      const perChannel = Math.floor(carry.length / BYTES_PER_SAMPLE / channels)
      if (!atEnd && perChannel < CALIBRATION_SAMPLES) return false
      const peak = peakOf(carry)
      if (!atEnd && peak <= PRE_GAIN_SILENCE_PEAK && perChannel < MAX_CALIBRATION_SAMPLES) return false
      stager.calibrate(peak)
      calibrated = true
      return true
    }

    /** Denoises every whole frame waiting in `carry` and emits the result. */
    const drainWholeFrames = (): void => {
      const frames = Math.floor(carry.length / frameBytes)
      if (frames === 0) return
      const block = carry.subarray(0, frames * frameBytes)
      carry = carry.subarray(frames * frameBytes)
      emit(denoiseFrames(block, frames, frames * frameSamples, bank, channels, scratch, stager.step))
      processedSamples += frames * bank.frameLength
    }

    source.on('data', (chunk: Buffer) => {
      if (settled) return
      // The failure that stopped us is already recorded by the caller.
      if (options.isStopped()) { settle(); return }

      inputBytes += chunk.length
      carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
      if (!calibrated && !calibrate(false)) return
      try {
        drainWholeFrames()
      } catch (cause) {
        settle(toError(cause))
        return
      }
      report(false)
    })

    source.once('end', () => {
      if (settled) return
      ended = true
      total = Math.floor(inputBytes / BYTES_PER_SAMPLE)
      try {
        if (!calibrated) calibrate(true)
        drainWholeFrames()

        const remaining = Math.floor(carry.length / BYTES_PER_SAMPLE)
        if (remaining > 0) {
          const padded = Buffer.alloc(frameBytes)
          carry.copy(padded, 0, 0, remaining * BYTES_PER_SAMPLE)
          emit(denoiseFrames(padded, 1, remaining, bank, channels, scratch, stager.step))
          processedSamples += Math.ceil(remaining / channels)
        }

        // Silence in, so the frames still inside the model come out. Each one is
        // divided by the lift its audio went in at, which is still queued.
        const silence = Buffer.alloc(frameBytes)
        for (let frame = 0; frame < bank.delayFrames && writtenSamples < total; frame++) {
          emit(denoiseFrames(silence, 1, 0, bank, channels, scratch, stager.step))
        }
      } catch (cause) {
        settle(toError(cause))
        return
      }
      report(true)
      sink.end()
      settle()
    })

    source.once('error', (cause) => settle(toError(cause)))
    // Reached only when the decoder dies mid-stream. A stream that ended normally
    // closes afterwards too, so that case is ruled out explicitly rather than left
    // to the order the two events happen to arrive in.
    source.once('close', () => {
      if (!ended) settle(new Error('The decoder stopped before the audio ended'))
    })
    sink.once('error', (cause) => settle(toError(cause)))
  })
}

/**
 * Denoises `frameCount` whole frames of interleaved samples and returns the
 * interleaved result. Samples at or past `availableSamples` are read as silence,
 * which is how the final partial frame gets padded.
 *
 * `stage` is called once per frame with that frame's own peak, before any lift, and
 * answers with the pair of factors to use: `in` on the way into the model, `out` —
 * the lift from `delayFrames` ago — on the way back out. Undoing the current lift
 * instead would mis-scale the frames still in flight whenever it changes.
 *
 * Samples are read and written a float at a time rather than through a typed
 * array view: a Buffer that arrived from a pipe carries no alignment guarantee,
 * and `new Float32Array(buffer, byteOffset, …)` throws on an odd offset. The lift
 * itself is applied over the typed scratch array, so it costs one pass over a frame
 * and saves the separate pass a per-block peak used to make.
 */
function denoiseFrames(
  input: Buffer,
  frameCount: number,
  availableSamples: number,
  bank: DeepFilterBank,
  channels: number,
  scratch: Float32Array[],
  stage: (framePeak: number) => StagedGain
): Buffer {
  const { frameLength } = bank
  const output = Buffer.allocUnsafe(frameCount * frameLength * channels * BYTES_PER_SAMPLE)

  for (let frame = 0; frame < frameCount; frame++) {
    const base = frame * frameLength * channels
    let framePeak = 0

    for (let sample = 0; sample < frameLength; sample++) {
      for (let channel = 0; channel < channels; channel++) {
        const position = base + sample * channels + channel
        const target = scratch[channel] as Float32Array
        const value = position < availableSamples ? input.readFloatLE(position * BYTES_PER_SAMPLE) : 0
        target[sample] = value
        const magnitude = Math.abs(value)
        // A NaN or an infinity would otherwise decide the lift for the whole file.
        if (Number.isFinite(magnitude) && magnitude > framePeak) framePeak = magnitude
      }
    }

    const { in: gainIn, out: gainOut } = stage(framePeak)
    if (gainIn !== 1) {
      for (const channel of scratch) {
        for (let sample = 0; sample < frameLength; sample++) {
          channel[sample] = (channel[sample] as number) * gainIn
        }
      }
    }

    for (let channel = 0; channel < channels; channel++) {
      const denoised = bank.processFrame(channel, scratch[channel] as Float32Array)
      for (let sample = 0; sample < frameLength; sample++) {
        const position = base + sample * channels + channel
        output.writeFloatLE((denoised[sample] as number) / gainOut, position * BYTES_PER_SAMPLE)
      }
    }
  }

  return output
}

/** Runs a task, tearing the rest of the pipeline down if it throws. */
async function guard(task: () => Promise<void>, stop: (error: Error) => void): Promise<void> {
  try {
    await task()
  } catch (cause) {
    stop(toError(cause))
    throw cause
  }
}

function collectStderr(child: ChildProcess): () => string {
  let output = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    output = `${output}${chunk}`.slice(-MAX_ERROR_OUTPUT)
  })
  return () => output
}

function waitForExit(child: ChildProcess, readErrors: () => string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once('error', (cause) => reject(toError(cause)))
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(mapFFmpegError(readErrors()))
    })
  })
}

/**
 * Progress through the file, or null when the duration is unknown — in which case
 * there is no percentage to be had and the UI says so rather than showing a 0 that
 * never moves.
 */
function percentOf(processedSeconds: number, totalSeconds: number | undefined): number | null {
  if (!totalSeconds || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return null
  return Math.min(100, Math.max(0, (processedSeconds / totalSeconds) * 100))
}
