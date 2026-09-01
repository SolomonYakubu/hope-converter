import { describe, expect, it } from 'vitest'
import { classifyMedia, isSupportedInput } from '../../electron/utils/media-kind'

describe('media kinds', () => {
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

  // The renderer classifies a bare `File.name`, the main process a full path, and both
  // must reach the same verdict or a file becomes droppable but unconvertible.
  it('reads the extension off a full path the same way it reads a bare name', () => {
    expect(classifyMedia('/Users/person/My Videos/clip.final.mp4')).toBe('video')
    expect(classifyMedia('C:\\Users\\person\\My Videos\\clip.final.mp4')).toBe('video')
    expect(classifyMedia('/Users/person/audio.wav/notes')).toBeNull()
  })

  // `extname` calls a name that is nothing but an extension a hidden file, and so does
  // this: `.mp4` is a dotfile, not a video, on whichever side of the bridge it arrives.
  it('treats a name that is only an extension as a hidden file', () => {
    expect(classifyMedia('.mp4')).toBeNull()
    expect(classifyMedia('/Users/person/.flac')).toBeNull()
    expect(classifyMedia('clip.')).toBeNull()
  })
})
