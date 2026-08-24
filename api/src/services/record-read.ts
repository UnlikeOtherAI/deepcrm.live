import { tenantWhere } from '@deepcrm/db'
import {
  AttributeSpec,
  ErrorCode,
  ServiceError,
  Slug,
  Uuid,
  type ActorContext,
} from '@deepcrm/schemas'
import {
  findUniqueRecord,
  getAttributeType,
  keyHash,
  listLinks,
  loadSchema,
  normalizedAttributeValue,
  type LoadedObjectType,
  type LoadedSchema,
  type QueryRecord,
} from '@deepcrm/schema-engine'

import type { AppDeps } from '../deps.js'
import { loadPolicyEvaluator, type PolicyRequest, type PolicyScopeRef } from './policy.js'
import { recordBoundary } from './record-boundary.js'
import { recordTimeline, type RecordTimelineResult } from './timeline.js'
import { findVisibleLiveRecords, requireVisibleRecord } from './record-visibility.js'
import { buildRedactionMatrix, redactForActor, type RecordOut } from './redact.js'

export type GetRecordInput = {
  id?: string
  objectType?: string
  matchAttribute?: string
  value?: unknown
  includeLinks?: boolean
  includeTimeline?: number
}

export type RecordLinkOut = {
  id: string
  relation_type: string
  from_record_id: string
  to_record_id: string
  label: string | null
  data: Record<string, unknown>
  active_from: string
  active_until: string | null
}

export type GetRecordResult = {
  record: RecordOut
  links?: Record<string, Array<{ link: RecordLinkOut; related: Pick<RecordOut, 'id' | 'object_type' | 'display_name'> }>>
  timeline?: RecordTimelineResult['items']
}

type Lookup = { kind: 'id'; id: string } | {
  kind: 'unique'; objectType: string; matchAttribute: string; value: unknown
}
type JsonValue = QueryRecord['data'][string]
type LinkEntry = Awaited<ReturnType<typeof listLinks>>[number]

function invalid(path: string, message: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Record get input is invalid', {
    issues: [{ path, message }],
  })
}

function lookup(input: GetRecordInput): Lookup {
  const id = input.id !== undefined
  const objectType = input.objectType !== undefined
  const matchAttribute = input.matchAttribute !== undefined
  const value = input.value !== undefined
  if (id && !objectType && !matchAttribute && !value) {
    const parsed = Uuid.safeParse(input.id)
    if (!parsed.success) invalid('/id', 'Invalid record id')
    return { kind: 'id', id: parsed.data }
  }
  if (!id && objectType && matchAttribute && value) {
    const parsedObjectType = Slug.safeParse(input.objectType)
    if (!parsedObjectType.success) invalid('/object_type', 'Invalid object type slug')
    const parsedAttribute = Slug.safeParse(input.matchAttribute)
    if (!parsedAttribute.success) invalid('/match_attribute', 'Invalid match attribute slug')
    return {
      kind: 'unique', objectType: parsedObjectType.data,
      matchAttribute: parsedAttribute.data, value: input.value,
    }
  }
  invalid('', 'Supply exactly id, or object_type with match_attribute and value')
}

function requestedTimeline(input: GetRecordInput): number {
  const value = input.includeTimeline ?? 0
  if (!Number.isInteger(value) || value < 0 || value > 50) {
    invalid('/include_timeline', 'Include timeline must be an integer from 0 to 50')
  }
  return value
}

function activeObjectType(schema: LoadedSchema, slug: string): LoadedObjectType {
  const objectType = schema.objectTypesBySlug.get(slug)
  if (objectType === undefined || objectType.archivedAt !== null) {
    throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type does not exist')
  }
  return objectType
}

function activeAttribute(schema: LoadedSchema, objectType: LoadedObjectType, slug: string) {
  const attribute = schema.attributesByObjectTypeId.get(objectType.id)?.get(slug)
  if (attribute !== undefined && attribute.archivedAt === null) return attribute
  if (schema.archivedAttributeSlugsByObjectTypeId.get(objectType.id)?.has(slug) === true) {
    throw new ServiceError(ErrorCode.ATTRIBUTE_ARCHIVED, 'Attribute is archived', { attribute: slug })
  }
  throw new ServiceError(ErrorCode.UNKNOWN_ATTRIBUTE, 'Attribute does not exist', { attribute: slug })
}

function parsedUniqueValues(attribute: LoadedObjectType['attributes'][number], value: unknown): JsonValue[] {
  const supplied = attribute.isMulti && Array.isArray(value) ? value : [value]
  if (supplied.length === 0) invalid('/value', 'Match value must not be empty')
  const values: JsonValue[] = []
  for (const item of supplied) {
    const validation = getAttributeType(attribute.type).valueSchema(attribute.config).safeParse(item)
    if (!validation.success) invalid('/value', 'Invalid match attribute value')
    if (!isJsonValue(validation.data)) invalid('/value', 'Invalid match attribute value')
    values.push(validation.data)
  }
  return values
}

function recordScopes(ctx: ActorContext, record: Pick<QueryRecord, 'id' | 'objectTypeId'>): PolicyScopeRef[] {
  return [
    { scope: 'team', id: ctx.tenant.teamId },
    { scope: 'object_type', id: record.objectTypeId },
    { scope: 'record', id: record.id },
  ]
}

function recordRequest(ctx: ActorContext, record: Pick<QueryRecord, 'id' | 'objectTypeId'>): PolicyRequest {
  return { resourceType: 'record', action: 'view', scopes: recordScopes(ctx, record) }
}

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

export function asQueryRecord(row: {
  id: string; objectTypeId: string; data: unknown; displayName: string
  ownerType: QueryRecord['ownerType']; ownerId: string | null
  visibility: QueryRecord['visibility']; createdOnBehalfOf: string | null; origin: string | null
  version: number; lastActivityAt: Date | null; createdAt: Date; updatedAt: Date
}): QueryRecord {
  if (!isJsonObject(row.data)) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Record data is invalid')
  }
  return { ...row, data: row.data }
}

async function visibleRecord(deps: AppDeps, ctx: ActorContext, id: string): Promise<QueryRecord> {
  await requireVisibleRecord(deps.db, ctx, id)
  const row = await deps.db.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id, deletedAt: null, mergedIntoId: null, erasedAt: null },
    select: {
      id: true, objectTypeId: true, data: true, displayName: true, ownerType: true, ownerId: true,
      visibility: true, createdOnBehalfOf: true, origin: true, version: true, lastActivityAt: true,
      createdAt: true, updatedAt: true,
    },
  })
  if (row === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  return asQueryRecord(row)
}

async function resolveUnique(
  deps: AppDeps, ctx: ActorContext, schema: LoadedSchema, input: Extract<Lookup, { kind: 'unique' }>,
): Promise<string> {
  const objectType = activeObjectType(schema, input.objectType)
  const attribute = activeAttribute(schema, objectType, input.matchAttribute)
  if (!attribute.isUnique) {
    invalid('/match_attribute', 'Match attribute must be unique')
  }
  const values = parsedUniqueValues(attribute, input.value)
  const recordIds = await Promise.all(values.map(async (value) => findUniqueRecord(
    deps.db, ctx.tenant, attribute.id, keyHash(normalizedAttributeValue(attribute, value)),
  )))
  const first = recordIds[0]
  if (first === undefined || first === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const others = [...new Set(recordIds.slice(1).filter((id): id is string => id !== null && id !== first))]
  if (others.length > 0) {
    const candidates = [first, ...others].sort()
    const visible = await findVisibleLiveRecords(deps.db, ctx, candidates)
    // The lookup happens before policy. Never include a candidate id unless visibility admits all
    // candidates; otherwise the collision itself becomes an existence oracle.
    if (visible.length !== candidates.length) {
      throw new ServiceError(ErrorCode.DUPLICATE_FOUND, 'Multiple records match supplied values')
    }
    throw new ServiceError(ErrorCode.DUPLICATE_FOUND, 'Multiple records match supplied values', {
      record_ids: candidates,
    })
  }
  return first
}

function redactedLinkData(
  entry: LinkEntry,
  ctx: ActorContext,
  schema: LoadedSchema,
  primary: QueryRecord,
  related: QueryRecord,
  evaluator: Awaited<ReturnType<typeof loadPolicyEvaluator>>,
): Record<string, unknown> {
  const relation = schema.relationTypesById.get(entry.link.relationTypeId)
  if (relation === undefined || relation.archivedAt !== null) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Link relation type is not active')
  }
  const data = entry.link.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Link data is invalid')
  }
  const scopes = [...recordScopes(ctx, primary), ...recordScopes(ctx, related)]
  const output: Record<string, unknown> = {}
  for (const spec of AttributeSpec.array().parse(relation.edgeAttributes)) {
    if (!Object.hasOwn(data, spec.slug)) continue
    const decision = evaluator.evaluate({
      resourceType: 'attribute', action: 'view', scopes, sensitivity: spec.sensitivity,
    })
    if (decision.allowed && !decision.requiresApproval) output[spec.slug] = data[spec.slug]
  }
  return output
}

async function writeDeniedAudit(
  deps: AppDeps,
  ctx: ActorContext,
  record: QueryRecord,
): Promise<void> {
  await deps.db.$transaction((tx) => deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action: 'crm_record_get',
    resourceType: 'record',
    resourceId: record.id,
    outcome: 'denied',
    reason: null,
    metadata: { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance },
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  }))
}

/** Pure RecordOut presenter for callers which already loaded a bounded policy evaluator. */
export function presentRecord(
  ctx: ActorContext,
  schema: LoadedSchema,
  record: QueryRecord,
  evaluator: Awaited<ReturnType<typeof loadPolicyEvaluator>>,
): RecordOut {
  return redactForActor(
    ctx, schema, record, buildRedactionMatrix(evaluator, ctx, schema, [record]),
  )
}

export async function getRecord(
  deps: AppDeps,
  ctx: ActorContext,
  input: GetRecordInput,
): Promise<GetRecordResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const target = lookup(input)
    const timelineLimit = requestedTimeline(input)
    const schema = await loadSchema(deps.db, ctx.tenant)
    const recordId = target.kind === 'id'
      ? target.id
      : await resolveUnique(deps, ctx, schema, target)
    const primary = await visibleRecord(deps, ctx, recordId)
    const objectType = schema.objectTypesById.get(primary.objectTypeId)
    if (objectType === undefined || objectType.archivedAt !== null) {
      throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Record object type is not active')
    }
    const entries = input.includeLinks === true
      ? await listLinks(deps.db, ctx, schema, { recordId: primary.id })
      : []
    const relatedIds = entries.map((entry) => entry.relatedRecordId)
    const visibleRelated = await findVisibleLiveRecords(deps.db, ctx, relatedIds)
    const visibleRelatedIds = new Set(visibleRelated.map((record) => record.id))
    const relatedRows = visibleRelatedIds.size === 0 ? [] : await deps.db.record.findMany({
      where: {
        ...tenantWhere(ctx.tenant), id: { in: [...visibleRelatedIds] }, deletedAt: null,
        mergedIntoId: null, erasedAt: null,
      },
      select: {
        id: true, objectTypeId: true, data: true, displayName: true, ownerType: true, ownerId: true,
        visibility: true, createdOnBehalfOf: true, origin: true, version: true, lastActivityAt: true,
        createdAt: true, updatedAt: true,
      },
    })
    const related = relatedRows.map(asQueryRecord)
    const evaluator = await loadPolicyEvaluator(deps.db, ctx, [
      recordRequest(ctx, primary),
      ...related.map((record) => recordRequest(ctx, record)),
      { resourceType: 'attribute', action: 'view', scopes: [{ scope: 'team', id: ctx.tenant.teamId }] },
    ])
    const primaryDecision = evaluator.evaluate(recordRequest(ctx, primary))
    if (!primaryDecision.allowed || primaryDecision.requiresApproval) {
      await writeDeniedAudit(deps, ctx, primary)
      throw new ServiceError(
        primaryDecision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
        'Record read is not permitted', { resource: 'record', action: 'view' },
      )
    }
    const permittedRelated = related.filter((record) => {
      const decision = evaluator.evaluate(recordRequest(ctx, record))
      return decision.allowed && !decision.requiresApproval
    })
    const matrix = buildRedactionMatrix(evaluator, ctx, schema, [primary, ...permittedRelated])
    const record = redactForActor(ctx, schema, primary, matrix)
    const timeline = timelineLimit === 0 ? undefined : (await recordTimeline(deps, ctx, {
      id: primary.id,
      limit: timelineLimit,
    })).items
    if (input.includeLinks !== true) return { record, ...(timeline === undefined ? {} : { timeline }) }
    const relatedById = new Map(permittedRelated.map((item) => [item.id, item]))
    const summaries = new Map<string, Pick<RecordOut, 'id' | 'object_type' | 'display_name'>>(permittedRelated.map((item) => {
      const redacted = redactForActor(ctx, schema, item, matrix)
      return [item.id, { id: redacted.id, object_type: redacted.object_type, display_name: redacted.display_name }]
    }))
    const links: GetRecordResult['links'] = {}
    for (const entry of entries) {
      const relatedRecord = relatedById.get(entry.relatedRecordId)
      const summary = summaries.get(entry.relatedRecordId)
      if (relatedRecord === undefined || summary === undefined) continue
      const group = links[entry.link.relationType] ?? []
      group.push({
        link: {
          id: entry.link.id, relation_type: entry.link.relationType,
          from_record_id: entry.link.fromRecordId, to_record_id: entry.link.toRecordId,
          label: entry.link.label, data: redactedLinkData(entry, ctx, schema, primary, relatedRecord, evaluator),
          active_from: entry.link.activeFrom.toISOString(),
          active_until: entry.link.activeUntil?.toISOString() ?? null,
        },
        related: summary,
      })
      links[entry.link.relationType] = group
    }
    return { record, links, ...(timeline === undefined ? {} : { timeline }) }
  })
}
