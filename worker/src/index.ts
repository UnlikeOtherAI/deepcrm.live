import type { Db } from '@deepcrm/db'

export type WorkerDeps = {
  db: Db
  clock: () => Date
  ids: () => string
  version: string
}

export type JobHandler = (payload: unknown) => Promise<void>

/**
 * T04 process-mode seam. T07 replaces this with the queue-processing loop.
 */
export async function startWorker(
  _deps: WorkerDeps,
  handlers: Record<string, JobHandler>,
): Promise<void> {
  if (Object.keys(handlers).length > 0) {
    throw new Error('Worker handlers are not supported until T07')
  }
}
