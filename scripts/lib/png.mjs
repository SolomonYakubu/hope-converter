/**
 * The little bit of PNG needed to recolour an image at build time: read 8-bit RGBA in,
 * write 8-bit RGBA out. Deliberately not a general decoder — anything other than the
 * one shape src/assets/logo.png is in throws rather than being silently reinterpreted.
 *
 * It exists so `npm run logos` needs no image dependency: node:zlib already carries the
 * only hard part, and the rest is chunk framing, the five row filters and a CRC.
 */

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** RGBA at 8 bits: four bytes per pixel, which is the only case here. */
const BYTES_PER_PIXEL = 4

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let c = index
  for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const framed = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(framed))
  return Buffer.concat([length, framed, crc])
}

const paeth = (a, b, c) => {
  const p = a + b - c
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** What filter type `type` predicts for the byte at `x`, given the row above. */
function predict(type, pixels, row, prior, x, hasPrior) {
  const a = x >= BYTES_PER_PIXEL ? pixels[row + x - BYTES_PER_PIXEL] : 0
  const b = hasPrior ? pixels[prior + x] : 0
  const c = x >= BYTES_PER_PIXEL && hasPrior ? pixels[prior + x - BYTES_PER_PIXEL] : 0
  if (type === 0) return 0
  if (type === 1) return a
  if (type === 2) return b
  if (type === 3) return (a + b) >> 1
  if (type === 4) return paeth(a, b, c)
  throw new Error(`Unknown PNG row filter ${type}`)
}

/** @returns {{ width: number, height: number, pixels: Buffer }} RGBA, one byte each. */
export function decodePng(file) {
  if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file')
  const parts = []
  let header = null
  for (let at = 8; at + 12 <= file.length;) {
    const length = file.readUInt32BE(at)
    const type = file.toString('latin1', at + 4, at + 8)
    const data = file.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), spec: [data[8], data[9], data[12]] }
    if (type === 'IDAT') parts.push(data)
    at += length + 12
  }
  if (!header) throw new Error('PNG has no IHDR chunk')
  const [depth, colourType, interlace] = header.spec
  if (depth !== 8 || colourType !== 6 || interlace !== 0) {
    throw new Error(`Only 8-bit RGBA, non-interlaced PNGs are handled — this one is depth ${depth}, colour type ${colourType}, interlace ${interlace}`)
  }

  const { width, height } = header
  const stride = width * BYTES_PER_PIXEL
  const raw = inflateSync(Buffer.concat(parts))
  if (raw.length !== (stride + 1) * height) throw new Error('PNG pixel data is the wrong length')
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const type = raw[y * (stride + 1)]
    const line = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x += 1) {
      pixels[row + x] = (raw[line + x] + predict(type, pixels, row, row - stride, x, y > 0)) & 255
    }
  }
  return { width, height, pixels }
}

export function encodePng({ width, height, pixels }) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filterRows(pixels, width, height), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Filters each row with all five types and keeps the one whose bytes are smallest read
 * as signed — libpng's own heuristic for what deflate will compress best.
 */
function filterRows(pixels, width, height) {
  const stride = width * BYTES_PER_PIXEL
  const out = Buffer.alloc((stride + 1) * height)
  const [candidate, chosen] = [Buffer.alloc(stride), Buffer.alloc(stride)]
  for (let y = 0; y < height; y += 1) {
    const [row, prior] = [y * stride, (y - 1) * stride]
    let best = { score: Infinity, type: 0 }
    for (let type = 0; type <= 4; type += 1) {
      let score = 0
      for (let x = 0; x < stride; x += 1) {
        const value = (pixels[row + x] - predict(type, pixels, row, prior, x, y > 0)) & 255
        candidate[x] = value
        score += value < 128 ? value : 256 - value
      }
      if (score < best.score) {
        best = { score, type }
        candidate.copy(chosen)
      }
    }
    out[y * (stride + 1)] = best.type
    chosen.copy(out, y * (stride + 1) + 1)
  }
  return out
}
