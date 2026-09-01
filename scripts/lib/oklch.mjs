/**
 * sRGB <-> OKLab/OKLCh, per CSS Color 4, plus WCAG contrast and the sRGB mix the
 * stylesheet's color-mix() performs. Shared by scripts/build-accents.mjs, which turns
 * the palette to a new hue, and scripts/build-logos.mjs, which turns the mark to the
 * same one — two things that have to agree about what "the hue of #39ff6a" means.
 */

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toEncoded = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

export const DEG = 180 / Math.PI

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export function rgbToHex([r, g, b]) {
  const part = (c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

export function rgbToOklab([r, g, b]) {
  const [rl, gl, bl] = [toLinear(r), toLinear(g), toLinear(b)]
  const l = Math.cbrt(0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl)
  const m = Math.cbrt(0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl)
  const s = Math.cbrt(0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

export function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    toEncoded(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toEncoded(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toEncoded(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  ]
}

export function rgbToOklch(rgb) {
  const [L, a, b] = rgbToOklab(rgb)
  return { L, C: Math.hypot(a, b), h: (Math.atan2(b, a) * DEG + 360) % 360 }
}

export const hexToOklch = (hex) => rgbToOklch(hexToRgb(hex))

/** The nearest in-gamut colour at this lightness and hue, found by dropping chroma. */
export function oklchToRgb({ L, C, h }) {
  const at = (chroma) => oklabToRgb([L, chroma * Math.cos(h / DEG), chroma * Math.sin(h / DEG)])
  const inGamut = (rgb) => rgb.every((c) => c >= -0.0005 && c <= 1.0005)
  if (inGamut(at(C))) return at(C)
  let [low, high] = [0, C]
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2
    if (inGamut(at(mid))) low = mid
    else high = mid
  }
  return at(low)
}

export const oklchToHex = (colour) => rgbToHex(oklchToRgb(colour))

export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

/** `color-mix(in srgb, top p%, bottom)` — sRGB mixing is linear in encoded values. */
export function mix(top, bottom, p) {
  const [a, b] = [hexToRgb(top), hexToRgb(bottom)]
  return rgbToHex(a.map((c, i) => c * p + b[i] * (1 - p)))
}
