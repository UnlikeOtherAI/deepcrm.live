import {
  tenantWhere,
  type ActorType,
  type ChangeKind,
  type TenantRef,
} from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import { canonicalJsonValue, type JsonValue } from './json.js'
import type { RecordTx } from '../schema/tx.js'

export type HistoryTx = RecordTx

export type HistoryVisibility = Readonly<{
  visibleAttributeSlugs?: ReadonlySet<string>
  visibleLinkDataSlugsByRelationType?: ReadonlyMap<string, ReadonlySet<string>>
  visibleLinkedRecordIds?: ReadonlySet<string>
}>

export type HistoricalLink = Readonly<{
  id: string
  relation_type: string
  from_record_id: string
  to_record_id: string
  label: string | null
  data: Readonly<Record<string, JsonValue>>
  active_from: string
  active_until: string | null
}>

export type RecordAtResult = Readonly<{
  data: Readonly<Record<string, JsonValue>>
  links: Readonly<Record<string, readonly HistoricalLink[]>>
  version_at: number
  as_of: string
}>

export type HistoryCursorState = Readonly<{
  occurredAt: string
  seq: string
  id: string
}>

export type HistoricalChange = Readonly<{
  id: string
  seq: string
  resulting_version: number
  record: Readonly<{ id: string; object_type: string; display_name: string }>
  group_id: string | null
  kind: ChangeKind
  attribute: string | null
  relation_type: string | null
  link_id: string | null
  old_value?: JsonValue
  new_value?: JsonValue
  actor: Readonly<{ type: ActorType; id: string }>
  on_behalf_of: string | null
  provenance: Readonly<{
    run_id: string | null
    tool_call_id: string | null
    request_id: string
  }>
  reason: string | null
  occurred_at: string
}>

export type RecordHistoryInput = HistoryVisibility & Readonly<{
  recordId: string
  attributes?: readonly string[]
  after?: HistoryCursorState
  limit?: number
}>

export type RecordHistoryPage = Readonly<{
  changes: readonly HistoricalChange[]
  next: HistoryCursorState | null
}>

type HistoryRow = Awaited<ReturnType<HistoryTx['recordChange']['findMany']>>[number]

function notFound(): ServiceError {
  return new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
}

function invalidCursor(): ServiceError {
  return new ServiceError(ErrorCode.VALIDATION_FAILED, 'History cursor does not match', {
    detail: 'cursor_mismatch',
  })
}

function visible(slug: string, options: HistoryVisibility): boolean {
  return options.visibleAttributeSlugs?.has(slug) ?? true
}

function objectData(value: unknown): Readonly<Record<string, JsonValue>> {
  const parsed = canonicalJsonValue(value)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new ServiceError(ErrorCode.INTERNAL, 'Stored link data is invalid')
  }
  return parsed
}

function visibleLinkData(
  value: unknown,
  relationType: string,
  options: HistoryVisibility,
): Readonly<Record<string, JsonValue>> {
  const data = objectData(value)
  const allowed = options.visibleLinkDataSlugsByRelationType?.get(relationType)
  if (allowed === undefined) return data
  return Object.fromEntries(Object.entries(data).filter(([slug]) => allowed.has(slug)))
}

function historicalValue(
  value: unknown,
  relationType: string | null,
  options: HistoryVisibility,
): JsonValue {
  const parsed = canonicalJsonValue(value)
  if (
    relationType === null
    || options.visibleLinkDataSlugsByRelationType === undefined
    || parsed === null
    || Array.isArray(parsed)
    || typeof parsed !== 'object'
    || parsed['data'] === undefined
  ) return parsed
  return { ...parsed, data: visibleLinkData(parsed['data'], relationType, options) }
}

function linkValueVisible(
  row: HistoryRow,
  recordId: string,
  options: HistoryVisibility,
): boolean {
  if (
    options.visibleLinkedRecordIds === undefined
    || (row.kind !== 'link' && row.kind !== 'unlink')
  ) return true
  const value = row.newValue ?? row.oldValue
  const parsed = canonicalJsonValue(value)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new ServiceError(ErrorCode.INTERNAL, 'Stored link change is invalid')
  }
  const from = parsed['from_record_id']
  const to = parsed['to_record_id']
  if (typeof from !== 'string' || typeof to !== 'string') {
    throw new ServiceError(ErrorCode.INTERNAL, 'Stored link endpoints are invalid')
  }
  const related = from === recordId ? to : (to === recordId ? from : null)
  return related !== null && options.visibleLinkedRecordIds.has(related)
}

function linkPosition(value: unknown, fallback: number | null): number | null {
  const parsed = canonicalJsonValue(value)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') return fallback
  return typeof parsed['position'] === 'number' ? parsed['position'] : fallback
}

function replayData(rows: readonly HistoryRow[], options: HistoryVisibility): Record<string, JsonValue> {
  const data: Record<string, JsonValue> = {}
  for (const row of rows) {
    const slug = row.attributeSlug
    if (slug === null || !visible(slug, options)) continue
    if (row.kind === 'unset') {
      delete data[slug]
      continue
    }
    if (row.kind !== 'set') continue
    if (row.newValue === null) {
      throw new ServiceError(ErrorCode.INTERNAL, 'Stored set change has no value')
    }
    data[slug] = canonicalJsonValue(row.newValue)
  }
  return data
}

function activeAt(
  row: { activeFrom: Date; activeUntil: Date | null },
  event: HistoryRow | undefined,
  at: Date,
): boolean {
  if (event !== undefined) return event.kind === 'link'
  return row.activeFrom <= at && (row.activeUntil === null || row.activeUntil > at)
}

async function historicalLinks(
  tx: HistoryTx,
  tenant: TenantRef,
  recordId: string,
  at: Date,
  changes: readonly HistoryRow[],
  options: HistoryVisibility,
): Promise<Readonly<Record<string, readonly HistoricalLink[]>>> {
  const events = new Map<string, HistoryRow>()
  for (const change of changes) {
    if ((change.kind === 'link' || change.kind === 'unlink') && change.linkId !== null) {
      events.set(change.linkId, change)
    }
  }
  const rows = await tx.recordLink.findMany({
    where: {
      ...tenantWhere(tenant),
      fromRecordId: recordId,
      activeFrom: { lte: at },
      relationType: { projectionAttributeSlug: { not: null } },
    },
    select: {
      id: true, fromRecordId: true, toRecordId: true, label: true, data: true,
      position: true, activeFrom: true, activeUntil: true,
      relationType: { select: { slug: true, projectionAttributeSlug: true } },
    },
  })
  const grouped = new Map<string, Array<{ link: HistoricalLink; position: number | null }>>()
  for (const row of rows) {
    const attribute = row.relationType.projectionAttributeSlug
    if (attribute === null || !visible(attribute, options)) continue
    if (
      options.visibleLinkedRecordIds !== undefined
      && !options.visibleLinkedRecordIds.has(row.toRecordId)
    ) continue
    const event = events.get(row.id)
    if (!activeAt(row, event, at)) continue
    const positionValue = event?.kind === 'link' ? event.newValue : null
    const item = {
      link: {
        id: row.id,
        relation_type: row.relationType.slug,
        from_record_id: row.fromRecordId,
        to_record_id: row.toRecordId,
        label: row.label,
        data: visibleLinkData(row.data, row.relationType.slug, options),
        active_from: row.activeFrom.toISOString(),
        active_until: row.activeUntil?.toISOString() ?? null,
      },
      position: linkPosition(positionValue, row.position),
    }
    const existing = grouped.get(attribute) ?? []
    existing.push(item)
    grouped.set(attribute, existing)
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([attribute, values]) => [attribute, values
      .sort((left, right) => {
        if (left.position === null && right.position !== null) return 1
        if (left.position !== null && right.position === null) return -1
        const positionOrder = (left.position ?? 0) - (right.position ?? 0)
        return positionOrder === 0 ? left.link.id.localeCompare(right.link.id) : positionOrder
      })
      .map(({ link }) => link)]))
}

export async function recordAt(
  tx: HistoryTx,
  tenant: TenantRef,
  recordId: string,
  at: Date,
  options: HistoryVisibility = {},
): Promise<RecordAtResult> {
  if (Number.isNaN(at.getTime())) throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Invalid history time')
  const record = await tx.record.findFirst({
    where: { ...tenantWhere(tenant), id: recordId },
    select: { id: true },
  })
  if (record === null) throw notFound()
  const rows = await tx.recordChange.findMany({
    where: { ...tenantWhere(tenant), recordId, occurredAt: { lte: at } },
    orderBy: [{ occurredAt: 'asc' }, { seq: 'asc' }],
  })
  let exists = false
  let created = false
  for (const row of rows) {
    if (row.kind === 'create') {
      exists = true
      created = true
    } else if (row.kind === 'delete') exists = false
    else if (row.kind === 'restore') exists = true
  }
  const latest = rows.at(-1)
  if (!created || !exists || latest === undefined) throw notFound()
  return {
    data: replayData(rows, options),
    links: await historicalLinks(tx, tenant, recordId, at, rows, options),
    version_at: latest.resultingVersion,
    as_of: at.toISOString(),
  }
}

function cursorValues(after: HistoryCursorState): { occurredAt: Date; seq: bigint; id: string } {
  const occurredAt = new Date(after.occurredAt)
  let seq: bigint
  try {
    seq = BigInt(after.seq)
  } catch {
    throw invalidCursor()
  }
  if (Number.isNaN(occurredAt.getTime()) || after.id.length === 0 || seq < 0n) throw invalidCursor()
  return { occurredAt, seq, id: after.id }
}

function cursor(row: HistoryRow): HistoryCursorState {
  return { occurredAt: row.occurredAt.toISOString(), seq: row.seq.toString(), id: row.id }
}

function serializeChange(
  row: HistoryRow,
  recordId: string,
  summary: { id: string; objectType: { slug: string }; displayName: string },
  relations: ReadonlyMap<string, { slug: string; projectionAttributeSlug: string | null }>,
  options: HistoryVisibility,
): HistoricalChange {
  const relation = row.relationTypeId === null ? undefined : relations.get(row.relationTypeId)
  const exposeAttribute = row.attributeSlug === null || visible(row.attributeSlug, options)
  const exposeReference = row.relationTypeId === null
    || (relation !== undefined && (
      relation.projectionAttributeSlug === null
      || visible(relation.projectionAttributeSlug, options)
    ))
  const exposeValues = exposeAttribute && exposeReference && linkValueVisible(row, recordId, options)
  const relationType = relation?.slug ?? null
  return {
    id: row.id,
    seq: row.seq.toString(),
    resulting_version: row.resultingVersion,
    record: { id: summary.id, object_type: summary.objectType.slug, display_name: summary.displayName },
    group_id: row.groupId,
    kind: row.kind,
    attribute: row.attributeSlug,
    relation_type: relationType,
    link_id: row.linkId,
    ...(exposeValues && row.oldValue !== null
      ? { old_value: historicalValue(row.oldValue, relationType, options) } : {}),
    ...(exposeValues && row.newValue !== null
      ? { new_value: historicalValue(row.newValue, relationType, options) } : {}),
    actor: { type: row.actorType, id: row.actorId },
    on_behalf_of: row.onBehalfOf,
    provenance: { run_id: row.runId, tool_call_id: row.toolCallId, request_id: row.requestId },
    reason: row.reason,
    occurred_at: row.occurredAt.toISOString(),
  }
}

export async function recordHistory(
  tx: HistoryTx,
  tenant: TenantRef,
  input: RecordHistoryInput,
): Promise<RecordHistoryPage> {
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'History limit is invalid')
  }
  const summary = await tx.record.findFirst({
    where: { ...tenantWhere(tenant), id: input.recordId },
    select: { id: true, displayName: true, objectType: { select: { slug: true } } },
  })
  if (summary === null) throw notFound()
  const after = input.after === undefined ? undefined : cursorValues(input.after)
  const rows = await tx.recordChange.findMany({
    where: {
      ...tenantWhere(tenant),
      recordId: input.recordId,
      ...(input.attributes === undefined ? {} : { attributeSlug: { in: [...input.attributes] } }),
      ...(after === undefined ? {} : {
        OR: [
          { occurredAt: { lt: after.occurredAt } },
          { occurredAt: after.occurredAt, seq: { lt: after.seq } },
          { occurredAt: after.occurredAt, seq: after.seq, id: { lt: after.id } },
        ],
      }),
    },
    orderBy: [{ occurredAt: 'desc' }, { seq: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  })
  const page = rows.slice(0, limit)
  const relationIds = [...new Set(page.flatMap((row) => row.relationTypeId === null ? [] : [row.relationTypeId]))]
  const relationRows = relationIds.length === 0 ? [] : await tx.$queryRaw<Array<{
    id: string; slug: string; projection_attribute_slug: string | null
  }>>`
    SELECT id, slug, projection_attribute_slug FROM relation_types
    WHERE organization_id = ${tenant.organizationId}::uuid
      AND team_id = ${tenant.teamId}::uuid
      AND id = ANY(${relationIds}::uuid[])
  `
  const relations = new Map(relationRows.map((relation) => [relation.id, {
    slug: relation.slug, projectionAttributeSlug: relation.projection_attribute_slug,
  }]))
  return {
    changes: page.map((row) => serializeChange(row, input.recordId, summary, relations, input)),
    next: rows.length > limit && page.length > 0 ? cursor(page[page.length - 1] as HistoryRow) : null,
  }
}
