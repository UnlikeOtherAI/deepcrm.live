import { Prisma, type Db, type QueueJob } from '@deepcrm/db'

type TenantJob = { organizationId: string; teamId: string }
type SystemJob = { organizationId?: never; teamId?: never }
export type EnqueueInput = (TenantJob | SystemJob) & {
  type: string
  payload: Prisma.InputJsonValue
  idempotencyKey?: string
  visibleAt?: Date
  priority?: number
  maxAttempts?: number
}

export async function enqueue(
  db: Db,
  input: EnqueueInput,
): Promise<{ id: string; created: boolean }> {
  if (input.idempotencyKey !== undefined) {
    const existing = await db.queueJob.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    })
    if (existing !== null) return { id: existing.id, created: false }
  }
  const job = await db.queueJob.create({
    data: { ...input, visibleAt: input.visibleAt, priority: input.priority, maxAttempts: input.maxAttempts },
    select: { id: true },
  })
  return { id: job.id, created: true }
}

export async function claimNext(
  db: Db,
  workerId: string,
  types: string[],
): Promise<QueueJob | null> {
  if (types.length === 0) return null
  const jobs = await db.$queryRaw<QueueJob[]>`
    UPDATE queue_jobs SET status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
    WHERE id = (SELECT id FROM queue_jobs WHERE ((status = 'queued' AND visible_at <= now()) OR (status = 'running' AND locked_at < now() - interval '10 minutes')) AND type = ANY(${types}) ORDER BY priority DESC, created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *
  `
  return jobs[0] ?? null
}

export async function complete(
  db: Db,
  id: string,
  workerId: string,
  result: Prisma.InputJsonValue | null,
): Promise<boolean> {
  const update = await db.queueJob.updateMany({
    where: { id, lockedBy: workerId, status: 'running' },
    data: {
      status: 'completed',
      result: result === null ? Prisma.JsonNull : result,
      lockedAt: null,
      lockedBy: null,
    },
  })
  return update.count === 1
}
export async function progress(
  db: Db,
  id: string,
  workerId: string,
  value: Prisma.InputJsonValue,
): Promise<boolean> {
  const update = await db.queueJob.updateMany({
    where: { id, lockedBy: workerId, status: 'running' },
    data: { progress: value },
  })
  return update.count === 1
}
export async function cancel(
  db: Db,
  id: string,
  tenant: TenantJob,
): Promise<boolean> {
  const update = await db.queueJob.updateMany({
    where: {
      id,
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      status: { in: ['queued', 'running'] },
    },
    data: { status: 'cancelled' },
  })
  return update.count === 1
}
export async function fail(
  db: Db,
  id: string,
  workerId: string,
  error: string,
): Promise<boolean> {
  const job = await db.queueJob.findFirst({
    where: { id, lockedBy: workerId, status: 'running' },
    select: { attempts: true, maxAttempts: true },
  })
  if (job === null) return false
  const terminal = job.attempts >= job.maxAttempts
  const visibleAt = new Date(Date.now() + Math.min(2 ** job.attempts, 60) * 60_000)
  const data = terminal
    ? { status: 'failed' as const, lastError: error }
    : {
        status: 'queued' as const,
        lastError: error,
        visibleAt,
        lockedAt: null,
        lockedBy: null,
      }
  const update = await db.queueJob.updateMany({
    where: { id, lockedBy: workerId, status: 'running' },
    data,
  })
  return update.count === 1
}
