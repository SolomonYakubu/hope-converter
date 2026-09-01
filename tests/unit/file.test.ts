import { describe, expect, it } from 'vitest'
import { createOutputPath } from '../../electron/utils/file'

describe('createOutputPath', () => {
  it('creates an output path without duplicating the original extension', () => {
    expect(createOutputPath('/media/My Clip.final.mov', '/exports', 'mp4'))
      .toBe('/exports/My Clip.final-converted.mp4')
  })

  it('sanitizes invalid filename characters in generated output names', () => {
    expect(createOutputPath('/media/interview.mov', '/exports', 'mp4', 'take: 1 / final'))
      .toBe('/exports/take- 1 - final.mp4')
  })
})
