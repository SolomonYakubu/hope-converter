import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ConverterService } from '../../electron/ffmpeg/converter'
import { probeMedia } from '../../electron/ffmpeg/probe'

let workspace = ''
const source = () => join(workspace, 'tone.wav')
const videoSource = () => join(workspace, 'clip.mp4')

async function runFFmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath as string, args, { shell: false, stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${String(code)}`)))
  })
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'hope-integration-'))
  await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', source()])
  // Small but slow to re-encode: enough frames that a pause is observable
  // without spending a minute of wall clock on the suite.
  await runFFmpeg([
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=480x360:rate=24:duration=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', videoSource()
  ])
}, 120_000)

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

describe('real FFmpeg integration', () => {
  it('probes rich metadata from a real file', async () => {
    const metadata = await probeMedia(source())
    expect(metadata.duration).toBeCloseTo(6, 1)
    expect(metadata.audioCodec).toBe('pcm_s16le')
    expect(metadata.audioSampleRate).toBe(44_100)
    expect(metadata.audioChannels).toBe(1)
    expect(metadata.container).toContain('wav')
  })

  it('pauses, resumes, and completes a real conversion', async () => {
    const service = new ConverterService()
    const outputPath = join(workspace, 'clip-converted.mp4')
    const cancelled: string[] = []
    const errors: string[] = []
    const percents: number[] = []

    const conversion = service.convert({
      id: 'integration-1',
      inputPath: videoSource(),
      outputPath,
      options: { kind: 'video', videoCodec: 'libx265', crf: 22, preset: 'slow', audioCodec: 'aac' }
    }, {
      onProgress: ({ percent }) => percents.push(percent),
      onCancelled: (id) => cancelled.push(id),
      onError: (_id, error) => errors.push(error.message)
    })

    await vi.waitFor(() => expect(percents.length).toBeGreaterThan(0), { timeout: 20_000 })
    expect(service.pause('integration-1')).toBe(true)
    const pausedAt = percents.length
    await new Promise((resolve) => setTimeout(resolve, 500))
    // A suspended FFmpeg process cannot emit new progress blocks.
    expect(percents.length).toBe(pausedAt)
    expect(service.resume('integration-1')).toBe(true)

    await expect(conversion).resolves.toMatchObject({ outputPath })
    expect((await stat(outputPath)).size).toBeGreaterThan(1_000)
    expect(cancelled).toEqual([])
    expect(errors).toEqual([])

    const converted = await probeMedia(outputPath)
    expect(converted.videoCodec).toBe('hevc')
    expect(converted.width).toBe(480)
    expect(converted.height).toBe(360)
  }, 180_000)

  it('reports a friendly message for an unreadable input', async () => {
    const service = new ConverterService()
    const messages: string[] = []
    await expect(service.convert({
      id: 'integration-2',
      inputPath: join(workspace, 'tone.wav'),
      outputPath: join(workspace, 'broken.mp4'),
      options: { kind: 'video', videoCodec: 'libx264' }
    }, { onError: (_id, error) => messages.push(error.message) })).rejects.toThrow()
    expect(messages[0]).toMatch(/input|stream|codec|FFmpeg could not complete/i)
  }, 60_000)
})
