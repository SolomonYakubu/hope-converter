import { spawn } from 'node:child_process'
import { rename, rm } from 'node:fs/promises'
import { extname } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import type { ChildProcess } from 'node:child_process'
import type {
  ConversionProgress,
  ConversionRequest,
  ConversionResult
} from '../types/conversion'
import { toError } from '../utils/guards'
import { unpackedBinaryPath } from './binary-path'
import { buildFFmpegArgs } from './command-builder'
import { mapFFmpegError } from './errors'
import { parseProgressBlock } from './progress'
import { probeDuration, type Spawn } from './probe'

export class ConversionCancelledError extends Error {
  constructor(id: string) {
    super(`Conversion ${id} was cancelled`)
    this.name = 'ConversionCancelledError'
  }
}

export interface ConversionCallbacks {
  onProgress?: (progress: ConversionProgress) => void
  onComplete?: (result: ConversionResult) => void
  onCancelled?: (id: string) => void
  onError?: (id: string, error: Error) => void
}

type ConverterEvents = {
  progress: (progress: ConversionProgress) => void
  complete: (result: ConversionResult) => void
  cancelled: (id: string) => void
  error: (id: string, error: Error) => void
}

export interface ConverterDependencies {
  spawn?: Spawn
  ffmpegPath?: string
  probeDuration?: (inputPath: string) => Promise<number>
  rename?: typeof rename
  remove?: typeof rm
  cancelTimeoutMs?: number
  platform?: NodeJS.Platform
}

interface Job {
  request: ConversionRequest
  callbacks: ConversionCallbacks
  child: ChildProcess | null
  cancelled: boolean
  paused: boolean
  settled: boolean
  killTimer?: ReturnType<typeof setTimeout>
}

const MAX_ERROR_OUTPUT = 16_384

export class ConverterService {
  private readonly jobs = new Map<string, Job>()
  private readonly listeners = new Map<keyof ConverterEvents, Set<(...args: never[]) => void>>()
  private readonly spawnProcess: Spawn
  private readonly executable: string
  private readonly getDuration: (inputPath: string) => Promise<number>
  private readonly renameFile: typeof rename
  private readonly removeFile: typeof rm
  private readonly cancelTimeoutMs: number
  private readonly platform: NodeJS.Platform

  constructor(dependencies: ConverterDependencies = {}) {
    const executable = dependencies.ffmpegPath ?? ffmpegPath
    if (!executable) throw new Error('The bundled FFmpeg executable is unavailable')

    this.executable = unpackedBinaryPath(executable)
    this.spawnProcess = dependencies.spawn ?? spawn
    this.getDuration = dependencies.probeDuration ?? probeDuration
    this.renameFile = dependencies.rename ?? rename
    this.removeFile = dependencies.remove ?? rm
    this.cancelTimeoutMs = dependencies.cancelTimeoutMs ?? 2_000
    this.platform = dependencies.platform ?? process.platform
  }

  on<K extends keyof ConverterEvents>(event: K, listener: ConverterEvents[K]): () => void {
    let listeners = this.listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(event, listeners)
    }
    listeners.add(listener as (...args: never[]) => void)
    return () => { listeners?.delete(listener as (...args: never[]) => void) }
  }

  isRunning(id: string): boolean {
    return this.jobs.has(id)
  }

  convert(request: ConversionRequest, callbacks: ConversionCallbacks = {}): Promise<ConversionResult> {
    if (!request.id.trim()) return Promise.reject(new Error('Conversion id cannot be empty'))
    if (this.jobs.has(request.id)) return Promise.reject(new Error(`Conversion id "${request.id}" is already running`))

    // Validate all command options synchronously before reserving resources.
    buildFFmpegArgs(request.inputPath, temporaryOutputPath(request.outputPath), request.options)

    const job: Job = { request, callbacks, child: null, cancelled: false, paused: false, settled: false }
    this.jobs.set(request.id, job)
    return this.run(job)
  }

  pause(id: string): boolean {
    const job = this.jobs.get(id)
    if (!this.supportsProcessSuspension() || !job?.child || job.settled || job.cancelled || job.paused) return false
    if (!job.child.kill('SIGSTOP')) return false
    job.paused = true
    return true
  }

  resume(id: string): boolean {
    const job = this.jobs.get(id)
    if (!this.supportsProcessSuspension() || !job?.child || job.settled || job.cancelled || !job.paused) return false
    if (!job.child.kill('SIGCONT')) return false
    job.paused = false
    return true
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job || job.settled) return false

    job.cancelled = true
    if (job.child) {
      if (job.paused) {
        job.child.kill('SIGCONT')
        job.paused = false
      }
      job.child.kill('SIGTERM')
      job.killTimer = setTimeout(() => {
        if (!job.settled) job.child?.kill('SIGKILL')
      }, this.cancelTimeoutMs)
      job.killTimer.unref?.()
    }
    return true
  }

  cancelAll(): void {
    for (const id of this.jobs.keys()) this.cancel(id)
  }

  private supportsProcessSuspension(): boolean {
    return this.platform === 'darwin' || this.platform === 'linux'
  }

  private async run(job: Job): Promise<ConversionResult> {
    const { request } = job
    const partPath = temporaryOutputPath(request.outputPath)

    try {
      await this.removeFile(partPath, { force: true })
      const duration = validDuration(request.durationSeconds)
        ? request.durationSeconds
        : await this.getDuration(request.inputPath).catch(() => 0)

      if (job.cancelled) throw new ConversionCancelledError(request.id)

      const args = buildFFmpegArgs(request.inputPath, partPath, request.options)
      await this.runProcess(job, args, duration)
      if (job.cancelled) throw new ConversionCancelledError(request.id)

      await this.renameFile(partPath, request.outputPath)
      const result = { id: request.id, outputPath: request.outputPath }
      job.callbacks.onComplete?.(result)
      this.emit('complete', result)
      return result
    } catch (cause) {
      const error = job.cancelled && !(cause instanceof ConversionCancelledError)
        ? new ConversionCancelledError(request.id)
        : toError(cause)
      await this.removeFile(partPath, { force: true }).catch(() => undefined)
      // A cancellation is a user decision, not a failure to report as one.
      if (error instanceof ConversionCancelledError) {
        job.callbacks.onCancelled?.(request.id)
        this.emit('cancelled', request.id)
      } else {
        job.callbacks.onError?.(request.id, error)
        this.emit('error', request.id, error)
      }
      throw error
    } finally {
      job.settled = true
      if (job.killTimer) clearTimeout(job.killTimer)
      this.jobs.delete(request.id)
    }
  }

  private async runProcess(job: Job, args: string[], duration: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let completed = false
      let lineBuffer = ''
      let progressBlock = ''
      let errorOutput = ''

      const settle = (error?: Error): void => {
        if (completed) return
        completed = true
        if (error) reject(error)
        else resolve()
      }

      try {
        job.child = this.spawnProcess(this.executable, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe']
        })
      } catch (cause) {
        settle(toError(cause))
        return
      }

      job.child.stderr?.setEncoding('utf8')
      job.child.stderr?.on('data', (chunk: string) => {
        errorOutput = `${errorOutput}${chunk}`.slice(-MAX_ERROR_OUTPUT)
        lineBuffer += chunk
        let newline = lineBuffer.indexOf('\n')
        while (newline >= 0) {
          const line = lineBuffer.slice(0, newline).replace(/\r$/, '')
          lineBuffer = lineBuffer.slice(newline + 1)
          progressBlock += `${line}\n`
          if (line.startsWith('progress=')) {
            const progress = { id: job.request.id, ...parseProgressBlock(progressBlock, duration) }
            job.callbacks.onProgress?.(progress)
            this.emit('progress', progress)
            progressBlock = ''
          }
          newline = lineBuffer.indexOf('\n')
        }
      })
      job.child.once('error', (cause) => settle(toError(cause)))
      job.child.once('close', (code, signal) => {
        job.child = null
        if (job.cancelled) {
          settle(new ConversionCancelledError(job.request.id))
        } else if (code === 0) {
          settle()
        } else {
          settle(mapFFmpegError(errorOutput))
        }
      })
    })
  }

  private emit<K extends keyof ConverterEvents>(event: K, ...args: Parameters<ConverterEvents[K]>): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as unknown as (...values: Parameters<ConverterEvents[K]>) => void)(...args)
    }
  }
}

export function temporaryOutputPath(outputPath: string): string {
  const extension = extname(outputPath)
  if (!extension) return `${outputPath}.part`
  return `${outputPath.slice(0, -extension.length)}.part${extension}`
}

function validDuration(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}
