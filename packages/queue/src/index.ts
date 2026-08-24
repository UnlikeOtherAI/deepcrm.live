import { Prisma, type Db, type QueueJob } from '@deepcrm/db'

export type QueueEnqueueTx = Pick<Db, 'queueJob'>

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

type ExistingJob = {
  id: string
  organizationId: string | null
  teamId: string | null
  type: string
}

function sameJobScope(existing: ExistingJob, input: EnqueueInput): boolean {
  return existing.organizationId === (input.organizationId ?? null)
    && existing.teamId === (input.teamId ?? null)
    && existing.type === input.type
}

function duplicateIdempotencyKey(): never {
  throw new Error('Queue job idempotency key is already used by another job')
}

async function existingJob(
  db: QueueEnqueueTx,
  input: EnqueueInput,
): Promise<{ id: string; created: false } | null> {
  if (input.idempotencyKey === undefined) return null
  const existing = await db.queueJob.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, organizationId: true, teamId: true, type: true },
  })
  if (existing === null) return null
  if (!sameJobScope(existing, input)) duplicateIdempotencyKey()
  return { id: existing.id, created: false }
}

export async function enqueue(
  db: QueueEnqueueTx,
  input: EnqueueInput,
): Promise<{ id: string; created: boolean }> {
  const existing = await existingJob(db, input)
  if (existing !== null) return existing
  if (input.idempotencyKey !== undefined) {
    const inserted = await db.queueJob.createMany({
      data: { ...input, visibleAt: input.visibleAt, priority: input.priority, maxAttempts: input.maxAttempts },
      skipDuplicates: true,
    })
    const stored = await existingJob(db, input)
    if (stored === null) throw new Error('Queue idempotency row was not stored')
    return { id: stored.id, created: inserted.count === 1 }
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
