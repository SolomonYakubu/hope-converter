/**
 * Shared rules for adding files to a queue that may already hold them, and the ids
 * their rows are keyed by.
 *
 * Picking the same file twice is normal — a conversion is checked, the settings
 * are changed, the file is picked again. Dropping it as a duplicate makes the
 * click look broken, so a row that has finished is put back in the queue and the
 * caller is told what happened.
 */

/** Statuses that mean the job is over, so re-picking the file means "run it again". */
const FINISHED_STATUSES: ReadonlySet<string> = new Set(['completed', 'error', 'cancelled'])

export function isFinishedStatus(status: string): boolean {
  return FINISHED_STATUSES.has(status)
}

/**
 * The id a new row is keyed by, and the one the main process reports progress against.
 *
 * `randomUUID` needs a secure context, which the packaged app is and a plain-HTTP dev
 * server would not be, so the fallback is what keeps a queue usable there rather than
 * dead: `prefix` only makes those readable in a log, since a UUID carries no queue name.
 */
export function createId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export interface AddFilesResult {
  /** Files that became new rows. */
  added: number
  /** Finished rows put back in the queue because their file was picked again. */
  requeued: number
  /** Files whose row is still queued or running, so re-adding them changed nothing. */
  alreadyQueued: number
}

export const NO_ADDITIONS: AddFilesResult = { added: 0, requeued: 0, alreadyQueued: 0 }

/**
 * The one case worth a banner is a pick that changed nothing, which otherwise
 * looks like the click was missed. A revived row says so itself by flipping back
 * to "Queued", so it is only announced when it was the whole of what happened.
 */
export function describeAdditions({ added, requeued, alreadyQueued }: AddFilesResult): string | null {
  if (alreadyQueued > 0) {
    return alreadyQueued === 1
      ? 'That file is already in the queue.'
      : `${alreadyQueued} of those files are already in the queue.`
  }
  if (requeued > 0 && added === 0) {
    return requeued === 1
      ? 'That file had already finished, so its row is queued to run again.'
      : `${requeued} finished files are queued to run again.`
  }
  return null
}
