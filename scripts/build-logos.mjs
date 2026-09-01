/**
 * Recolours the app mark to each accent, writing src/assets/logo-<accent>.png.
 *
 * The mark in src/assets/logo.png is the violet original and the one artwork here: an
 * accent's version is that image with every painted pixel turned to the accent's hue in
 * OKLCh, keeping the pixel's own lightness and chroma, and its own hue offset from the
 * violet glint. That is the same rotation scripts/build-accents.mjs performs on the
 * palette, from the same table in scripts/lib/accents.mjs, so the mark and the buttons
 * around it land on one hue rather than two that nearly agree.
 *
 * Keeping lightness per pixel is what preserves the artwork: the bevels, the gloss and
 * the near-black outlines are lightness, not hue, so they survive untouched. Where a hue
 * cannot hold the violet's chroma at that lightness — sRGB has far less room for a
 * saturated green than for a saturated purple — chroma is dropped to the edge of the
 * gamut rather than the lightness being moved, so the shading never flattens.
 *
 * Run `npm run logos` after changing an accent's glint in scripts/lib/accents.mjs. The
 * files it writes are committed: the renderer imports them like any other asset, and
 * there is no image dependency to install to build the app.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { ACCENTS, REFERENCE_ACCENT, REFERENCE_GLINT } from './lib/accents.mjs'
import { hexToOklch, oklchToRgb, rgbToOklch } from './lib/oklch.mjs'
import { decodePng, encodePng } from './lib/png.mjs'

/** Below this, a pixel is grey and a hue rotation would only round-trip it. */
const NEUTRAL_CHROMA = 0.002

const sourceUrl = new URL('../src/assets/logo.png', import.meta.url)
const source = decodePng(readFileSync(sourceUrl))
const originHue = hexToOklch(REFERENCE_GLINT).h

/**
 * @param {number} turn Degrees to add to every painted pixel's hue.
 * @returns {Buffer} A fresh RGBA buffer; alpha and neutral pixels are copied as they are.
 */
function recolour(turn) {
  const pixels = Buffer.from(source.pixels)
  // A glossy 512px render holds tens of thousands of distinct colours but far fewer than
  // it has pixels, and the solve below is a binary search, so each colour is done once.
  const seen = new Map()
  for (let at = 0; at < pixels.length; at += 4) {
    if (pixels[at + 3] === 0) continue
    const key = (pixels[at] << 16) | (pixels[at + 1] << 8) | pixels[at + 2]
    let turned = seen.get(key)
    if (turned === undefined) {
      const { L, C, h } = rgbToOklch([pixels[at] / 255, pixels[at + 1] / 255, pixels[at + 2] / 255])
      turned = C < NEUTRAL_CHROMA
        ? [pixels[at], pixels[at + 1], pixels[at + 2]]
        : oklchToRgb({ L, C, h: (h + turn + 360) % 360 })
          .map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255))
      seen.set(key, turned)
    }
    pixels.set(turned, at)
  }
  return pixels
}

for (const accent of ACCENTS) {
  if (accent.name === REFERENCE_ACCENT) {
    console.log(`${accent.name.padEnd(7)} logo.png — the source artwork, left alone`)
    continue
  }
  const turn = hexToOklch(accent.glint).h - originHue
  const file = encodePng({ ...source, pixels: recolour(turn) })
  const name = `logo-${accent.name}.png`
  writeFileSync(new URL(`../src/assets/${name}`, import.meta.url), file)
  console.log(`${accent.name.padEnd(7)} ${name} — hue ${turn > 0 ? '+' : ''}${turn.toFixed(1)}°, ${Math.round(file.length / 1024)} kB`)
}
