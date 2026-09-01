import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MODEL_FILENAME,
  WASM_FILENAME,
  checkAssets,
  loadAssets,
  resolveAssetDirectory
} from '../../electron/denoise/assets'
import { clampOptions } from '../../electron/denoise/engine'
import { DENOISE_MAX_SPEECH_GAIN_DB } from '../../electron/types/denoise'

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hope-denoise-assets-'))
})

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('resolveAssetDirectory', () => {
  it('reads a packaged build from beside the app rather than inside the asar', () => {
    expect(resolveAssetDirectory(true, '/Applications/Hope.app/Contents/Resources'))
      .toBe(join('/Applications/Hope.app/Contents/Resources', 'deepfilternet3'))
  })

  it('resolves the checkout copy from the application path during development', () => {
    expect(resolveAssetDirectory(false, undefined, '/Users/someone/projects/hopeconverter'))
      .toBe(join('/Users/someone/projects/hopeconverter', 'resources', 'deepfilternet3'))
  })

  it('refuses to guess either base, since a wrong guess only looks like a missing model', () => {
    expect(() => resolveAssetDirectory(true)).toThrow(/must provide a resources path/)
    expect(() => resolveAssetDirectory(false)).toThrow(/must provide the application path/)
  })
})

describe('checkAssets', () => {
  it('passes when both files are present and non-empty', async () => {
    await writeFile(join(directory, WASM_FILENAME), 'wasm')
    await writeFile(join(directory, MODEL_FILENAME), 'model')
    expect(await checkAssets(directory)).toBeNull()
  })

  it('names the missing file and how to get it', async () => {
    const reason = await checkAssets(directory)
    expect(reason).toContain(WASM_FILENAME)
    expect(reason).toContain(directory)
    expect(reason).toContain('npm run fetch:models')
  })

  it('reports a half-finished download rather than letting the worker fail on it', async () => {
    await writeFile(join(directory, WASM_FILENAME), 'wasm')
    await writeFile(join(directory, MODEL_FILENAME), '')
    expect(await checkAssets(directory)).toMatch(new RegExp(`${MODEL_FILENAME} is empty`))
  })
})

describe('loadAssets', () => {
  it('returns both files as bytes', async () => {
    await writeFile(join(directory, WASM_FILENAME), 'wasm-bytes')
    await writeFile(join(directory, MODEL_FILENAME), 'model-bytes')

    const assets = await loadAssets(directory)
    expect(Buffer.from(assets.wasm).toString()).toBe('wasm-bytes')
    expect(Buffer.from(assets.model).toString()).toBe('model-bytes')
  })

  it('throws the same reason the check reports', async () => {
    await expect(loadAssets(directory)).rejects.toThrow(/npm run fetch:models/)
  })
})

describe('clampOptions', () => {
  /** The level stage's own defaults, so each case names only what it is testing. */
  const level = { speechGainDb: 0, normalizeLoudness: false }

  it('keeps values that are already in range', () => {
    expect(clampOptions({ attenuationLimitDb: 60, postFilterBeta: 0.02, speechGainDb: 12, normalizeLoudness: true }))
      .toEqual({ attenuationLimitDb: 60, postFilterBeta: 0.02, speechGainDb: 12, normalizeLoudness: true })
  })

  it('clamps both settings to what the model accepts', () => {
    expect(clampOptions({ attenuationLimitDb: 140, postFilterBeta: 1, ...level }))
      .toEqual({ attenuationLimitDb: 100, postFilterBeta: 0.05, ...level })
    expect(clampOptions({ attenuationLimitDb: -20, postFilterBeta: -1, ...level }))
      .toEqual({ attenuationLimitDb: 0, postFilterBeta: 0, ...level })
  })

  it('clamps the speech lift to the offered range', () => {
    expect(clampOptions({ attenuationLimitDb: 60, postFilterBeta: 0, speechGainDb: 40, normalizeLoudness: false }))
      .toEqual({ attenuationLimitDb: 60, postFilterBeta: 0, speechGainDb: DENOISE_MAX_SPEECH_GAIN_DB, normalizeLoudness: false })
    expect(clampOptions({ attenuationLimitDb: 60, postFilterBeta: 0, speechGainDb: -6, normalizeLoudness: false }))
      .toEqual({ attenuationLimitDb: 60, postFilterBeta: 0, speechGainDb: 0, normalizeLoudness: false })
  })

  it('treats a non-finite value as the minimum, never passing NaN to wasm', () => {
    expect(clampOptions({ attenuationLimitDb: Number.NaN, postFilterBeta: Number.POSITIVE_INFINITY, ...level }))
      .toEqual({ attenuationLimitDb: 0, postFilterBeta: 0, ...level })
    expect(clampOptions({ attenuationLimitDb: Number.NEGATIVE_INFINITY, postFilterBeta: Number.NaN, ...level }))
      .toEqual({ attenuationLimitDb: 0, postFilterBeta: 0, ...level })
    expect(clampOptions({ attenuationLimitDb: 60, postFilterBeta: 0, speechGainDb: Number.NaN, normalizeLoudness: false }))
      .toEqual({ attenuationLimitDb: 60, postFilterBeta: 0, speechGainDb: 0, normalizeLoudness: false })
  })
})
