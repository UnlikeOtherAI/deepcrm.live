import { tenantWhere, type TenantRef, writeAudit } from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import { definePipelineBatch } from '../pipeline/index.js'
import { defineDerivedAttributeBatch } from '../schema/derived-attributes.js'
import {
  bumpSchemaVersion,
  defineAttributeBatch,
  defineObjectTypeBatch,
  defineRelationTypeBatch,
  setMatchingRulesBatch,
  updateObjectTypeBatch,
  type AuditActor,
} from '../schema/mutate.js'
import type { SchemaTx } from '../schema/tx.js'
import standardCommerceJson from './standard_commerce.json' with { type: 'json' }
import standardCrmJson from './standard_crm.json' with { type: 'json' }
import standardSalesJson from './standard_sales.json' with { type: 'json' }
import standardServiceJson from './standard_service.json' with { type: 'json' }
import systemJson from './system.json' with { type: 'json' }
import { TemplateSchema, type Template, type TemplateAdded } from './types.js'

const templates = [
  TemplateSchema.parse(systemJson),
  TemplateSchema.parse(standardCrmJson),
  TemplateSchema.parse(standardSalesJson),
  TemplateSchema.parse(standardServiceJson),
  TemplateSchema.parse(standardCommerceJson),
] as const

function emptyAdded(): TemplateAdded {
  return { objectTypes: 0, attributes: 0, relationTypes: 0, pipelines: 0, matchingRules: 0 }
}

function total(added: TemplateAdded): number {
  return added.objectTypes + added.attributes + added.relationTypes + added.pipelines + added.matchingRules
}

function templateFor(slug: string): Template {
  const template = templates.find((candidate) => candidate.slug === slug)
  if (template === undefined) {
    throw new ServiceError(ErrorCode.UNKNOWN_TEMPLATE, 'Unknown template', {
      available: templates.map((candidate) => candidate.slug),
    })
  }
  return template
}

export function listTemplates(): readonly { slug: string; description: string }[] {
  return templates.map(({ slug, description }) => ({ slug, description }))
}

export async function applyTemplateBatch(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  slug: string,
): Promise<{ added: TemplateAdded }> {
  const template = templateFor(slug)
  const added = emptyAdded()
  const created = new Set<string>()

  for (const item of template.object_types) {
    const exists = await tx.objectType.findFirst({
      where: { ...tenantWhere(tenant), slug: item.slug, archivedAt: null },
    })
    if (exists !== null) continue
    await defineObjectTypeBatch(tx, tenant, actor, {
      slug: item.slug,
      singularName: item.singular_name,
      pluralName: item.plural_name,
      description: item.description,
      icon: item.icon,
      kind: item.kind,
    })
    created.add(item.slug)
    added.objectTypes += 1
  }

  for (const item of template.relation_types) {
    const exists = await tx.relationType.findFirst({
      where: { ...tenantWhere(tenant), slug: item.slug, archivedAt: null },
    })
    if (exists !== null) continue
    await defineRelationTypeBatch(tx, tenant, actor, {
      slug: item.slug,
      fromObjectType: item.from_object_type,
      toObjectType: item.to_object_type,
      forwardName: item.forward_name,
      inverseName: item.inverse_name,
      description: item.description,
      cardinality: item.cardinality,
      onDelete: item.on_delete,
      edgeAttributes: item.edge_attributes,
      isSystem: item.is_system,
    })
    added.relationTypes += 1
  }

  for (const object of template.object_types) {
    const owner = await tx.objectType.findFirst({
      where: { ...tenantWhere(tenant), slug: object.slug, archivedAt: null },
    })
    if (owner === null) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Template object missing')
    for (const item of object.attributes) {
      const exists = await tx.attribute.findFirst({
        where: { ...tenantWhere(tenant), objectTypeId: owner.id, slug: item.slug, archivedAt: null },
      })
      if (exists !== null) continue
      await defineAttributeBatch(tx, tenant, actor, {
        ...item,
        objectType: object.slug,
        isSystem: item.is_system,
      })
      added.attributes += 1
    }
  }

  for (const object of template.object_types) {
    const owner = await tx.objectType.findFirst({
      where: { ...tenantWhere(tenant), slug: object.slug, archivedAt: null },
    })
    if (owner === null) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Template object missing')
    for (const item of object.derived_attributes) {
      const exists = await tx.attribute.findFirst({
        where: { ...tenantWhere(tenant), objectTypeId: owner.id, slug: item.slug, archivedAt: null },
      })
      if (exists !== null) continue
      await defineDerivedAttributeBatch(tx, tenant, actor, {
        objectType: object.slug,
        slug: item.slug,
        name: item.name,
        description: item.description,
        type: item.type,
        config: item.config,
        isRequired: item.is_required,
        isIndexed: item.is_indexed,
        sensitivity: item.sensitivity,
        valueSource: item.value_source,
        derivationConfig: item.derivation_config,
      })
      added.attributes += 1
    }
  }

  for (const item of template.pipelines) {
    const exists = await tx.pipeline.findFirst({
      where: { ...tenantWhere(tenant), slug: item.slug, archivedAt: null },
    })
    if (exists !== null) continue
    await definePipelineBatch(tx, tenant, actor, {
      objectType: item.object_type,
      slug: item.slug,
      name: item.name,
      description: item.description,
      isDefault: item.is_default,
      stages: item.stages,
    })
    added.pipelines += 1
  }

  for (const object of template.object_types) {
    if (!created.has(object.slug)) continue
    await updateObjectTypeBatch(tx, tenant, actor, object.slug, {
      primaryAttribute: object.primary_attribute,
    })
    const rules = template.matching_rules[object.slug] ?? []
    await setMatchingRulesBatch(tx, tenant, actor, object.slug, rules)
    added.matchingRules += rules.length
  }
  return { added }
}

export async function applyTemplate(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  slug: string,
): Promise<{ added: TemplateAdded }> {
  const result = await applyTemplateBatch(tx, tenant, actor, slug)
  if (total(result.added) === 0) return result
  await bumpSchemaVersion(tx, tenant)
  await writeAudit(tx, {
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    actorType: actor.type,
    actorId: actor.id,
    onBehalfOf: actor.onBehalfOf,
    action: 'schema.template.apply',
    resourceType: 'template',
    resourceId: slug,
    outcome: 'success',
    reason: null,
    metadata: null,
    requestId: actor.requestId,
    ipAddress: null,
    userAgent: null,
  })
  return result
}
