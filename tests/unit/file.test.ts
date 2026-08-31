import { describe, expect, it } from 'vitest'
import { classifyMedia, createOutputPath, isSupportedInput } from '../../electron/utils/file'

describe('file utilities', () => {
  it.each([
    ['movie.MOV', 'video'],
    ['recording.flac', 'audio'],
    ['portrait.HEIC', 'image']
  ] as const)('classifies %s as %s', (file, expected) => {
    expect(classifyMedia(file)).toBe(expected)
    expect(isSupportedInput(file)).toBe(true)
  })

  it('rejects unsupported and extensionless files', () => {
    expect(classifyMedia('archive.zip')).toBeNull()
    expect(isSupportedInput('README')).toBe(false)
  })

  it('creates an output path without duplicating the original extension', () => {
    expect(createOutputPath('/media/My Clip.final.mov', '/exports', 'mp4'))
      .toBe('/exports/My Clip.final-converted.mp4')
  })

  it('sanitizes invalid filename characters in generated output names', () => {
    expect(createOutputPath('/media/interview.mov', '/exports', 'mp4', 'take: 1 / final'))
      .toBe('/exports/take- 1 - final.mp4')
  })
})
