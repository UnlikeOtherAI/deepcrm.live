import type { TenantRef } from '@deepcrm/db'

import type { AuditActor } from '../schema/mutate.js'
import { ensureSystemAttributes, templateAttributeSpecs } from '../schema/system-attributes.js'
import type { SchemaTx } from '../schema/tx.js'
import standardCrmJson from '../templates/standard_crm.json' with { type: 'json' }

/** The three system attributes marketing consent is held in (schema-engine §4d′). */
export const CONSENT_ATTRIBUTE_SLUGS = {
  state: 'marketing_consent',
  at: 'marketing_consent_at',
  source: 'marketing_consent_source',
} as const

// The `person` type of the standard_crm template is the one definition of the
// consent attributes; an older tenant receives exactly those.
const CONSENT_SPECS = templateAttributeSpecs(standardCrmJson, 'person', Object.values(CONSENT_ATTRIBUTE_SLUGS))

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
export function ensureConsentAttributes(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  objectTypeSlug: string,
): Promise<{ added: number }> {
  return ensureSystemAttributes(tx, tenant, actor, {
    objectTypeSlug,
    specs: CONSENT_SPECS,
    lockKey: `consent:${tenant.teamId}`,
    auditAction: 'schema.consent_attributes.ensure',
    conflictMessage: 'Consent attributes conflict with existing metadata',
  })
}
