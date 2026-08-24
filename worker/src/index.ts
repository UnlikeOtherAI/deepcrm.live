import type { Db, QueueJob, Prisma, writeAudit } from '@deepcrm/db'
import {
  claimNext,
  complete,
  fail,
  progress,
  type QueueCompleteTx,
} from '@deepcrm/queue'

export type WorkerDeps = {
  db: Db
  clock: () => Date
  ids: () => string
  writeAudit: typeof writeAudit
}

export type { BulkAssertRecordInput, BulkAssertRecordPort } from './bulk-assert-port.js'

export type JobHandlerInput = {
  db: Db
  job: QueueJob
  workerId: string
  clock: () => Date
  writeAudit: typeof writeAudit
  progress: (value: Prisma.InputJsonValue) => Promise<boolean>
  terminalize: (
    tx: QueueCompleteTx,
    result: Prisma.InputJsonValue | null,
  ) => Promise<boolean>
}

export type JobHandlerOutcome = void | { terminalized: true }
export type JobHandler = (input: JobHandlerInput) => Promise<JobHandlerOutcome>

/**
 * Processes at most four claimed jobs concurrently until aborted.
 */
export async function startWorker(
  deps: WorkerDeps,
  handlers: Record<string, JobHandler>,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const workerId = deps.ids()
  const types = Object.keys(handlers)
  const active = new Set<Promise<void>>()
  const pause = (): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
  const run = async (job: QueueJob): Promise<void> => {
    const handler = handlers[job.type]
    if (handler === undefined) return
    try {
      const outcome = await handler({
        db: deps.db,
        job,
        workerId,
        clock: deps.clock,
        writeAudit: deps.writeAudit,
        progress: (value) => progress(deps.db, job.id, workerId, value),
        terminalize: (tx, result) => complete(tx, job.id, workerId, result),
      })
      if (outcome?.terminalized === true) return
      await complete(deps.db, job.id, workerId, null)
    } catch (error: unknown) {
      await fail(deps.db, job.id, workerId, error instanceof Error ? error.message : 'worker failure')
    }
  }
  while (!signal.aborted) {
    if (types.length === 0) { await pause(); continue }
    while (!signal.aborted && active.size < 4) {
      const job = await claimNext(deps.db, workerId, types)
      if (job === null) break
      const task = run(job).finally(() => active.delete(task))
      active.add(task)
    }
    if (active.size === 0) await pause()
    else await Promise.race(active)
  }
  await Promise.all(active)
}
