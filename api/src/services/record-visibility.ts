import { tenantWhere, type Db, type Prisma } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

export type VisibleRecord = { id: string; objectTypeId: string }

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
  const details = { ...error.details }
  delete details['record_id']
  delete details['record_ids']
  delete details['candidates']
  throw new ServiceError(error.code, error.message, details)
}
