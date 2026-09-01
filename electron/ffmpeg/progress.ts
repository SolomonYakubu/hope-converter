import { clamp } from '../utils/guards'

export interface ParsedProgress {
  frame: number | null
  timeSeconds: number
  percent: number
  speed: number | null
  state: 'continue' | 'end'
}

export function parseProgressBlock(block: string, durationSeconds: number): ParsedProgress {
  const fields = new Map<string, string>()

  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator > 0) {
      fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
    }
  }

  const rawTime = fields.get('out_time_us') ?? fields.get('out_time_ms') ?? '0'
  const timeSeconds = (toFiniteNumber(rawTime) ?? 0) / 1_000_000
  const speedValue = fields.get('speed')?.replace(/x$/, '')
  const speed = speedValue && speedValue !== 'N/A' ? toFiniteNumber(speedValue, null) : null
  const frame = fields.has('frame') ? toFiniteNumber(fields.get('frame') ?? '', null) : null
  const percent = durationSeconds > 0
    ? clamp((timeSeconds / durationSeconds) * 100, 0, 100)
    : 0

  return {
    frame,
    timeSeconds,
    percent,
    speed,
    state: fields.get('progress') === 'end' ? 'end' : 'continue'
  }
}

function toFiniteNumber(value: string, fallback?: null): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : (fallback ?? 0)
}
