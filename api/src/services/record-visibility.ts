import { tenantWhere, type Db, type Prisma } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

export type VisibleRecord = { id: string; objectTypeId: string }
export type ResolvedVisibleRecord = { record: VisibleRecord; redirectedFrom?: string }

function visibleWhere(ctx: ActorContext): Prisma.RecordWhereInput {
  return {
    ...tenantWhere(ctx.tenant),
    OR: [
      { visibility: 'team' },
      { createdOnBehalfOf: ctx.onBehalfOf.uoaUserId },
      {
        visibility: 'users',
        visibilityGrants: { some: { uoaUserId: ctx.onBehalfOf.uoaUserId } },
      },
    ],
  }
}

export async function findVisibleRecord(
  db: Db,
  ctx: ActorContext,
  recordId: string,
): Promise<VisibleRecord | null> {
  return db.record.findFirst({
    where: { ...visibleWhere(ctx), id: recordId },
    select: { id: true, objectTypeId: true },
  })
}

export async function findVisibleLiveRecords(
  db: Db,
  ctx: ActorContext,
  recordIds: readonly string[],
): Promise<readonly VisibleRecord[]> {
  if (recordIds.length === 0) return []
  return db.record.findMany({
    where: {
      ...visibleWhere(ctx),
      id: { in: [...new Set(recordIds)] },
      deletedAt: null,
      mergedIntoId: null,
    },
    select: { id: true, objectTypeId: true },
    orderBy: { id: 'asc' },
  })
}

export async function requireVisibleRecord(
  db: Db,
  ctx: ActorContext,
  recordId: string,
): Promise<VisibleRecord> {
  const record = await findVisibleRecord(db, ctx, recordId)
  if (record === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  return record
}

export async function resolveVisibleRecord(
  db: Db,
  ctx: ActorContext,
  recordId: string,
): Promise<ResolvedVisibleRecord> {
  const original = await requireVisibleRecord(db, ctx, recordId)
  const state = await db.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: original.id },
    select: { mergedIntoId: true },
  })
  if (state === null || state.mergedIntoId === null) return { record: original }
  const survivor = await requireVisibleRecord(db, ctx, state.mergedIntoId)
  const survivorState = await db.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: survivor.id },
    select: { deletedAt: true, erasedAt: true, mergedIntoId: true },
  })
  if (
    survivorState === null
    || survivorState.deletedAt !== null
    || survivorState.erasedAt !== null
    || survivorState.mergedIntoId !== null
  ) {
    throw new ServiceError(ErrorCode.MERGED, 'Merged record survivor is unavailable', {
      redirect_to: survivor.id,
    })
  }
  return { record: survivor, redirectedFrom: recordId }
}

export async function redactInvisibleDuplicate(
  db: Db,
  ctx: ActorContext,
  error: unknown,
): Promise<never> {
  if (!(error instanceof ServiceError) || error.code !== ErrorCode.DUPLICATE_FOUND) throw error
  const recordId = error.details['record_id']
  if (
    typeof recordId === 'string'
    && await findVisibleRecord(db, ctx, recordId) !== null
  ) throw error
  const recordIds = error.details['record_ids']
  if (Array.isArray(recordIds) && recordIds.every((id): id is string => typeof id === 'string')) {
    const visible = await findVisibleLiveRecords(db, ctx, recordIds)
    if (visible.length === recordIds.length) throw error
  }
  const details = { ...error.details }
  delete details['record_id']
  delete details['record_ids']
  delete details['candidates']
  throw new ServiceError(error.code, error.message, details)
}
