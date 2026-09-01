/**
 * Generates the `[data-accent]` palette blocks in src/styles.css.
 *
 * The purple theme is the reference: every colour in it was picked by hand and its
 * text colours were checked against WCAG 1.4.3. An accent is that same palette turned
 * to a new hue in OKLCh — which keeps perceptual lightness, and so the *look* of the
 * palette, but not its luminance, and luminance is what contrast is made of. So every
 * role that carries text is re-solved here: hue and chroma come from the accent,
 * lightness is moved until the role clears its contrast floor against the ground it
 * can appear on. That floor is 4.6:1 for label text (a margin over the 4.5 the
 * guideline asks for) and 4.8:1 for ink on a filled button.
 *
 * Run `npm run accents` and paste the output into src/styles.css. Colours in those
 * blocks should not be edited by hand: change an accent's glint in
 * scripts/lib/accents.mjs and regenerate — then run `npm run logos`, which turns the app
 * mark to the same hues — or the printed contrast figures stop describing what ships.
 */

import { ACCENTS, REFERENCE_ACCENT, REFERENCE_GLINT } from './lib/accents.mjs'
import { contrast, hexToOklch, mix, oklchToHex } from './lib/oklch.mjs'

// --- The reference palette --------------------------------------------------

/** Every hand-picked colour of the purple theme that an accent has to reproduce. */
const REFERENCE = {
  dark: {
    bg: '#16122a', surface: '#201b39', 'surface-raised': '#262041', 'surface-soft': '#120f23',
    text: '#f5f2fc', muted: '#a7a0c4', subtle: '#8d85ad', brand: '#c77dff'
  },
  light: {
    bg: '#e9e7f6', surface: '#ecebf8', 'surface-raised': '#f1f0fa', 'surface-soft': '#e1dff1',
    text: '#1e1830', muted: '#5b5375', subtle: '#6a6288', brand: '#7415cf',
    // The opaque colours behind `--shade` and `--line-strong`, which the stylesheet
    // fades with color-mix rather than declaring an rgba() per accent.
    'shade-solid': '#8578b4', 'line-solid': '#7468a2'
  },
  fill: '#6417ab', lift: '#7d24cd'
}

const GLINT = hexToOklch(REFERENCE_GLINT)
/**
 * How the reference fills sit under their glint, and how its resting fill sits under
 * its own hover fill — the ratios every accent reuses. `step` is what makes a hover
 * state that is reliably brighter than the button at rest: the bright fill is solved
 * against the contrast floor and the resting one is stepped down from whatever that
 * came out as, rather than the two being solved separately and landing together.
 */
const FILL_RATIO = (() => {
  const [fill, lift] = [hexToOklch(REFERENCE.fill), hexToOklch(REFERENCE.lift)]
  return {
    lift: { L: lift.L / GLINT.L, C: lift.C / GLINT.C },
    step: { L: fill.L / lift.L, C: fill.C / lift.C }
  }
})()

/** Small labels have to clear 4.5:1; the extra tenth keeps rounding out of it. */
const TEXT_FLOOR = 4.6
/** Ink on the brighter of the two fills, which is the hover state of a filled button. */
const INK_FLOOR = 4.8

/**
 * Turns one reference colour to an accent's hue, keeping its lightness and its hue
 * offset from the glint, so the relationships inside the palette survive the move.
 */
function turn(hex, accent) {
  const { L, C, h } = hexToOklch(hex)
  const target = hexToOklch(accent.glint)
  return { L, C: C * accent.chroma, h: (target.h + (h - GLINT.h) + 360) % 360 }
}

/**
 * Walks lightness in `step` increments until `ratio` of the candidate clears `floor`,
 * so a role that carries text is never merely close to the guideline.
 */
function solve(colour, ratio, floor, step) {
  let candidate = { ...colour }
  for (let i = 0; i < 260; i += 1) {
    const hex = oklchToHex(candidate)
    if (ratio(hex) >= floor) return hex
    candidate = { ...candidate, L: candidate.L + step }
    if (candidate.L <= 0 || candidate.L >= 1) return oklchToHex({ ...candidate, L: candidate.L <= 0 ? 0 : 1 })
  }
  return oklchToHex(candidate)
}

/**
 * What the reference palette's own text achieves against the ground it is worst on,
 * which is the target every accent is solved to. Matching the reference's *contrast*
 * rather than its lightness is what keeps a green as legible as the violet it came
 * from: equal lightness in OKLCh is not equal luminance across hues, and luminance is
 * what a contrast ratio is made of. Where the reference itself came in under the
 * guideline — light --subtle sat at 4.3:1 on a well — the floor wins.
 */
const TARGET = { dark: {}, light: {} }
for (const role of ['text', 'muted', 'subtle', 'brand']) {
  TARGET.dark[role] = Math.max(contrast(REFERENCE.dark[role], REFERENCE.dark['surface-raised']), TEXT_FLOOR)
  TARGET.light[role] = Math.max(contrast(REFERENCE.light[role], REFERENCE.light['surface-soft']), TEXT_FLOOR)
}

function buildAccent(accent) {
  const isPurple = accent.name === REFERENCE_ACCENT
  // The purple grounds and fills are the hand-picked reference, so they are used as
  // they are rather than round-tripped through OKLCh for no reason. Its text colours
  // are not pinned: they go through the same solver as everyone else's, which is what
  // caught --subtle falling to 4.3:1 on a light well.
  const keep = (hex, turned) => (isPurple ? hex : turned)

  const dark = {}
  for (const role of ['bg', 'surface', 'surface-raised', 'surface-soft']) {
    dark[role] = keep(REFERENCE.dark[role], oklchToHex(turn(REFERENCE.dark[role], accent)))
  }
  const light = {}
  for (const role of ['bg', 'surface', 'surface-raised', 'surface-soft', 'shade-solid', 'line-solid']) {
    light[role] = keep(REFERENCE.light[role], oklchToHex(turn(REFERENCE.light[role], accent)))
  }

  // Dark text sits on the lightest ground it can appear on — the raised surface a
  // queue row is drawn with — and is solved upward. Light text sits on the darkest,
  // which is the well a status pill is sunk into, and is solved downward.
  const darkGround = dark['surface-raised']
  const lightGround = light['surface-soft']
  for (const role of ['text', 'muted', 'subtle', 'brand']) {
    dark[role] = solve(
      isPurple ? hexToOklch(REFERENCE.dark[role]) : turn(REFERENCE.dark[role], accent),
      (hex) => contrast(hex, darkGround), TARGET.dark[role], 0.004
    )
    light[role] = solve(
      isPurple ? hexToOklch(REFERENCE.light[role]) : turn(REFERENCE.light[role], accent),
      (hex) => contrast(hex, lightGround), TARGET.light[role], -0.004
    )
  }

  // No text sits on the glint — it only rims the fills and paints a swatch — so it is
  // taken as picked. The bright fill is the one solved, because it is the lighter of
  // the pair and so the harder one for a near-white label; the resting fill is then
  // stepped down from it by the same ratio the reference uses, which cannot lose
  // contrast. Fills keep their lightness rather than matching the reference's 9:1: a
  // green dark enough to reach that stops looking like the colour that was chosen.
  const glint = accent.glint
  const target = hexToOklch(glint)
  const ink = mix(glint, '#ffffff', 0.07)
  const lift = keep(REFERENCE.lift, solve(
    { L: target.L * FILL_RATIO.lift.L, C: target.C * FILL_RATIO.lift.C, h: target.h },
    (hex) => contrast(ink, hex), INK_FLOOR, -0.004
  ))
  const lifted = hexToOklch(lift)
  const fill = keep(REFERENCE.fill, oklchToHex({
    L: lifted.L * FILL_RATIO.step.L, C: lifted.C * FILL_RATIO.step.C, h: lifted.h
  }))
  return { ...accent, dark, light, glint, ink, fill, lift }
}

// --- Output -----------------------------------------------------------------

const built = ACCENTS.map(buildAccent)

console.log('/* Generated by scripts/build-accents.mjs — see the note there before editing. */')
console.log('\n  /* Headline colours, one line per accent, declared here rather than in the')
console.log('     blocks below so the swatches in Appearance can paint an accent that is not')
console.log('     the selected one. */')
for (const a of built) {
  console.log(`  --accent-${a.name}: ${a.fill}; --accent-${a.name}-lift: ${a.lift}; --accent-${a.name}-glint: ${a.glint};`)
}

for (const a of built) {
  const isPurple = a.name === REFERENCE_ACCENT
  console.log(`\n/* ${a.label}: the reference palette turned to the hue of ${a.glint}`
    + `${a.chroma === 1 ? '' : `, ground chroma × ${a.chroma}`}. */`)
  console.log(isPurple ? '/* purple lives in :root — these are its solved text colours only */' : '')
  console.log(`:root${isPurple ? '' : `[data-accent='${a.name}']`} {`)
  if (!isPurple) {
    console.log(`  --fill: var(--accent-${a.name}); --fill-bright: var(--accent-${a.name}-lift); --tint: var(--accent-${a.name}-glint);`)
  }
  for (const role of ['bg', 'surface', 'surface-raised', 'surface-soft', 'text', 'muted', 'subtle', 'brand']) {
    if (isPurple && !['text', 'muted', 'subtle', 'brand'].includes(role)) continue
    console.log(`  --${role}: ${a.dark[role]};`)
  }
  console.log('}')
  console.log(`:root[data-theme='light']${isPurple ? '' : `[data-accent='${a.name}']`} {`)
  for (const role of ['bg', 'surface', 'surface-raised', 'surface-soft', 'text', 'muted', 'subtle', 'brand']) {
    if (isPurple && !['text', 'muted', 'subtle', 'brand'].includes(role)) continue
    console.log(`  --${role}: ${a.light[role]};`)
  }
  if (!isPurple) console.log(`  --shade-solid: ${a.light['shade-solid']}; --line-solid: ${a.light['line-solid']};`)
  console.log('}')
}

console.log('\n--- contrast, smallest first (label floor 4.6, ink on either fill 4.8) ---')
const rows = []
for (const a of built) {
  const push = (theme, what, ratio) => rows.push({ accent: a.name, theme, what, ratio: Number(ratio.toFixed(2)) })
  for (const role of ['text', 'muted', 'subtle', 'brand']) {
    push('dark', `${role} on surface-raised`, contrast(a.dark[role], a.dark['surface-raised']))
    push('light', `${role} on surface-soft`, contrast(a.light[role], a.light['surface-soft']))
  }
  push('both', 'ink on fill', contrast(a.ink, a.fill))
  push('both', 'ink on fill-bright', contrast(a.ink, a.lift))
}
console.table(rows.sort((x, y) => x.ratio - y.ratio).slice(0, 22))
const worstLabel = Math.min(...rows.filter((r) => !r.what.startsWith('ink')).map((r) => r.ratio))
const worstInk = Math.min(...rows.filter((r) => r.what.startsWith('ink')).map((r) => r.ratio))
console.log(`worst label ${worstLabel}:1 · worst ink on a fill ${worstInk}:1`)
