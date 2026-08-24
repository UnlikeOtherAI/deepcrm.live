import { Prisma, type Db, type TenantRef } from '@deepcrm/db'
import {
  ErrorCode,
  ServiceError,
  Slug,
  Uuid,
  type ActorContext,
} from '@deepcrm/schemas'

import { rowAccess } from '../records/visibility.js'
import type {
  LoadedObjectType,
  LoadedRelationType,
  LoadedSchema,
} from '../schema/load.js'

export type TimelineTx = Pick<Db, '$queryRaw'>

export type TimelineKind = 'activity' | 'change' | 'note' | 'task'
export type TimelineSystemKind = Exclude<TimelineKind, 'change'>

export type TimelineCursorState = Readonly<{
  occurredAt: string
  kind: TimelineKind
  id: string
}>

export type TimelineInput = Readonly<{
  hops?: 0 | 1
  kinds?: readonly TimelineKind[]
  relationTypes?: readonly string[]
  since?: Date
  after?: TimelineCursorState
  limit?: number
}>

export type TimelineRecordItem = Readonly<{
  kind: TimelineSystemKind
  recordId: string
  aboutRecordIds: readonly string[]
  occurredAt: string
}>

export type TimelineChangeItem = Readonly<{
  kind: 'change'
  changeId: string
  recordId: string
  occurredAt: string
}>

export type TimelineItem = TimelineRecordItem | TimelineChangeItem

export type TimelinePage = Readonly<{
  items: readonly TimelineItem[]
  next: TimelineCursorState | null
}>

type NormalizedInput = Readonly<{
  hops: 0 | 1
  kinds: readonly TimelineKind[]
  relationIds: readonly string[]
  since?: Date
  after?: Readonly<{ occurredAt: Date; kind: TimelineKind; id: string }>
  limit: number
}>

type SystemDefinition = Readonly<{
  kind: TimelineSystemKind
  objectType: LoadedObjectType
  relation: LoadedRelationType
}>

type TimelineRow = {
  kind: string
  id: string
  record_id: string
  occurred_at: Date
  about_record_ids: string[]
}

const allKinds: readonly TimelineKind[] = ['activity', 'change', 'note', 'task']

function invalid(message: string, detail: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, message, { detail })
}

function isTimelineKind(value: unknown): value is TimelineKind {
  return typeof value === 'string' && allKinds.some((kind) => kind === value)
}

function isSystemKind(value: TimelineKind): value is TimelineSystemKind {
  return value !== 'change'
}

function assertScope(
  tenant: TenantRef,
  ctx: ActorContext,
  schema: LoadedSchema,
): readonly LoadedObjectType[] {
  if (
    tenant.organizationId !== ctx.tenant.organizationId
    || tenant.teamId !== ctx.tenant.teamId
    || schema.teamId !== tenant.teamId
  ) {
    throw new ServiceError(ErrorCode.TENANT_MISMATCH, 'Timeline tenant does not match')
  }
  const active = schema.objectTypes.filter((objectType) => objectType.archivedAt === null)
  if (
    active.length === 0
    || active.some((objectType) => (
      objectType.organizationId !== tenant.organizationId || objectType.teamId !== tenant.teamId
    ))
    || schema.relationTypes.some((relation) => (
      relation.organizationId !== tenant.organizationId || relation.teamId !== tenant.teamId
    ))
  ) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Timeline schema does not match tenant')
  }
  return active
}

function normalizedKinds(values: readonly TimelineKind[] | undefined): readonly TimelineKind[] {
  if (values === undefined) return allKinds
  for (const value of values) {
    if (!isTimelineKind(value)) invalid('Timeline kind is invalid', 'invalid_kind')
  }
  return [...new Set(values)]
}

function activeRelation(
  schema: LoadedSchema,
  slug: string,
): LoadedRelationType {
  if (!Slug.safeParse(slug).success) invalid('Timeline relation type is invalid', 'invalid_relation')
  const relation = schema.relationTypesBySlug.get(slug)
  if (relation === undefined || relation.archivedAt !== null) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Timeline relation type is not active', {
      relation_type: slug,
    })
  }
  return relation
}

function relationIds(
  schema: LoadedSchema,
  requested: readonly string[] | undefined,
): readonly string[] {
  if (requested !== undefined) {
    return [...new Set(requested)].map((slug) => activeRelation(schema, slug).id)
  }
  return schema.relationTypes
    .filter((relation) => relation.archivedAt === null)
    .map((relation) => relation.id)
}

function normalizedInput(schema: LoadedSchema, input: TimelineInput): NormalizedInput {
  const hops = input.hops ?? 0
  if (hops !== 0 && hops !== 1) invalid('Timeline hops is invalid', 'invalid_hops')
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    invalid('Timeline limit is invalid', 'invalid_limit')
  }
  if (input.since !== undefined && Number.isNaN(input.since.getTime())) {
    invalid('Timeline since is invalid', 'invalid_since')
  }
  let after: NormalizedInput['after']
  if (input.after !== undefined) {
    const occurredAt = new Date(input.after.occurredAt)
    if (
      Number.isNaN(occurredAt.getTime())
      || !isTimelineKind(input.after.kind)
      || !Uuid.safeParse(input.after.id).success
    ) invalid('Timeline cursor does not match', 'cursor_mismatch')
    after = { occurredAt, kind: input.after.kind, id: input.after.id }
  }
  return {
    hops,
    kinds: normalizedKinds(input.kinds),
    relationIds: relationIds(schema, input.relationTypes),
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(after === undefined ? {} : { after }),
    limit,
  }
}

function anyRecordAccess(
  tenant: TenantRef,
  ctx: ActorContext,
  objectTypes: readonly LoadedObjectType[],
): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(
    objectTypes.map((objectType) => rowAccess(tenant, ctx, objectType)),
    ' OR ',
  )})`
}

function systemDefinition(
  tenant: TenantRef,
  schema: LoadedSchema,
  kind: TimelineSystemKind,
): SystemDefinition {
  const objectType = schema.objectTypesBySlug.get(kind)
  const relation = schema.relationTypesBySlug.get(`${kind}_about`)
  if (
    objectType === undefined
    || objectType.archivedAt !== null
    || objectType.kind !== 'system'
    || objectType.organizationId !== tenant.organizationId
    || objectType.teamId !== tenant.teamId
    || relation === undefined
    || relation.archivedAt !== null
    || !relation.isSystem
    || relation.fromObjectTypeId !== objectType.id
    || relation.toObjectTypeId !== null
  ) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Timeline system schema is invalid', {
      kind,
    })
  }
  return { kind, objectType, relation }
}

function idPredicate(column: Prisma.Sql, ids: readonly string[]): Prisma.Sql {
  if (ids.length === 0) return Prisma.sql`false`
  return Prisma.sql`${column} IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`
}

function systemBranch(
  tenant: TenantRef,
  ctx: ActorContext,
  definition: SystemDefinition,
): Prisma.Sql {
  const occurredAt = definition.kind === 'activity'
    ? Prisma.sql`(r.data ->> 'occurred_at')::timestamptz`
    : Prisma.sql`r.created_at`
  return Prisma.sql`
    SELECT ${definition.kind}::text AS kind,
      r.id,
      r.id AS record_id,
      ${occurredAt} AS occurred_at,
      ${definition.relation.id}::uuid AS about_relation_id
    FROM records r
    WHERE ${rowAccess(tenant, ctx, definition.objectType)}
      AND r.erased_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM record_links about
        JOIN neighborhood target ON target.id = about.to_record_id
        WHERE about.organization_id = ${tenant.organizationId}::uuid
          AND about.team_id = ${tenant.teamId}::uuid
          AND about.relation_type_id = ${definition.relation.id}::uuid
          AND about.from_record_id = r.id
          AND about.active_until IS NULL
      )`
}

function changeBranch(tenant: TenantRef, recordId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT 'change'::text AS kind,
      change.id,
      change.record_id,
      change.occurred_at,
      NULL::uuid AS about_relation_id
    FROM record_changes change
    WHERE change.organization_id = ${tenant.organizationId}::uuid
      AND change.team_id = ${tenant.teamId}::uuid
      AND change.record_id = ${recordId}::uuid`
}

function kindRank(kind: TimelineKind): number {
  switch (kind) {
    case 'activity': return 4
    case 'change': return 3
    case 'note': return 2
    case 'task': return 1
  }
}

function candidates(
  tenant: TenantRef,
  ctx: ActorContext,
  schema: LoadedSchema,
  recordId: string,
  kinds: readonly TimelineKind[],
): Prisma.Sql {
  const branches = kinds.map((kind) => isSystemKind(kind)
    ? systemBranch(tenant, ctx, systemDefinition(tenant, schema, kind))
    : changeBranch(tenant, recordId))
  return Prisma.join(branches, ' UNION ALL ')
}

function rowItem(row: TimelineRow): TimelineItem {
  if (
    !isTimelineKind(row.kind)
    || !Uuid.safeParse(row.id).success
    || !Uuid.safeParse(row.record_id).success
    || !(row.occurred_at instanceof Date)
    || Number.isNaN(row.occurred_at.getTime())
    || !Array.isArray(row.about_record_ids)
    || row.about_record_ids.some((id) => !Uuid.safeParse(id).success)
  ) {
    throw new ServiceError(ErrorCode.INTERNAL, 'Timeline query returned an invalid row')
  }
  const occurredAt = row.occurred_at.toISOString()
  if (row.kind === 'change') {
    return { kind: 'change', changeId: row.id, recordId: row.record_id, occurredAt }
  }
  return {
    kind: row.kind,
    recordId: row.record_id,
    aboutRecordIds: row.about_record_ids,
    occurredAt,
  }
}

export async function timeline(
  tx: TimelineTx,
  tenant: TenantRef,
  ctx: ActorContext,
  schema: LoadedSchema,
  recordId: string,
  input: TimelineInput,
): Promise<TimelinePage> {
  if (!Uuid.safeParse(recordId).success) invalid('Timeline record id is invalid', 'invalid_record_id')
  const objectTypes = assertScope(tenant, ctx, schema)
  const normalized = normalizedInput(schema, input)
  const access = anyRecordAccess(tenant, ctx, objectTypes)
  const anchor = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT r.id
    FROM records r
    WHERE r.id = ${recordId}::uuid
      AND ${access}
      AND r.erased_at IS NULL
    LIMIT 1`)
  if (anchor.length === 0) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  if (normalized.kinds.length === 0) return { items: [], next: null }

  const hopRelations = idPredicate(Prisma.sql`hop.relation_type_id`, normalized.relationIds)
  const union = candidates(tenant, ctx, schema, recordId, normalized.kinds)
  const since = normalized.since === undefined
    ? Prisma.sql`true`
    : Prisma.sql`ranked.occurred_at >= ${normalized.since}`
  const after = normalized.after === undefined
    ? Prisma.sql`true`
    : Prisma.sql`(
      ranked.occurred_at < ${normalized.after.occurredAt}
      OR (ranked.occurred_at = ${normalized.after.occurredAt}
        AND ranked.kind_rank < ${kindRank(normalized.after.kind)})
      OR (ranked.occurred_at = ${normalized.after.occurredAt}
        AND ranked.kind_rank = ${kindRank(normalized.after.kind)}
        AND ranked.id < ${normalized.after.id}::uuid)
    )`
  const rows = await tx.$queryRaw<TimelineRow[]>(Prisma.sql`
    WITH neighborhood AS (
      SELECT ${recordId}::uuid AS id
      UNION
      SELECT r.id
      FROM record_links hop
      JOIN records r ON r.id = CASE
        WHEN hop.from_record_id = ${recordId}::uuid THEN hop.to_record_id
        ELSE hop.from_record_id
      END
      WHERE ${normalized.hops === 1}
        AND hop.organization_id = ${tenant.organizationId}::uuid
        AND hop.team_id = ${tenant.teamId}::uuid
        AND hop.active_until IS NULL
        AND (hop.from_record_id = ${recordId}::uuid OR hop.to_record_id = ${recordId}::uuid)
        AND ${hopRelations}
        AND ${access}
        AND r.erased_at IS NULL
    ), candidate_items AS (
      ${union}
    ), ranked_items AS (
      SELECT candidate.*,
        CASE candidate.kind
          WHEN 'activity' THEN 4
          WHEN 'change' THEN 3
          WHEN 'note' THEN 2
          WHEN 'task' THEN 1
        END AS kind_rank
      FROM candidate_items candidate
    ), page_items AS (
      SELECT ranked.*
      FROM ranked_items ranked
      WHERE ${since} AND ${after}
      ORDER BY ranked.occurred_at DESC, ranked.kind_rank DESC, ranked.id DESC
      LIMIT ${normalized.limit + 1}
    )
    SELECT page.kind,
      page.id,
      page.record_id,
      page.occurred_at,
      CASE WHEN page.about_relation_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY(
        SELECT r.id
        FROM record_links listed_about
        JOIN records r ON r.id = listed_about.to_record_id
        WHERE listed_about.organization_id = ${tenant.organizationId}::uuid
          AND listed_about.team_id = ${tenant.teamId}::uuid
          AND listed_about.from_record_id = page.record_id
          AND listed_about.relation_type_id = page.about_relation_id
          AND listed_about.active_until IS NULL
          AND ${access}
          AND r.erased_at IS NULL
        ORDER BY r.id
      ) END AS about_record_ids
    FROM page_items page
    ORDER BY page.occurred_at DESC, page.kind_rank DESC, page.id DESC`)
  const pageRows = rows.slice(0, normalized.limit)
  const items = pageRows.map(rowItem)
  const last = items.at(-1)
  return {
    items,
    next: rows.length > normalized.limit && last !== undefined
      ? { occurredAt: last.occurredAt, kind: last.kind, id: last.kind === 'change' ? last.changeId : last.recordId }
      : null,
  }
}
