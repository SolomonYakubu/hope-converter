/**
 * The accents the app offers. One place, because three things are generated from this
 * list and they have to agree: the palette blocks in src/styles.css
 * (scripts/build-accents.mjs), the recoloured marks in src/assets
 * (scripts/build-logos.mjs), and — kept by hand, guarded by a test — the names and
 * labels the selector shows in src/stores/appearance-persistence.ts.
 *
 * The glint is the vivid colour an accent is named for and the one thing here chosen by
 * eye: hue rotation cannot invent it, because violet at the lightness that reads as neon
 * is not the lightness green reads as neon at. Everything else is derived from it.
 *
 * `chroma` pulls the *grounds* in for a hue that would otherwise shout at full
 * saturation across a whole window. It does not apply to the mark or to the fills, which
 * are the colour the accent is named for and should look it.
 */

/** The violet everything else is a rotation of; its hue is the origin of the rotation. */
export const REFERENCE_GLINT = '#a301fa'

/** The accent the reference palette and the source artwork are already drawn in. */
export const REFERENCE_ACCENT = 'purple'

export const ACCENTS = [
  { name: 'purple', label: 'Purple', glint: REFERENCE_GLINT, chroma: 1 },
  { name: 'neon', label: 'Neon green', glint: '#39ff6a', chroma: 0.82 },
  { name: 'lime', label: 'Lime', glint: '#cbff21', chroma: 0.8 },
  { name: 'orange', label: 'Orange', glint: '#ff8a1f', chroma: 0.86 },
  { name: 'cyan', label: 'Cyan', glint: '#22e0f5', chroma: 0.9 },
  { name: 'rose', label: 'Rose', glint: '#ff2f78', chroma: 0.94 }
]
