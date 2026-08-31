import { describe, expect, it } from 'vitest'
import { createConversionStore } from '../../src/stores/conversion-store'
import { RENDERER_SETTINGS_KEY, type StorageLike } from '../../src/stores/settings-persistence'
import { createConversionOptions, createOutputPath } from '../../src/utils/conversion'
import type { InputFile } from '../../src/types/hope-converter'

const video: InputFile = { path: '/media/demo.mov', name: 'demo.mov', size: 1_572_864, kind: 'video' }

describe('conversion store', () => {
  it('adds local files once and initializes queue state', () => {
    const store = createConversionStore()
    store.getState().addFiles([video, video, { ...video, path: '', name: 'missing.mov' }])

    expect(store.getState().items).toHaveLength(1)
    expect(store.getState().items[0]).toMatchObject({ ...video, status: 'queued', progress: 0 })
    expect(store.getState().performanceMode).toBe(true)

    store.getState().setPerformanceMode(false)
    expect(store.getState().performanceMode).toBe(false)
  })

  it('clamps progress and completes an item with its output path', () => {
    const store = createConversionStore()
    store.getState().addFiles([video])
    const id = store.getState().items[0].id

    store.getState().updateProgress({ id, frame: 12, timeSeconds: 1, percent: 125, speed: 1, state: 'continue' })
    expect(store.getState().items[0]).toMatchObject({ status: 'converting', progress: 100 })

    store.getState().completeItem(id, '/exports/demo-converted.mp4')
    expect(store.getState().items[0]).toMatchObject({ status: 'completed', progress: 100, outputPath: '/exports/demo-converted.mp4' })
  })

  it('hydrates settings, defaults concurrency to two, and never persists queue jobs', () => {
    let stored = JSON.stringify({
      version: 1,
      settings: {
        quality: 'small',
        formats: { video: 'webm', audio: 'wav', image: 'png' },
        outputDirectory: '/saved',
        performanceMode: false,
        concurrency: 3
      }
    })
    const storage: StorageLike = {
      getItem: (key) => key === RENDERER_SETTINGS_KEY ? stored : null,
      setItem: (_key, value) => { stored = value }
    }
    const store = createConversionStore(storage)

    expect(store.getState()).toMatchObject({ quality: 'small', outputDirectory: '/saved', performanceMode: false, concurrency: 3 })
    store.getState().addFiles([video])
    store.getState().setConcurrency(4)
    expect(JSON.parse(stored)).toMatchObject({ version: 1, settings: { concurrency: 4 } })
    expect(stored).not.toContain('demo.mov')

    expect(createConversionStore(null).getState().concurrency).toBe(2)
  })

  it('tracks queue and individual pause state without losing progress', () => {
    const store = createConversionStore(null)
    store.getState().addFiles([video])
    const id = store.getState().items[0].id
    store.getState().setStatus(id, 'converting')
    store.getState().updateProgress({ id, frame: 12, timeSeconds: 1, percent: 42, speed: 1, state: 'continue' })
    store.getState().setStatus(id, 'paused')
    store.getState().updateProgress({ id, frame: 13, timeSeconds: 2, percent: 43, speed: 1, state: 'continue' })
    store.getState().setQueuePaused(true)

    expect(store.getState().queuePaused).toBe(true)
    expect(store.getState().items[0]).toMatchObject({ status: 'paused', progress: 43 })
    store.getState().setStatus(id, 'cancelled')
    expect(store.getState().items[0].status).toBe('cancelled')
  })

  it('attaches probed metadata to queued items and ignores unknown ids', () => {
    const store = createConversionStore(null)
    store.getState().addFiles([video])
    const id = store.getState().items[0].id

    store.getState().setMetadata(id, { duration: 42, width: 1920, height: 1080, videoCodec: 'h264' })
    expect(store.getState().items[0].metadata).toEqual({ duration: 42, width: 1920, height: 1080, videoCodec: 'h264' })

    expect(() => store.getState().setMetadata('missing', { duration: 1 })).not.toThrow()
    expect(store.getState().items).toHaveLength(1)
  })

  it('clears terminal items without removing active work', () => {
    const store = createConversionStore()
    store.getState().addFiles([video, { ...video, path: '/media/song.wav', name: 'song.wav', kind: 'audio' }])
    const [finished, active] = store.getState().items
    store.getState().setStatus(finished.id, 'error', 'Failed')
    store.getState().setStatus(active.id, 'converting')

    store.getState().clearFinished()
    expect(store.getState().items.map((item) => item.id)).toEqual([active.id])
  })
})

describe('conversion request helpers', () => {
  it('creates portable output paths', () => {
    expect(createOutputPath(video, '/exports/', 'mp4')).toBe('/exports/demo-converted.mp4')
    expect(createOutputPath(video, 'C:\\Exports', 'webm')).toBe('C:\\Exports\\demo-converted.webm')
  })

  it('maps media format and quality to typed FFmpeg options', () => {
    const formats = { video: 'webm', audio: 'flac', image: 'webp' } as const
    expect(createConversionOptions('video', formats, 'high')).toMatchObject({ kind: 'video', videoCodec: 'libvpx-vp9', crf: 18 })
    expect(createConversionOptions('audio', formats, 'balanced')).toEqual({ kind: 'audio', audioCodec: 'flac', sampleRate: 48_000, channels: 2 })
    expect(createConversionOptions('image', formats, 'small')).toEqual({ kind: 'image', format: 'webp', quality: 70, keepAspectRatio: true })
  })

  it('uses a compatible hardware encoder only when performance mode is enabled', () => {
    const formats = { video: 'mp4', audio: 'mp3', image: 'jpg' } as const
    expect(createConversionOptions('video', formats, 'balanced', 'h264_videotoolbox', true))
      .toMatchObject({ videoCodec: 'h264_videotoolbox', crf: 23 })
    expect(createConversionOptions('video', formats, 'balanced', 'h264_videotoolbox', false))
      .toMatchObject({ videoCodec: 'libx264' })

    const webmFormats = { ...formats, video: 'webm' } as const
    expect(createConversionOptions('video', webmFormats, 'balanced', 'h264_videotoolbox', true))
      .toMatchObject({ videoCodec: 'libvpx-vp9' })
  })
})
