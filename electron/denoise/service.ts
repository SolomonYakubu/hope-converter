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
import { clamp, messageOf, toError } from '../utils/guards'
import { PINNED_ASSETS, checkAssets, resolveAssetDirectory, type PinnedAsset } from './assets'
import { clampOptions } from './engine'
import { DenoiseCancelledError } from './errors'
import type {
  DenoiseJobMessage,
  DenoisePreviewMessage,
  DenoiseWorkerData,
  DenoiseWorkerEvent,
  DenoiseWorkerRequest
} from './protocol'


/** Longest preview window offered, to keep the transferred WAVs small. */
export const DENOISE_PREVIEW_MAX_SECONDS = 20

/**
 * How long a job may go without a word from the worker before it is given up on.
 *
 * A running job reports progress on every FFmpeg progress line, and each one
 * refreshes this, so the limit is against silence rather than against duration —
 * a two-hour file is fine, a wedged worker is not. Without it a hang leaves the
 * row on "Cleaning" for as long as the app runs, with no way out but restarting.
 */
const DENOISE_JOB_SILENCE_LIMIT_MS = 120_000

/**
 * The same guard for a preview, which reports no progress at all: two short
 * FFmpeg runs and a few thousand frames, so this is a wide margin rather than a
 * deadline anyone should ever meet.
 */
const DENOISE_PREVIEW_LIMIT_MS = 180_000

/**
 * Seeds the model state a worker loads before it is given anything to do. Every
 * request calls `prepare` with its own settings before a frame is processed, and a
 * state that has processed nothing carries no trace of what it was created with,
 * so this only decides what `df_create` is handed while the engine is warming up.
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
  /**
   * The digests the assets are verified against. Only tests override it, standing
   * a few bytes in for the ~17 MB the shipped table pins; the check itself is the
   * same one a real run makes.
   */
  pinnedAssets?: readonly PinnedAsset[]
  /**
   * Overrides both stall limits above. Only tests set it, so the watchdog can be
   * watched working without waiting two minutes for it.
   */
  stallLimitMs?: number
}

interface Pending {
  id: string
  kind: 'job' | 'preview'
  message: DenoiseJobMessage | DenoisePreviewMessage
  resolve: (result: DenoiseResult | DenoisePreviewResult) => void
  reject: (error: Error) => void
  /** Resolves when the request has settled, so the queue can move on. */
  settled: Promise<void>
  finish: () => void
  /** Stall watchdog, armed when the request is handed over and refreshed by its progress. */
  timer: ReturnType<typeof setTimeout> | null
  /** The worker serving it, once it has one. */
  session: WorkerSession | null
  cancelled: boolean
}

/**
 * One worker thread, which serves at most one request.
 *
 * The model states inside a thread cannot be returned to their initial condition
 * (see `engine.ts`), so a thread is used once and terminated. `used` marks it as
 * spoken for, `retired` as gone — a retired thread's last messages may still be in
 * flight, and must not be allowed to settle anything.
 */
interface WorkerSession {
  worker: DenoiseWorkerHandle
  used: boolean
  retired: boolean
}

/** Whether the assets can be used, or the reason they cannot. */
type AssetVerdict = { directory: string, reason?: undefined } | { directory?: undefined, reason: string }

/**
 * Owns the denoise workers and the queue in front of them.
 *
 * One request runs at a time, in a thread of its own that is terminated when the
 * request settles. A loaded thread is kept standing by so nothing waits for the
 * model, and its replacement is started as soon as it is claimed — so in a queue
 * the next file's model load happens while the current file is being processed
 * rather than being added to it. At most two threads are alive at once.
 *
 * Startup either resolves to a usable engine or to a reason the UI can show; a
 * missing model leaves the rest of the app untouched.
 */
export class DenoiseService {
  private readonly listeners = new Map<keyof DenoiseEvents, Set<(...args: never[]) => void>>()
  private readonly pending = new Map<string, Pending>()
  private readonly queue: Pending[] = []
  private readonly locateAssets: () => string
  private readonly executable: string
  private readonly workerPath: string | URL
  private readonly probeFile: (inputPath: string) => Promise<MediaMetadata>
  private readonly spawnWorker: (path: string | URL, data: DenoiseWorkerData) => DenoiseWorkerHandle
  private readonly pinnedAssets: readonly PinnedAsset[]
  private readonly stallLimitMs?: number

  /** A loaded thread that has served nothing yet, waiting to be claimed. */
  private standby: WorkerSession | null = null
  private active: Pending | null = null
  private startup: Promise<DenoiseEngineInfo> | null = null
  private assetVerdict: Promise<AssetVerdict> | null = null
  private pumping = false
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
    this.pinnedAssets = dependencies.pinnedAssets ?? PINNED_ASSETS
    this.stallLimitMs = dependencies.stallLimitMs
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

  /** Starts loading the model so the first request does not pay for it. */
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
    return await this.dispatch<DenoiseResult>(request.id, 'job', {
      type: 'job', request: prepared, channels: resolveChannels(media)
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
    return await this.dispatch<DenoisePreviewResult>(request.id, 'preview', {
      type: 'preview', request: prepared, channels: resolveChannels(media)
    })
  }

  cancel(id: string): boolean {
    const pending = this.pending.get(id)
    if (!pending) return false
    pending.cancelled = true

    if (pending.session) {
      // The thread is mid-file: it is told to stop so it can shut FFmpeg down and
      // clear its partial output, rather than have the thread pulled from under it.
      pending.session.worker.postMessage({ type: 'cancel', id })
      return true
    }
    // Nothing has been handed over, so there is nothing to tell. A request that is
    // being handed over right now is answered by `serve`, which checks the flag.
    if (this.active !== pending) this.answerCancelled(pending)
    return true
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id)
  }

  /** Stops the workers for good. Called when the app is quitting. */
  dispose(): void {
    this.disposed = true
    this.retire(this.standby)
    this.standby = null
    this.retire(this.active?.session ?? null)
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

  /**
   * Queues a request. Only one runs at a time, and the queue is held here rather
   * than inside a worker: a worker serves one request and is then terminated, so a
   * queue kept inside one would be lost with it.
   */
  private async dispatch<T extends DenoiseResult | DenoisePreviewResult>(
    id: string,
    kind: Pending['kind'],
    message: DenoiseJobMessage | DenoisePreviewMessage
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      let finish = (): void => undefined
      const settled = new Promise<void>((done) => { finish = () => { done() } })
      this.pending.set(id, {
        id,
        kind,
        message,
        resolve: resolve as Pending['resolve'],
        reject,
        settled,
        finish,
        timer: null,
        session: null,
        cancelled: false
      })
      this.queue.push(this.pending.get(id) as Pending)
      void this.pump()
    })
  }

  /** Serves the queue one request at a time, each in a thread of its own. */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      let next = this.queue.shift()
      while (next) {
        // Anything cancelled or failed while it waited has already been answered.
        if (this.pending.get(next.id) === next) await this.serve(next)
        next = this.queue.shift()
      }
    } finally {
      this.pumping = false
    }
  }

  /**
   * Runs one request on the standby worker and retires that worker afterwards,
   * whether it finished, failed, was cancelled or wedged. Nothing else runs in the
   * meantime, so the thread it is given has processed nothing before it.
   */
  private async serve(pending: Pending): Promise<void> {
    const info = await this.start()
    if (this.disposed) {
      this.failRequest(pending, new Error('The denoiser was shut down'))
      return
    }
    if (!info.available) {
      this.failRequest(pending, new Error(info.reason ?? 'Denoising is unavailable'))
      return
    }

    const session = this.claim()
    if (!session) {
      this.failRequest(pending, new Error('The denoise worker is not running'))
      return
    }

    this.active = pending
    pending.session = session
    try {
      // A cancel can land in the gap between queueing and handing over, in which
      // case the worker never hears about the request at all.
      if (pending.cancelled) this.answerCancelled(pending)
      else {
        pending.timer = this.watch(pending.id, pending.kind)
        session.worker.postMessage(pending.message)
      }
      await pending.settled
    } finally {
      this.active = null
      this.retire(session)
    }
  }

  /**
   * Takes the standby worker and starts its replacement, so the next file's model
   * load runs while this one is being processed instead of before it.
   */
  private claim(): WorkerSession | null {
    const session = this.standby
    if (!session) return null
    session.used = true
    this.standby = null
    this.startup = null
    void this.start().catch(() => undefined)
    return session
  }

  /** Terminates a worker and stops listening to it. */
  private retire(session: WorkerSession | null): void {
    if (!session || session.retired) return
    session.retired = true
    session.worker.terminate()
  }

  /**
   * Arms the stall watchdog for one request. The worker serving it does its work in
   * a single thread and answers on one port, so silence past the limit means it is
   * wedged rather than busy — there is no third state to wait out.
   */
  private watch(id: string, kind: Pending['kind']): ReturnType<typeof setTimeout> {
    const limit = this.stallLimitMs
      ?? (kind === 'job' ? DENOISE_JOB_SILENCE_LIMIT_MS : DENOISE_PREVIEW_LIMIT_MS)
    const timer = setTimeout(() => this.stall(id), limit)
    // A watchdog must never be the reason the app refuses to quit.
    timer.unref?.()
    return timer
  }

  /** Restarts the timer for a request that has just been heard from. */
  private refresh(id: string): void {
    const pending = this.pending.get(id)
    if (!pending?.timer) return
    clearTimeout(pending.timer)
    pending.timer = this.watch(id, pending.kind)
  }

  /**
   * Gives up on a wedged worker. Only the silent request is failed: its thread is
   * retired by `serve` as it settles, and whatever is queued behind it is served on
   * a thread of its own, so one hang no longer costs the rest of the queue.
   */
  private stall(id: string): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.failRequest(pending, new Error('The denoiser stopped responding and was restarted'))
  }

  private start(): Promise<DenoiseEngineInfo> {
    if (this.disposed) return Promise.resolve(unavailableInfo('The denoiser was shut down'))
    this.startup ??= this.launch()
    return this.startup
  }

  /**
   * Brings a worker up, loads the model in it, and leaves it standing by.
   *
   * The assets are verified before the first one is spawned — present, the right
   * size, and hashing to their pinned digests — which produces a far better message
   * than a worker that fails to boot on a file that is not what it claims to be.
   * That verdict is kept, so replacing the worker per file does not mean hashing
   * ~17 MB per file: it stays one pass per app run.
   */
  private async launch(): Promise<DenoiseEngineInfo> {
    const assets = await this.verifyAssets()
    if (assets.reason !== undefined) return unavailableInfo(assets.reason)
    if (this.disposed) return unavailableInfo('The denoiser was shut down')

    return await new Promise<DenoiseEngineInfo>((resolve) => {
      const session: WorkerSession = { worker: null as unknown as DenoiseWorkerHandle, used: false, retired: false }
      let settled = false
      const fail = (reason: string): void => {
        // A worker that died must not be reused; the next call starts a fresh one.
        // Only an unclaimed one is the standby this `startup` stands for, though: a
        // claimed thread's death must not discard the promise its replacement is
        // already loading under, or the replacement would be spawned over and left
        // running with nobody holding it.
        if (!session.used) {
          if (this.standby === session) this.standby = null
          this.startup = null
        }
        if (settled) return
        settled = true
        resolve(unavailableInfo(reason))
      }

      try {
        session.worker = this.spawnWorker(this.workerPath, {
          assetDirectory: assets.directory,
          ffmpegPath: this.executable,
          options: DEFAULT_OPTIONS
        })
      } catch (cause) {
        fail(messageOf(cause))
        return
      }

      session.worker.on('message', (event) => {
        if (event.type === 'ready') {
          if (settled) return
          settled = true
          // A thread nobody holds a handle to would never be terminated, so an
          // earlier standby is retired rather than displaced.
          if (this.standby && this.standby !== session) this.retire(this.standby)
          this.standby = session
          // Quitting while the model was loading leaves a thread nobody will claim.
          if (this.disposed) this.retire(this.standby)
          resolve({ available: true, frameLength: event.frameLength, sampleRate: DENOISE_SAMPLE_RATE })
          return
        }
        if (event.type === 'unavailable') {
          fail(event.reason)
          return
        }
        this.handleEvent(session, event)
      })
      session.worker.on('error', (error) => {
        if (session.retired) return
        this.failSession(session, toError(error))
        fail(messageOf(error))
      })
      session.worker.on('exit', (code) => {
        if (session.retired || this.disposed) return
        const reason = `The denoise worker stopped unexpectedly (exit code ${String(code)})`
        this.failSession(session, new Error(reason))
        fail(reason)
      })
    })
  }

  /** Locates and verifies the assets once, for every worker this service starts. */
  private verifyAssets(): Promise<AssetVerdict> {
    this.assetVerdict ??= (async (): Promise<AssetVerdict> => {
      let directory: string
      try {
        directory = this.locateAssets()
      } catch (cause) {
        return { reason: messageOf(cause) }
      }
      const unusable = await checkAssets(directory, this.pinnedAssets)
      return unusable === null ? { directory } : { reason: unusable }
    })()
    return this.assetVerdict
  }

  /**
   * Answers whatever a dead worker was serving. Only that request is affected: a
   * thread serves one request, so nothing else was riding on it.
   */
  private failSession(session: WorkerSession, error: Error): void {
    const pending = this.active
    if (pending?.session !== session) return
    this.failRequest(pending, error)
  }

  private handleEvent(session: WorkerSession, event: DenoiseWorkerEvent): void {
    // Only the thread serving the active request may speak for it: a retired
    // thread's last message, or a standby that has been claimed since, must not
    // settle anything.
    if (session.retired || this.active?.session !== session) return

    switch (event.type) {
      case 'progress':
        // Proof of life as much as a percentage: it holds the watchdog off.
        this.refresh(event.progress.id)
        this.emit('progress', event.progress)
        break
      case 'done': {
        const pending = this.takeById(event.result.id)
        this.emit('complete', event.result)
        if (pending?.kind === 'job') pending.resolve(event.result)
        break
      }
      case 'preview': {
        const pending = this.takeById(event.result.id)
        if (pending?.kind === 'preview') pending.resolve(event.result)
        break
      }
      case 'cancelled': {
        const pending = this.takeById(event.id)
        this.emit('cancelled', event.id)
        pending?.reject(new DenoiseCancelledError(event.id))
        break
      }
      case 'failed': {
        const pending = this.takeById(event.id)
        const error = new Error(event.message)
        this.emit('error', event.id, error)
        pending?.reject(error)
        break
      }
      default:
        break
    }
  }

  /** Answers a request as cancelled without a worker having been involved. */
  private answerCancelled(pending: Pending): void {
    if (!this.settle(pending)) return
    this.emit('cancelled', pending.id)
    pending.reject(new DenoiseCancelledError(pending.id))
  }

  /**
   * Answers a request as failed. A preview is not a queue row, so it is answered
   * through its own rejection rather than announced as a file that failed to clean.
   */
  private failRequest(pending: Pending, error: Error): void {
    if (!this.settle(pending)) return
    if (pending.kind === 'job') this.emit('error', pending.id, error)
    pending.reject(error)
  }

  private takeById(id: string): Pending | undefined {
    const pending = this.pending.get(id)
    if (!pending || !this.settle(pending)) return undefined
    return pending
  }

  /**
   * Retires a request's bookkeeping exactly once, whatever answered it, and lets
   * `serve` move on. The identity check matters because a failed id can be queued
   * again straight away — a retry keeps its row's id — and a late message from the
   * first attempt must not settle the second.
   */
  private settle(pending: Pending): boolean {
    if (this.pending.get(pending.id) !== pending) return false
    this.pending.delete(pending.id)
    if (pending.timer) clearTimeout(pending.timer)
    const queued = this.queue.indexOf(pending)
    if (queued >= 0) this.queue.splice(queued, 1)
    pending.finish()
    return true
  }

  private failPending(error: Error): void {
    for (const pending of [...this.pending.values()]) this.failRequest(pending, error)
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
