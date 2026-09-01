import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import manifest from './asset-manifest.json'

export const WASM_FILENAME = 'df_bg.wasm'
export const MODEL_FILENAME = 'DeepFilterNet3_onnx.tar.gz'

const MISSING_ASSETS_HINT = 'Run "npm run fetch:models" to download the DeepFilterNet3 assets.'
const REPLACED_ASSETS_HINT = 'Re-run "npm run fetch:models" to restore the pinned files.'

export interface DenoiseAssets {
  wasm: Uint8Array
  model: Uint8Array
}

/** One asset's identity: what it is called, how big it is, and what it hashes to. */
export interface PinnedAsset {
  name: string
  bytes: number
  sha256: string
}

/**
 * The pinned assets, in the order {@link loadAssets} returns them.
 *
 * Read from `asset-manifest.json`, the same table `scripts/fetch-denoise-assets.mjs`
 * downloads against — one set of digests rather than two that can drift apart. The
 * import means electron-vite compiles them into the bundle, so they are not a file
 * an attacker could edit alongside the assets it vouches for.
 */
export const PINNED_ASSETS: readonly PinnedAsset[] = [WASM_FILENAME, MODEL_FILENAME].map((name) => {
  const asset = manifest.assets.find((entry) => entry.name === name)
  if (!asset) throw new Error(`asset-manifest.json has no entry for ${name}`)
  return { name: asset.name, bytes: asset.bytes, sha256: asset.sha256 }
})

/**
 * Where the WebAssembly module and model weights live.
 *
 * A packaged build gets them from electron-builder's `extraResources`, which
 * lands them beside the app rather than inside the asar so they can be read as
 * plain files. During development they sit in the checkout's `resources/`.
 *
 * Both bases are supplied by the caller rather than derived from this module's
 * own location: only the main process can answer `app.isPackaged`, and a path
 * relative to `import.meta.url` moves whenever the bundler decides to split this
 * module into a chunk of its own.
 */
export function resolveAssetDirectory(packaged: boolean, resourcesPath?: string, appPath?: string): string {
  if (packaged) {
    if (!resourcesPath) throw new Error('A packaged build must provide a resources path')
    return join(resourcesPath, 'deepfilternet3')
  }
  if (!appPath) throw new Error('A development build must provide the application path')
  return join(appPath, 'resources', 'deepfilternet3')
}

/**
 * Reports whether both assets are present and are the files they are meant to be.
 * Returns the reason when they are not, for the UI to show as-is.
 *
 * The digest is re-checked here rather than trusted from setup time: the fetch
 * script verifies what it downloads, which says nothing about a file swapped or
 * truncated afterwards. That costs one pass over ~17 MB when the engine is probed —
 * paid once per app run, off the interactive path — and is what makes the claim that
 * a substituted asset cannot be loaded actually true.
 *
 * `pinned` is a seam for tests, which cannot keep 17 MB of real assets on hand.
 */
export async function checkAssets(
  directory: string,
  pinned: readonly PinnedAsset[] = PINNED_ASSETS
): Promise<string | null> {
  for (const asset of pinned) {
    const outcome = await verify(directory, asset)
    if (typeof outcome === 'string') return outcome
  }
  return null
}

/**
 * Reads both assets, verifying each against its pinned digest first. Throws with
 * the same wording {@link checkAssets} would have reported.
 */
export async function loadAssets(
  directory: string,
  pinned: readonly PinnedAsset[] = PINNED_ASSETS
): Promise<DenoiseAssets> {
  const [wasm, model] = await Promise.all(pinned.map(async (asset) => {
    const outcome = await verify(directory, asset)
    if (typeof outcome === 'string') throw new Error(outcome)
    return outcome
  }))
  if (!wasm || !model) throw new Error('The denoiser needs both the wasm module and the model weights')
  return { wasm, model }
}

/** The file's bytes, or the reason it cannot be trusted. */
async function verify(directory: string, asset: PinnedAsset): Promise<Uint8Array | string> {
  const path = join(directory, asset.name)
  const size = await stat(path).then((stats) => stats.size).catch(() => -1)
  if (size < 0) return `${asset.name} is missing from ${directory}. ${MISSING_ASSETS_HINT}`
  if (size === 0) return `${asset.name} is empty. ${MISSING_ASSETS_HINT}`
  if (size !== asset.bytes) {
    return `${asset.name} is ${size} bytes rather than the expected ${asset.bytes}. ${REPLACED_ASSETS_HINT}`
  }

  const bytes = await readFile(path)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== asset.sha256) {
    return `${asset.name} does not match its pinned SHA-256, so it was not loaded. ${REPLACED_ASSETS_HINT}`
  }
  return bytes
}
