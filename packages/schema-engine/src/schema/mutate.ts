/* eslint-disable max-len */
import { tenantWhere, type Db, type TenantRef, writeAudit } from '@deepcrm/db'
import { AttributeSpec, type AttributeSpec as AttributeSpecValue } from '@deepcrm/schemas'
import { getAttributeType } from '../attribute-types/index.js'

type Tx = Db
type AuditActor = { type: 'human' | 'agent' | 'system'; id: string; onBehalfOf: string | null; requestId: string }
type ObjectInput = { slug: string; singularName: string; pluralName: string; description: string; icon?: string; kind?: 'system' | 'standard' | 'custom'; primaryAttribute?: string }
type AttributeInput = AttributeSpecValue & { objectType: string; isSystem?: boolean }
type RelationInput = { slug: string; fromObjectType: string | null; toObjectType: string | null; forwardName: string; inverseName: string; description?: string; cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many'; onDelete?: 'unlink' | 'cascade' | 'restrict'; edgeAttributes?: AttributeSpecValue[]; projectionAttributeSlug?: string }

function audit(tx: Tx, tenant: TenantRef, actor: AuditActor, action: string, resourceType: string, resourceId: string | null): Promise<unknown> {
  return writeAudit(tx, { organizationId: tenant.organizationId, teamId: tenant.teamId, actorType: actor.type, actorId: actor.id, onBehalfOf: actor.onBehalfOf, action, resourceType, resourceId, outcome: 'success', reason: null, metadata: null, requestId: actor.requestId, ipAddress: null, userAgent: null })
}

async function bump(tx: Tx, tenant: TenantRef): Promise<void> {
  const result = await tx.team.updateMany({ where: { id: tenant.teamId, organizationId: tenant.organizationId }, data: { schemaVersion: { increment: 1 } } })
  if (result.count !== 1) throw new Error('tenant not found')
}

async function object(tx: Tx, tenant: TenantRef, slug: string) {
  const value = await tx.objectType.findFirst({ where: { ...tenantWhere(tenant), slug, archivedAt: null } })
  if (value === null) throw new Error(`unknown object type ${slug}`)
  return value
}

export async function defineObjectType(tx: Tx, tenant: TenantRef, actor: AuditActor, input: ObjectInput) {
  const created = await tx.objectType.create({ data: { ...tenantWhere(tenant), slug: input.slug, singularName: input.singularName, pluralName: input.pluralName, description: input.description, icon: input.icon ?? null, kind: input.kind ?? 'custom', createdByType: actor.type, createdById: actor.id } })
  await bump(tx, tenant)
  await audit(tx, tenant, actor, 'define', 'object_type', created.id)
  return created
}

async function ensureBackingRelation(tx: Tx, tenant: TenantRef, actor: AuditActor, attribute: AttributeInput, objectTypeId: string): Promise<void> {
  if (attribute.type !== 'record_reference') return
  const config = attribute.config
  const parsed = getAttributeType('record_reference').configSchema.safeParse(config)
  if (!parsed.success) throw new Error('invalid record_reference config')
  const referenceConfig = parsed.data
  if (!('objectTypes' in referenceConfig) || !Array.isArray(referenceConfig.objectTypes)) throw new Error('invalid record_reference config')
  const targets = referenceConfig.objectTypes
  const targetId = targets.length === 1 ? (await object(tx, tenant, targets[0] ?? '')).id : null
  const slug = 'relationTypeSlug' in referenceConfig && typeof referenceConfig.relationTypeSlug === 'string' ? referenceConfig.relationTypeSlug : `${attribute.objectType}_${attribute.slug}`
  const expectedCardinality = attribute.is_multi ? 'many_to_many' : 'many_to_one'
  const existing = await tx.relationType.findFirst({ where: { ...tenantWhere(tenant), slug } })
  if (existing !== null) {
    if (existing.fromObjectTypeId !== objectTypeId || existing.toObjectTypeId !== targetId || existing.cardinality !== expectedCardinality || existing.projectionAttributeSlug !== attribute.slug) throw new Error('SCHEMA_CONFLICT')
    return
  }
  await tx.relationType.create({ data: { ...tenantWhere(tenant), slug, fromObjectTypeId: objectTypeId, toObjectTypeId: targetId, forwardName: attribute.name, inverseName: attribute.name, description: attribute.description, cardinality: expectedCardinality, projectionAttributeSlug: attribute.slug, isSystem: false } })
  void actor
}

export async function defineAttribute(tx: Tx, tenant: TenantRef, actor: AuditActor, input: AttributeInput) {
  const objectType = await object(tx, tenant, input.objectType)
  const parsed = AttributeSpec.parse(input)
  const type = getAttributeType(parsed.type)
  const config = type.configSchema.parse(parsed.config ?? { type: parsed.type })
  if (parsed.type === 'status' && parsed.is_multi) throw new Error('SCHEMA_CONFLICT')
  if (parsed.is_unique && !type.supportsUnique) throw new Error('SCHEMA_CONFLICT')
  if (parsed.default_value !== undefined) type.valueSchema(config).parse(parsed.default_value)
  const count = await tx.attribute.count({ where: { ...tenantWhere(tenant), objectTypeId: objectType.id } })
  const created = await tx.attribute.create({ data: { ...tenantWhere(tenant), objectTypeId: objectType.id, slug: parsed.slug, name: parsed.name, description: parsed.description, type: parsed.type, config: config as never, isMulti: parsed.is_multi, isRequired: parsed.is_required, isUnique: parsed.is_unique, isIndexed: parsed.is_indexed, isSystem: input.isSystem ?? false, sensitivity: parsed.sensitivity, defaultValue: parsed.default_value as never, position: count } })
  await ensureBackingRelation(tx, tenant, actor, input, objectType.id)
  await bump(tx, tenant)
  await audit(tx, tenant, actor, 'define', 'attribute', created.id)
  return created
}

export async function defineRelationType(tx: Tx, tenant: TenantRef, actor: AuditActor, input: RelationInput) {
  const edgeAttributes = input.edgeAttributes ?? []
  if (edgeAttributes.length > 20) throw new Error('SCHEMA_CONFLICT')
  for (const edgeAttribute of edgeAttributes) AttributeSpec.parse(edgeAttribute)
  const from = input.fromObjectType === null ? null : await object(tx, tenant, input.fromObjectType)
  const to = input.toObjectType === null ? null : await object(tx, tenant, input.toObjectType)
  const created = await tx.relationType.create({ data: { ...tenantWhere(tenant), slug: input.slug, fromObjectTypeId: from?.id ?? null, toObjectTypeId: to?.id ?? null, forwardName: input.forwardName, inverseName: input.inverseName, description: input.description ?? '', cardinality: input.cardinality, onDelete: input.onDelete ?? 'unlink', edgeAttributes: edgeAttributes as never, projectionAttributeSlug: input.projectionAttributeSlug ?? null } })
  await bump(tx, tenant)
  await audit(tx, tenant, actor, 'define', 'relation_type', created.id)
  return created
}

export async function archiveObjectType(tx: Tx, tenant: TenantRef, actor: AuditActor, slug: string) {
  const target = await object(tx, tenant, slug)
  const archived = await tx.objectType.update({ where: { id: target.id }, data: { archivedAt: new Date() } })
  await bump(tx, tenant)
  await audit(tx, tenant, actor, 'archive', 'object_type', archived.id)
  return archived
}

export async function updateObjectType(tx: Tx, tenant: TenantRef, actor: AuditActor, slug: string, input: Partial<Omit<ObjectInput, 'slug'>>) {
  const target = await object(tx, tenant, slug)
  const updated = await tx.objectType.update({ where: { id: target.id }, data: { singularName: input.singularName, pluralName: input.pluralName, description: input.description, icon: input.icon } })
  await bump(tx, tenant)
  await audit(tx, tenant, actor, 'define', 'object_type', updated.id)
  return updated
}

export async function updateAttribute(tx: Tx, tenant: TenantRef, actor: AuditActor, objectSlug: string, slug: string, input: Partial<AttributeInput>) {
  const objectType = await object(tx, tenant, objectSlug)
  const target = await tx.attribute.findFirst({ where: { ...tenantWhere(tenant), objectTypeId: objectType.id, slug, archivedAt: null } })
  if (target === null) throw new Error(`unknown attribute ${slug}`)
  if (input.is_multi !== undefined && input.is_multi !== target.isMulti) throw new Error('SCHEMA_CONFLICT')
  if (input.type !== undefined && input.type !== target.type) throw new Error('SCHEMA_CONFLICT')
  const type = getAttributeType(target.type)
  if (input.is_unique === true && !type.supportsUnique) throw new Error('SCHEMA_CONFLICT')
  const config = input.config === undefined ? target.config : type.configSchema.parse(input.config)
  if (input.default_value !== undefined) type.valueSchema(config).parse(input.default_value)
  const updated = await tx.attribute.update({ where: { id: target.id }, data: { name: input.name, description: input.description, config: config as never, isRequired: input.is_required, isUnique: input.is_unique, isIndexed: input.is_indexed, sensitivity: input.sensitivity, defaultValue: input.default_value as never } })
  await bump(tx, tenant)
  await audit(tx, tenant, actor, 'define', 'attribute', updated.id)
  return updated
}

export async function archiveAttribute(tx: Tx, tenant: TenantRef, actor: AuditActor, objectSlug: string, slug: string) {
  const objectType = await object(tx, tenant, objectSlug)
  const target = await tx.attribute.findFirst({ where: { ...tenantWhere(tenant), objectTypeId: objectType.id, slug, archivedAt: null } })
  if (target === null) throw new Error(`unknown attribute ${slug}`)
  const archived = await tx.attribute.update({ where: { id: target.id }, data: { archivedAt: new Date() } })
  await bump(tx, tenant)
  await audit(tx, tenant, actor, 'archive', 'attribute', archived.id)
  return archived
}

export async function updateRelationType(tx: Tx, tenant: TenantRef, actor: AuditActor, slug: string, input: Partial<RelationInput>) {
  const target = await tx.relationType.findFirst({ where: { ...tenantWhere(tenant), slug, archivedAt: null } })
  if (target === null) throw new Error(`unknown relation type ${slug}`)
  const edgeAttributes = input.edgeAttributes
  if (edgeAttributes !== undefined) {
    if (edgeAttributes.length > 20) throw new Error('SCHEMA_CONFLICT')
    for (const attribute of edgeAttributes) AttributeSpec.parse(attribute)
  }
  const updated = await tx.relationType.update({ where: { id: target.id }, data: { forwardName: input.forwardName, inverseName: input.inverseName, description: input.description, cardinality: input.cardinality, onDelete: input.onDelete, edgeAttributes: edgeAttributes as never } })
  await bump(tx, tenant)
  await audit(tx, tenant, actor, 'define', 'relation_type', updated.id)
  return updated
}

export async function archiveRelationType(tx: Tx, tenant: TenantRef, actor: AuditActor, slug: string) {
  const target = await tx.relationType.findFirst({ where: { ...tenantWhere(tenant), slug, archivedAt: null } })
  if (target === null) throw new Error(`unknown relation type ${slug}`)
  const archived = await tx.relationType.update({ where: { id: target.id }, data: { archivedAt: new Date() } })
  await bump(tx, tenant)
  await audit(tx, tenant, actor, 'archive', 'relation_type', archived.id)
  return archived
}

export async function setMatchingRules(tx: Tx, tenant: TenantRef, actor: AuditActor, objectSlug: string, rules: Array<{ attributes: string[]; method: 'exact' | 'normalized' | 'fuzzy'; threshold?: number; action: 'block' | 'warn' | 'allow' }>) {
  const objectType = await object(tx, tenant, objectSlug)
  if (rules.length > 10) throw new Error('SCHEMA_CONFLICT')
  for (const rule of rules) {
    if (rule.action === 'block' && rule.method === 'fuzzy') throw new Error('SCHEMA_CONFLICT')
    if (rule.method === 'fuzzy' && (rule.threshold === undefined || rule.threshold < 0.5)) throw new Error('SCHEMA_CONFLICT')
  }
  await tx.matchingRule.deleteMany({ where: { ...tenantWhere(tenant), objectTypeId: objectType.id } })
  if (rules.length > 0) await tx.matchingRule.createMany({ data: rules.map((rule, position) => ({ ...tenantWhere(tenant), objectTypeId: objectType.id, position, attributeSlugs: rule.attributes, method: rule.method, threshold: rule.threshold ?? null, action: rule.action })) })
  await bump(tx, tenant)
  await audit(tx, tenant, actor, 'define', 'object_type', objectType.id)
}
