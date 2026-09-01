#!/usr/bin/env node
/**
 * Downloads the DeepFilterNet3 runtime assets that Hope Converter's denoiser
 * needs, and refuses anything whose SHA-256 does not match the digest pinned in
 * `electron/denoise/asset-manifest.json`. Run once per checkout:
 *
 *     npm run fetch:models
 *
 * `prebuild` and `predist` call it too, so a normal build picks the assets up
 * on its own. Re-running is free: a file that already matches is left alone.
 *
 * These assets are deliberately not committed — together they are ~17 MB of
 * binary. They ship inside the packaged app via electron-builder's
 * `extraResources`, and the app never reaches the network at runtime.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const targetDirectory = join(scriptDirectory, '..', 'resources', 'deepfilternet3')
const manifestPath = join(scriptDirectory, '..', 'electron', 'denoise', 'asset-manifest.json')

/**
 * What to download, where from, and what it must hash to.
 *
 * The table is read rather than declared here: `electron/denoise/assets.ts`
 * imports the same file, so the digests this script downloads against and the
 * digests the app re-checks at load time cannot drift apart. See the manifest's
 * own `$comment` for where each asset comes from.
 */
const ASSETS = JSON.parse(await readFile(manifestPath, 'utf8')).assets

async function digestOf(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function isAlreadyValid(path, asset) {
  const size = await stat(path).then((stats) => stats.size).catch(() => -1)
  if (size !== asset.bytes) return false
  return await digestOf(path) === asset.sha256
}

async function download(asset, destination) {
  const response = await fetch(asset.url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`${asset.url} returned HTTP ${response.status} ${response.statusText}`)
  }

  const partial = `${destination}.part`
  await writeFile(partial, Buffer.from(await response.arrayBuffer()))

  const size = (await stat(partial)).size
  const digest = await digestOf(partial)
  if (size !== asset.bytes || digest !== asset.sha256) {
    await rm(partial, { force: true })
    throw new Error(
      `${asset.name} does not match the pinned digest and was discarded.\n` +
      `  expected ${asset.bytes} bytes  sha256 ${asset.sha256}\n` +
      `  received ${size} bytes  sha256 ${digest}`
    )
  }

  await rename(partial, destination)
}

async function main() {
  await mkdir(targetDirectory, { recursive: true })

  for (const asset of ASSETS) {
    const destination = join(targetDirectory, asset.name)
    if (await isAlreadyValid(destination, asset)) {
      console.log(`✓ ${asset.name} already present and verified`)
      continue
    }
    console.log(`↓ ${asset.name} — ${asset.note}`)
    await download(asset, destination)
    console.log(`✓ ${asset.name} verified (sha256 ${asset.sha256.slice(0, 12)}…)`)
  }

  console.log(`\nDenoiser assets ready in ${targetDirectory}`)
}

main().catch((error) => {
  console.error(`\nCould not prepare the denoiser assets: ${error.message}`)
  console.error('The denoiser stays disabled until this succeeds; the rest of the app is unaffected.')
  process.exitCode = 1
})
