export interface ConcurrencyGate {
  wait: () => Promise<void>
}

/**
 * A reusable pause barrier. Workers await `wait()` before claiming their next
 * item, so pausing stops new dispatches without killing in-flight work.
 */
export class PausableGate implements ConcurrencyGate {
  private paused = false
  private waiters: Array<() => void> = []

  get isPaused(): boolean {
    return this.paused
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
  }

  wait(): Promise<void> {
    if (!this.paused) return Promise.resolve()
    return new Promise<void>((resolve) => { this.waiters.push(resolve) })
  }
}

export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  gate?: ConcurrencyGate
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer')
  }

  let nextIndex = 0
  const workerCount = Math.min(concurrency, items.length)

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      if (gate) await gate.wait()
      // The queue may have drained while this worker was paused.
      if (nextIndex >= items.length) return
      const item = items[nextIndex]
      nextIndex += 1
      await worker(item)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker))
}
