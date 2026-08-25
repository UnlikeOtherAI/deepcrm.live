import { tenantWhere, type TenantRef } from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import { audit, bumpSchemaVersion, object, type AuditActor } from './mutate.js'
import type { AttributeGroupInput } from './mutation-types.js'
import type { SchemaTx } from './tx.js'

function schemaConflict(detail: string): ServiceError {
  return new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema conflicts with existing metadata', { detail })
}

function uniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

async function activeGroup(tx: SchemaTx, tenant: TenantRef, objectTypeId: string, slug: string) {
  const group = await tx.attributeGroup.findFirst({
    where: { ...tenantWhere(tenant), objectTypeId, slug, archivedAt: null },
  })
  if (group === null) throw schemaConflict('unknown_attribute_group')
  return group
}

async function nextPosition(tx: SchemaTx, tenant: TenantRef, objectTypeId: string): Promise<number> {
  const row = await tx.attributeGroup.findFirst({
    where: { ...tenantWhere(tenant), objectTypeId },
    orderBy: { position: 'desc' },
    select: { position: true },
  })
  return row === null ? 0 : row.position + 1
}

export async function defineAttributeGroup(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  input: AttributeGroupInput,
) {
  const objectType = await object(tx, tenant, input.objectType)
  let created
  try {
    created = await tx.attributeGroup.create({
      data: {
        ...tenantWhere(tenant),
        objectTypeId: objectType.id,
        slug: input.slug,
        name: input.name,
        description: input.description,
        position: await nextPosition(tx, tenant, objectType.id),
        createdByType: actor.type,
        createdById: actor.id,
      },
    })
  } catch (error) {
    if (uniqueConstraint(error)) throw schemaConflict('attribute_group_slug')
    throw error
  }
  const attributes = input.attributes ?? []
  if (attributes.length > 0) {
    const updated = await tx.attribute.updateMany({
      where: { ...tenantWhere(tenant), objectTypeId: objectType.id, slug: { in: attributes }, archivedAt: null },
      data: { groupId: created.id },
    })
    if (updated.count !== new Set(attributes).size) throw schemaConflict('unknown_attribute')
  }
  await bumpSchemaVersion(tx, tenant)
  await audit(tx, tenant, actor, 'define', 'attribute_group', created.id)
  return created
}

export async function reorderAttributeGroups(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  objectSlug: string,
  slugs: readonly string[],
) {
  const objectType = await object(tx, tenant, objectSlug)
  const groups = await tx.attributeGroup.findMany({
    where: { ...tenantWhere(tenant), objectTypeId: objectType.id, archivedAt: null },
    orderBy: { position: 'asc' },
  })
  if (groups.length !== slugs.length || new Set(slugs).size !== slugs.length) {
    throw schemaConflict('attribute_group_order_mismatch')
  }
  const bySlug = new Map(groups.map((group) => [group.slug, group]))
  if (slugs.some((slug) => !bySlug.has(slug))) throw schemaConflict('attribute_group_order_mismatch')
  for (const group of groups) {
    await tx.attributeGroup.update({ where: { id: group.id }, data: { position: -group.position - 1 } })
  }
  const ordered = []
  for (const [position, slug] of slugs.entries()) {
    const group = bySlug.get(slug)
    if (group === undefined) throw schemaConflict('attribute_group_order_mismatch')
    ordered.push(await tx.attributeGroup.update({ where: { id: group.id }, data: { position } }))
  }
  await bumpSchemaVersion(tx, tenant)
  await audit(tx, tenant, actor, 'define', 'attribute_group', objectType.id)
  return ordered
}

export async function archiveAttributeGroup(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  objectSlug: string,
  slug: string,
  reason?: string,
) {
  const objectType = await object(tx, tenant, objectSlug)
  const group = await activeGroup(tx, tenant, objectType.id, slug)
  const archived = await tx.attributeGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } })
  await tx.attribute.updateMany({ where: { ...tenantWhere(tenant), groupId: group.id }, data: { groupId: null } })
  await bumpSchemaVersion(tx, tenant)
  await audit(tx, tenant, actor, 'archive', 'attribute_group', archived.id, reason ?? null)
  return archived
}
