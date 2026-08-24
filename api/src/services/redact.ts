import type { LoadedObjectType, LoadedSchema, QueryRecord } from '@deepcrm/schema-engine'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { PolicyEvaluator, PolicyRequest, PolicyScopeRef } from './policy.js'

type LoadedAttribute = LoadedObjectType['attributes'][number]

export type RedactionMatrix = {
  teamId: string
  deniedByRecordId: ReadonlyMap<string, ReadonlySet<string>>
}

export type RecordOut = {
  id: string
  object_type: string
  display_name: string
  version: number
  data: QueryRecord['data']
  visibility: QueryRecord['visibility']
  origin: string | null
  owner: { type: 'human' | 'agent'; id: string } | null
  created_at: string
  updated_at: string
  last_activity_at: string | null
  redacted_attributes: string[]
}

function objectType(schema: LoadedSchema, record: QueryRecord): LoadedObjectType {
  const found = schema.objectTypesById.get(record.objectTypeId)
  if (found === undefined) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Record object type is not in the schema')
  }
  return found
}

function selectedAttributes(
  selected: LoadedObjectType,
  requestedAttributes: readonly string[] | undefined,
): readonly LoadedAttribute[] {
  if (requestedAttributes === undefined) return [...selected.attributes].sort(bySlug)
  const requested = new Set(requestedAttributes)
  return selected.attributes.filter((attribute) => requested.has(attribute.slug)).sort(bySlug)
}

function bySlug(left: LoadedAttribute, right: LoadedAttribute): number {
  return left.slug.localeCompare(right.slug)
}

function attributeViewRequest(
  ctx: ActorContext,
  record: QueryRecord,
  attribute: LoadedAttribute,
): PolicyRequest {
  const scopes: PolicyScopeRef[] = [
    { scope: 'team', id: ctx.tenant.teamId },
    { scope: 'object_type', id: record.objectTypeId },
    { scope: 'record', id: record.id },
  ]
  return {
    resourceType: 'attribute',
    action: 'view',
    scopes,
    sensitivity: attribute.sensitivity,
  }
}

export function buildRedactionMatrix(
  evaluator: PolicyEvaluator,
  ctx: ActorContext,
  schema: LoadedSchema,
  records: readonly QueryRecord[],
  requestedAttributes?: readonly string[],
): RedactionMatrix {
  const deniedByRecordId = new Map<string, ReadonlySet<string>>()
  for (const record of records) {
    const denied = new Set<string>()
    for (const attribute of selectedAttributes(objectType(schema, record), requestedAttributes)) {
      const decision = evaluator.evaluate(attributeViewRequest(ctx, record, attribute))
      if (!decision.allowed || decision.requiresApproval) denied.add(attribute.slug)
    }
    deniedByRecordId.set(record.id, denied)
  }
  return { teamId: ctx.tenant.teamId, deniedByRecordId }
}

function owner(record: QueryRecord): RecordOut['owner'] {
  if (record.ownerType === null || record.ownerType === 'system' || record.ownerId === null) return null
  return { type: record.ownerType, id: record.ownerId }
}

export function redactForActor(
  ctx: ActorContext,
  schema: LoadedSchema,
  record: QueryRecord,
  matrix: RedactionMatrix,
  requestedAttributes?: readonly string[],
): RecordOut {
  if (matrix.teamId !== ctx.tenant.teamId) {
    throw new ServiceError(ErrorCode.TENANT_MISMATCH, 'Redaction matrix does not match tenant')
  }
  const selected = selectedAttributes(objectType(schema, record), requestedAttributes)
  const denied = matrix.deniedByRecordId.get(record.id)
  if (denied === undefined) {
    throw new ServiceError(ErrorCode.INTERNAL, 'Redaction matrix does not contain record')
  }
  const data: QueryRecord['data'] = {}
  const redacted: string[] = []
  for (const attribute of selected) {
    if (!Object.hasOwn(record.data, attribute.slug)) continue
    if (denied.has(attribute.slug)) redacted.push(attribute.slug)
    else {
      const value = record.data[attribute.slug]
      if (value !== undefined) data[attribute.slug] = value
    }
  }
  return {
    id: record.id,
    object_type: objectType(schema, record).slug,
    display_name: record.displayName,
    version: record.version,
    data,
    visibility: record.visibility,
    origin: record.origin,
    owner: owner(record),
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
    last_activity_at: record.lastActivityAt?.toISOString() ?? null,
    redacted_attributes: redacted,
  }
}
