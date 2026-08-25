import { Prisma, tenantWhere, type TenantRef, writeAudit } from '@deepcrm/db'
import { AttributeSpec, ErrorCode, ServiceError, type AttributeSpec as AttributeSpecValue } from '@deepcrm/schemas'
import { getAttributeType } from '../attribute-types/index.js'
import {
  cancelMatchingRules,
  finalizeMatchingBackfill,
  finalizeMatchingBootstrap,
  retryMatchingRules,
  setMatchingRules,
  setMatchingRulesBatch,
} from './matching-rules.js'
import { enqueueAttributeEvolutionJobs, prepareAttributeEvolution } from './evolution.js'
import type { AttributeInput, AttributeUpdateInput, AuditActor, ObjectInput, RelationInput } from './mutation-types.js'
import { relationLimitData } from './relation-limits.js'
import type { SchemaTx } from './tx.js'
type Tx = SchemaTx
export type { AttributeInput, AuditActor, ObjectInput, RelationInput } from './mutation-types.js'
type RelationUpdateInput = Partial<Omit<RelationInput, 'slug' | 'fromObjectType' | 'toObjectType'>>
type ObjUpdate = Partial<Omit<ObjectInput, 'slug'>>
type StoredJsonValue = Prisma.InputJsonValue | typeof Prisma.JsonNull
function objectField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined
}
function schemaConflict(detail: string): ServiceError {
  return new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema conflicts with existing metadata', { detail })
}
function unknownObjectType(slug: string): ServiceError {
  return new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type is not active in this tenant', { slug })
}
export function unknownAttribute(slug: string): ServiceError {
  return new ServiceError(ErrorCode.UNKNOWN_ATTRIBUTE, 'Attribute is not active in this tenant', { slug })
}
function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}
export function audit(
  tx: Tx,
  tenant: TenantRef,
  actor: AuditActor,
  action: string,
  resourceType: string,
  resourceId: string | null,
  reason: string | null = null,
): Promise<unknown> {
  return writeAudit(tx, {
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    actorType: actor.type,
    actorId: actor.id,
    onBehalfOf: actor.onBehalfOf,
    action,
    resourceType,
    resourceId,
    outcome: 'success',
    reason,
    metadata: null,
    requestId: actor.requestId,
    ipAddress: null,
    userAgent: null,
  })
}
export async function bumpSchemaVersion(tx: Tx, tenant: TenantRef): Promise<void> {
  const result = await tx.team.updateMany({
    where: { id: tenant.teamId, organizationId: tenant.organizationId },
    data: { schemaVersion: { increment: 1 } },
  })
  if (result.count !== 1) throw schemaConflict('tenant_not_found')
}
export async function object(tx: Tx, tenant: TenantRef, slug: string) {
  const value = await tx.objectType.findFirst({ where: { ...tenantWhere(tenant), slug, archivedAt: null } })
  if (value === null) throw unknownObjectType(slug)
  return value
}
export async function resolvePrimaryAttribute(
  tx: Tx,
  tenant: TenantRef,
  objectTypeId: string,
  slug: string | undefined,
): Promise<string | null | undefined> {
  if (slug === undefined) return undefined
  if (slug === '') return null
  const attribute = await tx.attribute.findFirst({
    where: { ...tenantWhere(tenant), objectTypeId, slug, archivedAt: null },
  })
  if (
    attribute === null ||
    attribute.isMulti ||
    attribute.sensitivity === 'confidential' ||
    attribute.sensitivity === 'restricted'
  ) throw schemaConflict('invalid_primary_attribute')
  return attribute.id
}
function configValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, 'type')) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'type'))
}
function nestedJsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(nestedJsonValue)
  if (typeof value === 'object') {
    const result: Record<string, Prisma.InputJsonValue | null> = {}
    for (const [key, child] of Object.entries(value)) result[key] = nestedJsonValue(child)
    return result
  }
  throw schemaConflict('invalid_json_value')
}
export function jsonValue(value: unknown): StoredJsonValue {
  if (value === null) return Prisma.JsonNull
  const result = nestedJsonValue(value)
  if (result === null) throw schemaConflict('invalid_json_value')
  return result
}
export function validateAttributeValue(spec: AttributeSpecValue): {
  config: StoredJsonValue
  defaultValue: StoredJsonValue | undefined
} {
  const definition = getAttributeType(spec.type)
  const config = definition.configSchema.parse(configValue(spec.config) ?? {})
  if (spec.is_multi && !definition.supportsMulti) throw schemaConflict('multi_not_supported')
  if (spec.is_unique && !definition.supportsUnique) throw schemaConflict('unique_not_supported')
  if (spec.is_indexed && !definition.supportsIndexed) throw schemaConflict('index_not_supported')
  if (spec.default_value !== undefined) {
    if (spec.is_multi) {
      if (!Array.isArray(spec.default_value)) throw schemaConflict('multi_default_must_be_array')
      for (const value of spec.default_value) definition.valueSchema(config).parse(value)
    } else definition.valueSchema(config).parse(spec.default_value)
  }
  return {
    config: jsonValue(config),
    defaultValue: spec.default_value === undefined ? undefined : jsonValue(spec.default_value),
  }
}
async function defineObjectTypeInternal(
  tx: Tx, tenant: TenantRef, actor: AuditActor, input: ObjectInput, finalize: boolean,
) {
  let created
  try {
    created = await tx.objectType.create({ data: { ...tenantWhere(tenant), slug: input.slug, singularName: input.singularName, pluralName: input.pluralName, description: input.description, icon: input.icon ?? null, kind: input.kind ?? 'custom', createdByType: actor.type, createdById: actor.id } })
  } catch (error) {
    if (isUniqueConstraint(error)) throw schemaConflict('object_type_slug')
    throw error
  }
  if (finalize) { await bumpSchemaVersion(tx, tenant); await audit(tx, tenant, actor, 'define', 'object_type', created.id) }
  return created
}
export async function ensureBackingRelation(
  tx: Tx,
  tenant: TenantRef,
  attribute: AttributeInput,
  objectTypeId: string,
): Promise<void> {
  if (attribute.type !== 'record_reference') return
  const config = configValue(attribute.config)
  const parsed = getAttributeType('record_reference').configSchema.safeParse(config)
  if (!parsed.success) throw schemaConflict('invalid_record_reference_config')
  const referenceConfig = parsed.data
  if (!('objectTypes' in referenceConfig) || !Array.isArray(referenceConfig.objectTypes)) {
    throw schemaConflict('invalid_record_reference_config')
  }
  const targets = referenceConfig.objectTypes
  const resolvedTargets = await Promise.all(targets.map((target: string) => object(tx, tenant, target)))
  const targetId = resolvedTargets.length === 1 ? (resolvedTargets[0]?.id ?? null) : null
  const slug = 'relationTypeSlug' in referenceConfig && typeof referenceConfig.relationTypeSlug === 'string' ? referenceConfig.relationTypeSlug : `${attribute.objectType}_${attribute.slug}`
  const expectedCardinality = attribute.is_multi ? 'many_to_many' : 'many_to_one'
  const existing = await tx.relationType.findFirst({ where: { ...tenantWhere(tenant), slug, archivedAt: null } })
  if (existing !== null) {
    if (
      existing.fromObjectTypeId !== objectTypeId ||
      existing.toObjectTypeId !== targetId ||
      existing.cardinality !== expectedCardinality
    ) throw schemaConflict('incompatible_backing_relation')
    if (existing.projectionAttributeSlug === null) {
      const claim = await tx.relationType.updateMany({
        where: { id: existing.id, ...tenantWhere(tenant), archivedAt: null, projectionAttributeSlug: null },
        data: { projectionAttributeSlug: attribute.slug },
      })
      if (claim.count !== 1) throw schemaConflict('backing_relation_claim_conflict')
      return
    }
    if (existing.projectionAttributeSlug !== attribute.slug) {
      throw schemaConflict('backing_relation_already_claimed')
    }
    return
  }
  try {
    await tx.relationType.create({
      data: {
        ...tenantWhere(tenant),
        slug,
        fromObjectTypeId: objectTypeId,
        toObjectTypeId: targetId,
        forwardName: attribute.name,
        inverseName: attribute.name,
        description: attribute.description,
        cardinality: expectedCardinality,
        projectionAttributeSlug: attribute.slug,
        isSystem: attribute.isSystem ?? false,
      },
    })
  } catch (error) {
    if (isUniqueConstraint(error)) throw schemaConflict('relation_type_slug')
    throw error
  }
}

export async function defineAttributeInternal(
  tx: Tx, tenant: TenantRef, actor: AuditActor, input: AttributeInput, finalize: boolean,
) {
  const objectType = await object(tx, tenant, input.objectType)
  const parsed = AttributeSpec.parse(input)
  const values = validateAttributeValue(parsed)
  const count = await tx.attribute.count({ where: { ...tenantWhere(tenant), objectTypeId: objectType.id } })
  let created
  try {
    created = await tx.attribute.create({
      data: {
        ...tenantWhere(tenant),
        objectTypeId: objectType.id,
        slug: parsed.slug,
        name: parsed.name,
        description: parsed.description,
        type: parsed.type,
        config: values.config,
        isMulti: parsed.is_multi,
        isRequired: parsed.is_required,
        isUnique: parsed.is_unique,
        isIndexed: parsed.is_indexed,
        isSystem: input.isSystem ?? false,
        sensitivity: parsed.sensitivity,
        defaultValue: values.defaultValue,
        position: count,
      },
    })
  } catch (error) {
    if (isUniqueConstraint(error)) throw schemaConflict('attribute_slug')
    throw error
  }
  await ensureBackingRelation(tx, tenant, input, objectType.id)
  if (finalize) { await bumpSchemaVersion(tx, tenant); await audit(tx, tenant, actor, 'define', 'attribute', created.id) }
  return created
}
async function defineRelationTypeInternal(
  tx: Tx, tenant: TenantRef, actor: AuditActor, input: RelationInput, finalize: boolean,
) {
  if (Object.hasOwn(input, 'projectionAttributeSlug')) {
    throw schemaConflict('projection_ownership_is_internal')
  }
  const edgeAttributes = input.edgeAttributes ?? []
  if (edgeAttributes.length > 20) throw schemaConflict('too_many_edge_attributes')
  for (const edgeAttribute of edgeAttributes) validateAttributeValue(AttributeSpec.parse(edgeAttribute))
  const from = input.fromObjectType === null ? null : await object(tx, tenant, input.fromObjectType)
  const to = input.toObjectType === null ? null : await object(tx, tenant, input.toObjectType)
  const edgeLimits = await relationLimitData(tx, tenant, input)
  let created
  try {
    created = await tx.relationType.create({
      data: {
        ...tenantWhere(tenant),
        slug: input.slug,
        fromObjectTypeId: from?.id ?? null,
        toObjectTypeId: to?.id ?? null,
        forwardName: input.forwardName,
        inverseName: input.inverseName,
        description: input.description ?? '',
        cardinality: input.cardinality,
        maxActiveEdgesFrom: edgeLimits.maxActiveEdgesFrom,
        maxActiveEdgesTo: edgeLimits.maxActiveEdgesTo,
        edgeLimitConfig: jsonValue(edgeLimits.edgeLimitConfig),
        onDelete: input.onDelete ?? 'unlink',
        edgeAttributes: jsonValue(edgeAttributes),
        projectionAttributeSlug: null,
        isSystem: input.isSystem ?? false,
      },
    })
  } catch (error) {
    if (isUniqueConstraint(error)) throw schemaConflict('relation_type_slug')
    throw error
  }
  if (finalize) { await bumpSchemaVersion(tx, tenant); await audit(tx, tenant, actor, 'define', 'relation_type', created.id) }
  return created
}
export async function archiveObjectType(
  tx: Tx,
  tenant: TenantRef,
  actor: AuditActor,
  slug: string,
  reason?: string,
) {
  const target = await object(tx, tenant, slug)
  const archived = await tx.objectType.update({ where: { id: target.id }, data: { archivedAt: new Date() } })
  await bumpSchemaVersion(tx, tenant)
  await audit(tx, tenant, actor, 'archive', 'object_type', archived.id, reason ?? null)
  return archived
}
async function updateObjectTypeInternal(
  tx: Tx,
  tenant: TenantRef,
  actor: AuditActor,
  slug: string,
  input: Partial<Omit<ObjectInput, 'slug'>>,
  finalize: boolean,
) {
  const target = await object(tx, tenant, slug)
  const primaryAttributeId = await resolvePrimaryAttribute(tx, tenant, target.id, input.primaryAttribute)
  const updated = await tx.objectType.update({
    where: { id: target.id },
    data: {
      singularName: input.singularName,
      pluralName: input.pluralName,
      description: input.description,
      icon: input.icon,
      primaryAttributeId,
    },
  })
  if (finalize) { await bumpSchemaVersion(tx, tenant); await audit(tx, tenant, actor, 'define', 'object_type', updated.id) }
  return updated
}
export async function updateAttribute(
  tx: Tx,
  tenant: TenantRef,
  actor: AuditActor,
  objectSlug: string,
  slug: string,
  input: AttributeUpdateInput,
) {
  const objectType = await object(tx, tenant, objectSlug)
  const target = await tx.attribute.findFirst({
    where: { ...tenantWhere(tenant), objectTypeId: objectType.id, slug, archivedAt: null },
  })
  if (target === null) throw unknownAttribute(slug)
  if (input.is_multi !== undefined && input.is_multi !== target.isMulti) {
    throw schemaConflict('attribute_multi_is_immutable')
  }
  if (input.type !== undefined && input.type !== target.type) {
    throw schemaConflict('attribute_type_is_immutable')
  }
  const merged = AttributeSpec.parse({
    slug: target.slug, name: input.name ?? target.name, description: input.description ?? target.description,
    type: target.type, config: input.config ?? target.config, is_multi: target.isMulti,
    is_required: input.is_required ?? target.isRequired, is_unique: input.is_unique ?? target.isUnique,
    is_indexed: input.is_indexed ?? target.isIndexed, sensitivity: input.sensitivity ?? target.sensitivity,
    default_value: input.default_value,
  })
  const values = validateAttributeValue(merged)
  if (target.type === 'actor_reference' && input.config !== undefined) {
    const oldConfig = validateAttributeValue(AttributeSpec.parse({
      slug: target.slug, name: target.name, description: target.description, type: target.type,
      config: target.config, is_multi: target.isMulti, sensitivity: target.sensitivity,
    })).config
    if (objectField(oldConfig, 'role') !== objectField(values.config, 'role')) {
      throw schemaConflict('actor_reference_role_is_immutable')
    }
  }
  const evolutionTarget = {
    id: target.id,
    slug: target.slug,
    type: target.type,
    config: target.config,
    sensitivity: target.sensitivity,
    objectTypeId: objectType.id,
  }
  const evolution = await prepareAttributeEvolution(tx, tenant, evolutionTarget, input, values.config)
  const updated = await tx.attribute.update({
    where: { id: target.id },
    data: {
      name: input.name,
      description: input.description,
      config: evolution.config,
      isRequired: input.is_required,
      isUnique: input.is_unique,
      isIndexed: input.is_indexed,
      sensitivity: input.sensitivity,
      defaultValue: values.defaultValue,
    },
  })
  await enqueueAttributeEvolutionJobs(tx, tenant, evolutionTarget, actor, 'update', evolution)
  await bumpSchemaVersion(tx, tenant)
  await audit(tx, tenant, actor, 'define', 'attribute', updated.id)
  return updated
}
export async function archiveAttribute(
  tx: Tx,
  tenant: TenantRef,
  actor: AuditActor,
  objectSlug: string,
  slug: string,
  reason?: string,
) {
  const objectType = await object(tx, tenant, objectSlug)
  const target = await tx.attribute.findFirst({
    where: { ...tenantWhere(tenant), objectTypeId: objectType.id, slug, archivedAt: null },
  })
  if (target === null) throw unknownAttribute(slug)
  const archived = await tx.attribute.update({ where: { id: target.id }, data: { archivedAt: new Date() } })
  await enqueueAttributeEvolutionJobs(tx, tenant, {
    id: target.id,
    slug: target.slug,
    type: target.type,
    config: target.config,
    sensitivity: target.sensitivity,
    objectTypeId: objectType.id,
  }, actor, 'archive', { keyRecompute: false, reindex: true })
  await bumpSchemaVersion(tx, tenant)
  await audit(tx, tenant, actor, 'archive', 'attribute', archived.id, reason ?? null)
  return archived
}
export async function updateRelationType(
  tx: Tx,
  tenant: TenantRef,
  actor: AuditActor,
  slug: string,
  input: RelationUpdateInput,
) {
  const target = await tx.relationType.findFirst({ where: { ...tenantWhere(tenant), slug, archivedAt: null } })
  if (target === null) throw schemaConflict('unknown_relation_type')
  if (
    target.projectionAttributeSlug !== null &&
    input.cardinality !== undefined &&
    input.cardinality !== target.cardinality
  ) throw schemaConflict('claimed_relation_structure_is_immutable')
  const edgeAttributes = input.edgeAttributes
  if (edgeAttributes !== undefined) {
    if (edgeAttributes.length > 20) throw schemaConflict('too_many_edge_attributes')
    for (const attribute of edgeAttributes) validateAttributeValue(AttributeSpec.parse(attribute))
  }
  const edgeLimits = await relationLimitData(tx, tenant, {
    maxActiveEdgesFrom: input.maxActiveEdgesFrom === undefined ? target.maxActiveEdgesFrom : input.maxActiveEdgesFrom,
    maxActiveEdgesTo: input.maxActiveEdgesTo === undefined ? target.maxActiveEdgesTo : input.maxActiveEdgesTo,
    edgeLimitConfig: input.edgeLimitConfig === undefined ? target.edgeLimitConfig : input.edgeLimitConfig,
  }, target)
  const updated = await tx.relationType.update({
    where: { id: target.id },
    data: {
      forwardName: input.forwardName,
      inverseName: input.inverseName,
      description: input.description,
      cardinality: input.cardinality,
      maxActiveEdgesFrom: edgeLimits.maxActiveEdgesFrom,
      maxActiveEdgesTo: edgeLimits.maxActiveEdgesTo,
      edgeLimitConfig: jsonValue(edgeLimits.edgeLimitConfig),
      onDelete: input.onDelete,
      edgeAttributes: edgeAttributes === undefined ? undefined : jsonValue(edgeAttributes),
    },
  })
  await bumpSchemaVersion(tx, tenant)
  await audit(tx, tenant, actor, 'define', 'relation_type', updated.id)
  return updated
}
export async function archiveRelationType(
  tx: Tx,
  tenant: TenantRef,
  actor: AuditActor,
  slug: string,
  reason?: string,
) {
  const target = await tx.relationType.findFirst({ where: { ...tenantWhere(tenant), slug, archivedAt: null } })
  if (target === null) throw schemaConflict('unknown_relation_type')
  const archived = await tx.relationType.update({ where: { id: target.id }, data: { archivedAt: new Date() } })
  await bumpSchemaVersion(tx, tenant)
  await audit(tx, tenant, actor, 'archive', 'relation_type', archived.id, reason ?? null)
  return archived
}
export const defineObjectType = (tx: Tx, tenant: TenantRef, actor: AuditActor, input: ObjectInput) =>
  defineObjectTypeInternal(tx, tenant, actor, input, true)
export async function defineObjectTypeWithAttributes(
  tx: Tx,
  tenant: TenantRef,
  actor: AuditActor,
  input: ObjectInput & { attributes?: AttributeSpecValue[] },
) {
  const created = await defineObjectTypeBatch(tx, tenant, actor, input)
  for (const attribute of input.attributes ?? []) {
    await defineAttributeBatch(tx, tenant, actor, { ...attribute, objectType: input.slug })
  }
  if (input.primaryAttribute !== undefined)
    await updateObjectTypeBatch(tx, tenant, actor, input.slug, { primaryAttribute: input.primaryAttribute })
  await bumpSchemaVersion(tx, tenant)
  await audit(tx, tenant, actor, 'define', 'object_type', created.id)
  return created
}
export const defineObjectTypeBatch = (tx: Tx, tenant: TenantRef, actor: AuditActor, input: ObjectInput) =>
  defineObjectTypeInternal(tx, tenant, actor, input, false)
export const defineAttribute = (tx: Tx, tenant: TenantRef, actor: AuditActor, input: AttributeInput) =>
  defineAttributeInternal(tx, tenant, actor, input, true)
export const defineAttributeBatch = (tx: Tx, tenant: TenantRef, actor: AuditActor, input: AttributeInput) =>
  defineAttributeInternal(tx, tenant, actor, input, false)
export const defineRelationType = (tx: Tx, tenant: TenantRef, actor: AuditActor, input: RelationInput) =>
  defineRelationTypeInternal(tx, tenant, actor, input, true)
export const defineRelationTypeBatch = (tx: Tx, tenant: TenantRef, actor: AuditActor, input: RelationInput) =>
  defineRelationTypeInternal(tx, tenant, actor, input, false)
export const updateObjectType = (tx: Tx, tenant: TenantRef, actor: AuditActor, slug: string, input: ObjUpdate) =>
  updateObjectTypeInternal(tx, tenant, actor, slug, input, true)
export const updateObjectTypeBatch = (tx: Tx, tenant: TenantRef, actor: AuditActor, slug: string, input: ObjUpdate) =>
  updateObjectTypeInternal(tx, tenant, actor, slug, input, false)
export { cancelMatchingRules, retryMatchingRules, setMatchingRules, setMatchingRulesBatch }
export { finalizeMatchingBackfill, finalizeMatchingBootstrap }
