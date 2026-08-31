import { describe, expect, it } from 'vitest'
import { describeMetadata, formatDuration } from '../../src/utils/media-summary'

describe('formatDuration', () => {
  it('formats sub-hour durations as minutes and seconds', () => {
    expect(formatDuration(0.4)).toBe('0:00')
    expect(formatDuration(12.5)).toBe('0:13')
    expect(formatDuration(65)).toBe('1:05')
  })

  it('formats hour-long durations with an hour segment', () => {
    expect(formatDuration(3_725)).toBe('1:02:05')
  })

  it('ignores values that are not usable durations', () => {
    expect(formatDuration(-1)).toBeNull()
    expect(formatDuration(Number.NaN)).toBeNull()
  })
})

describe('describeMetadata', () => {
  it('summarizes video streams', () => {
    expect(describeMetadata('video', {
      duration: 65, width: 1920, height: 1080, videoCodec: 'h264', fps: 29.97, audioCodec: 'aac'
    })).toEqual(['1:05', '1920×1080', 'h264', '30 fps'])
  })

  it('summarizes audio streams', () => {
    expect(describeMetadata('audio', {
      duration: 212, audioCodec: 'aac', audioSampleRate: 48_000, audioChannels: 2
    })).toEqual(['3:32', 'aac', '48 kHz', 'Stereo'])
    expect(describeMetadata('audio', { audioChannels: 1 })).toEqual(['Mono'])
  })

  it('summarizes images without a duration', () => {
    expect(describeMetadata('image', {
      width: 4032, height: 3024, videoCodec: 'mjpeg', duration: 0.04
    })).toEqual(['4032×3024', 'mjpeg'])
  })

  it('returns nothing when metadata is empty', () => {
    expect(describeMetadata('video', {})).toEqual([])
  })
})
