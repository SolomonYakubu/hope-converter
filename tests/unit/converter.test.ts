import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  ConversionCancelledError,
  ConverterService,
  temporaryOutputPath
} from '../../electron/ffmpeg/converter'
import type { Spawn } from '../../electron/ffmpeg/probe'
import type { ConversionRequest } from '../../electron/types/conversion'

class FakeProcess extends EventEmitter {
  readonly stderr = new PassThrough()
  readonly stdout = null
  readonly stdin = null
  readonly kill = vi.fn(() => true)
}

const request: ConversionRequest = {
  id: 'job-1',
  inputPath: '/media/input.mov',
  outputPath: '/exports/output.mp4',
  durationSeconds: 10,
  options: { kind: 'video', videoCodec: 'libx264' }
}

function setup(platform: NodeJS.Platform = 'linux') {
  const child = new FakeProcess()
  const spawn = vi.fn(() => child as unknown as ChildProcess) as unknown as Spawn
  const rename = vi.fn(async () => undefined)
  const remove = vi.fn(async () => undefined)
  const service = new ConverterService({
    spawn,
    ffmpegPath: '/bundled/ffmpeg',
    probeDuration: vi.fn(async () => 10),
    rename: rename as never,
    remove: remove as never,
    cancelTimeoutMs: 5,
    platform
  })
  return { child, spawn, rename, remove, service }
}

async function waitForSpawn(spawn: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
}

describe('ConverterService', () => {
  it('reports progress and renames the completed part file', async () => {
    const { child, spawn, rename, service } = setup()
    const progress = vi.fn()
    const conversion = service.convert(request, { onProgress: progress })
    await waitForSpawn(spawn as never)

    expect(spawn).toHaveBeenCalledWith('/bundled/ffmpeg', expect.arrayContaining([
      '/media/input.mov', '/exports/output.part.mp4'
    ]), expect.objectContaining({ shell: false }))

    child.stderr.write('frame=20\nout_time_us=5000000\nspeed=2x\nprogress=continue\n')
    child.emit('close', 0, null)

    await expect(conversion).resolves.toEqual({ id: 'job-1', outputPath: '/exports/output.mp4' })
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1', percent: 50, speed: 2 }))
    expect(rename).toHaveBeenCalledWith('/exports/output.part.mp4', '/exports/output.mp4')
    expect(service.isRunning('job-1')).toBe(false)
  })

  it('rejects duplicate ids and cancels with SIGTERM', async () => {
    const { child, spawn, remove, service } = setup()
    const conversion = service.convert(request)
    await waitForSpawn(spawn as never)

    await expect(service.convert(request)).rejects.toThrow('already running')
    expect(service.cancel('job-1')).toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('close', null, 'SIGTERM')

    await expect(conversion).rejects.toBeInstanceOf(ConversionCancelledError)
    expect(remove).toHaveBeenCalledWith('/exports/output.part.mp4', { force: true })
  })

  it('pauses and resumes active jobs on supported platforms', async () => {
    const { child, spawn, service } = setup('darwin')
    const conversion = service.convert(request)
    await waitForSpawn(spawn as never)

    expect(service.pause('job-1')).toBe(true)
    expect(service.pause('job-1')).toBe(false)
    expect(child.kill).toHaveBeenCalledWith('SIGSTOP')
    expect(service.resume('job-1')).toBe(true)
    expect(service.resume('job-1')).toBe(false)
    expect(child.kill).toHaveBeenCalledWith('SIGCONT')

    child.emit('close', 0, null)
    await expect(conversion).resolves.toEqual({ id: 'job-1', outputPath: '/exports/output.mp4' })
  })

  it('rejects pause and resume when unsupported or inactive', async () => {
    const { child, spawn, service } = setup('win32')
    const conversion = service.convert(request)
    await waitForSpawn(spawn as never)

    expect(service.pause('job-1')).toBe(false)
    expect(service.resume('job-1')).toBe(false)
    expect(service.pause('missing')).toBe(false)
    expect(child.kill).not.toHaveBeenCalledWith('SIGSTOP')

    child.emit('close', 0, null)
    await conversion
  })

  it('continues a paused job before terminating it for cancellation', async () => {
    const { child, spawn, service } = setup('linux')
    const conversion = service.convert(request)
    await waitForSpawn(spawn as never)

    expect(service.pause('job-1')).toBe(true)
    expect(service.cancel('job-1')).toBe(true)
    expect(child.kill.mock.calls.slice(0, 3)).toEqual([
      ['SIGSTOP'],
      ['SIGCONT'],
      ['SIGTERM']
    ])
    child.emit('close', null, 'SIGTERM')

    await expect(conversion).rejects.toBeInstanceOf(ConversionCancelledError)
  })

  it('reports cancellation separately from conversion failures', async () => {
    const { child, spawn, service } = setup()
    const onCancelled = vi.fn()
    const onError = vi.fn()
    const conversion = service.convert(request, { onCancelled, onError })
    await waitForSpawn(spawn as never)

    service.cancel('job-1')
    child.emit('close', null, 'SIGTERM')

    await expect(conversion).rejects.toBeInstanceOf(ConversionCancelledError)
    expect(onCancelled).toHaveBeenCalledWith('job-1')
    expect(onError).not.toHaveBeenCalled()
  })

  it('maps a failing FFmpeg exit to a human readable error', async () => {
    const { child, spawn, service } = setup()
    const onError = vi.fn()
    const conversion = service.convert(request, { onError })
    await waitForSpawn(spawn as never)

    child.stderr.write('[mov,mp4] moov atom not found\n')
    child.emit('close', 1, null)

    await expect(conversion).rejects.toThrow('The input file is invalid or corrupt.')
    expect(onError).toHaveBeenCalledWith('job-1', expect.objectContaining({
      message: 'The input file is invalid or corrupt.'
    }))
  })

  it('preserves the media extension in temporary paths', () => {
    expect(temporaryOutputPath('/exports/movie.webm')).toBe('/exports/movie.part.webm')
    expect(temporaryOutputPath('/exports/output')).toBe('/exports/output.part')
  })
})
