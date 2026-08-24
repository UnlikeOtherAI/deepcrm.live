import { canonicalJson, Prisma, type Db, type QueueJob } from '@deepcrm/db'

export type QueueEnqueueTx = Pick<Db, 'queueJob'>
export type QueueCompleteTx = Pick<Db, 'queueJob'>
export type QueueCancelTx = Pick<Db, 'queueJob'>

type TenantJob = { organizationId: string; teamId: string }
type SystemJob = { organizationId?: never; teamId?: never }
export type EnqueueInput = (TenantJob | SystemJob) & {
  type: string
  payload: Prisma.InputJsonValue
  idempotencyKey?: string
  visibleAt?: Date
  priority?: number
  maxAttempts?: number
  matchesExistingPayload?: (payload: Prisma.JsonValue) => boolean
}

type ExistingJob = {
  id: string
  organizationId: string | null
  teamId: string | null
  type: string
  payload: Prisma.JsonValue
}

export class QueueIdempotencyMismatchError extends Error {
  constructor() {
    super('Queue job idempotency key arguments do not match')
  }
}

function sameJobScope(existing: ExistingJob, input: EnqueueInput): boolean {
  return existing.organizationId === (input.organizationId ?? null)
    && existing.teamId === (input.teamId ?? null)
    && existing.type === input.type
}

function duplicateIdempotencyKey(): never {
  throw new Error('Queue job idempotency key is already used by another job')
}

function storedJob(input: EnqueueInput) {
  return {
    type: input.type,
    payload: input.payload,
    organizationId: input.organizationId,
    teamId: input.teamId,
    idempotencyKey: input.idempotencyKey,
    visibleAt: input.visibleAt,
    priority: input.priority,
    maxAttempts: input.maxAttempts,
  }
}

async function existingJob(
  db: QueueEnqueueTx,
  input: EnqueueInput,
): Promise<{ id: string; created: false } | null> {
  if (input.idempotencyKey === undefined) return null
  const existing = await db.queueJob.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, organizationId: true, teamId: true, type: true, payload: true },
  })
  if (existing === null) return null
  if (!sameJobScope(existing, input)) duplicateIdempotencyKey()
  const payloadMatches = input.matchesExistingPayload?.(existing.payload)
    ?? canonicalJson(existing.payload) === canonicalJson(input.payload)
  if (!payloadMatches) {
    throw new QueueIdempotencyMismatchError()
  }
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
      data: storedJob(input),
      skipDuplicates: true,
    })
    const stored = await existingJob(db, input)
    if (stored === null) throw new Error('Queue idempotency row was not stored')
    return { id: stored.id, created: inserted.count === 1 }
  }
  const job = await db.queueJob.create({
    data: storedJob(input),
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
  const claimed = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE queue_jobs SET status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
    WHERE id = (SELECT id FROM queue_jobs WHERE ((status = 'queued' AND visible_at <= now()) OR (status = 'running' AND locked_at < now() - interval '10 minutes')) AND type = ANY(${types}) ORDER BY priority DESC, created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id
  `
  const id = claimed[0]?.id
  if (id === undefined) return null
  return db.queueJob.findUnique({ where: { id } })
}

export async function complete(
  db: QueueCompleteTx,
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
  db: QueueCancelTx,
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
  retryAt?: Date,
): Promise<boolean> {
  const job = await db.queueJob.findFirst({
    where: { id, lockedBy: workerId, status: 'running' },
    select: { attempts: true, maxAttempts: true },
  })
  if (job === null) return false
  const terminal = job.attempts >= job.maxAttempts
  const visibleAt = retryAt ?? new Date(Date.now() + Math.min(2 ** job.attempts, 60) * 60_000)
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
