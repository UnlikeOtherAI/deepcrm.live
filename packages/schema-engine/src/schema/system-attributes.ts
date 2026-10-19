import { tenantWhere, type TenantRef } from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import { TemplateSchema } from '../templates/types.js'
import { audit, bumpSchemaVersion, defineAttributeBatch, type AuditActor } from './mutate.js'
import type { LoadedObjectType } from './load.js'
import type { SchemaTx } from './tx.js'

/** One system attribute as a template defines it. */
export type SystemAttributeSpec = ReturnType<typeof TemplateSchema.parse>['object_types'][number]['attributes'][number]

type ExistingAttribute = {
  type: string; config: unknown; isMulti: boolean; isUnique: boolean; valueSource: string; archivedAt: Date | null
}

const NAMESPACE_PROVISIONING = 3

/**
 * The named attributes of one object type in a template — the one definition
 * of a set of system attributes, so an older tenant receives exactly what a
 * newly provisioned one has.
 */
export function templateAttributeSpecs(
  template: unknown, objectTypeSlug: string, slugs: readonly string[],
): readonly SystemAttributeSpec[] {
  const parsed = TemplateSchema.parse(template)
  const owner = parsed.object_types.find((item) => item.slug === objectTypeSlug)
  return slugs.map((slug) => {
    const spec = owner?.attributes.find((attribute) => attribute.slug === slug)
    if (spec === undefined) throw new Error(`${parsed.slug} ${objectTypeSlug} lacks the system attribute ${slug}`)
    return spec
  })
}

function optionIds(config: unknown): Set<string> {
  if (typeof config !== 'object' || config === null || !('options' in config) || !Array.isArray(config.options)) {
    return new Set()
  }
  return new Set(config.options.flatMap((option: unknown) => (
    typeof option === 'object' && option !== null && 'id' in option && typeof option.id === 'string'
      ? [option.id] : []
  )))
}

function maxLength(config: unknown): number | null {
  if (typeof config !== 'object' || config === null || !('maxLength' in config)) return null
  return typeof config.maxLength === 'number' ? config.maxLength : null
}

/**
 * Why an attribute of the same slug cannot hold a system attribute's values —
 * archived, another type or multiplicity, derived, unique, a missing option,
 * a shorter text limit — or null when it can. Never silently reused when it cannot.
 */
export function systemAttributeConflict(existing: ExistingAttribute, spec: SystemAttributeSpec): string | null {
  if (existing.archivedAt !== null) return `${spec.slug}_archived`
  if (existing.type !== spec.type || existing.isMulti !== spec.is_multi || existing.valueSource !== 'stored') {
    return `${spec.slug}_type`
  }
  if (existing.isUnique && !spec.is_unique) return `${spec.slug}_unique`
  const held = optionIds(existing.config)
  for (const id of optionIds(spec.config)) if (!held.has(id)) return `${spec.slug}_options`
  const required = maxLength(spec.config)
  const available = maxLength(existing.config)
  if (required !== null && available !== null && available < required) return `${spec.slug}_length`
  return null
}

export function systemAttributeConflictError(message: string, detail: string): ServiceError {
  return new ServiceError(ErrorCode.SCHEMA_CONFLICT, message, { detail })
}

/**
 * Whether `objectType` already holds every spec: true when all are present
 * and compatible, false when one is missing; an incompatible one is a
 * `SCHEMA_CONFLICT`.
 */
export function holdsSystemAttributes(
  objectType: LoadedObjectType, specs: readonly SystemAttributeSpec[], message: string,
): boolean {
  let complete = true
  for (const spec of specs) {
    const existing = objectType.attributes.find((attribute) => attribute.slug === spec.slug)
    if (existing === undefined) {
      complete = false
      continue
    }
    const conflict = systemAttributeConflict(existing, spec)
    if (conflict !== null) throw systemAttributeConflictError(message, conflict)
  }
  return complete
}

export type EnsureSystemAttributesInput = {
  objectTypeSlug: string
  specs: readonly SystemAttributeSpec[]
  /** The advisory key, under the provisioning namespace, that serialises two first writes of one team. */
  lockKey: string
  auditAction: string
  conflictMessage: string
}

/**
 * Defines whichever of `specs` the object type lacks, in the caller's
 * transaction, with one schema-version bump and one audit when anything was
 * added. An attribute of the same slug that cannot hold the values is a
 * `SCHEMA_CONFLICT`.
 */
export async function ensureSystemAttributes(
  tx: SchemaTx, tenant: TenantRef, actor: AuditActor, input: EnsureSystemAttributesInput,
): Promise<{ added: number }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NAMESPACE_PROVISIONING}::integer, hashtext(${input.lockKey}))`
  const owner = await tx.objectType.findFirst({
    where: { ...tenantWhere(tenant), slug: input.objectTypeSlug, archivedAt: null },
    select: { id: true },
  })
  if (owner === null) {
    throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type is not active in this tenant', {
      slug: input.objectTypeSlug,
    })
  }
  let added = 0
  for (const spec of input.specs) {
    const existing = await tx.attribute.findFirst({
      where: { ...tenantWhere(tenant), objectTypeId: owner.id, slug: spec.slug },
      select: { type: true, config: true, isMulti: true, isUnique: true, valueSource: true, archivedAt: true },
    })
    if (existing !== null) {
      const conflict = systemAttributeConflict(existing, spec)
      if (conflict !== null) throw systemAttributeConflictError(input.conflictMessage, conflict)
      continue
    }
    await defineAttributeBatch(tx, tenant, actor, {
      ...spec, objectType: input.objectTypeSlug, isSystem: spec.is_system,
    })
    added += 1
  }
  if (added === 0) return { added }
  await bumpSchemaVersion(tx, tenant)
  await audit(tx, tenant, actor, input.auditAction, 'object_type', owner.id)
  return { added }
}
