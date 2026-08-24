import {
  tenantWhere,
  type ChangeKind,
  type Prisma,
} from '@deepcrm/db'
import {
  loadSchema,
  type LoadedObjectType,
  type QueryRecord,
} from '@deepcrm/schema-engine'
import {
  AttributeSpec,
  ErrorCode,
  FeedChangeKind,
  ServiceError,
  Slug,
  type ActorContext,
  type FeedChangeKindValue,
  type FeedChangeValue,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { loadPolicyEvaluator, type PolicyEvaluator, type PolicyRequest } from './policy.js'
import { recordBoundary } from './record-boundary.js'
import { asQueryRecord } from './record-read.js'
import { buildRedactionMatrix, redactForActor } from './redact.js'

const BATCH_SIZE = 500

export type ChangesSinceInput = {
  cursor?: string
  from?: 'beginning'
  objectTypes?: readonly string[]
  kinds?: readonly FeedChangeKindValue[]
  limit?: number
}

export type ChangesSinceResult = {
  changes: FeedChangeValue[]
  next_cursor: string
  has_more: boolean
}

type NormalizedInput = {
  cursor: bigint
  objectTypeIds?: ReadonlySet<string>
  objectTypeSlugs?: ReadonlySet<string>
  kinds?: readonly ChangeKind[]
  limit: number
}

type CurrentAttribute = {
  objectTypeId: string
  slug: string
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'
}

type EdgeAttribute = {
  slug: string
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'
}

type RelationMetadata = { slug: string; attributes: readonly EdgeAttribute[] }

type FeedRecord = QueryRecord & { mergedIntoId: string | null }

function invalid(path: string, message: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Change feed arguments are invalid', {
    issues: [{ path, message }],
  })
}

function cursor(value: string): bigint {
  if (!/^\d+$/u.test(value)) invalid('/cursor', 'Cursor must be a decimal sequence')
  return BigInt(value)
}

function databaseKind(kind: FeedChangeKindValue): ChangeKind {
  return kind === 'schema' ? 'schema_change' : kind
}

function externalKind(kind: ChangeKind): FeedChangeKindValue {
  return kind === 'schema_change' ? 'schema' : kind
}

function normalizeKinds(values: readonly FeedChangeKindValue[] | undefined): readonly ChangeKind[] | undefined {
  if (values === undefined) return undefined
  const parsed = FeedChangeKind.array().max(10).safeParse(values)
  if (!parsed.success) invalid('/kinds', 'Kinds contain an unsupported change kind')
  return [...new Set(parsed.data.map(databaseKind))]
}

function scopes(ctx: ActorContext, record: Pick<QueryRecord, 'id' | 'objectTypeId'>) {
  return [
    { scope: 'team' as const, id: ctx.tenant.teamId },
    { scope: 'object_type' as const, id: record.objectTypeId },
    { scope: 'record' as const, id: record.id },
  ]
}

function recordRequest(ctx: ActorContext, record: Pick<QueryRecord, 'id' | 'objectTypeId'>): PolicyRequest {
  return { resourceType: 'record', action: 'view', scopes: scopes(ctx, record) }
}

function attributeRequest(
  ctx: ActorContext,
  record: Pick<QueryRecord, 'id' | 'objectTypeId'>,
  attribute: CurrentAttribute | EdgeAttribute,
): PolicyRequest {
  return {
    resourceType: 'attribute', action: 'view', scopes: scopes(ctx, record),
    sensitivity: attribute.sensitivity,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function linkEndpoints(value: unknown): readonly string[] {
  if (!isObject(value)) return []
  const from = value['from_record_id']
  const to = value['to_record_id']
  return [
    ...(typeof from === 'string' ? [from] : []),
    ...(typeof to === 'string' ? [to] : []),
  ]
}

function relatedRecordId(row: ChangeRow): string | null {
  if (row.recordId === null || (row.kind !== 'link' && row.kind !== 'unlink')) return null
  const endpoints = linkEndpoints(row.newValue ?? row.oldValue)
  if (endpoints.length !== 2) {
    throw new ServiceError(ErrorCode.INTERNAL, 'Stored link change endpoints are invalid')
  }
  if (endpoints[0] === row.recordId) return endpoints[1] ?? null
  if (endpoints[1] === row.recordId) return endpoints[0] ?? null
  throw new ServiceError(ErrorCode.INTERNAL, 'Stored link change does not contain its record')
}

function eventName(row: ChangeRow, record: FeedRecord | undefined): FeedChangeValue['event'] {
  switch (row.kind) {
    case 'create': return 'record.created'
    case 'set':
    case 'unset':
    case 'restore':
    case 'unmerge': return 'record.updated'
    case 'delete': return 'record.deleted'
    case 'merge': return record?.mergedIntoId === null ? 'record.merged' : 'record.deleted'
    case 'link': return 'link.created'
    case 'unlink': return 'link.ended'
    case 'schema_change': return 'schema.changed'
  }
}

function visibleDecision(evaluator: PolicyEvaluator, request: PolicyRequest): boolean {
  const decision = evaluator.evaluate(request)
  return decision.allowed && !decision.requiresApproval
}

function redactLinkValue(
  value: Prisma.JsonValue,
  relation: RelationMetadata,
  ctx: ActorContext,
  record: FeedRecord,
  evaluator: PolicyEvaluator,
): Prisma.JsonValue {
  if (!isObject(value)) throw new ServiceError(ErrorCode.INTERNAL, 'Stored link change is invalid')
  const rawData = value['data']
  if (!isObject(rawData)) return value
  const allowed = new Set(relation.attributes.flatMap((attribute) => (
    visibleDecision(evaluator, attributeRequest(ctx, record, attribute)) ? [attribute.slug] : []
  )))
  return {
    ...value,
    data: Object.fromEntries(Object.entries(rawData).filter(([slug]) => allowed.has(slug))),
  }
}

function changeValue(
  value: Prisma.JsonValue | null,
  row: ChangeRow,
  record: FeedRecord | undefined,
  attributes: ReadonlyMap<string, CurrentAttribute>,
  relations: ReadonlyMap<string, RelationMetadata>,
  evaluator: PolicyEvaluator,
  ctx: ActorContext,
): Prisma.JsonValue | undefined {
  if (value === null) return undefined
  if (record === undefined) return value
  if (row.attributeSlug !== null) {
    const attribute = attributes.get(`${record.objectTypeId}:${row.attributeSlug}`)
    if (attribute === undefined) return undefined
    return visibleDecision(evaluator, attributeRequest(ctx, record, attribute)) ? value : undefined
  }
  if (row.relationTypeId !== null) {
    const relation = relations.get(row.relationTypeId)
    if (relation === undefined) return undefined
    return redactLinkValue(value, relation, ctx, record, evaluator)
  }
  return value
}

async function loadBatch(deps: AppDeps, ctx: ActorContext, input: NormalizedInput, after: bigint) {
  return deps.db.recordChange.findMany({
    where: {
      ...tenantWhere(ctx.tenant), seq: { gt: after },
      ...(input.kinds === undefined ? {} : { kind: { in: [...input.kinds] } }),
    },
    orderBy: { seq: 'asc' },
    take: BATCH_SIZE,
  })
}

type ChangeRow = Awaited<ReturnType<typeof loadBatch>>[number]

async function visibleRecords(
  deps: AppDeps,
  ctx: ActorContext,
  ids: readonly string[],
): Promise<FeedRecord[]> {
  if (ids.length === 0) return []
  const rows = await deps.db.record.findMany({
    where: {
      ...tenantWhere(ctx.tenant), id: { in: [...new Set(ids)] },
      OR: [
        { visibility: 'team' },
        { createdOnBehalfOf: ctx.onBehalfOf.uoaUserId },
        { visibility: 'users', visibilityGrants: { some: { uoaUserId: ctx.onBehalfOf.uoaUserId } } },
      ],
    },
    select: {
      id: true, objectTypeId: true, data: true, displayName: true,
      ownerType: true, ownerId: true, visibility: true, createdOnBehalfOf: true,
      origin: true, version: true, lastActivityAt: true, createdAt: true, updatedAt: true,
      mergedIntoId: true,
    },
  })
  return rows.map((row) => ({ ...asQueryRecord(row), mergedIntoId: row.mergedIntoId }))
}

function relationMetadata(rows: readonly {
  id: string; slug: string; edgeAttributes: Prisma.JsonValue
}[]): ReadonlyMap<string, RelationMetadata> {
  return new Map(rows.map((row) => [row.id, {
    slug: row.slug,
    attributes: AttributeSpec.array().parse(row.edgeAttributes).map((attribute) => ({
      slug: attribute.slug, sensitivity: attribute.sensitivity,
    })),
  }]))
}

function schemaObjectType(row: ChangeRow): string | null {
  if (!isObject(row.newValue)) return null
  const slug = row.newValue['object_type']
  return typeof slug === 'string' ? slug : null
}

function matchesObjectFilter(
  row: ChangeRow,
  record: FeedRecord | undefined,
  input: NormalizedInput,
): boolean {
  if (input.objectTypeIds === undefined || input.objectTypeSlugs === undefined) return true
  return record === undefined
    ? (schemaObjectType(row) !== null && input.objectTypeSlugs.has(schemaObjectType(row) ?? ''))
    : input.objectTypeIds.has(record.objectTypeId)
}

function present(
  row: ChangeRow,
  record: FeedRecord | undefined,
  summary: ReturnType<typeof redactForActor> | undefined,
  attributes: ReadonlyMap<string, CurrentAttribute>,
  relations: ReadonlyMap<string, RelationMetadata>,
  evaluator: PolicyEvaluator,
  ctx: ActorContext,
): FeedChangeValue {
  const oldValue = changeValue(row.oldValue, row, record, attributes, relations, evaluator, ctx)
  const newValue = changeValue(row.newValue, row, record, attributes, relations, evaluator, ctx)
  return {
    id: row.id,
    event: eventName(row, record),
    seq: row.seq.toString(),
    resulting_version: row.resultingVersion,
    record: summary === undefined ? null : {
      id: summary.id, object_type: summary.object_type, display_name: summary.display_name,
    },
    group_id: row.groupId,
    kind: externalKind(row.kind),
    attribute: row.attributeSlug,
    relation_type: row.relationTypeId === null ? null : relations.get(row.relationTypeId)?.slug ?? null,
    link_id: row.linkId,
    ...(oldValue === undefined ? {} : { old_value: oldValue }),
    ...(newValue === undefined ? {} : { new_value: newValue }),
    actor: { type: row.actorType, id: row.actorId },
    on_behalf_of: row.onBehalfOf,
    provenance: { run_id: row.runId, tool_call_id: row.toolCallId, request_id: row.requestId },
    reason: row.reason,
    occurred_at: row.occurredAt.toISOString(),
  }
}

async function feed(
  deps: AppDeps,
  ctx: ActorContext,
  input: NormalizedInput,
): Promise<ChangesSinceResult> {
  const [schema, attributeRows, relationRows, evaluator] = await Promise.all([
    loadSchema(deps.db, ctx.tenant),
    deps.db.attribute.findMany({
      where: tenantWhere(ctx.tenant),
      select: { objectTypeId: true, slug: true, sensitivity: true },
    }),
    deps.db.relationType.findMany({
      where: tenantWhere(ctx.tenant), select: { id: true, slug: true, edgeAttributes: true },
    }),
    loadPolicyEvaluator(deps.db, ctx, [
      { resourceType: 'record', action: 'view', scopes: [{ scope: 'team', id: ctx.tenant.teamId }] },
      { resourceType: 'attribute', action: 'view', scopes: [{ scope: 'team', id: ctx.tenant.teamId }] },
    ]),
  ])
  const attributes = new Map<string, CurrentAttribute>()
  for (const attribute of attributeRows) {
    if (attribute.objectTypeId === null) continue
    attributes.set(`${attribute.objectTypeId}:${attribute.slug}`, {
      objectTypeId: attribute.objectTypeId,
      slug: attribute.slug,
      sensitivity: attribute.sensitivity,
    })
  }
  const relations = relationMetadata(relationRows)
  const changes: FeedChangeValue[] = []
  let scanned = input.cursor
  let exhausted = false
  while (changes.length <= input.limit && !exhausted) {
    const rows = await loadBatch(deps, ctx, input, scanned)
    if (rows.length === 0) break
    const last = rows.at(-1)
    if (last === undefined) break
    scanned = last.seq
    exhausted = rows.length < BATCH_SIZE
    const ids = rows.flatMap((row) => [
      ...(row.recordId === null ? [] : [row.recordId]),
      ...linkEndpoints(row.newValue ?? row.oldValue),
    ])
    const candidates = await visibleRecords(deps, ctx, ids)
    const admitted = candidates.filter((record) => (
      schema.objectTypesById.has(record.objectTypeId)
      && visibleDecision(evaluator, recordRequest(ctx, record))
    ))
    const byId = new Map(admitted.map((record) => [record.id, record]))
    const matrix = buildRedactionMatrix(evaluator, ctx, schema, admitted)
    const summaries = new Map(admitted.map((record) => [
      record.id, redactForActor(ctx, schema, record, matrix),
    ]))
    for (const row of rows) {
      const record = row.recordId === null ? undefined : byId.get(row.recordId)
      if (row.recordId !== null && record === undefined) continue
      if (!matchesObjectFilter(row, record, input)) continue
      const related = relatedRecordId(row)
      if (related !== null && !byId.has(related)) continue
      changes.push(present(
        row, record, row.recordId === null ? undefined : summaries.get(row.recordId),
        attributes, relations, evaluator, ctx,
      ))
      if (changes.length > input.limit) break
    }
  }
  const page = changes.slice(0, input.limit)
  return {
    changes: page,
    next_cursor: page.at(-1)?.seq ?? input.cursor.toString(),
    has_more: changes.length > input.limit,
  }
}

async function normalize(
  deps: AppDeps,
  ctx: ActorContext,
  input: ChangesSinceInput,
): Promise<NormalizedInput | ChangesSinceResult> {
  if (input.from !== undefined && input.from !== 'beginning') {
    invalid('/from', 'From must be beginning')
  }
  if (input.cursor !== undefined && input.from !== undefined) {
    invalid('', 'Cursor and from cannot be combined')
  }
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    invalid('/limit', 'Limit must be an integer from 1 to 200')
  }
  const kinds = normalizeKinds(input.kinds)
  let objectTypeIds: ReadonlySet<string> | undefined
  let objectTypeSlugs: ReadonlySet<string> | undefined
  if (input.objectTypes !== undefined) {
    const parsed = Slug.array().max(50).safeParse(input.objectTypes)
    if (!parsed.success) invalid('/object_types', 'Object types must be valid slugs')
    const schema = await loadSchema(deps.db, ctx.tenant)
    const selected: LoadedObjectType[] = parsed.data.map((slug) => {
      const objectType = schema.objectTypesBySlug.get(slug)
      if (objectType === undefined) {
        throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type does not exist', {
          object_type: slug,
        })
      }
      return objectType
    })
    objectTypeIds = new Set(selected.map((objectType) => objectType.id))
    objectTypeSlugs = new Set(selected.map((objectType) => objectType.slug))
  }
  if (input.cursor === undefined && input.from === undefined) {
    const team = await deps.db.team.findFirst({
      where: { id: ctx.tenant.teamId, organizationId: ctx.tenant.organizationId },
      select: { feedSeq: true },
    })
    if (team === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Tenant team not found')
    return { changes: [], next_cursor: team.feedSeq.toString(), has_more: false }
  }
  return {
    cursor: input.cursor === undefined ? 0n : cursor(input.cursor),
    ...(objectTypeIds === undefined ? {} : { objectTypeIds, objectTypeSlugs }),
    ...(kinds === undefined ? {} : { kinds }),
    limit,
  }
}

export function changesSince(
  deps: AppDeps,
  ctx: ActorContext,
  input: ChangesSinceInput,
): Promise<ChangesSinceResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const normalized = await normalize(deps, ctx, input)
    return 'changes' in normalized ? normalized : feed(deps, ctx, normalized)
  })
}
