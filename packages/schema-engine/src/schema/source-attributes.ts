import type { TenantRef } from '@deepcrm/db'

import standardCrmJson from '../templates/standard_crm.json' with { type: 'json' }
import systemJson from '../templates/system.json' with { type: 'json' }
import type { AuditActor } from './mutate.js'
import type { LoadedObjectType } from './load.js'
import {
  ensureSystemAttributes, holdsSystemAttributes, templateAttributeSpecs, type SystemAttributeSpec,
} from './system-attributes.js'
import type { SchemaTx } from './tx.js'

/**
 * Where a record first came from (schema-engine §4d″): three system attributes
 * on the record's type, set once when a call that names a source creates it.
 */
export const FIRST_SOURCE_ATTRIBUTE_SLUGS = {
  kind: 'first_source_kind',
  id: 'first_source_id',
  name: 'first_source_name',
} as const

/** The source an inbound activity came through: three system attributes on `activity`. */
export const ACTIVITY_SOURCE_ATTRIBUTE_SLUGS = {
  kind: 'source_kind',
  id: 'source_id',
  name: 'source_name',
} as const

// The standard_crm `person` and the system `activity` are the one definition
// of each set; any other type receives exactly the person's first-source specs.
const FIRST_SOURCE_SPECS = templateAttributeSpecs(
  standardCrmJson, 'person', Object.values(FIRST_SOURCE_ATTRIBUTE_SLUGS),
)
const ACTIVITY_SOURCE_SPECS = templateAttributeSpecs(
  systemJson, 'activity', Object.values(ACTIVITY_SOURCE_ATTRIBUTE_SLUGS),
)
const CONFLICT_MESSAGE = 'Source attributes conflict with existing metadata'

export type SourceAttributeSet = 'first_source' | 'activity_source'

function specs(set: SourceAttributeSet): readonly SystemAttributeSpec[] {
  return set === 'first_source' ? FIRST_SOURCE_SPECS : ACTIVITY_SOURCE_SPECS
}

/**
 * Whether the type holds the set already. A same-slug attribute that cannot
 * hold the values (another type, multi, unique, a missing option, a shorter
 * limit, archived) is a `SCHEMA_CONFLICT`.
 */
export function holdsSourceAttributes(objectType: LoadedObjectType, set: SourceAttributeSet): boolean {
  return holdsSystemAttributes(objectType, specs(set), CONFLICT_MESSAGE)
}

/**
 * Defines whichever attributes of the set the type lacks, in the caller's
 * transaction: one schema-version bump and one `schema.source_attributes.ensure`
 * audit when anything is added, serialised per team.
 */
export function ensureSourceAttributes(
  tx: SchemaTx, tenant: TenantRef, actor: AuditActor, objectTypeSlug: string, set: SourceAttributeSet,
): Promise<{ added: number }> {
  return ensureSystemAttributes(tx, tenant, actor, {
    objectTypeSlug,
    specs: specs(set),
    lockKey: `source:${tenant.teamId}`,
    auditAction: 'schema.source_attributes.ensure',
    conflictMessage: CONFLICT_MESSAGE,
  })
}
