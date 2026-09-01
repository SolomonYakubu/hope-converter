/**
 * The denoise pipeline against the real FFmpeg binary.
 *
 * The FFmpeg half — decoding to raw floats, framing, remuxing, cancellation —
 * runs everywhere with a stand-in for the model, so these tests do not depend on
 * a ~17 MB download. The DeepFilterNet3 half runs only when the assets are
 * present (`npm run fetch:models`) and is skipped, loudly, when they are not.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegBinary from 'ffmpeg-static'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkAssets, loadAssets, resolveAssetDirectory } from '../../electron/denoise/assets'
import { DeepFilterBank, DENOISE_DELAY_FRAMES } from '../../electron/denoise/engine'
import { DenoiseCancelledError } from '../../electron/denoise/errors'
import { runDenoisePipeline } from '../../electron/denoise/pipeline'
import { probeMedia } from '../../electron/ffmpeg/probe'
import { DENOISE_MAX_ATTENUATION_DB, originalShareForLimitDb } from '../../electron/types/denoise'
import type { DenoiseProgress } from '../../electron/types/denoise'

const ffmpegPath = ffmpegBinary as string
/** The real model's frame size, which the stand-in has to match. */
const FRAME_LENGTH = 480

let workspace = ''
const noisy = () => join(workspace, 'noisy.wav')
const clip = () => join(workspace, 'clip.mp4')

interface RunResult { stdout: string, stderr: string }

async function runFFmpeg(args: string[]): Promise<RunResult> {
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`ffmpeg exited ${String(code)}: ${stderr.slice(-400)}`)))
  })
}

/** A checksum of the video stream alone, which only matches if it was copied. */
async function videoStreamDigest(path: string): Promise<string> {
  const { stdout } = await runFFmpeg(['-hide_banner', '-nostdin', '-i', path, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-'])
  return stdout.trim()
}

async function volumeDb(path: string, field: 'max_volume' | 'mean_volume'): Promise<number> {
  const { stderr } = await runFFmpeg([
    '-hide_banner', '-nostdin', '-i', path, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'
  ])
  const match = new RegExp(`${field}:\\s*(-?\\d+(?:\\.\\d+)?) dB`).exec(stderr)
  if (!match?.[1]) throw new Error(`volumedetect reported no ${field}`)
  return Number(match[1])
}

/**
 * Stands in for the model: same interface, arithmetic simple enough that the
 * assertions can say exactly what should come out the far end. It has no
 * lookahead, so the pipeline has nothing to compensate for here — the delay
 * compensation itself is covered in `tests/unit/denoise-pipeline.test.ts` and
 * re-measured against the real model below.
 */
function stubBank(transform: (sample: number) => number): DeepFilterBank {
  return {
    frameLength: FRAME_LENGTH,
    delayFrames: 0,
    processFrame: (_channel: number, frame: Float32Array) => frame.map(transform)
  } as unknown as DeepFilterBank
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'hope-denoise-integration-'))
  // A tone under white noise: speech-like enough for the model to have something
  // to keep, and exactly what a "clean this up" file sounds like in miniature.
  await runFFmpeg([
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6:sample_rate=48000',
    '-f', 'lavfi', '-i', 'anoisesrc=duration=6:color=white:amplitude=0.15:sample_rate=48000',
    '-filter_complex', '[0][1]amix=inputs=2:duration=shortest:normalize=0[out]',
    '-map', '[out]', '-ac', '1', noisy()
  ])
  await runFFmpeg([
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip()
  ])
}, 120_000)

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

describe('denoise pipeline with real FFmpeg', () => {
  it('writes a lossless audio copy and reports progress on the way', async () => {
    const outputPath = join(workspace, 'noisy-denoised.flac')
    const progress: DenoiseProgress[] = []

    await runDenoisePipeline({
      id: 'audio-1',
      inputPath: noisy(),
      outputPath,
      kind: 'audio',
      channels: 1,
      bank: stubBank((sample) => sample),
      ffmpegPath,
      totalSeconds: 6,
      audioFormat: 'flac',
      onProgress: (update) => progress.push(update)
    })

    const written = await probeMedia(outputPath)
    expect(written.audioCodec).toBe('flac')
    expect(written.audioSampleRate).toBe(48_000)
    expect(written.audioChannels).toBe(1)
    expect(written.duration).toBeCloseTo(6, 1)

    expect(progress.length).toBeGreaterThan(0)
    const last = progress.at(-1) as DenoiseProgress
    expect(last.id).toBe('audio-1')
    expect(last.processedSeconds).toBeCloseTo(6, 1)
    expect(last.percent).toBeGreaterThan(95)
    // Nothing is left behind once the file is renamed into place.
    expect(await readdir(workspace)).not.toContain('noisy-denoised.flac.part')
  })

  it('writes what the model returned, not the samples it was given', async () => {
    const outputPath = join(workspace, 'halved.wav')
    await runDenoisePipeline({
      id: 'audio-2',
      inputPath: noisy(),
      outputPath,
      kind: 'audio',
      channels: 1,
      // Exactly 6 dB down, which is a change no re-encode could account for.
      bank: stubBank((sample) => sample * 0.5),
      ffmpegPath,
      audioFormat: 'wav'
    })

    const before = await volumeDb(noisy(), 'max_volume')
    const after = await volumeDb(outputPath, 'max_volume')
    expect(after - before).toBeCloseTo(-6.02, 1)
  })

  it('keeps a stereo file in stereo, one model state per side', async () => {
    const stereoInput = join(workspace, 'stereo.wav')
    await runFFmpeg([
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3:sample_rate=48000',
      '-ac', '2', stereoInput
    ])

    const outputPath = join(workspace, 'stereo-denoised.flac')
    await runDenoisePipeline({
      id: 'audio-3', inputPath: stereoInput, outputPath, kind: 'audio', channels: 2,
      bank: stubBank((sample) => sample), ffmpegPath, audioFormat: 'flac'
    })

    expect(await probeMedia(outputPath)).toMatchObject({ audioChannels: 2, audioCodec: 'flac' })
  })

  it('remuxes a video with the picture copied bit for bit', async () => {
    const outputPath = join(workspace, 'clip-denoised.mp4')
    await runDenoisePipeline({
      id: 'video-1', inputPath: clip(), outputPath, kind: 'video', channels: 1,
      bank: stubBank((sample) => sample * 0.5), ffmpegPath, totalSeconds: 5
    })

    const original = await probeMedia(clip())
    const written = await probeMedia(outputPath)
    expect(written).toMatchObject({
      videoCodec: original.videoCodec, width: original.width, height: original.height, audioCodec: 'aac'
    })
    expect(written.duration).toBeCloseTo(original.duration ?? 5, 0)
    // The picture is a straight copy, so its checksum is unchanged; only the
    // soundtrack went through the model.
    expect(await videoStreamDigest(outputPath)).toBe(await videoStreamDigest(clip()))
    expect(await volumeDb(outputPath, 'max_volume')).toBeLessThan(await volumeDb(clip(), 'max_volume') - 4)
  })

  it('leaves nothing behind when a job is cancelled part way', async () => {
    const controller = new AbortController()
    const outputPath = join(workspace, 'cancelled.flac')
    const job = runDenoisePipeline({
      id: 'cancel-1', inputPath: noisy(), outputPath, kind: 'audio', channels: 1,
      bank: stubBank((sample) => sample), ffmpegPath, audioFormat: 'flac',
      signal: controller.signal,
      onProgress: () => controller.abort()
    })

    await expect(job).rejects.toBeInstanceOf(DenoiseCancelledError)
    await expect(stat(outputPath)).rejects.toThrow()
    expect((await readdir(workspace)).filter((name) => name.startsWith('cancelled'))).toEqual([])
  })

  it('refuses a file with no audio track and cleans up after itself', async () => {
    const silent = join(workspace, 'silent.mp4')
    await runFFmpeg([
      '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=12:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silent
    ])

    const outputPath = join(workspace, 'silent-denoised.mp4')
    await expect(runDenoisePipeline({
      id: 'silent-1', inputPath: silent, outputPath, kind: 'video', channels: 1,
      bank: stubBank((sample) => sample), ffmpegPath
    })).rejects.toThrow()
    expect((await readdir(workspace)).filter((name) => name.startsWith('silent-denoised'))).toEqual([])
  })
})

// Resolved at collection time so the model suite can announce itself as skipped
// rather than failing on a checkout that has not fetched the assets. The checkout
// root stands in for `app.getAppPath()`; unlike the main bundle, this file is not
// code-split, so its own location is a safe base.
const checkoutRoot = fileURLToPath(new URL('../..', import.meta.url))
const assetDirectory = resolveAssetDirectory(false, undefined, checkoutRoot)
const assetsMissing = await checkAssets(assetDirectory)

describe.skipIf(assetsMissing !== null)('DeepFilterNet3 end to end', () => {
  const MODEL_OPTIONS = { attenuationLimitDb: 100, postFilterBeta: 0.02, speechGainDb: 0, normalizeLoudness: false }
  /** Through the model, but allowed to suppress almost nothing. */
  const LIGHT_TOUCH = { attenuationLimitDb: 1, postFilterBeta: 0, speechGainDb: 0, normalizeLoudness: false }
  /** A limit of zero: the wrapper returns the input untouched and undelayed. */
  const PASS_THROUGH = { attenuationLimitDb: 0, postFilterBeta: 0, speechGainDb: 0, normalizeLoudness: false }

  it(`loads the bundled model${assetsMissing ? ' (skipped: run npm run fetch:models)' : ''}`, async () => {
    const assets = await loadAssets(assetDirectory)
    const bank = await DeepFilterBank.create(assets.wasm, assets.model, MODEL_OPTIONS)
    expect(bank.frameLength).toBe(FRAME_LENGTH)
  }, 120_000)

  it('lags its input by exactly the frames the pipeline compensates for', async () => {
    // Re-measures DENOISE_DELAY_FRAMES against the shipped model, so a model with
    // a different lookahead fails here rather than quietly desyncing every video.
    // White noise, because it correlates with itself only where it lines up.
    const raw = join(workspace, 'align.raw')
    await runFFmpeg([
      '-y', '-hide_banner', '-nostdin', '-f', 'lavfi',
      '-i', 'anoisesrc=duration=4:color=white:amplitude=0.5:sample_rate=48000:seed=7',
      '-ac', '1', '-f', 'f32le', raw
    ])
    const bytes = await readFile(raw)
    const input = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4)).slice()

    const assets = await loadAssets(assetDirectory)
    const bank = await DeepFilterBank.create(assets.wasm, assets.model, LIGHT_TOUCH)

    /** Normalised correlation of the model's output against its input at `lag`. */
    const measure = (output: Float32Array, lag: number): number => {
      const start = 48_000
      const count = 48_000 * 2
      let dot = 0
      let left = 0
      let right = 0
      for (let index = 0; index < count; index++) {
        const one = output[start + index] as number
        const two = input[start + index - lag] ?? 0
        dot += one * two
        left += one * one
        right += two * two
      }
      return left && right ? dot / Math.sqrt(left * right) : 0
    }

    const runThroughModel = (): Float32Array => {
      const output = new Float32Array(input.length)
      for (let offset = 0; offset + FRAME_LENGTH <= input.length; offset += FRAME_LENGTH) {
        output.set(bank.processFrame(0, input.subarray(offset, offset + FRAME_LENGTH)), offset)
      }
      return output
    }

    const bestLag = (output: Float32Array): { lag: number, value: number } => {
      let best = { lag: -1, value: -2 }
      for (let lag = 0; lag <= FRAME_LENGTH * 8; lag++) {
        const value = measure(output, lag)
        if (value > best.value) best = { lag, value }
      }
      return best
    }

    // A 1 dB limit leaves the signal recognisable while still going through the
    // model, which a limit high enough to erase white noise would not.
    bank.prepare(1, LIGHT_TOUCH)
    expect(bank.delayFrames).toBe(3)
    const delayed = bestLag(runThroughModel())
    expect(delayed.lag).toBe(bank.delayFrames * FRAME_LENGTH)
    expect(delayed.value).toBeGreaterThan(0.99)
    // An aligned output would score near 1 here; a delayed one scores near nothing.
    expect(measure(runThroughModel(), 0)).toBeLessThan(0.2)

    // With the limit at zero the wrapper hands the input straight back, so there
    // is no lookahead to undo and the pipeline must not try.
    bank.prepare(1, PASS_THROUGH)
    expect(bank.delayFrames).toBe(0)
    const bypassed = bestLag(runThroughModel())
    expect(bypassed.lag).toBe(0)
    expect(bypassed.value).toBeGreaterThan(0.99)
  }, 180_000)

  it('lowers the noise floor of a real file and writes a playable result', async () => {
    const assets = await loadAssets(assetDirectory)
    const bank = await DeepFilterBank.create(assets.wasm, assets.model, MODEL_OPTIONS)
    bank.prepare(1, MODEL_OPTIONS)

    const outputPath = join(workspace, 'noisy-model.flac')
    await runDenoisePipeline({
      id: 'model-1', inputPath: noisy(), outputPath, kind: 'audio', channels: 1,
      bank, ffmpegPath, totalSeconds: 6, audioFormat: 'flac'
    })

    const written = await probeMedia(outputPath)
    expect(written).toMatchObject({ audioCodec: 'flac', audioSampleRate: 48_000 })
    // The delay compensation means the cleaned file is as long as the original,
    // rather than 30 ms of silence followed by a truncated tail.
    expect(written.duration).toBeCloseTo(6, 1)
    expect((await stat(outputPath)).size).toBeGreaterThan(1_000)
    // The tone is synthetic rather than speech, so the model suppresses most of
    // the signal; what matters here is that it ran and changed the audio.
    expect(await volumeDb(outputPath, 'mean_volume')).toBeLessThan(await volumeDb(noisy(), 'mean_volume'))
  }, 180_000)

  it('treats the attenuation limit as a dry/wet mix, as the UI tells the user it does', async () => {
    // The whole control is presented as "how much of the original is kept", which is
    // only honest if the model means the same thing by its limit. DeepFilterNet3
    // emits `alpha * noisy + (1 - alpha) * enhanced` with `alpha = 10 ** (-dB / 20)`;
    // this fits that prediction against the shipped model, so a model that means
    // something else by the limit fails the build instead of quietly making the
    // percentages in the panel wrong.
    const raw = join(workspace, 'blend.raw')
    await runFFmpeg([
      '-y', '-hide_banner', '-nostdin', '-f', 'lavfi',
      '-i', 'anoisesrc=duration=4:color=white:amplitude=0.2:sample_rate=48000:seed=11',
      '-ac', '1', '-f', 'f32le', raw
    ])
    const bytes = await readFile(raw)
    const input = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4)).slice()

    const assets = await loadAssets(assetDirectory)
    const bank = await DeepFilterBank.create(assets.wasm, assets.model, MODEL_OPTIONS)

    const runAtLimit = (attenuationLimitDb: number): Float32Array => {
      bank.prepare(1, { ...MODEL_OPTIONS, attenuationLimitDb })
      const output = new Float32Array(input.length)
      for (let offset = 0; offset + FRAME_LENGTH <= input.length; offset += FRAME_LENGTH) {
        output.set(bank.processFrame(0, input.subarray(offset, offset + FRAME_LENGTH)), offset)
      }
      return output
    }

    // The limit at 100 keeps a hundred-thousandth of the original, so it stands in
    // for the model's unmixed opinion.
    const enhanced = runAtLimit(100)
    const delay = DENOISE_DELAY_FRAMES * FRAME_LENGTH
    const start = delay + FRAME_LENGTH * 10 // past the model's warm-up

    for (const limit of [6, 12, 18, DENOISE_MAX_ATTENUATION_DB, 60]) {
      const output = runAtLimit(limit)
      const alpha = originalShareForLimitDb(limit)
      let residual = 0
      let energy = 0
      for (let index = start; index < output.length; index++) {
        const dry = input[index - delay] as number
        const wet = enhanced[index] as number
        residual += ((output[index] as number) - (alpha * dry + (1 - alpha) * wet)) ** 2
        energy += (output[index] as number) ** 2
      }
      // Everything above f32 rounding would mean the percentages shown are fiction.
      expect(Math.sqrt(residual / energy)).toBeLessThan(0.005)
    }
  }, 240_000)
})
