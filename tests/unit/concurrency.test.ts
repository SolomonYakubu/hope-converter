import { describe, expect, it, vi } from 'vitest'
import { PausableGate, runWithConcurrency } from '../../src/utils/concurrency'

describe('runWithConcurrency', () => {
  it('processes every item while respecting the worker limit', async () => {
    let active = 0
    let maximumActive = 0
    const completed: number[] = []
    const releases: Array<() => void> = []

    const work = vi.fn(async (item: number) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      completed.push(item)
      active -= 1
    })

    const running = runWithConcurrency([1, 2, 3, 4], 2, work)
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(2))
    releases.shift()?.()
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(3))
    releases.shift()?.()
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(4))
    releases.splice(0).forEach((release) => release())
    await running

    expect(maximumActive).toBe(2)
    expect(completed.sort()).toEqual([1, 2, 3, 4])
  })

  it.each([0, -1, 1.5])('rejects invalid concurrency %s', async (limit) => {
    await expect(runWithConcurrency([1], limit, async () => undefined)).rejects.toThrow('concurrency')
  })

  it('does not dispatch pending work while paused and wakes every worker on resume', async () => {
    const gate = new PausableGate()
    const started: number[] = []
    const releases: Array<() => void> = []
    const work = vi.fn(async (item: number) => {
      started.push(item)
      await new Promise<void>((resolve) => releases.push(resolve))
    })

    gate.pause()
    const running = runWithConcurrency([1, 2, 3], 2, work, gate)
    await Promise.resolve()
    expect(work).not.toHaveBeenCalled()

    gate.resume()
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(2))
    gate.pause()
    releases.splice(0).forEach((release) => release())
    await Promise.resolve()
    expect(work).toHaveBeenCalledTimes(2)

    gate.resume()
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(3))
    releases.splice(0).forEach((release) => release())
    await running
    expect(started.sort()).toEqual([1, 2, 3])
  })

  it('allows repeated pause and resume without deadlocking', async () => {
    const gate = new PausableGate()
    gate.pause()
    const first = gate.wait()
    const second = gate.wait()
    gate.resume()
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])

    gate.pause()
    const third = gate.wait()
    gate.resume()
    await expect(third).resolves.toBeUndefined()
  })
})
