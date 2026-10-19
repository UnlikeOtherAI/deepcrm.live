import { tenantWhere, type Db, type Prisma } from '@deepcrm/db'
import { ErrorCode, ServiceError, onBehalfOfUserId, type ActorContext } from '@deepcrm/schemas'

import { canonicalJsonValue, type JsonValue } from '../records/json.js'
import { keyHash, normalizedAttributeValue } from '../records/unique-keys.js'
import type { LoadedAttribute, LoadedObjectType } from '../schema/load.js'
import type { RecordTx } from '../schema/tx.js'

/** A transaction that keeps contact points (schema-engine §4d‴). */
export type ContactPointTx = RecordTx & Pick<Db, 'recordContactPoint'>
export type ContactPointRow = Prisma.RecordContactPointGetPayload<Record<string, never>>

/** Where a value came from: the source it came through, and whether a person stands behind it. */
export type ContactProvenance = {
  source: { kind: string; id: string; name: string } | null
  confirmed: boolean
}

/** The email and phone attributes of a type: the contact points it holds. */
export function contactAttributes(objectType: LoadedObjectType): LoadedAttribute[] {
  return objectType.attributes.filter((attribute) => (
    (attribute.type === 'email' || attribute.type === 'phone') && attribute.valueSource === 'stored'
  ))
}

/** A value's normalised form and key hash, as its attribute's unique keys use them. */
export function contactKey(attribute: LoadedAttribute, value: JsonValue): { value: string; hash: string } {
  const normalized = normalizedAttributeValue(attribute, value)
  return { value: normalized, hash: keyHash(normalized) }
}

/** The stored items of a contact attribute value, in stored order. */
export function contactItems(attribute: LoadedAttribute, value: JsonValue | undefined): JsonValue[] {
  if (value === undefined || value === null) return []
  return attribute.isMulti && Array.isArray(value) ? value : [value]
}

export function actorColumns(ctx: ActorContext) {
  return { type: ctx.actor.type, id: ctx.actor.id, onBehalfOf: onBehalfOfUserId(ctx) }
}

/**
 * Starts or refreshes the rows for values a write added: a new row with the
 * write's actor, time and provenance, or — for a value archived before and
 * written again — the row made active again. Rows of values the write removed
 * go too, unless archived (an archived value stays readable).
 */
export async function syncContactPoints(
  tx: ContactPointTx, ctx: ActorContext, objectType: LoadedObjectType, recordId: string,
  change: { before: Readonly<Record<string, JsonValue>>; after: Readonly<Record<string, JsonValue>> },
  provenance: ContactProvenance,
): Promise<void> {
  for (const attribute of contactAttributes(objectType)) {
    const before = new Map(contactItems(attribute, change.before[attribute.slug])
      .map((item) => { const key = contactKey(attribute, item); return [key.hash, key.value] as const }))
    const after = new Map(contactItems(attribute, change.after[attribute.slug])
      .map((item) => { const key = contactKey(attribute, item); return [key.hash, key.value] as const }))
    for (const [hash, value] of after) {
      if (before.has(hash)) continue
      const where = { recordId_attributeId_valueHash: { recordId, attributeId: attribute.id, valueHash: hash } }
      const actor = actorColumns(ctx)
      await tx.recordContactPoint.upsert({
        where,
        create: {
          ...tenantWhere(ctx.tenant), recordId, attributeId: attribute.id, value, valueHash: hash,
          confirmed: provenance.confirmed, addedAt: ctx.now, addedByType: actor.type, addedById: actor.id,
          addedOnBehalfOf: actor.onBehalfOf, sourceKind: provenance.source?.kind ?? null,
          sourceId: provenance.source?.id ?? null, sourceName: provenance.source?.name ?? null,
        },
        update: { archivedAt: null, archivedByType: null, archivedById: null, archivedOnBehalfOf: null },
      })
    }
    const removed = [...before.keys()].filter((hash) => !after.has(hash))
    if (removed.length === 0) continue
    await tx.recordContactPoint.deleteMany({
      where: {
        ...tenantWhere(ctx.tenant), recordId, attributeId: attribute.id, valueHash: { in: removed }, archivedAt: null,
      },
    })
  }
}

/** The record's data, as stored, for a contact-point decision. */
export async function liveRecord(
  tx: Pick<RecordTx, 'record'>, ctx: ActorContext, recordId: string,
): Promise<{ id: string; objectTypeId: string; version: number; data: Record<string, JsonValue> }> {
  const row = await tx.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: recordId, deletedAt: null, mergedIntoId: null, erasedAt: null },
    select: { id: true, objectTypeId: true, version: true, data: true },
  })
  if (row === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const data = canonicalJsonValue(row.data)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ServiceError(ErrorCode.INTERNAL, 'Stored record data is invalid')
  }
  return { id: row.id, objectTypeId: row.objectTypeId, version: row.version, data }
}
