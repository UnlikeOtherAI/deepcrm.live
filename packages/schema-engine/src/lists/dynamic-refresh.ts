import { tenantWhere, type Db, type TenantRef, type writeAudit } from '@deepcrm/db'
import { ErrorCode, Filter, ServiceError, type ActorContext } from '@deepcrm/schemas'

import { queryRecords, type QueryCursorState } from '../query/index.js'
import { loadSchema } from '../schema/load.js'

export type DynamicListRefreshResult = {
  listId: string
  evaluationVersion: number
  members: number
}

type AuditWriter = typeof writeAudit

function definitionFilter(definition: unknown) {
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Stored dynamic list definition is invalid')
  }
  return Filter.parse(Object.fromEntries(Object.entries(definition)).filter)
}

async function visibleMemberIds(
  db: Db,
  tenant: TenantRef,
  ctx: ActorContext,
  objectTypeSlug: string,
  filter: ReturnType<typeof definitionFilter>,
): Promise<string[]> {
  const schema = await loadSchema(db, tenant, { useCache: false })
  const objectType = schema.objectTypesBySlug.get(objectTypeSlug)
  if (objectType === undefined) throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type does not exist')
  const ids: string[] = []
  let after: QueryCursorState | undefined
  do {
    const page = await queryRecords(db, tenant, ctx, schema, objectType, {
      filter,
      sort: [{ system: 'created_at', direction: 'asc' }],
      limit: 200,
      ...(after === undefined ? {} : { after }),
    })
    ids.push(...page.records.map((record) => record.id))
    after = page.next ?? undefined
  } while (after !== undefined)
  return ids
}

async function writeMembership(
  db: Db,
  tenant: TenantRef,
  ctx: ActorContext,
  listId: string,
  evaluationVersion: number,
  memberIds: readonly string[],
  now: Date,
  audit: AuditWriter,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const list = await tx.list.findFirst({
      where: { ...tenantWhere(tenant), id: listId, kind: 'dynamic', evaluationVersion },
      select: { id: true },
    })
    if (list === null) return
    await tx.$executeRaw`
      DELETE FROM list_entries le USING lists l
      WHERE le.list_id = l.id AND l.id = ${listId}::uuid
        AND l.organization_id = ${tenant.organizationId}::uuid
        AND l.team_id = ${tenant.teamId}::uuid
    `
    for (let index = 0; index < memberIds.length; index += 500) {
      const batch = memberIds.slice(index, index + 500)
      await tx.listEntry.createMany({
        data: batch.map((recordId, offset) => ({
          listId,
          recordId,
          data: {},
          position: index + offset,
        })),
        skipDuplicates: true,
      })
    }
    await tx.list.updateMany({
      where: { ...tenantWhere(tenant), id: listId },
      data: { refreshState: 'ready', refreshErrorCode: null, lastEvaluatedAt: now },
    })
    await audit(tx, {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      onBehalfOf: ctx.onBehalfOf.uoaUserId,
      action: 'crm_dynamic_list_refresh',
      resourceType: 'list',
      resourceId: listId,
      outcome: 'success',
      reason: null,
      metadata: { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance },
      requestId: ctx.requestId,
      ipAddress: null,
      userAgent: null,
    })
  })
}

export async function refreshDynamicListMembership(
  db: Db,
  tenant: TenantRef,
  ctx: ActorContext,
  listId: string,
  evaluationVersion: number,
  now: Date,
  audit: AuditWriter,
): Promise<DynamicListRefreshResult> {
  const schema = await loadSchema(db, tenant, { useCache: false })
  const loaded = schema.listsById.get(listId)
  if (loaded === undefined) throw new ServiceError(ErrorCode.NOT_FOUND, 'List not found')
  if (loaded.kind !== 'dynamic' || loaded.objectTypeId === null || loaded.evaluationVersion !== evaluationVersion) {
    return { listId, evaluationVersion, members: 0 }
  }
  const objectType = schema.objectTypesById.get(loaded.objectTypeId)
  if (objectType === undefined) throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type does not exist')
  await db.list.updateMany({
    where: { ...tenantWhere(tenant), id: listId },
    data: { refreshState: 'refreshing', refreshErrorCode: null },
  })
  try {
    const memberIds = await visibleMemberIds(db, tenant, ctx, objectType.slug, definitionFilter(loaded.definition))
    await writeMembership(db, tenant, ctx, listId, evaluationVersion, memberIds, now, audit)
    return { listId, evaluationVersion, members: memberIds.length }
  } catch (error: unknown) {
    await db.list.updateMany({
      where: { ...tenantWhere(tenant), id: listId },
      data: { refreshState: 'failed', refreshErrorCode: error instanceof Error ? error.message : 'refresh_failed' },
    })
    throw error
  }
}
