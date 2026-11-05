import { randomUUID } from 'node:crypto'
import { tenantWhere, type TenantRef, writeAudit } from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import { writeChangeRows } from '../change-log.js'
import type { AuditActor } from './mutation-types.js'
import type { SchemaTx } from './tx.js'

export function audit(
  tx: SchemaTx, tenant: TenantRef, actor: AuditActor, action: string,
  resourceType: string, resourceId: string | null, reason: string | null = null,
): Promise<unknown> {
  return writeAudit(tx, {
    organizationId: tenant.organizationId, teamId: tenant.teamId,
    actorType: actor.type, actorId: actor.id, onBehalfOf: actor.onBehalfOf,
    action, resourceType, resourceId, outcome: 'success', reason, metadata: null,
    requestId: actor.requestId, ipAddress: null, userAgent: null,
  })
}

/** Wildcard relation endpoints affect every currently defined type in this tenant. */
export async function relationSchemaObjects(
  tx: SchemaTx, tenant: TenantRef,
  relation: { fromObjectTypeId: string | null; toObjectTypeId: string | null },
): Promise<string[]> {
  const unrestricted = relation.fromObjectTypeId === null || relation.toObjectTypeId === null
  const rows = await tx.objectType.findMany({ where: {
    ...tenantWhere(tenant), archivedAt: null,
    ...(unrestricted ? {} : { id: { in: [relation.fromObjectTypeId!, relation.toObjectTypeId!] } }),
  }, select: { slug: true }, orderBy: { slug: 'asc' } })
  return rows.map(row => row.slug)
}

/** A reference field can introduce a backing relation visible from its target type too. */
export async function attributeSchemaObjects(
  tx: SchemaTx, tenant: TenantRef, objectTypeId: string, objectType: string, attribute: string,
): Promise<string[]> {
  const relation = await tx.relationType.findFirst({ where: {
    ...tenantWhere(tenant), fromObjectTypeId: objectTypeId, projectionAttributeSlug: attribute, archivedAt: null,
  } })
  return relation ? relationSchemaObjects(tx, tenant, relation) : [objectType]
}

/** Schema metadata, its version, and its feed events commit or roll back together. */
export async function bumpSchemaVersion(
  tx: SchemaTx, tenant: TenantRef, actor: AuditActor, objectTypes: readonly string[],
): Promise<void> {
  const [team] = await tx.$queryRaw<{ schemaVersion: number }[]>`
    UPDATE teams SET schema_version = schema_version + 1
    WHERE id = ${tenant.teamId}::uuid AND organization_id = ${tenant.organizationId}::uuid
    RETURNING schema_version AS "schemaVersion"
  `
  if (team === undefined) throw new ServiceError(ErrorCode.NOT_FOUND, 'Tenant team not found')
  const groupId = randomUUID()
  await writeChangeRows(tx, { tenant, actor, onBehalfOf: actor.onBehalfOf,
    requestId: actor.requestId, provenance: actor.provenance }, [...new Set(objectTypes)].sort().map(objectType => ({
    recordId: null, kind: 'schema_change', attributeSlug: objectType,
    relationTypeId: null, linkId: null, groupId,
    oldValue: null, newValue: { object_type: objectType, schema_version: team.schemaVersion }, snapshot: null,
    resultingVersion: team.schemaVersion, reason: null,
  })))
}
