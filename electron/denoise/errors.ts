/**
 * A cancellation is a user decision, not a failure, and both the worker and the
 * main thread need to tell the two apart — hence a shared type rather than a
 * string comparison.
 */
export class DenoiseCancelledError extends Error {
  constructor(id: string) {
    super(`Denoising ${id} was cancelled`)
    this.name = 'DenoiseCancelledError'
  }
}
