import { describe, expect, it } from 'vitest'
import { mapFFmpegError } from '../../electron/ffmpeg/errors'

describe('mapFFmpegError', () => {
  it.each([
    ['Invalid data found when processing input', 'invalid or corrupt'],
    ['Unknown encoder \'h264_magic\'', 'codec or encoder'],
    ['Permission denied', 'permission'],
    ['No space left on device', 'disk'],
    ['Output file #0 does not contain any stream', 'required media stream'],
    ['File already exists. Not overwriting - exiting', 'already exists'],
    ['Immediate exit requested', 'cancelled']
  ])('maps %s to a useful message', (stderr, expected) => {
    expect(mapFFmpegError(stderr).message.toLowerCase()).toContain(expected)
  })

  it('returns a safe bounded generic message without dumping raw stderr', () => {
    const raw = `private/path/token ${'x'.repeat(50_000)}`
    const error = mapFFmpegError(raw)

    expect(error.message).toContain('FFmpeg could not complete the conversion')
    expect(error.message).not.toContain('private/path/token')
    expect(error.message.length).toBeLessThan(300)
  })
})
