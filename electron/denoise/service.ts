import { Worker } from 'node:worker_threads'
import ffmpegBinary from 'ffmpeg-static'
import { unpackedBinaryPath } from '../ffmpeg/binary-path'
import { probeMedia } from '../ffmpeg/probe'
import type { MediaMetadata } from '../types/conversion'
import {
  DENOISE_MAX_CHANNELS,
  DENOISE_SAMPLE_RATE,
  type DenoiseEngineInfo,
  type DenoiseOptions,
  type DenoisePreviewRequest,
  type DenoisePreviewResult,
  type DenoiseProgress,
  type DenoiseRequest,
  type DenoiseResult
} from '../types/denoise'
import { checkAssets, resolveAssetDirectory } from './assets'
import { clampOptions } from './engine'
import { DenoiseCancelledError } from './errors'
import type { DenoiseWorkerData, DenoiseWorkerEvent, DenoiseWorkerRequest } from './protocol'

/** Longest preview window offered, to keep the transferred WAVs small. */
export const DENOISE_PREVIEW_MAX_SECONDS = 20

/**
 * Seeds the worker's model state at startup. Every job calls `prepare` with its own
 * settings before a frame is processed, so this only decides what `df_create` is
 * handed while the engine is being probed for availability.
 */
const DEFAULT_OPTIONS: DenoiseOptions = {
  attenuationLimitDb: 12,
  postFilterBeta: 0.02,
  speechGainDb: 0,
  normalizeLoudness: false
}

type DenoiseEvents = {
  progress: (progress: DenoiseProgress) => void
  complete: (result: DenoiseResult) => void
  cancelled: (id: string) => void
  error: (id: string, error: Error) => void
}

/** The slice of `worker_threads.Worker` this service uses, so tests can stand in for it. */
export interface DenoiseWorkerHandle {
  postMessage: (message: DenoiseWorkerRequest) => void
  on: {
    (event: 'message', listener: (value: DenoiseWorkerEvent) => void): unknown
    (event: 'error', listener: (error: Error) => void): unknown
    (event: 'exit', listener: (code: number) => void): unknown
  }
  terminate: () => unknown
}

export interface DenoiseServiceDependencies {
  packaged?: boolean
  resourcesPath?: string
  /** `app.getAppPath()`, which is the checkout root during development. */
  appPath?: string
  assetDirectory?: string
  ffmpegPath?: string
  workerPath?: string | URL
  probe?: (inputPath: string) => Promise<MediaMetadata>
  createWorker?: (path: string | URL, data: DenoiseWorkerData) => DenoiseWorkerHandle
}

interface Pending {
  kind: 'job' | 'preview'
  resolve: (result: DenoiseResult | DenoisePreviewResult) => void
  reject: (error: Error) => void
}

/**
 * Owns the denoise worker and the queue in front of it.
 *
 * The worker is started once, on the first call, and kept for the life of the
 * process. Startup either resolves to a usable engine or to a reason the UI can
 * show; a missing model leaves the rest of the app untouched.
 */
export class DenoiseService {
  private readonly listeners = new Map<keyof DenoiseEvents, Set<(...args: never[]) => void>>()
  private readonly pending = new Map<string, Pending>()
  private readonly locateAssets: () => string
  private readonly executable: string
  private readonly workerPath: string | URL
  private readonly probeFile: (inputPath: string) => Promise<MediaMetadata>
  private readonly spawnWorker: (path: string | URL, data: DenoiseWorkerData) => DenoiseWorkerHandle

  private worker: DenoiseWorkerHandle | null = null
  private startup: Promise<DenoiseEngineInfo> | null = null
  private disposed = false

  constructor(dependencies: DenoiseServiceDependencies = {}) {
    const executable = dependencies.ffmpegPath ?? ffmpegBinary
    if (!executable) throw new Error('The bundled FFmpeg executable is unavailable')

    this.executable = unpackedBinaryPath(executable)
    // Resolved on first use, so a missing base disables the denoiser with a
    // readable reason instead of throwing while the app is still starting up.
    this.locateAssets = () => dependencies.assetDirectory
      ?? resolveAssetDirectory(dependencies.packaged ?? false, dependencies.resourcesPath, dependencies.appPath)
    // The worker is a second entry point of the main build, so it sits alongside it.
    this.workerPath = dependencies.workerPath ?? new URL('denoise-worker.js', import.meta.url)
    this.probeFile = dependencies.probe ?? ((inputPath) => probeMedia(inputPath))
    this.spawnWorker = dependencies.createWorker
      ?? ((path, data) => new Worker(path, { workerData: data }) as unknown as DenoiseWorkerHandle)
  }

  on<K extends keyof DenoiseEvents>(event: K, listener: DenoiseEvents[K]): () => void {
    let listeners = this.listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(event, listeners)
    }
    listeners.add(listener as (...args: never[]) => void)
    return () => { listeners?.delete(listener as (...args: never[]) => void) }
  }

  /** Starts loading the model so the first job does not pay for it. */
  warmUp(): void {
    void this.start().catch(() => undefined)
  }

  /** Whether denoising can run, and why not when it cannot. */
  async info(): Promise<DenoiseEngineInfo> {
    return await this.start()
  }

  isRunning(id: string): boolean {
    return this.pending.has(id)
  }

  /**
   * Denoises one file. Resolves with the written path, rejects with a
   * `DenoiseCancelledError` if the job is cancelled before it finishes.
   */
  async denoise(request: DenoiseRequest): Promise<DenoiseResult> {
    const media = await this.acceptJob(request.id, request.inputPath)
    const prepared: DenoiseRequest = {
      ...request,
      durationSeconds: request.durationSeconds ?? media.duration,
      options: clampOptions(request.options)
    }
    return await this.dispatch<DenoiseResult>(request.id, 'job', () => {
      this.post({ type: 'job', request: prepared, channels: resolveChannels(media) })
    })
  }

  /** Renders a short A/B excerpt: the same window untouched and denoised. */
  async preview(request: DenoisePreviewRequest): Promise<DenoisePreviewResult> {
    const media = await this.accept(request.id, request.inputPath)
    const windowSeconds = clamp(request.durationSeconds, 1, DENOISE_PREVIEW_MAX_SECONDS)
    // Starting past the end would hand back two empty files.
    const latestStart = media.duration === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, media.duration - 1)
    const prepared: DenoisePreviewRequest = {
      ...request,
      startSeconds: clamp(request.startSeconds, 0, latestStart),
      durationSeconds: windowSeconds,
      options: clampOptions(request.options)
    }
    return await this.dispatch<DenoisePreviewResult>(request.id, 'preview', () => {
      this.post({ type: 'preview', request: prepared, channels: resolveChannels(media) })
    })
  }

  cancel(id: string): boolean {
    if (!this.pending.has(id)) return false
    this.worker?.postMessage({ type: 'cancel', id })
    return true
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id)
  }

  /** Stops the worker for good. Called when the app is quitting. */
  dispose(): void {
    this.disposed = true
    this.cancelAll()
    this.worker?.terminate()
    this.worker = null
    this.startup = null
    this.failPending(new Error('The denoiser was shut down'))
  }

  /** Shared entry checks: the engine is up, the id is free, the file has audio. */
  private async accept(id: string, inputPath: string): Promise<MediaMetadata> {
    if (!id.trim()) throw new Error('Denoise id cannot be empty')
    const info = await this.start()
    if (!info.available) throw new Error(info.reason ?? 'Denoising is unavailable')
    if (this.pending.has(id)) throw new Error(`Denoise id "${id}" is already running`)

    const media = await this.probeFile(inputPath)
    resolveChannels(media)
    return media
  }

  /**
   * The same checks for a whole-file job, announced as an `error` event when they
   * fail. A job that never reaches the worker produces no worker event, and the
   * renderer learns about the outcome through events rather than the call.
   */
  private async acceptJob(id: string, inputPath: string): Promise<MediaMetadata> {
    try {
      return await this.accept(id, inputPath)
    } catch (cause) {
      // A rejected duplicate belongs to a job that is still running; reporting it
      // against that id would mislabel the job that is doing fine.
      if (!this.pending.has(id)) this.emit('error', id, toError(cause))
      throw cause
    }
  }

  private async dispatch<T extends DenoiseResult | DenoisePreviewResult>(
    id: string,
    kind: Pending['kind'],
    send: () => void
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, { kind, resolve: resolve as Pending['resolve'], reject })
      try {
        send()
      } catch (cause) {
        this.pending.delete(id)
        reject(toError(cause))
      }
    })
  }

  private post(message: DenoiseWorkerRequest): void {
    if (!this.worker) throw new Error('The denoise worker is not running')
    this.worker.postMessage(message)
  }

  private start(): Promise<DenoiseEngineInfo> {
    if (this.disposed) return Promise.resolve(unavailableInfo('The denoiser was shut down'))
    this.startup ??= this.launch()
    return this.startup
  }

  /**
   * Brings the worker up and waits for its verdict. The assets are checked here
   * first: it costs one `stat` each and produces a far better message than a
   * worker that fails to boot.
   */
  private async launch(): Promise<DenoiseEngineInfo> {
    let assetDirectory: string
    try {
      assetDirectory = this.locateAssets()
    } catch (cause) {
      return unavailableInfo(describe(cause))
    }

    const missing = await checkAssets(assetDirectory)
    if (missing) return unavailableInfo(missing)

    return await new Promise<DenoiseEngineInfo>((resolve) => {
      let settled = false
      const fail = (reason: string): void => {
        // A worker that died must not be reused; the next call starts a fresh one.
        this.worker = null
        this.startup = null
        if (settled) return
        settled = true
        resolve(unavailableInfo(reason))
      }

      let worker: DenoiseWorkerHandle
      try {
        worker = this.spawnWorker(this.workerPath, {
          assetDirectory,
          ffmpegPath: this.executable,
          options: DEFAULT_OPTIONS
        })
      } catch (cause) {
        fail(describe(cause))
        return
      }
      this.worker = worker

      worker.on('message', (event) => {
        if (event.type === 'ready') {
          if (settled) return
          settled = true
          resolve({ available: true, frameLength: event.frameLength, sampleRate: DENOISE_SAMPLE_RATE })
          return
        }
        if (event.type === 'unavailable') {
          fail(event.reason)
          return
        }
        this.handleEvent(event)
      })
      worker.on('error', (error) => {
        this.failPending(toError(error))
        fail(describe(error))
      })
      worker.on('exit', (code) => {
        if (this.disposed) return
        const reason = `The denoise worker stopped unexpectedly (exit code ${String(code)})`
        this.failPending(new Error(reason))
        fail(reason)
      })
    })
  }

  private handleEvent(event: DenoiseWorkerEvent): void {
    switch (event.type) {
      case 'progress':
        this.emit('progress', event.progress)
        break
      case 'done': {
        const pending = this.take(event.result.id)
        this.emit('complete', event.result)
        if (pending?.kind === 'job') pending.resolve(event.result)
        break
      }
      case 'preview': {
        const pending = this.take(event.result.id)
        if (pending?.kind === 'preview') pending.resolve(event.result)
        break
      }
      case 'cancelled': {
        const pending = this.take(event.id)
        this.emit('cancelled', event.id)
        pending?.reject(new DenoiseCancelledError(event.id))
        break
      }
      case 'failed': {
        const pending = this.take(event.id)
        const error = new Error(event.message)
        this.emit('error', event.id, error)
        pending?.reject(error)
        break
      }
      default:
        break
    }
  }

  private take(id: string): Pending | undefined {
    const pending = this.pending.get(id)
    this.pending.delete(id)
    return pending
  }

  private failPending(error: Error): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id)
      this.emit('error', id, error)
      pending.reject(error)
    }
  }

  private emit<K extends keyof DenoiseEvents>(event: K, ...args: Parameters<DenoiseEvents[K]>): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as unknown as (...values: Parameters<DenoiseEvents[K]>) => void)(...args)
    }
  }
}

function unavailableInfo(reason: string): DenoiseEngineInfo {
  return { available: false, frameLength: null, sampleRate: DENOISE_SAMPLE_RATE, reason }
}

/**
 * The model is mono, so a stereo file gets one state per side and anything wider
 * is downmixed by FFmpeg on the way in.
 */
function resolveChannels(media: MediaMetadata): number {
  if (!media.audioCodec) throw new Error('This file has no audio track to denoise')
  return Math.min(DENOISE_MAX_CHANNELS, Math.max(1, Math.trunc(media.audioChannels ?? 1)))
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}
