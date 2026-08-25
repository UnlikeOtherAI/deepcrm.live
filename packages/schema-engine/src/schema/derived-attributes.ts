import { Prisma, tenantWhere, type TenantRef } from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import {
  parseDerivedConfig,
  sourceAttributeSlugs,
  type DerivedAttributeDefinition,
  type DerivedValueSource,
} from '../derived/index.js'
import type { AttributeInput, AuditActor } from './mutation-types.js'
import {
  audit,
  bumpSchemaVersion,
  defineAttributeInternal,
  jsonValue,
  object,
  unknownAttribute,
} from './mutate.js'
import type { SchemaTx } from './tx.js'

type StoredJsonValue = Prisma.InputJsonValue | typeof Prisma.JsonNull
type Dependency = {
  sourceKind: string
  sourcePath: string[]
  sourceAttributeId: string | null
  relationTypeId: string | null
}

function derivationError(detail: string): ServiceError {
  return new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Derived attribute definition is invalid', { detail })
}

function derivedAttributeSpec(input: DerivedAttributeDefinition): AttributeInput {
  return {
    objectType: input.objectType,
    slug: input.slug,
    name: input.name,
    description: input.description,
    type: input.type,
    config: input.config,
    is_multi: false,
    is_required: input.isRequired,
    is_unique: false,
    is_indexed: input.isIndexed,
    sensitivity: input.sensitivity,
  }
}

async function activeAttributeBySlug(
  tx: SchemaTx,
  tenant: TenantRef,
  objectTypeId: string,
  slug: string,
) {
  const attribute = await tx.attribute.findFirst({
    where: { ...tenantWhere(tenant), objectTypeId, slug, archivedAt: null },
  })
  if (attribute === null) throw unknownAttribute(slug)
  return attribute
}

async function relatedObjectTypeId(
  tx: SchemaTx,
  tenant: TenantRef,
  currentObjectTypeId: string,
  relationSlug: string,
  direction: 'outgoing' | 'incoming',
): Promise<{ relationTypeId: string; objectTypeId: string }> {
  const relation = await tx.relationType.findFirst({
    where: { ...tenantWhere(tenant), slug: relationSlug, archivedAt: null },
  })
  if (relation === null) throw derivationError('unknown_relation_type')
  if (direction === 'outgoing') {
    if (relation.fromObjectTypeId !== currentObjectTypeId || relation.toObjectTypeId === null) {
      throw derivationError('relation_direction')
    }
    return { relationTypeId: relation.id, objectTypeId: relation.toObjectTypeId }
  }
  if (relation.toObjectTypeId !== currentObjectTypeId || relation.fromObjectTypeId === null) {
    throw derivationError('relation_direction')
  }
  return { relationTypeId: relation.id, objectTypeId: relation.fromObjectTypeId }
}

async function dependsOn(
  tx: SchemaTx,
  tenant: TenantRef,
  candidateId: string,
  targetId: string,
  seen: Set<string>,
): Promise<boolean> {
  if (candidateId === targetId) return true
  if (seen.has(candidateId)) return false
  seen.add(candidateId)
  const edges = await tx.attributeDerivationDependency.findMany({
    where: { ...tenantWhere(tenant), attributeId: candidateId, sourceAttributeId: { not: null } },
    select: { sourceAttributeId: true },
  })
  for (const edge of edges) {
    if (edge.sourceAttributeId !== null && await dependsOn(tx, tenant, edge.sourceAttributeId, targetId, seen)) {
      return true
    }
  }
  return false
}

async function dependencies(
  tx: SchemaTx,
  tenant: TenantRef,
  objectTypeId: string,
  targetAttributeId: string,
  valueSource: DerivedValueSource,
  config: unknown,
): Promise<{ config: StoredJsonValue; dependencies: Dependency[] }> {
  const parsed = (() => {
    try { return parseDerivedConfig(valueSource, config) } catch { throw derivationError('invalid_config') }
  })()
  const rows: Dependency[] = []
  const directSourceSlugs = sourceAttributeSlugs(parsed)
  if (parsed.value_source === 'rollup' || parsed.value_source === 'relation_sync') {
    const relation = await relatedObjectTypeId(
      tx, tenant, objectTypeId, parsed.config.relation_type, parsed.config.direction,
    )
    rows.push({
      sourceKind: 'relation',
      sourcePath: [parsed.config.direction, parsed.config.relation_type],
      sourceAttributeId: null,
      relationTypeId: relation.relationTypeId,
    })
    for (const slug of directSourceSlugs) {
      const source = await activeAttributeBySlug(tx, tenant, relation.objectTypeId, slug)
      rows.push({
        sourceKind: 'attribute',
        sourcePath: [parsed.value_source, slug],
        sourceAttributeId: source.id,
        relationTypeId: relation.relationTypeId,
      })
    }
  } else {
    for (const slug of directSourceSlugs) {
      const source = await activeAttributeBySlug(tx, tenant, objectTypeId, slug)
      if (await dependsOn(tx, tenant, source.id, targetAttributeId, new Set())) {
        throw derivationError('dependency_cycle')
      }
      rows.push({
        sourceKind: 'attribute',
        sourcePath: [parsed.value_source, slug],
        sourceAttributeId: source.id,
        relationTypeId: null,
      })
    }
  }
  return { config: jsonValue(parsed.config), dependencies: rows }
}

async function replaceDerivation(
  tx: SchemaTx,
  tenant: TenantRef,
  attributeId: string,
  valueSource: DerivedValueSource,
  config: StoredJsonValue,
  dependenciesInput: readonly Dependency[],
): Promise<void> {
  await tx.attributeDerivation.upsert({
    where: { attributeId },
    update: { valueSource, config, refreshState: 'pending', refreshErrorCode: null },
    create: { ...tenantWhere(tenant), attributeId, valueSource, config, materialized: true, refreshState: 'pending' },
  })
  await tx.attributeDerivationDependency.deleteMany({ where: { ...tenantWhere(tenant), attributeId } })
  for (const dependency of dependenciesInput) {
    await tx.attributeDerivationDependency.create({
      data: {
        ...tenantWhere(tenant),
        attributeId,
        sourceKind: dependency.sourceKind,
        sourcePath: dependency.sourcePath,
        sourceAttributeId: dependency.sourceAttributeId,
        relationTypeId: dependency.relationTypeId,
      },
    })
  }
}

async function enqueueDerivedBackfill(
  tx: SchemaTx,
  tenant: TenantRef,
  objectTypeId: string,
  attributeId: string,
  actor: AuditActor,
): Promise<void> {
  const records = await tx.record.findMany({
    where: { ...tenantWhere(tenant), objectTypeId, deletedAt: null, mergedIntoId: null, erasedAt: null },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  if (records.length === 0) return
  for (let index = 0; index < records.length; index += 500) {
    const batch = records.slice(index, index + 500)
    await tx.queueJob.create({
      data: {
        ...tenantWhere(tenant),
        type: 'derived.refresh',
        priority: 90,
        payload: {
          organizationId: tenant.organizationId,
          teamId: tenant.teamId,
          sourceRecordIds: batch.map((record) => record.id),
        },
        idempotencyKey: `derived-schema:${tenant.teamId}:${attributeId}:${actor.requestId}:${index}`,
      },
    })
  }
}

async function defineDerivedAttributeInternal(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  input: DerivedAttributeDefinition,
  finalize: (objectTypeId: string, attributeId: string) => Promise<void>,
) {
  const objectType = await object(tx, tenant, input.objectType)
  const created = await defineAttributeInternal(tx, tenant, actor, derivedAttributeSpec(input), false)
  const prepared = await dependencies(
    tx, tenant, objectType.id, created.id, input.valueSource, input.derivationConfig,
  )
  await tx.attribute.update({ where: { id: created.id }, data: { valueSource: input.valueSource } })
  await replaceDerivation(tx, tenant, created.id, input.valueSource, prepared.config, prepared.dependencies)
  await enqueueDerivedBackfill(tx, tenant, objectType.id, created.id, actor)
  await finalize(objectType.id, created.id)
  return tx.attribute.findFirstOrThrow({ where: { ...tenantWhere(tenant), id: created.id } })
}

export async function defineDerivedAttribute(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  input: DerivedAttributeDefinition,
) {
  return defineDerivedAttributeInternal(tx, tenant, actor, input, async (_objectTypeId, attributeId) => {
    await bumpSchemaVersion(tx, tenant)
    await audit(tx, tenant, actor, 'define', 'attribute', attributeId)
  })
}

export async function defineDerivedAttributeBatch(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  input: DerivedAttributeDefinition,
) {
  return defineDerivedAttributeInternal(tx, tenant, actor, input, async () => {})
}

export async function updateDerivedAttribute(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  objectSlug: string,
  slug: string,
  input: {
    name?: string
    description?: string
    isRequired?: boolean
    isIndexed?: boolean
    sensitivity?: 'public' | 'internal' | 'confidential' | 'restricted'
    derivationConfig?: Record<string, unknown>
  },
) {
  const objectType = await object(tx, tenant, objectSlug)
  const target = await tx.attribute.findFirst({
    where: { ...tenantWhere(tenant), objectTypeId: objectType.id, slug, archivedAt: null },
  })
  if (target === null) throw unknownAttribute(slug)
  if (target.valueSource === 'stored' || target.valueSource === 'system') throw derivationError('not_derived')
  const valueSource = target.valueSource
  const derivation = await tx.attributeDerivation.findUnique({ where: { attributeId: target.id } })
  if (derivation === null) throw derivationError('missing_derivation')
  const prepared = await dependencies(
    tx, tenant, objectType.id, target.id, valueSource, input.derivationConfig ?? derivation.config,
  )
  const updated = await tx.attribute.update({
    where: { id: target.id },
    data: {
      name: input.name,
      description: input.description,
      isRequired: input.isRequired,
      isIndexed: input.isIndexed,
      sensitivity: input.sensitivity,
    },
  })
  await replaceDerivation(tx, tenant, target.id, valueSource, prepared.config, prepared.dependencies)
  await bumpSchemaVersion(tx, tenant)
  await enqueueDerivedBackfill(tx, tenant, objectType.id, target.id, actor)
  await audit(tx, tenant, actor, 'define', 'attribute', target.id)
  return updated
}
