import { tenantWhere } from '@deepcrm/db'
import {
  recordChangesByIds,
  type HistoricalChange,
  type LoadedSchema,
  type QueryRecord,
  type TimelineItem as EngineTimelineItem,
} from '@deepcrm/schema-engine'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import type { HistoryAccess } from './record-history.js'
import { loadPolicyEvaluator } from './policy.js'
import { buildRedactionMatrix, redactForActor, type RecordOut } from './redact.js'

export type PresentedTimelineItem =
  | { kind: 'change'; change: HistoricalChange; occurred_at: string }
  | {
    kind: 'activity' | 'note' | 'task'
    record: RecordOut
    about: Array<Pick<RecordOut, 'id' | 'object_type' | 'display_name'>>
    occurred_at: string
  }

type RecordRow = Omit<QueryRecord, 'data'> & { data: unknown }
type JsonValue = QueryRecord['data'][string]

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return typeof value === 'object' && value !== null && Object.values(value).every(isJsonValue)
}

function isJsonObject(value: unknown): value is QueryRecord['data'] {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(isJsonValue)
}

function queryRecord(row: RecordRow): QueryRecord {
  if (!isJsonObject(row.data)) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Timeline record data is invalid')
  }
  return { ...row, data: row.data }
}

function missing(kind: 'change' | 'record'): never {
  throw new ServiceError(ErrorCode.INTERNAL, `Timeline ${kind} is missing`)
}

function summary(record: RecordOut): Pick<RecordOut, 'id' | 'object_type' | 'display_name'> {
  return {
    id: record.id,
    object_type: record.object_type,
    display_name: record.display_name,
  }
}

export async function presentTimelineItems(
  deps: AppDeps,
  ctx: ActorContext,
  schema: LoadedSchema,
  anchorId: string,
  items: readonly EngineTimelineItem[],
  historyAccess: HistoryAccess,
): Promise<PresentedTimelineItem[]> {
  const recordIds = [...new Set(items.flatMap((item) => (
    item.kind === 'change' ? [] : [item.recordId, ...item.aboutRecordIds]
  )))]
  const changeIds = items.flatMap((item) => item.kind === 'change' ? [item.changeId] : [])
  const [rows, changes, evaluator] = await Promise.all([
    recordIds.length === 0 ? [] : deps.db.record.findMany({
      where: {
        ...tenantWhere(ctx.tenant), id: { in: recordIds }, deletedAt: null,
        mergedIntoId: null, erasedAt: null,
      },
      select: {
        id: true, objectTypeId: true, data: true, displayName: true, ownerType: true,
        ownerId: true, visibility: true, createdOnBehalfOf: true, origin: true,
        version: true, lastActivityAt: true, createdAt: true, updatedAt: true,
      },
    }),
    recordChangesByIds(deps.db, ctx.tenant, {
      recordId: anchorId,
      ids: changeIds,
      ...historyAccess,
    }),
    loadPolicyEvaluator(deps.db, ctx, [{
      resourceType: 'attribute',
      action: 'view',
      scopes: [{ scope: 'team', id: ctx.tenant.teamId }],
    }]),
  ])
  const records = rows.map(queryRecord)
  if (records.length !== recordIds.length) missing('record')
  const matrix = buildRedactionMatrix(evaluator, ctx, schema, records)
  const presented = new Map(records.map((record) => [
    record.id,
    redactForActor(ctx, schema, record, matrix),
  ]))
  const changesById = new Map(changes.map((change) => [change.id, change]))
  return items.map((item) => {
    if (item.kind === 'change') {
      const change = changesById.get(item.changeId)
      if (change === undefined) return missing('change')
      return { kind: 'change', change, occurred_at: item.occurredAt }
    }
    const record = presented.get(item.recordId)
    if (record === undefined) return missing('record')
    return {
      kind: item.kind,
      record,
      about: item.aboutRecordIds.map((id) => {
        const about = presented.get(id)
        return about === undefined ? missing('record') : summary(about)
      }),
      occurred_at: item.occurredAt,
    }
  })
}
