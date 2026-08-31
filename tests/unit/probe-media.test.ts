import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { probeDuration, probeMedia } from '../../electron/ffmpeg/probe'
import type { Spawn } from '../../electron/ffmpeg/probe'

class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = null
}

function fakeSpawn(stdout: string, code = 0): Spawn {
  return vi.fn((_command, _args, options) => {
    const child = new FakeProcess()
    queueMicrotask(() => {
      child.stdout.end(stdout)
      child.emit('close', code, null)
    })
    expect(options).toMatchObject({ shell: false })
    return child as unknown as ChildProcess
  }) as unknown as Spawn
}

const ffprobeJson = JSON.stringify({
  format: { duration: '12.5', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
    { codec_type: 'video', codec_name: 'mjpeg', width: 320, height: 180, avg_frame_rate: '0/0' },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }
  ]
})

describe('probeMedia', () => {
  it('parses format and primary stream metadata from ffprobe JSON', async () => {
    await expect(probeMedia('/media/input.mp4', {
      spawn: fakeSpawn(ffprobeJson),
      ffprobePath: '/ffprobe'
    })).resolves.toEqual({
      duration: 12.5,
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      fps: 30000 / 1001,
      audioSampleRate: 48000,
      audioChannels: 2
    })
  })

  it('safely omits malformed and zero-denominator numeric values', async () => {
    const data = JSON.stringify({
      format: { duration: 'unknown', format_name: 'matroska,webm' },
      streams: [{
        codec_type: 'video', codec_name: 'vp9', width: -1, height: '720', avg_frame_rate: '25/0'
      }]
    })

    await expect(probeMedia('/media/input.webm', {
      spawn: fakeSpawn(data),
      ffprobePath: '/ffprobe'
    })).resolves.toEqual({ container: 'matroska,webm', videoCodec: 'vp9' })
  })

  it('keeps probeDuration compatibility through rich probing', async () => {
    await expect(probeDuration('/media/input.mp4', {
      spawn: fakeSpawn(ffprobeJson),
      ffprobePath: '/ffprobe'
    })).resolves.toBe(12.5)
  })

  it('rejects invalid ffprobe JSON', async () => {
    await expect(probeMedia('/media/input.mp4', {
      spawn: fakeSpawn('not json'),
      ffprobePath: '/ffprobe'
    })).rejects.toThrow('valid JSON')
  })
})
