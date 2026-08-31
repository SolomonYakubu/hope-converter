import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { detectHardwareEncoders, getFFmpegVersion } from '../../electron/ffmpeg/hardware'
import type { Spawn } from '../../electron/ffmpeg/probe'

class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = null
}

function fakeSpawn(output: string): Spawn {
  return vi.fn(() => {
    const child = new FakeProcess()
    queueMicrotask(() => {
      child.stdout.end(output)
      child.emit('close', 0, null)
    })
    return child as unknown as ChildProcess
  }) as unknown as Spawn
}

describe('FFmpeg hardware detection', () => {
  it('returns only supported hardware encoders in preference order', async () => {
    const spawn = fakeSpawn([
      'Encoders:',
      ' V..... h264_nvenc NVIDIA NVENC H.264 encoder',
      ' V..... libx264 libx264 H.264 encoder',
      ' V..... h264_videotoolbox VideoToolbox H.264 Encoder'
    ].join('\n'))

    await expect(detectHardwareEncoders({ spawn, ffmpegPath: '/ffmpeg' })).resolves.toEqual({
      encoders: ['h264_videotoolbox', 'h264_nvenc'],
      preferredEncoder: 'h264_videotoolbox'
    })
    expect(spawn).toHaveBeenCalledWith('/ffmpeg', ['-hide_banner', '-encoders'], expect.objectContaining({ shell: false }))
  })

  it('reads the FFmpeg version without invoking a shell', async () => {
    const spawn = fakeSpawn('ffmpeg version 7.1-static Copyright FFmpeg developers\nconfiguration: test')
    await expect(getFFmpegVersion({ spawn, ffmpegPath: '/ffmpeg' }))
      .resolves.toBe('ffmpeg version 7.1-static Copyright FFmpeg developers')
  })
})
