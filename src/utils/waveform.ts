/**
 * Pure sample maths behind the A/B player: the peak envelope a waveform is drawn
 * from, and the loudness figures used to compare two versions honestly.
 *
 * Nothing here touches the DOM or WebAudio, so it is testable on plain typed
 * arrays and reusable for any number of channels.
 */

/** One column of a drawn waveform: the lowest and highest sample it covers. */
export interface PeakEnvelope {
  min: Float32Array
  max: Float32Array
}

/**
 * Reduces every channel to `columns` min/max pairs — one per pixel column of the
 * canvas. All channels are scanned together so a hard-panned sound still shows
 * up, which a downmix to mono could hide.
 */
export function computePeaks(channels: readonly Float32Array[], columns: number): PeakEnvelope {
  const width = Math.max(0, Math.floor(columns))
  const min = new Float32Array(width)
  const max = new Float32Array(width)
  const length = channels[0]?.length ?? 0
  if (!width || !length) return { min, max }

  const perColumn = length / width
  for (let column = 0; column < width; column++) {
    const from = Math.floor(column * perColumn)
    // The last column takes the remainder, so no samples are dropped by rounding.
    const to = column === width - 1 ? length : Math.max(from + 1, Math.floor((column + 1) * perColumn))
    let low = 0
    let high = 0

    for (const samples of channels) {
      for (let index = from; index < to && index < samples.length; index++) {
        const value = samples[index] as number
        if (value < low) low = value
        if (value > high) high = value
      }
    }
    min[column] = low
    max[column] = high
  }

  return { min, max }
}

/** Root-mean-square amplitude across every channel, 0 for silence. */
export function rmsOf(channels: readonly Float32Array[]): number {
  let sum = 0
  let count = 0
  for (const samples of channels) {
    for (let index = 0; index < samples.length; index++) {
      const value = samples[index] as number
      sum += value * value
    }
    count += samples.length
  }
  return count ? Math.sqrt(sum / count) : 0
}

/**
 * The gain that makes `cleaned` as loud as `original`, for a comparison that is
 * about noise rather than volume.
 *
 * Denoising removes energy, and a level stage can add it back; either way the two
 * sides rarely match, and the louder one wins a blind listen regardless of which
 * is actually better. The result is bounded because a nearly silent cleaned clip —
 * a recording with no speech at Maximum — would otherwise ask for enormous gain.
 */
export function levelMatchGain(original: readonly Float32Array[], cleaned: readonly Float32Array[]): number {
  const target = rmsOf(original)
  const actual = rmsOf(cleaned)
  if (!target || !actual) return 1
  return Math.min(8, Math.max(0.125, target / actual))
}

/** `m:ss`, for a clip short enough that hours never appear. */
export function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const whole = Math.floor(safe)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * An SVG path filling the envelope: left to right along the peaks, then back
 * along the troughs.
 *
 * The path is built in the envelope's own coordinates and drawn with a viewBox
 * rather than at pixel size, so the same string stretches to any width and takes
 * its colour from CSS. That means no redraw on a resize or a theme change, which
 * is the whole reason this is a path and not a canvas.
 */
export function peaksToPath({ min, max }: PeakEnvelope, height = 100): string {
  if (!max.length) return ''
  const mid = height / 2
  const y = (value: number): string => (mid - Math.min(1, Math.max(-1, value)) * mid).toFixed(2)

  const top: string[] = []
  const bottom: string[] = []
  for (let column = 0; column < max.length; column++) {
    top.push(`${column},${y(max[column] as number)}`)
    const mirror = max.length - 1 - column
    bottom.push(`${mirror},${y(min[mirror] as number)}`)
  }

  return `M${top.join(' L')} L${bottom.join(' L')} Z`
}
