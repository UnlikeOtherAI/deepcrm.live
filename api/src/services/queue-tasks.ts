import { tenantWhere, type QueueJob } from '@deepcrm/db'
import { cancel } from '@deepcrm/queue'
import {
  BulkAssertProgress,
  BulkAssertResult,
  FindDuplicatesProgress,
  FindDuplicatesResult,
  ExportProgress,
  ExportResult,
  ErrorCode,
  McpTask,
  ServiceError,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'

export const BULK_ASSERT_JOB = 'records.bulk_assert'
export const DEDUP_SCAN_JOB = 'records.dedup_scan'
export const EXPORT_JOB = 'records.export'
const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const TASK_POLL_INTERVAL_MS = 1_000

function invalidState(detail: string): never {
  throw new ServiceError(ErrorCode.INTERNAL, 'Stored task state is invalid', { detail })
}

function status(job: QueueJob): 'working' | 'completed' | 'failed' | 'cancelled' {
  switch (job.status) {
    case 'queued':
    case 'running': return 'working'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
  }
}

function progress(job: QueueJob) {
  if (job.progress === null) return undefined
  const parsed = job.type === DEDUP_SCAN_JOB
    ? FindDuplicatesProgress.safeParse(job.progress)
    : job.type === EXPORT_JOB
      ? ExportProgress.safeParse(job.progress)
      : BulkAssertProgress.safeParse(job.progress)
  if (!parsed.success) return invalidState('progress')
  return parsed.data
}

function statusMessage(
  mapped: ReturnType<typeof status>,
  jobProgress: ReturnType<typeof progress>,
): string | undefined {
  if (mapped === 'failed') return 'Task failed'
  if (mapped === 'cancelled') return 'Task cancelled'
  if (jobProgress !== undefined) {
    return `Processed ${jobProgress.done} of ${jobProgress.total} rows`
  }
  return undefined
}

function present(job: QueueJob): ReturnType<typeof McpTask.parse> {
  const mapped = status(job)
  const jobProgress = progress(job)
  const message = statusMessage(mapped, jobProgress)
  return McpTask.parse({
    taskId: job.id,
    status: mapped,
    ttl: TASK_TTL_MS,
    createdAt: job.createdAt.toISOString(),
    lastUpdatedAt: job.updatedAt.toISOString(),
    ...(mapped === 'working' ? { pollInterval: TASK_POLL_INTERVAL_MS } : {}),
    ...(message === undefined ? {} : { statusMessage: message }),
  })
}

async function taskJob(deps: AppDeps, ctx: ActorContext, taskId: string): Promise<QueueJob> {
  const job = await deps.db.queueJob.findFirst({
    where: {
      ...tenantWhere(ctx.tenant), id: taskId,
      type: { in: [BULK_ASSERT_JOB, DEDUP_SCAN_JOB, EXPORT_JOB] },
    },
  })
  if (job === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Task not found')
  return job
}

export async function getQueueTask(
  deps: AppDeps,
  ctx: ActorContext,
  taskId: string,
): Promise<ReturnType<typeof McpTask.parse>> {
  return present(await taskJob(deps, ctx, taskId))
}

export async function cancelQueueTask(
  deps: AppDeps,
  ctx: ActorContext,
  taskId: string,
): Promise<ReturnType<typeof McpTask.parse>> {
  const job = await taskJob(deps, ctx, taskId)
  if (job.status === 'queued' || job.status === 'running') {
    await cancel(deps.db, taskId, ctx.tenant)
  }
  return present(await taskJob(deps, ctx, taskId))
}

export async function getQueueTaskResult(
  deps: AppDeps,
  ctx: ActorContext,
  taskId: string,
): Promise<
  | ReturnType<typeof BulkAssertResult.parse>
  | ReturnType<typeof FindDuplicatesResult.parse>
  | ReturnType<typeof ExportResult.parse>
> {
  const job = await taskJob(deps, ctx, taskId)
  if (job.status !== 'completed' || job.result === null) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Task result is not available', {
      detail: 'task_not_completed',
    })
  }
  if (job.type === DEDUP_SCAN_JOB) return FindDuplicatesResult.parse(job.result)
  if (job.type === EXPORT_JOB) return ExportResult.parse(job.result)
  return BulkAssertResult.parse(job.result)
}
