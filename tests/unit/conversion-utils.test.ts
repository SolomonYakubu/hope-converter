import { describe, expect, it, vi } from 'vitest'
import { createInputFileFromDrop } from '../../src/utils/conversion'

function file(name: string, size = 1024): File {
  return { name, size } as File
}

describe('createInputFileFromDrop', () => {
  it('resolves a dropped file path through the Electron webUtils bridge', () => {
    const droppedFile = file('My Clip.MOV', 2048)
    const getPathForFile = vi.fn(() => '/Users/person/Videos/My Clip.MOV')

    expect(createInputFileFromDrop(droppedFile, getPathForFile)).toEqual({
      path: '/Users/person/Videos/My Clip.MOV',
      name: 'My Clip.MOV',
      size: 2048,
      kind: 'video'
    })
    expect(getPathForFile).toHaveBeenCalledWith(droppedFile)
  })

  it('rejects unsupported files and files without a local path', () => {
    expect(createInputFileFromDrop(file('archive.zip'), () => '/tmp/archive.zip')).toBeNull()
    expect(createInputFileFromDrop(file('audio.wav'), () => '')).toBeNull()
  })
})
