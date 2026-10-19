import { tenantWhere, type Db } from '@deepcrm/db'
import {
  changeContactPoint,
  contactAttributes,
  contactItems,
  contactKey,
  contactPointRows,
  liveRecord,
  loadSchema,
  lockLinkTopology,
  type ContactPointRow,
  type JsonValue,
  type LoadedAttribute,
  type LoadedObjectType,
} from '@deepcrm/schema-engine'
import {
  ErrorCode,
  ServiceError,
  SourceRef,
  requireOnBehalfOf,
  type ActorContext,
  type ContactPointAttribute,
  type ContactPointValue,
  type CrmContactPointSetInput,
  type CrmContactPointSetOutput,
  type CrmContactPointsGetInput,
  type CrmContactPointsGetOutput,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { loadPolicyEvaluator, type PolicyEvaluator, type PolicyRequest, type PolicyScopeRef } from './policy.js'
import { recordBoundary } from './record-boundary.js'
import { enqueueRecordMutationEffects } from './record-mutation-effects.js'
import { requireVisibleRecord } from './record-visibility.js'
import {
  attributePolicies, authorizeRecordWrite, recordAuditMetadata, recordPolicy, recordScopes,
} from './record-write-authorization.js'

const TOOL = 'crm_contact_point_set'
type ReadDb = Pick<Db, 'recordContactPoint' | 'record'>

function actor(type: 'human' | 'agent' | 'system' | null, id: string | null) {
  return type === null || id === null ? null : { type, id }
}

function present(value: string, row: ContactPointRow | undefined): ContactPointValue {
  const addedBy = actor(row?.addedByType ?? null, row?.addedById ?? null)
  const reachedBy = actor(row?.reachedByType ?? null, row?.reachedById ?? null)
  const archivedBy = actor(row?.archivedByType ?? null, row?.archivedById ?? null)
  const source = row?.sourceKind === null || row?.sourceKind === undefined ? null
    : SourceRef.parse({ kind: row.sourceKind, id: row.sourceId, name: row.sourceName })
  return {
    value,
    confirmed: row?.confirmed ?? true,
    added: row?.addedAt === null || row?.addedAt === undefined || addedBy === null ? null
      : { at: row.addedAt.toISOString(), by: addedBy, source },
    reached: row?.reachedAt === null || row?.reachedAt === undefined || reachedBy === null ? null
      : { at: row.reachedAt.toISOString(), by: reachedBy, note: row.reachedNote },
    archived: row?.archivedAt === null || row?.archivedAt === undefined || archivedBy === null ? null
      : { at: row.archivedAt.toISOString(), by: archivedBy },
  }
}

/** One attribute's active values in stored order, then its archived values, newest first. */
function attributeView(
  attribute: LoadedAttribute, data: Readonly<Record<string, JsonValue>>, rows: readonly ContactPointRow[],
): ContactPointAttribute {
  const own = rows.filter((row) => row.attributeId === attribute.id)
  const byHash = new Map(own.map((row) => [row.valueHash, row]))
  const items = contactItems(attribute, data[attribute.slug])
  const active = items.map((item) => contactKey(attribute, item))
  const activeHashes = new Set(active.map((item) => item.hash))
  const archived = own
    .filter((row) => row.archivedAt !== null && !activeHashes.has(row.valueHash))
    .sort((left, right) => (right.archivedAt?.getTime() ?? 0) - (left.archivedAt?.getTime() ?? 0))
  return {
    slug: attribute.slug,
    name: attribute.name,
    type: attribute.type === 'email' ? 'email' : 'phone',
    is_multi: attribute.isMulti,
    values: active.map((item) => present(item.value, byHash.get(item.hash))),
    archived: archived.map((row) => present(row.value, row)),
  }
}

function attributeRequest(scopes: PolicyScopeRef[], attribute: LoadedAttribute): PolicyRequest {
  return { resourceType: 'attribute', action: 'view', scopes, sensitivity: attribute.sensitivity }
}

function allowed(evaluator: PolicyEvaluator, request: PolicyRequest): boolean {
  const decision = evaluator.evaluate(request)
  return decision.allowed && !decision.requiresApproval
}

async function view(
  db: ReadDb, ctx: ActorContext, objectType: LoadedObjectType, recordId: string, scopes: PolicyScopeRef[],
  evaluator: PolicyEvaluator, only?: LoadedAttribute,
) {
  const record = await liveRecord(db, ctx, recordId)
  const rows = await contactPointRows(db, ctx.tenant, recordId)
  const attributes: ContactPointAttribute[] = []
  const redacted: string[] = []
  for (const attribute of only === undefined ? contactAttributes(objectType) : [only]) {
    if (allowed(evaluator, attributeRequest(scopes, attribute))) {
      attributes.push(attributeView(attribute, record.data, rows))
    } else {
      redacted.push(attribute.slug)
    }
  }
  return { version: record.version, attributes, redacted }
}

/**
 * Reads every email and phone of a visible record with its state
 * (schema-engine §4d‴): active values in stored order and archived ones,
 * each with where it came from, whether it is confirmed and the last
 * successful contact on it. An attribute the caller may not view is listed
 * in `redacted_attributes` only.
 */
export async function getContactPoints(
  deps: AppDeps, ctx: ActorContext, input: CrmContactPointsGetInput,
): Promise<CrmContactPointsGetOutput> {
  requireOnBehalfOf(ctx)
  const visible = await requireVisibleRecord(deps.db, ctx, input.record_id)
  const schema = await loadSchema(deps.db, ctx.tenant)
  const objectType = schema.objectTypesById.get(visible.objectTypeId)
  if (objectType === undefined) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const scopes = recordScopes(ctx, visible)
  const team: PolicyScopeRef[] = [{ scope: 'team', id: ctx.tenant.teamId }]
  const evaluator = await loadPolicyEvaluator(deps.db, ctx, [
    recordPolicy('view', team), { resourceType: 'attribute', action: 'view', scopes: team },
  ])
  if (!allowed(evaluator, recordPolicy('view', scopes))) {
    throw new ServiceError(ErrorCode.POLICY_DENIED, 'Record is not readable by this caller', {
      resource: 'record', action: 'view',
    })
  }
  const displayName = await deps.db.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: visible.id }, select: { displayName: true },
  })
  const read = await view(deps.db, ctx, objectType, visible.id, scopes, evaluator)
  return {
    record: {
      id: visible.id, object_type: objectType.slug, display_name: displayName?.displayName ?? '', version: read.version,
    },
    attributes: read.attributes,
    redacted_attributes: read.redacted,
  }
}

function contactAttribute(objectType: LoadedObjectType, slug: string): LoadedAttribute {
  const found = contactAttributes(objectType).find((attribute) => attribute.slug === slug)
  if (found === undefined) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Contact point change is invalid', {
      issues: [{ path: '/attribute', message: 'must be an email or phone attribute of the record' }],
    })
  }
  return found
}

/**
 * Changes one email's or phone's state as the calling person, in one
 * transaction with its change rows and audit: reach / unreach / confirm need
 * `record.edit`; replace_others and restore write the attribute, so they
 * also need attribute edit for its sensitivity. Viewing the attribute is
 * required for all. Answers that attribute's state after the change.
 */
export async function setContactPoint(
  deps: AppDeps, ctx: ActorContext, input: CrmContactPointSetInput,
): Promise<CrmContactPointSetOutput> {
  requireOnBehalfOf(ctx)
  const visible = await requireVisibleRecord(deps.db, ctx, input.record_id)
  const schema = await loadSchema(deps.db, ctx.tenant)
  const objectType = schema.objectTypesById.get(visible.objectTypeId)
  if (objectType === undefined) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const attribute = contactAttribute(objectType, input.attribute)
  const scopes = recordScopes(ctx, visible)
  const writes = input.action === 'replace_others' || input.action === 'restore'
  const descriptor = { tool: TOOL, reason: input.reason, resourceId: visible.id }
  await authorizeRecordWrite(deps, ctx, descriptor, [
    recordPolicy('edit', scopes), attributeRequest(scopes, attribute),
    ...(writes ? attributePolicies(schema, objectType.id, { [attribute.slug]: null }, scopes) : []),
  ])
  const evaluator = await loadPolicyEvaluator(deps.db, ctx, [attributeRequest(scopes, attribute)])
  return recordBoundary(deps.db, deps.ids, ctx, () => deps.db.$transaction(async (tx) => {
    await lockLinkTopology(tx, ctx.tenant.teamId)
    const result = await changeContactPoint(tx, ctx, schema, {
      recordId: visible.id, attribute, value: input.value, action: input.action, note: input.note ?? null,
      reason: input.reason ?? null,
      ...(input.expected_version === undefined ? {} : { expectedVersion: input.expected_version }),
    }, deps.linkWriter)
    if (result.sequences.length > 0) {
      await enqueueRecordMutationEffects(tx, ctx, result.sequences, result.touchedRecordIds)
      await deps.writeAudit(tx, {
        organizationId: ctx.tenant.organizationId, teamId: ctx.tenant.teamId,
        actorType: ctx.actor.type, actorId: ctx.actor.id, onBehalfOf: requireOnBehalfOf(ctx).uoaUserId,
        action: TOOL, resourceType: 'record', resourceId: visible.id, outcome: 'success', reason: input.reason ?? null,
        metadata: { ...recordAuditMetadata(ctx), contact_point: { attribute: attribute.slug, action: input.action } },
        requestId: ctx.requestId, ipAddress: null, userAgent: null,
      })
    }
    const read = await view(tx, ctx, objectType, visible.id, scopes, evaluator, attribute)
    const [after] = read.attributes
    if (after === undefined) throw new ServiceError(ErrorCode.INTERNAL, 'Contact attribute is missing')
    return { record_id: visible.id, version: read.version, attribute: after }
  }, { timeout: 30_000 }))
}
