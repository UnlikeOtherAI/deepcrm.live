import { tenantWhere, type TenantRef } from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import { audit, bumpSchemaVersion, defineAttributeBatch, type AuditActor } from '../schema/mutate.js'
import type { SchemaTx } from '../schema/tx.js'
import standardCrmJson from '../templates/standard_crm.json' with { type: 'json' }
import { TemplateSchema } from '../templates/types.js'

/** The three system attributes marketing consent is held in (schema-engine §4d′). */
export const CONSENT_ATTRIBUTE_SLUGS = {
  state: 'marketing_consent',
  at: 'marketing_consent_at',
  source: 'marketing_consent_source',
} as const

const NAMESPACE_PROVISIONING = 3

type TemplateAttribute = ReturnType<typeof TemplateSchema.parse>['object_types'][number]['attributes'][number]

// The `person` type of the standard_crm template is the one definition of the
// consent attributes; an older tenant receives exactly those.
function consentSpecs(): readonly TemplateAttribute[] {
  const person = TemplateSchema.parse(standardCrmJson).object_types.find((item) => item.slug === 'person')
  const slugs: readonly string[] = Object.values(CONSENT_ATTRIBUTE_SLUGS)
  const specs = slugs.map((slug) => person?.attributes.find((attribute) => attribute.slug === slug))
  if (specs.some((spec) => spec === undefined)) throw new Error('standard_crm person lacks the consent attributes')
  return specs.filter((spec): spec is TemplateAttribute => spec !== undefined)
}

const CONSENT_SPECS = consentSpecs()

function optionIds(config: unknown): Set<string> {
  if (typeof config !== 'object' || config === null || !('options' in config) || !Array.isArray(config.options)) {
    return new Set()
  }
  return new Set(config.options.flatMap((option: unknown) => (
    typeof option === 'object' && option !== null && 'id' in option && typeof option.id === 'string'
      ? [option.id] : []
  )))
}

function conflict(detail: string): ServiceError {
  return new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Consent attributes conflict with existing metadata', { detail })
}

function assertCompatible(
  existing: { type: string; config: unknown; isMulti: boolean; archivedAt: Date | null },
  spec: TemplateAttribute,
): void {
  if (existing.archivedAt !== null) throw conflict(`${spec.slug}_archived`)
  if (existing.type !== spec.type || existing.isMulti) throw conflict(`${spec.slug}_type`)
  const held = optionIds(existing.config)
  for (const id of optionIds(spec.config)) if (!held.has(id)) throw conflict(`${spec.slug}_options`)
}

/** True when the object type already holds the three consent attributes. */
export function hasConsentAttributes(attributeSlugs: ReadonlySet<string>): boolean {
  return CONSENT_SPECS.every((spec) => attributeSlugs.has(spec.slug))
}

/**
 * Defines whichever consent attributes `objectTypeSlug` lacks, with one
 * schema-version bump and one `schema.consent_attributes.ensure` audit, in the
 * caller's transaction. Serialised per team so two first consent writes
 * cannot both define them. An attribute of the same slug that does not hold
 * the consent values (another type, missing options, archived) is a
 * `SCHEMA_CONFLICT`, never silently reused.
 */
export async function ensureConsentAttributes(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  objectTypeSlug: string,
): Promise<{ added: number }> {
  const lockKey = `consent:${tenant.teamId}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NAMESPACE_PROVISIONING}::integer, hashtext(${lockKey}))`
  const owner = await tx.objectType.findFirst({
    where: { ...tenantWhere(tenant), slug: objectTypeSlug, archivedAt: null },
    select: { id: true },
  })
  if (owner === null) {
    throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type is not active in this tenant', {
      slug: objectTypeSlug,
    })
  }
  let added = 0
  for (const spec of CONSENT_SPECS) {
    const existing = await tx.attribute.findFirst({
      where: { ...tenantWhere(tenant), objectTypeId: owner.id, slug: spec.slug },
      select: { type: true, config: true, isMulti: true, archivedAt: true },
    })
    if (existing !== null) {
      assertCompatible(existing, spec)
      continue
    }
    await defineAttributeBatch(tx, tenant, actor, { ...spec, objectType: objectTypeSlug, isSystem: spec.is_system })
    added += 1
  }
  if (added === 0) return { added }
  await bumpSchemaVersion(tx, tenant)
  await audit(tx, tenant, actor, 'schema.consent_attributes.ensure', 'object_type', owner.id)
  return { added }
}
