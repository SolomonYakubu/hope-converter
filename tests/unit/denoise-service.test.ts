import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODEL_FILENAME, WASM_FILENAME, type PinnedAsset } from '../../electron/denoise/assets'
import { DenoiseCancelledError } from '../../electron/denoise/errors'
import {
  DENOISE_PREVIEW_MAX_SECONDS,
  DenoiseService,
  type DenoiseWorkerHandle
} from '../../electron/denoise/service'
import type { DenoiseWorkerEvent, DenoiseWorkerRequest } from '../../electron/denoise/protocol'
import type { MediaMetadata } from '../../electron/types/conversion'
import type { DenoiseOptions } from '../../electron/types/denoise'

const OPTIONS: DenoiseOptions = { attenuationLimitDb: 60, postFilterBeta: 0.02, speechGainDb: 0, normalizeLoudness: false }
const STEREO: MediaMetadata = { audioCodec: 'aac', audioChannels: 2, duration: 30 }

/**
 * Digests for the stand-in asset files below. The service verifies whatever table
 * it is given, so these let every case exercise the real check without keeping
 * ~17 MB of model on hand.
 */
const STUB_ASSETS: readonly PinnedAsset[] = [
  pin(WASM_FILENAME, 'wasm'),
  pin(MODEL_FILENAME, 'model')
]

function pin(name: string, contents: string): PinnedAsset {
  return { name, bytes: Buffer.byteLength(contents), sha256: createHash('sha256').update(contents).digest('hex') }
}

/** Writes the stand-in assets that {@link STUB_ASSETS} pins. */
async function writeStubAssets(directory: string): Promise<void> {
  await writeFile(join(directory, WASM_FILENAME), 'wasm')
  await writeFile(join(directory, MODEL_FILENAME), 'model')
}

/** A worker stand-in: records what it was sent and replays whatever a test wants. */
class FakeWorker implements DenoiseWorkerHandle {
  readonly sent: DenoiseWorkerRequest[] = []
  terminated = false

  private readonly listeners = new Map<string, ((value: never) => void)[]>()

  /**
   * The event the worker answers its first listener with, standing in for the
   * real handshake. The service subscribes inside an async `launch()`, so tests
   * cannot emit until it does; replying to the subscription itself keeps that
   * deterministic.
   */
  constructor(private readonly handshake: DenoiseWorkerEvent | null = { type: 'ready', frameLength: 480 }) {}

  postMessage(message: DenoiseWorkerRequest): void {
    this.sent.push(message)
  }

  on(event: string, listener: (value: never) => void): unknown {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    if (event === 'message' && this.handshake) {
      const handshake = this.handshake
      queueMicrotask(() => this.emit(handshake))
    }
    return this
  }

  terminate(): unknown {
    this.terminated = true
    return 0
  }

  emit(event: DenoiseWorkerEvent): void {
    for (const listener of this.listeners.get('message') ?? []) (listener as (value: DenoiseWorkerEvent) => void)(event)
  }

  fail(error: Error): void {
    for (const listener of this.listeners.get('error') ?? []) (listener as (value: Error) => void)(error)
  }

  exit(code: number): void {
    for (const listener of this.listeners.get('exit') ?? []) (listener as (value: number) => void)(code)
  }

  /** The work it was handed for `id`, if any. */
  work(id: string): DenoiseWorkerRequest | undefined {
    return this.sent.find((entry) => entry.type !== 'cancel' && entry.request.id === id)
  }

  cancels(): DenoiseWorkerRequest[] {
    return this.sent.filter((entry) => entry.type === 'cancel')
  }
}

/**
 * A ready service whose workers are fakes, and a directory holding stand-in assets.
 *
 * The service starts a worker per request, so the fakes come as a list rather than
 * one: `serving(id)` is how a test gets hold of the one that was handed a given
 * request, which is also the only one allowed to answer for it.
 */
async function createService(overrides: {
  probe?: (inputPath: string) => Promise<MediaMetadata>
  handshake?: DenoiseWorkerEvent | null
  stallLimitMs?: number
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hope-denoise-service-'))
  await writeStubAssets(directory)

  const handshake = overrides.handshake === undefined ? { type: 'ready' as const, frameLength: 480 } : overrides.handshake
  const workers: FakeWorker[] = []
  const service = new DenoiseService({
    assetDirectory: directory,
    pinnedAssets: STUB_ASSETS,
    stallLimitMs: overrides.stallLimitMs,
    ffmpegPath: '/usr/bin/ffmpeg',
    workerPath: '/out/main/denoise-worker.js',
    probe: overrides.probe ?? (() => Promise.resolve(STEREO)),
    createWorker: () => {
      const worker = new FakeWorker(handshake)
      workers.push(worker)
      return worker
    }
  })

  const events: string[] = []
  const errors: { id: string, message: string }[] = []
  service.on('progress', (progress) => events.push(`progress:${progress.id}:${String(progress.percent)}`))
  service.on('complete', (result) => events.push(`complete:${result.id}`))
  service.on('cancelled', (id) => events.push(`cancelled:${id}`))
  service.on('error', (id, error) => { events.push(`error:${id}`); errors.push({ id, message: error.message }) })

  /** The worker a request was handed to, and the message it was handed. */
  const serving = async (id: string): Promise<{ worker: FakeWorker, message: DenoiseWorkerRequest }> => {
    return await vi.waitFor(() => {
      for (const worker of workers) {
        const message = worker.work(id)
        if (message) return { worker, message }
      }
      throw new Error(`nothing sent for ${id}`)
    })
  }

  return {
    service, workers, events, errors, directory, serving,
    spawnCount: () => workers.length,
    allSent: () => workers.flatMap((worker) => worker.sent),
    cleanup: async () => { service.dispose(); await rm(directory, { recursive: true, force: true }) }
  }
}

describe('DenoiseService startup', () => {
  it('reports the model frame length once the worker is up', async () => {
    const { service, cleanup } = await createService()
    await expect(service.info()).resolves.toEqual({ available: true, frameLength: 480, sampleRate: 48_000 })
    await cleanup()
  })

  it('keeps one loaded worker standing by, however many callers ask', async () => {
    const spawns = vi.fn()
    const directory = await mkdtemp(join(tmpdir(), 'hope-denoise-once-'))
    await writeStubAssets(directory)
    const worker = new FakeWorker()
    const service = new DenoiseService({
      assetDirectory: directory,
      pinnedAssets: STUB_ASSETS,
      ffmpegPath: '/usr/bin/ffmpeg',
      workerPath: '/out/main/denoise-worker.js',
      probe: () => Promise.resolve(STEREO),
      createWorker: () => { spawns(); return worker }
    })

    service.warmUp()
    await Promise.all([service.info(), service.info()])

    // A worker is spawned per request, but only when a request claims one: asking
    // whether the engine is up must not pile up threads.
    expect(spawns).toHaveBeenCalledTimes(1)
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('explains a missing model instead of starting a worker that cannot work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hope-denoise-missing-'))
    const spawns = vi.fn()
    const service = new DenoiseService({
      assetDirectory: directory,
      pinnedAssets: STUB_ASSETS,
      ffmpegPath: '/usr/bin/ffmpeg',
      createWorker: () => { spawns(); return new FakeWorker() }
    })

    const info = await service.info()
    expect(info).toMatchObject({ available: false, frameLength: null, sampleRate: 48_000 })
    expect(info.reason).toContain('npm run fetch:models')
    expect(spawns).not.toHaveBeenCalled()

    service.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('refuses to start on an asset that was replaced after setup', async () => {
    // The fetch script verified these files when it downloaded them, which says
    // nothing about the bytes on disk now. The digests are re-checked here, so a
    // swapped file disables the denoiser instead of being handed to the engine.
    const directory = await mkdtemp(join(tmpdir(), 'hope-denoise-tampered-'))
    await writeStubAssets(directory)
    await writeFile(join(directory, WASM_FILENAME), 'WASM')
    const spawns = vi.fn()
    const service = new DenoiseService({
      assetDirectory: directory,
      pinnedAssets: STUB_ASSETS,
      ffmpegPath: '/usr/bin/ffmpeg',
      createWorker: () => { spawns(); return new FakeWorker() }
    })

    const info = await service.info()
    expect(info.available).toBe(false)
    expect(info.reason).toContain('does not match its pinned SHA-256')
    expect(spawns).not.toHaveBeenCalled()

    service.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('passes a worker that reports itself unavailable straight through to the UI', async () => {
    const { service, cleanup } = await createService({
      handshake: { type: 'unavailable', reason: 'The wasm module could not be compiled' }
    })

    await expect(service.info()).resolves.toMatchObject({
      available: false, reason: 'The wasm module could not be compiled'
    })
    await cleanup()
  })

  it('refuses work after dispose rather than reviving the worker', async () => {
    const { service, cleanup } = await createService()
    service.dispose()

    await expect(service.info()).resolves.toMatchObject({ available: false, reason: 'The denoiser was shut down' })
    await expect(service.denoise({
      id: 'after', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    })).rejects.toThrow(/shut down/)
    await cleanup()
  })
})

describe('DenoiseService jobs', () => {
  it('hands the worker the probed duration, channel count and clamped options', async () => {
    const { service, serving, cleanup } = await createService()
    const job = service.denoise({
      id: 'job-1', inputPath: '/media/interview.mov', outputPath: '/out/interview-denoised.mp4',
      kind: 'video', options: { attenuationLimitDb: 500, postFilterBeta: 9, speechGainDb: 40, normalizeLoudness: true }
    })

    const { worker, message } = await serving('job-1')
    expect(message).toMatchObject({
      type: 'job',
      channels: 2,
      request: {
        durationSeconds: 30,
        options: { attenuationLimitDb: 100, postFilterBeta: 0.05, speechGainDb: 18, normalizeLoudness: true }
      }
    })

    worker.emit({ type: 'done', result: { id: 'job-1', outputPath: '/out/interview-denoised.mp4' } })
    await expect(job).resolves.toEqual({ id: 'job-1', outputPath: '/out/interview-denoised.mp4' })
    await cleanup()
  })

  it('keeps a duration the caller already knows rather than trusting the probe over it', async () => {
    const { service, serving, cleanup } = await createService()
    const job = service.denoise({
      id: 'job-2', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac',
      kind: 'audio', durationSeconds: 120, options: OPTIONS
    })

    const { worker, message } = await serving('job-2')
    expect(message).toMatchObject({ request: { durationSeconds: 120 } })
    worker.emit({ type: 'done', result: { id: 'job-2', outputPath: '/out/memo-denoised.flac' } })
    await job
    await cleanup()
  })

  it('downmixes more than two channels and treats an unknown count as mono', async () => {
    const surround = await createService({ probe: () => Promise.resolve({ audioCodec: 'eac3', audioChannels: 6 }) })
    void surround.service.denoise({
      id: 'wide', inputPath: '/media/film.mkv', outputPath: '/out/film-denoised.mkv', kind: 'video', options: OPTIONS
    }).catch(() => undefined)
    expect((await surround.serving('wide')).message).toMatchObject({ channels: 2 })
    await surround.cleanup()

    const unknown = await createService({ probe: () => Promise.resolve({ audioCodec: 'aac' }) })
    void unknown.service.denoise({
      id: 'bare', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    }).catch(() => undefined)
    expect((await unknown.serving('bare')).message).toMatchObject({ channels: 1 })
    await unknown.cleanup()
  })

  it('relays progress and completion as events, not just as a resolved call', async () => {
    const { service, serving, events, cleanup } = await createService()
    const job = service.denoise({
      id: 'job-3', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    })
    const { worker } = await serving('job-3')

    worker.emit({ type: 'progress', progress: { id: 'job-3', percent: 45, processedSeconds: 13.5, speed: 2 } })
    worker.emit({ type: 'done', result: { id: 'job-3', outputPath: '/out/memo-denoised.flac' } })
    await job

    expect(events).toEqual(['progress:job-3:45', 'complete:job-3'])
    expect(service.isRunning('job-3')).toBe(false)
    await cleanup()
  })

  it('reports a file with no audio track through an event, so the queue row does not hang', async () => {
    const { service, allSent, errors, cleanup } = await createService({ probe: () => Promise.resolve({ videoCodec: 'h264' }) })

    await expect(service.denoise({
      id: 'silent', inputPath: '/media/timelapse.mp4', outputPath: '/out/timelapse-denoised.mp4',
      kind: 'video', options: OPTIONS
    })).rejects.toThrow(/no audio track/)

    expect(errors).toEqual([{ id: 'silent', message: 'This file has no audio track to denoise' }])
    expect(allSent()).toEqual([])
    await cleanup()
  })

  it('rejects a duplicate id without touching the job that is already running', async () => {
    const { service, serving, errors, cleanup } = await createService()
    const first = service.denoise({
      id: 'same', inputPath: '/media/a.m4a', outputPath: '/out/a-denoised.flac', kind: 'audio', options: OPTIONS
    })
    const { worker } = await serving('same')

    await expect(service.denoise({
      id: 'same', inputPath: '/media/b.m4a', outputPath: '/out/b-denoised.flac', kind: 'audio', options: OPTIONS
    })).rejects.toThrow(/already running/)
    // The running job keeps its own status: no error is announced against its id.
    expect(errors).toEqual([])

    worker.emit({ type: 'done', result: { id: 'same', outputPath: '/out/a-denoised.flac' } })
    await first
    await cleanup()
  })

  it('rejects an empty id before it reaches the worker', async () => {
    const { service, allSent, cleanup } = await createService()
    await expect(service.denoise({
      id: '   ', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    })).rejects.toThrow(/cannot be empty/)
    expect(allSent()).toEqual([])
    await cleanup()
  })

  it('turns a worker failure into an error event and a rejection', async () => {
    const { service, serving, errors, cleanup } = await createService()
    const job = service.denoise({
      id: 'job-4', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    })
    const { worker } = await serving('job-4')

    worker.emit({ type: 'failed', id: 'job-4', message: 'FFmpeg could not read the audio' })
    await expect(job).rejects.toThrow('FFmpeg could not read the audio')
    expect(errors).toEqual([{ id: 'job-4', message: 'FFmpeg could not read the audio' }])
    await cleanup()
  })

  it('fails the job whose worker dies, and never hands work to that worker again', async () => {
    const { service, serving, errors, cleanup } = await createService()
    const job = service.denoise({
      id: 'job-5', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    })
    const dead = (await serving('job-5')).worker

    dead.exit(1)
    await expect(job).rejects.toThrow(/stopped unexpectedly \(exit code 1\)/)
    expect(errors[0]?.id).toBe('job-5')

    // The next file runs, and not on the corpse of the last one.
    const next = service.denoise({
      id: 'job-6', inputPath: '/media/next.m4a', outputPath: '/out/next-denoised.flac', kind: 'audio', options: OPTIONS
    })
    const { worker } = await serving('job-6')
    expect(worker).not.toBe(dead)
    worker.emit({ type: 'done', result: { id: 'job-6', outputPath: '/out/next-denoised.flac' } })
    await next
    await cleanup()
  })
})

describe('DenoiseService worker lifetime', () => {
  /**
   * The reason the rest of this design exists: a model state carries recurrent
   * history that cannot be cleared, so a second file run on a used thread comes out
   * differently from the way a fresh run renders it (`engine.ts` has the
   * measurement). These cases hold the guarantee that makes the difference — one
   * thread per request, terminated before the next one starts.
   */
  it('gives each request a thread of its own and terminates the one it used', async () => {
    const { service, serving, cleanup } = await createService()
    const first = service.denoise({
      id: 'one', inputPath: '/media/one.m4a', outputPath: '/out/one-denoised.flac', kind: 'audio', options: OPTIONS
    })
    const one = (await serving('one')).worker

    const second = service.denoise({
      id: 'two', inputPath: '/media/two.m4a', outputPath: '/out/two-denoised.flac', kind: 'audio', options: OPTIONS
    })
    // Nothing is handed over while the first file is still being processed.
    expect(one.work('two')).toBeUndefined()

    one.emit({ type: 'done', result: { id: 'one', outputPath: '/out/one-denoised.flac' } })
    await first

    const two = (await serving('two')).worker
    expect(two).not.toBe(one)
    expect(one.terminated).toBe(true)

    two.emit({ type: 'done', result: { id: 'two', outputPath: '/out/two-denoised.flac' } })
    await second
    await cleanup()
  })

  it('loads the next thread while the current file is still being processed', async () => {
    // A thread per file would otherwise add a model load to every file in a queue.
    // The replacement is started when the standby is claimed, so the wait is spent
    // on work rather than in front of it.
    const { service, serving, spawnCount, cleanup } = await createService()
    const job = service.denoise({
      id: 'overlap', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    })
    const { worker } = await serving('overlap')

    await vi.waitFor(() => { expect(spawnCount()).toBe(2) })
    // And no further: two threads at a time is the ceiling, whatever the queue holds.
    void service.denoise({
      id: 'queued', inputPath: '/media/next.m4a', outputPath: '/out/next-denoised.flac', kind: 'audio', options: OPTIONS
    }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(spawnCount()).toBe(2)

    worker.emit({ type: 'done', result: { id: 'overlap', outputPath: '/out/memo-denoised.flac' } })
    await job
    await cleanup()
  })
})

describe('DenoiseService stalls', () => {
  it('gives up on a worker that goes silent, rather than leaving the row cleaning forever', async () => {
    const { service, serving, errors, cleanup } = await createService({ stallLimitMs: 60 })
    // The handler goes on before the wait below, so the watchdog cannot fire into
    // a promise nobody is holding yet.
    const failure = service.denoise({
      id: 'wedged', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    }).catch((error: Error) => error.message)
    const { worker } = await serving('wedged')

    // The worker acknowledges nothing from here on, which is what a hang looks like.
    await expect(failure).resolves.toBe('The denoiser stopped responding and was restarted')
    expect(errors).toEqual([{ id: 'wedged', message: 'The denoiser stopped responding and was restarted' }])
    expect(service.isRunning('wedged')).toBe(false)

    // The wedged thread is killed rather than left running behind the app.
    await vi.waitFor(() => { expect(worker.terminated).toBe(true) })
    await expect(service.info()).resolves.toMatchObject({ available: true })
    await cleanup()
  })

  it('keeps a long job alive as long as it reports progress', async () => {
    const { service, serving, cleanup } = await createService({ stallLimitMs: 120 })
    const job = service.denoise({
      id: 'slow', inputPath: '/media/lecture.m4a', outputPath: '/out/lecture-denoised.flac', kind: 'audio', options: OPTIONS
    })
    const { worker } = await serving('slow')

    // Four times the limit in elapsed time, none of it silent.
    for (let tick = 0; tick < 8; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      worker.emit({ type: 'progress', progress: { id: 'slow', percent: tick * 10, processedSeconds: tick, speed: 1 } })
    }

    expect(service.isRunning('slow')).toBe(true)
    worker.emit({ type: 'done', result: { id: 'slow', outputPath: '/out/lecture-denoised.flac' } })
    await expect(job).resolves.toMatchObject({ id: 'slow' })
    await cleanup()
  })

  it('costs only the wedged job: what was queued behind it runs on its own thread', async () => {
    // The queue is held on the main thread now, so a hung worker takes its own
    // request down with it and nothing else. It used to take the whole queue.
    const { service, serving, events, cleanup } = await createService({ stallLimitMs: 40 })
    const first = service.denoise({
      id: 'first', inputPath: '/media/first.m4a', outputPath: '/out/first-denoised.flac', kind: 'audio', options: OPTIONS
    }).catch((error: Error) => error.message)
    const second = service.denoise({
      id: 'second', inputPath: '/media/second.m4a', outputPath: '/out/second-denoised.flac', kind: 'audio', options: OPTIONS
    })

    const wedged = (await serving('first')).worker
    await expect(first).resolves.toMatch(/stopped responding/)

    // The second file was never handed to the wedged worker, and is served after it.
    const { worker } = await serving('second')
    expect(worker).not.toBe(wedged)
    expect(wedged.work('second')).toBeUndefined()
    worker.emit({ type: 'done', result: { id: 'second', outputPath: '/out/second-denoised.flac' } })

    await expect(second).resolves.toMatchObject({ id: 'second' })
    expect(events).toEqual(['error:first', 'complete:second'])
    await cleanup()
  })
})

describe('DenoiseService cancellation', () => {
  it('forwards a cancel and rejects the job as cancelled, not failed', async () => {
    const { service, serving, events, cleanup } = await createService()
    const job = service.denoise({
      id: 'job-6', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    })
    const { worker } = await serving('job-6')

    expect(service.cancel('job-6')).toBe(true)
    expect(worker.sent.at(-1)).toEqual({ type: 'cancel', id: 'job-6' })

    worker.emit({ type: 'cancelled', id: 'job-6' })
    await expect(job).rejects.toBeInstanceOf(DenoiseCancelledError)
    expect(events).toContain('cancelled:job-6')
    await cleanup()
  })

  it('says so when there is nothing to cancel', async () => {
    const { service, cleanup } = await createService()
    expect(service.cancel('never-started')).toBe(false)
    await cleanup()
  })

  it('cancels the whole queue at once, telling only the worker that has work', async () => {
    const { service, serving, allSent, events, cleanup } = await createService()
    const jobs = ['a', 'b'].map((id) => service.denoise({
      id, inputPath: `/media/${id}.m4a`, outputPath: `/out/${id}-denoised.flac`, kind: 'audio', options: OPTIONS
    }).catch((error: Error) => error))
    const { worker } = await serving('a')

    service.cancelAll()
    // Only the running file is mid-FFmpeg and needs telling; the one still queued
    // has no thread yet, so it is answered here rather than sent anywhere.
    expect(worker.cancels()).toEqual([{ type: 'cancel', id: 'a' }])
    expect(allSent().some((message) => message.type !== 'cancel' && message.request.id === 'b')).toBe(false)

    worker.emit({ type: 'cancelled', id: 'a' })
    const [a, b] = await Promise.all(jobs)
    expect(a).toBeInstanceOf(DenoiseCancelledError)
    expect(b).toBeInstanceOf(DenoiseCancelledError)
    expect(events.filter((entry) => entry.startsWith('cancelled')).sort()).toEqual(['cancelled:a', 'cancelled:b'])
    await cleanup()
  })

  it('fails anything still waiting when the app quits', async () => {
    const { service, serving, cleanup } = await createService()
    const job = service.denoise({
      id: 'job-7', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    })
    const { worker } = await serving('job-7')

    service.dispose()
    await expect(job).rejects.toThrow(/shut down/)
    expect(worker.terminated).toBe(true)
    await cleanup()
  })
})

describe('DenoiseService preview', () => {
  it('clamps the window to what the renderer can hold in memory', async () => {
    const { service, serving, cleanup } = await createService()
    void service.preview({ id: 'p1', inputPath: '/media/memo.m4a', startSeconds: 2, durationSeconds: 600, options: OPTIONS })
      .catch(() => undefined)

    expect((await serving('p1')).message).toMatchObject({
      type: 'preview',
      request: { startSeconds: 2, durationSeconds: DENOISE_PREVIEW_MAX_SECONDS }
    })
    await cleanup()
  })

  it('never starts past the end, where both clips would come back empty', async () => {
    const { service, serving, cleanup } = await createService()
    void service.preview({ id: 'p2', inputPath: '/media/memo.m4a', startSeconds: 90, durationSeconds: 8, options: OPTIONS })
      .catch(() => undefined)

    // The probe reports 30 s, so the latest usable start is one second before the end.
    expect((await serving('p2')).message).toMatchObject({ request: { startSeconds: 29 } })
    await cleanup()
  })

  it('asks for at least a second, whatever the caller sent', async () => {
    const { service, serving, cleanup } = await createService()
    void service.preview({ id: 'p3', inputPath: '/media/memo.m4a', startSeconds: -5, durationSeconds: 0, options: OPTIONS })
      .catch(() => undefined)

    expect((await serving('p3')).message).toMatchObject({ request: { startSeconds: 0, durationSeconds: 1 } })
    await cleanup()
  })

  it('resolves with both clips and announces nothing to the queue', async () => {
    const { service, serving, events, cleanup } = await createService()
    const preview = service.preview({
      id: 'p4', inputPath: '/media/memo.m4a', startSeconds: 0, durationSeconds: 8, options: OPTIONS
    })
    const { worker } = await serving('p4')

    const result = { id: 'p4', original: new ArrayBuffer(8), denoised: new ArrayBuffer(8) }
    worker.emit({ type: 'preview', result })

    await expect(preview).resolves.toBe(result)
    // A preview is not a queue job, so it must not look like one finishing.
    expect(events).toEqual([])
    await cleanup()
  })

  it('rejects a preview that the engine cannot serve without emitting a queue error', async () => {
    const { service, events, cleanup } = await createService({ probe: () => Promise.resolve({ videoCodec: 'h264' }) })

    await expect(service.preview({
      id: 'p5', inputPath: '/media/timelapse.mp4', startSeconds: 0, durationSeconds: 8, options: OPTIONS
    })).rejects.toThrow(/no audio track/)
    expect(events).toEqual([])
    await cleanup()
  })

  it('runs a preview on a thread of its own, like a file does', async () => {
    // A preview renders the same window twice through the model, so a used state
    // would show the person something other than what their file will sound like.
    const { service, serving, cleanup } = await createService()
    const first = service.preview({
      id: 'p6', inputPath: '/media/memo.m4a', startSeconds: 0, durationSeconds: 4, options: OPTIONS
    })
    const one = (await serving('p6')).worker
    one.emit({ type: 'preview', result: { id: 'p6', original: new ArrayBuffer(4), denoised: new ArrayBuffer(4) } })
    await first

    const second = service.preview({
      id: 'p7', inputPath: '/media/memo.m4a', startSeconds: 4, durationSeconds: 4, options: OPTIONS
    })
    const two = (await serving('p7')).worker
    expect(two).not.toBe(one)
    expect(one.terminated).toBe(true)

    two.emit({ type: 'preview', result: { id: 'p7', original: new ArrayBuffer(4), denoised: new ArrayBuffer(4) } })
    await second
    await cleanup()
  })
})
