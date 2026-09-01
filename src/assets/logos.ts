import type { Accent } from '../stores/appearance-persistence'
import cyan from './logo-cyan.png'
import lime from './logo-lime.png'
import neon from './logo-neon.png'
import orange from './logo-orange.png'
import rose from './logo-rose.png'
import purple from './logo.png'

/**
 * The app mark, one file per accent, so the logo is the colour the rest of the window is.
 *
 * They are real artwork rather than a filter or a tinted mask: the mark is a glossy 3D
 * render whose bevels and near-black outlines a flat tint would erase. Each file is
 * logo.png turned to the accent's hue by scripts/build-logos.mjs, which keeps every
 * pixel's lightness and so keeps the shading. Run `npm run logos` after changing a glint.
 *
 * Typed as a total record on purpose: adding an accent without generating its mark is a
 * compile error rather than a broken image.
 */
export const ACCENT_LOGOS: Record<Accent, string> = { purple, neon, lime, orange, cyan, rose }
