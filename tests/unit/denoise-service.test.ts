import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODEL_FILENAME, WASM_FILENAME } from '../../electron/denoise/assets'
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

  /** The job or preview message for `id`, once the service has dispatched it. */
  async waitFor(id: string): Promise<DenoiseWorkerRequest> {
    return await vi.waitFor(() => {
      const message = this.sent.find((entry) => entry.type !== 'cancel' && entry.request.id === id)
      if (!message) throw new Error(`nothing sent for ${id}`)
      return message
    })
  }
}

/** A ready service with a fake worker and a directory holding stand-in assets. */
async function createService(overrides: {
  probe?: (inputPath: string) => Promise<MediaMetadata>
  handshake?: DenoiseWorkerEvent | null
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hope-denoise-service-'))
  await writeFile(join(directory, WASM_FILENAME), 'wasm')
  await writeFile(join(directory, MODEL_FILENAME), 'model')

  const worker = new FakeWorker(overrides.handshake === undefined ? { type: 'ready', frameLength: 480 } : overrides.handshake)
  let spawns = 0
  const service = new DenoiseService({
    assetDirectory: directory,
    ffmpegPath: '/usr/bin/ffmpeg',
    workerPath: '/out/main/denoise-worker.js',
    probe: overrides.probe ?? (() => Promise.resolve(STEREO)),
    createWorker: () => { spawns += 1; return worker }
  })

  const events: string[] = []
  const errors: { id: string, message: string }[] = []
  service.on('progress', (progress) => events.push(`progress:${progress.id}:${String(progress.percent)}`))
  service.on('complete', (result) => events.push(`complete:${result.id}`))
  service.on('cancelled', (id) => events.push(`cancelled:${id}`))
  service.on('error', (id, error) => { events.push(`error:${id}`); errors.push({ id, message: error.message }) })

  return {
    service, worker, events, errors, directory,
    spawnCount: () => spawns,
    cleanup: async () => { service.dispose(); await rm(directory, { recursive: true, force: true }) }
  }
}

describe('DenoiseService startup', () => {
  it('reports the model frame length once the worker is up', async () => {
    const { service, cleanup } = await createService()
    await expect(service.info()).resolves.toEqual({ available: true, frameLength: 480, sampleRate: 48_000 })
    await cleanup()
  })

  it('starts the worker only once, however many callers ask', async () => {
    const spawns = vi.fn()
    const directory = await mkdtemp(join(tmpdir(), 'hope-denoise-once-'))
    await writeFile(join(directory, WASM_FILENAME), 'wasm')
    await writeFile(join(directory, MODEL_FILENAME), 'model')
    const worker = new FakeWorker()
    const service = new DenoiseService({
      assetDirectory: directory,
      ffmpegPath: '/usr/bin/ffmpeg',
      workerPath: '/out/main/denoise-worker.js',
      probe: () => Promise.resolve(STEREO),
      createWorker: () => { spawns(); return worker }
    })

    service.warmUp()
    await Promise.all([service.info(), service.info()])

    expect(spawns).toHaveBeenCalledTimes(1)
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('explains a missing model instead of starting a worker that cannot work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hope-denoise-missing-'))
    const spawns = vi.fn()
    const service = new DenoiseService({
      assetDirectory: directory,
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
    const { service, worker, cleanup } = await createService()
    const job = service.denoise({
      id: 'job-1', inputPath: '/media/interview.mov', outputPath: '/out/interview-denoised.mp4',
      kind: 'video', options: { attenuationLimitDb: 500, postFilterBeta: 9, speechGainDb: 40, normalizeLoudness: true }
    })

    const message = await worker.waitFor('job-1')
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
    const { service, worker, cleanup } = await createService()
    const job = service.denoise({
      id: 'job-2', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac',
      kind: 'audio', durationSeconds: 120, options: OPTIONS
    })

    expect(await worker.waitFor('job-2')).toMatchObject({ request: { durationSeconds: 120 } })
    worker.emit({ type: 'done', result: { id: 'job-2', outputPath: '/out/memo-denoised.flac' } })
    await job
    await cleanup()
  })

  it('downmixes more than two channels and treats an unknown count as mono', async () => {
    const surround = await createService({ probe: () => Promise.resolve({ audioCodec: 'eac3', audioChannels: 6 }) })
    void surround.service.denoise({
      id: 'wide', inputPath: '/media/film.mkv', outputPath: '/out/film-denoised.mkv', kind: 'video', options: OPTIONS
    }).catch(() => undefined)
    expect(await surround.worker.waitFor('wide')).toMatchObject({ channels: 2 })
    await surround.cleanup()

    const unknown = await createService({ probe: () => Promise.resolve({ audioCodec: 'aac' }) })
    void unknown.service.denoise({
      id: 'bare', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    }).catch(() => undefined)
    expect(await unknown.worker.waitFor('bare')).toMatchObject({ channels: 1 })
    await unknown.cleanup()
  })

  it('relays progress and completion as events, not just as a resolved call', async () => {
    const { service, worker, events, cleanup } = await createService()
    const job = service.denoise({
      id: 'job-3', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    })
    await worker.waitFor('job-3')

    worker.emit({ type: 'progress', progress: { id: 'job-3', percent: 45, processedSeconds: 13.5, speed: 2 } })
    worker.emit({ type: 'done', result: { id: 'job-3', outputPath: '/out/memo-denoised.flac' } })
    await job

    expect(events).toEqual(['progress:job-3:45', 'complete:job-3'])
    expect(service.isRunning('job-3')).toBe(false)
    await cleanup()
  })

  it('reports a file with no audio track through an event, so the queue row does not hang', async () => {
    const { service, worker, errors, cleanup } = await createService({ probe: () => Promise.resolve({ videoCodec: 'h264' }) })

    await expect(service.denoise({
      id: 'silent', inputPath: '/media/timelapse.mp4', outputPath: '/out/timelapse-denoised.mp4',
      kind: 'video', options: OPTIONS
    })).rejects.toThrow(/no audio track/)

    expect(errors).toEqual([{ id: 'silent', message: 'This file has no audio track to denoise' }])
    expect(worker.sent).toEqual([])
    await cleanup()
  })

  it('rejects a duplicate id without touching the job that is already running', async () => {
    const { service, worker, errors, cleanup } = await createService()
    const first = service.denoise({
      id: 'same', inputPath: '/media/a.m4a', outputPath: '/out/a-denoised.flac', kind: 'audio', options: OPTIONS
    })
    await worker.waitFor('same')

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
    const { service, worker, cleanup } = await createService()
    await expect(service.denoise({
      id: '   ', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    })).rejects.toThrow(/cannot be empty/)
    expect(worker.sent).toEqual([])
    await cleanup()
  })

  it('turns a worker failure into an error event and a rejection', async () => {
    const { service, worker, errors, cleanup } = await createService()
    const job = service.denoise({
      id: 'job-4', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    })
    await worker.waitFor('job-4')

    worker.emit({ type: 'failed', id: 'job-4', message: 'FFmpeg could not read the audio' })
    await expect(job).rejects.toThrow('FFmpeg could not read the audio')
    expect(errors).toEqual([{ id: 'job-4', message: 'FFmpeg could not read the audio' }])
    await cleanup()
  })

  it('fails every waiting job when the worker dies, and starts a fresh one after', async () => {
    const { service, worker, errors, spawnCount, cleanup } = await createService()
    const job = service.denoise({
      id: 'job-5', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    })
    await worker.waitFor('job-5')

    worker.exit(1)
    await expect(job).rejects.toThrow(/stopped unexpectedly \(exit code 1\)/)
    expect(errors[0]?.id).toBe('job-5')

    // A dead worker is never reused, so the next caller gets a new one.
    expect(spawnCount()).toBe(1)
    await expect(service.info()).resolves.toMatchObject({ available: true })
    expect(spawnCount()).toBe(2)
    await cleanup()
  })
})

describe('DenoiseService cancellation', () => {
  it('forwards a cancel and rejects the job as cancelled, not failed', async () => {
    const { service, worker, events, cleanup } = await createService()
    const job = service.denoise({
      id: 'job-6', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    })
    await worker.waitFor('job-6')

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

  it('cancels the whole queue at once', async () => {
    const { service, worker, cleanup } = await createService()
    const jobs = ['a', 'b'].map((id) => service.denoise({
      id, inputPath: `/media/${id}.m4a`, outputPath: `/out/${id}-denoised.flac`, kind: 'audio', options: OPTIONS
    }).catch(() => undefined))
    await worker.waitFor('b')

    service.cancelAll()
    expect(worker.sent.filter((message) => message.type === 'cancel')).toHaveLength(2)

    worker.emit({ type: 'cancelled', id: 'a' })
    worker.emit({ type: 'cancelled', id: 'b' })
    await Promise.all(jobs)
    await cleanup()
  })

  it('fails anything still waiting when the app quits', async () => {
    const { service, worker, cleanup } = await createService()
    const job = service.denoise({
      id: 'job-7', inputPath: '/media/memo.m4a', outputPath: '/out/memo-denoised.flac', kind: 'audio', options: OPTIONS
    })
    await worker.waitFor('job-7')

    service.dispose()
    await expect(job).rejects.toThrow(/shut down/)
    expect(worker.terminated).toBe(true)
    await cleanup()
  })
})

describe('DenoiseService preview', () => {
  it('clamps the window to what the renderer can hold in memory', async () => {
    const { service, worker, cleanup } = await createService()
    void service.preview({ id: 'p1', inputPath: '/media/memo.m4a', startSeconds: 2, durationSeconds: 600, options: OPTIONS })
      .catch(() => undefined)

    expect(await worker.waitFor('p1')).toMatchObject({
      type: 'preview',
      request: { startSeconds: 2, durationSeconds: DENOISE_PREVIEW_MAX_SECONDS }
    })
    await cleanup()
  })

  it('never starts past the end, where both clips would come back empty', async () => {
    const { service, worker, cleanup } = await createService()
    void service.preview({ id: 'p2', inputPath: '/media/memo.m4a', startSeconds: 90, durationSeconds: 8, options: OPTIONS })
      .catch(() => undefined)

    // The probe reports 30 s, so the latest usable start is one second before the end.
    expect(await worker.waitFor('p2')).toMatchObject({ request: { startSeconds: 29 } })
    await cleanup()
  })

  it('asks for at least a second, whatever the caller sent', async () => {
    const { service, worker, cleanup } = await createService()
    void service.preview({ id: 'p3', inputPath: '/media/memo.m4a', startSeconds: -5, durationSeconds: 0, options: OPTIONS })
      .catch(() => undefined)

    expect(await worker.waitFor('p3')).toMatchObject({ request: { startSeconds: 0, durationSeconds: 1 } })
    await cleanup()
  })

  it('resolves with both clips and announces nothing to the queue', async () => {
    const { service, worker, events, cleanup } = await createService()
    const preview = service.preview({
      id: 'p4', inputPath: '/media/memo.m4a', startSeconds: 0, durationSeconds: 8, options: OPTIONS
    })
    await worker.waitFor('p4')

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
})
