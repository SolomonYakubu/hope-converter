/**
 * The checks and coercions that more than one module on the main side needs and none
 * of them owns.
 *
 * Nothing here knows about media, FFmpeg or IPC — a helper that does belongs beside
 * the code it serves. It also stays on this side of the process boundary on purpose:
 * the renderer keeps its own copy of the one guard it needs rather than a store
 * importing four lines out of the main process to read a stored setting.
 */

/** Narrows parsed JSON to something whose keys can be read without a cast. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whatever was thrown, as an Error — `catch` gives no guarantee it was one. */
export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

/** The same, where only the text is wanted and a new Error would be built to discard. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Confines a number to a range, treating NaN and the infinities as the low end. Every
 * caller is clamping a value that arrived over IPC or from a probe, where "not a number
 * at all" should land on the quietest setting rather than travel any further.
 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * Rejects a path argument that must not reach a child process: empty, which FFmpeg
 * takes for a missing argument and then guesses at, or one carrying a NUL, which the
 * C side of spawn truncates at.
 */
export function assertPath(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} cannot be empty`)
  if (value.includes('\u0000')) throw new Error(`${label} contains an invalid character`)
}
