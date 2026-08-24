import { tenantWhere } from '@deepcrm/db'
import { loadSchema, projectLinksIntoData, type QueryRecord } from '@deepcrm/schema-engine'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { loadPolicyEvaluator, type PolicyRequest, type PolicyScopeRef } from './policy.js'
import { recordBoundary } from './record-boundary.js'
import { asQueryRecord } from './record-read.js'
import { findVisibleLiveRecords } from './record-visibility.js'
import { buildRedactionMatrix, redactForActor, type RecordOut } from './redact.js'

export type RecordsGetManyResult = {
  records: RecordOut[]
  missing: string[]
}

function recordScopes(ctx: ActorContext, record: QueryRecord): PolicyScopeRef[] {
  return [
    { scope: 'team', id: ctx.tenant.teamId },
    { scope: 'object_type', id: record.objectTypeId },
    { scope: 'record', id: record.id },
  ]
}

function recordRequest(ctx: ActorContext, record: QueryRecord): PolicyRequest {
  return { resourceType: 'record', action: 'view', scopes: recordScopes(ctx, record) }
}

export async function getManyRecords(
  deps: AppDeps,
  ctx: ActorContext,
  ids: readonly string[],
): Promise<RecordsGetManyResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const visible = await findVisibleLiveRecords(deps.db, ctx, ids)
    const visibleIds = visible.map((record) => record.id)
    const rows = visibleIds.length === 0 ? [] : await deps.db.record.findMany({
      where: {
        ...tenantWhere(ctx.tenant),
        id: { in: visibleIds },
        deletedAt: null,
        mergedIntoId: null,
        erasedAt: null,
      },
      select: {
        id: true,
        objectTypeId: true,
        data: true,
        displayName: true,
        ownerType: true,
        ownerId: true,
        visibility: true,
        createdOnBehalfOf: true,
        origin: true,
        version: true,
        lastActivityAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    const schema = await loadSchema(deps.db, ctx.tenant)
    const candidates = rows.map(asQueryRecord).filter((record) => (
      schema.objectTypesById.get(record.objectTypeId)?.archivedAt === null
    ))
    const requests = candidates.map((record) => recordRequest(ctx, record))
    const evaluator = await loadPolicyEvaluator(deps.db, ctx, [
      ...requests,
      {
        resourceType: 'attribute',
        action: 'view',
        scopes: [{ scope: 'team', id: ctx.tenant.teamId }],
      },
    ])
    const permittedRows = candidates.filter((record) => {
      const decision = evaluator.evaluate(recordRequest(ctx, record))
      return decision.allowed && !decision.requiresApproval
    })
    const links = permittedRows.length === 0 ? [] : await deps.db.recordLink.findMany({
      where: {
        organizationId: ctx.tenant.organizationId,
        teamId: ctx.tenant.teamId,
        fromRecordId: { in: permittedRows.map((record) => record.id) },
        activeUntil: null,
      },
      select: {
        fromRecordId: true,
        relationTypeId: true,
        toRecordId: true,
        position: true,
      },
    })
    const linksByRecord = new Map<string, typeof links>()
    for (const link of links) {
      linksByRecord.set(link.fromRecordId, [...(linksByRecord.get(link.fromRecordId) ?? []), link])
    }
    const permitted = permittedRows.map((record) => {
      const objectType = schema.objectTypesById.get(record.objectTypeId)
      if (objectType === undefined) {
        throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Record object type is not in the schema')
      }
      return {
        ...record,
        data: {
          ...record.data,
          ...projectLinksIntoData(schema, objectType.slug, linksByRecord.get(record.id) ?? []),
        },
      }
    })
    const matrix = buildRedactionMatrix(evaluator, ctx, schema, permitted)
    const recordsById = new Map(permitted.map((record) => [
      record.id,
      redactForActor(ctx, schema, record, matrix),
    ]))
    const records: RecordOut[] = []
    const missing: string[] = []
    for (const id of ids) {
      const record = recordsById.get(id)
      if (record === undefined) missing.push(id)
      else records.push(record)
    }
    return { records, missing }
  })
}
