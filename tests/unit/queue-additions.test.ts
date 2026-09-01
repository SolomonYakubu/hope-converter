import { describe, expect, it } from 'vitest'
import { NO_ADDITIONS, describeAdditions, isFinishedStatus } from '../../src/stores/queue-additions'

describe('isFinishedStatus', () => {
  it('treats every terminal status as finished, and no working one', () => {
    for (const status of ['completed', 'error', 'cancelled']) expect(isFinishedStatus(status)).toBe(true)
    for (const status of ['queued', 'converting', 'processing', 'paused']) expect(isFinishedStatus(status)).toBe(false)
  })
})

describe('describeAdditions', () => {
  it('says nothing when the pick did what the person expected', () => {
    expect(describeAdditions({ added: 2, requeued: 0, alreadyQueued: 0 })).toBeNull()
    // A revived row shows its own reset, so the added file is the only news.
    expect(describeAdditions({ added: 1, requeued: 1, alreadyQueued: 0 })).toBeNull()
    expect(describeAdditions(NO_ADDITIONS)).toBeNull()
  })

  it('explains a pick that changed nothing, which otherwise looks like a missed click', () => {
    expect(describeAdditions({ added: 0, requeued: 0, alreadyQueued: 1 }))
      .toBe('That file is already in the queue.')
    expect(describeAdditions({ added: 0, requeued: 0, alreadyQueued: 3 }))
      .toBe('3 of those files are already in the queue.')
  })

  it('reports a re-pick that only revived rows, in case they are scrolled out of sight', () => {
    expect(describeAdditions({ added: 0, requeued: 1, alreadyQueued: 0 }))
      .toBe('That file had already finished, so its row is queued to run again.')
    expect(describeAdditions({ added: 0, requeued: 2, alreadyQueued: 0 }))
      .toBe('2 finished files are queued to run again.')
  })

  it('leads with the blocked files, since that is the half nothing happened for', () => {
    expect(describeAdditions({ added: 1, requeued: 1, alreadyQueued: 1 }))
      .toBe('That file is already in the queue.')
  })
})
