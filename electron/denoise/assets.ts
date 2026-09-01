import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const WASM_FILENAME = 'df_bg.wasm'
export const MODEL_FILENAME = 'DeepFilterNet3_onnx.tar.gz'

const MISSING_ASSETS_HINT = 'Run "npm run fetch:models" to download the DeepFilterNet3 assets.'

export interface DenoiseAssets {
  wasm: Uint8Array
  model: Uint8Array
}

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
 * Reports whether both assets are readable, without paying to load them.
 * Returns the reason when they are not, for the UI to show as-is.
 */
export async function checkAssets(directory: string): Promise<string | null> {
  for (const filename of [WASM_FILENAME, MODEL_FILENAME]) {
    const size = await stat(join(directory, filename)).then((stats) => stats.size).catch(() => -1)
    if (size < 0) return `${filename} is missing from ${directory}. ${MISSING_ASSETS_HINT}`
    if (size === 0) return `${filename} is empty. ${MISSING_ASSETS_HINT}`
  }
  return null
}

export async function loadAssets(directory: string): Promise<DenoiseAssets> {
  const reason = await checkAssets(directory)
  if (reason) throw new Error(reason)

  const [wasm, model] = await Promise.all([
    readFile(join(directory, WASM_FILENAME)),
    readFile(join(directory, MODEL_FILENAME))
  ])
  return { wasm, model }
}
