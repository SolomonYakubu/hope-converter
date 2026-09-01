import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MODEL_FILENAME,
  PINNED_ASSETS,
  WASM_FILENAME,
  checkAssets,
  loadAssets,
  resolveAssetDirectory,
  type PinnedAsset
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

/**
 * A pinned entry for a stub file, so a case can exercise the real verification
 * against a few bytes instead of the ~17 MB the shipped table describes.
 */
function pin(name: string, contents: string): PinnedAsset {
  return {
    name,
    bytes: Buffer.byteLength(contents),
    sha256: createHash('sha256').update(contents).digest('hex')
  }
}

const STUBS = [pin(WASM_FILENAME, 'wasm'), pin(MODEL_FILENAME, 'model')]

/** Writes each stub asset with the exact contents its pin was taken from. */
async function writeStubs(contents: Record<string, string> = { [WASM_FILENAME]: 'wasm', [MODEL_FILENAME]: 'model' }) {
  for (const [name, body] of Object.entries(contents)) await writeFile(join(directory, name), body)
}

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

describe('PINNED_ASSETS', () => {
  it('pins both runtime assets, in the order the loader returns them', () => {
    expect(PINNED_ASSETS.map((asset) => asset.name)).toEqual([WASM_FILENAME, MODEL_FILENAME])
  })

  it('carries a size and a full SHA-256 for each, since a partial digest verifies nothing', () => {
    for (const asset of PINNED_ASSETS) {
      expect(asset.bytes).toBeGreaterThan(0)
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('checkAssets', () => {
  it('passes when both files are the files they are pinned to be', async () => {
    await writeStubs()
    expect(await checkAssets(directory, STUBS)).toBeNull()
  })

  it('names the missing file and how to get it', async () => {
    const reason = await checkAssets(directory, STUBS)
    expect(reason).toContain(WASM_FILENAME)
    expect(reason).toContain(directory)
    expect(reason).toContain('npm run fetch:models')
  })

  it('reports a half-finished download rather than letting the worker fail on it', async () => {
    await writeStubs({ [WASM_FILENAME]: 'wasm', [MODEL_FILENAME]: '' })
    expect(await checkAssets(directory, STUBS)).toMatch(new RegExp(`${MODEL_FILENAME} is empty`))
  })

  it('reports a truncated file by the size it should have been', async () => {
    await writeStubs({ [WASM_FILENAME]: 'wa', [MODEL_FILENAME]: 'model' })
    expect(await checkAssets(directory, STUBS)).toBe(
      `${WASM_FILENAME} is 2 bytes rather than the expected 4. Re-run "npm run fetch:models" to restore the pinned files.`
    )
  })

  it('refuses a file swapped for a different one of the same size, which setup cannot catch', async () => {
    // The digest is the whole point of re-checking at load time: this file is the
    // right length and the wrong bytes, so only hashing tells it apart.
    await writeStubs({ [WASM_FILENAME]: 'WASM', [MODEL_FILENAME]: 'model' })
    expect(await checkAssets(directory, STUBS))
      .toMatch(new RegExp(`${WASM_FILENAME} does not match its pinned SHA-256`))
  })

  it('checks the real shipped assets when no table is passed', async () => {
    // The stubs are nothing like 9 MB, so the default table has to reject them —
    // which is what proves the digests reach `checkAssets` rather than sitting unused.
    await writeStubs()
    expect(await checkAssets(directory)).toContain(WASM_FILENAME)
  })
})

describe('loadAssets', () => {
  it('returns both files as bytes', async () => {
    await writeStubs()

    const assets = await loadAssets(directory, STUBS)
    expect(Buffer.from(assets.wasm).toString()).toBe('wasm')
    expect(Buffer.from(assets.model).toString()).toBe('model')
  })

  it('throws the same reason the check reports', async () => {
    await expect(loadAssets(directory, STUBS)).rejects.toThrow(/npm run fetch:models/)
  })

  it('never hands a tampered asset to the engine', async () => {
    await writeStubs({ [WASM_FILENAME]: 'wasm', [MODEL_FILENAME]: 'MODEL' })
    await expect(loadAssets(directory, STUBS)).rejects.toThrow(/does not match its pinned SHA-256/)
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
