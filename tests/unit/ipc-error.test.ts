import { describe, expect, it } from 'vitest'
import { cleanIpcErrorMessage, describeIpcError } from '../../electron/utils/ipc-error'

describe('cleanIpcErrorMessage', () => {
  it('strips the Electron remote method wrapper and error name prefixes', () => {
    expect(cleanIpcErrorMessage("Error invoking remote method 'convert-file': Error: Unsupported input file type"))
      .toBe('Unsupported input file type')
    expect(cleanIpcErrorMessage('Error: Error: The destination disk does not have enough free space.'))
      .toBe('The destination disk does not have enough free space.')
  })

  it('leaves already readable messages untouched', () => {
    expect(cleanIpcErrorMessage('The input file is invalid or corrupt.'))
      .toBe('The input file is invalid or corrupt.')
  })

  it('falls back when nothing readable remains', () => {
    expect(cleanIpcErrorMessage("Error invoking remote method 'cancel-conversion': Error:"))
      .toBe('Hope Converter could not complete that request.')
    expect(cleanIpcErrorMessage('   ')).toBe('Hope Converter could not complete that request.')
  })
})

describe('describeIpcError', () => {
  it('returns an Error carrying the cleaned message', () => {
    const error = describeIpcError(new Error("Error invoking remote method 'pick-input-files': Error: Unsupported input file type"))
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('Unsupported input file type')
  })

  it('describes non-Error rejection values', () => {
    expect(describeIpcError('plain failure').message).toBe('plain failure')
    expect(describeIpcError(undefined).message).toBe('Hope Converter could not complete that request.')
  })
})
