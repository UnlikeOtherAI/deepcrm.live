import { tenantWhere } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import { writeChanges, type ChangeIntent } from '../records/changes.js'
import { canonicalJsonValue, type JsonValue } from '../records/json.js'
import { lockRecords } from '../records/locks.js'
import { updateRecord, type LinkWriter } from '../records/write.js'
import type { LoadedAttribute, LoadedSchema } from '../schema/load.js'
import {
  actorColumns, contactItems, contactKey, liveRecord, type ContactPointRow, type ContactPointTx,
} from './state.js'

export type ContactPointAction = 'reach' | 'unreach' | 'confirm' | 'replace_others' | 'restore'

export type ContactPointChange = {
  recordId: string
  attribute: LoadedAttribute
  value: string
  action: ContactPointAction
  note: string | null
  reason: string | null
  expectedVersion?: number
}

export type ContactPointResult = { version: number; sequences: number[]; touchedRecordIds: string[] }

const SYSTEM = 'contact_point'

function notFound(): ServiceError {
  return new ServiceError(ErrorCode.NOT_FOUND, 'Contact point not found')
}

function invalid(path: string, message: string): ServiceError {
  return new ServiceError(ErrorCode.VALIDATION_FAILED, 'Contact point change is invalid', { issues: [{ path, message }] })
}

// A change row carries the value's key hash, never the value: system rows are
// not redacted by attribute sensitivity (crm_record_history).
function snapshot(attribute: LoadedAttribute, hash: string, row: ContactPointRow | null): JsonValue {
  return canonicalJsonValue({
    system: SYSTEM,
    value: row === null ? null : {
      attribute: attribute.slug, key: hash, confirmed: row.confirmed,
      reached_at: row.reachedAt?.toISOString() ?? null,
      reached_by: row.reachedById === null ? null : { type: row.reachedByType, id: row.reachedById },
      note: row.reachedNote, archived_at: row.archivedAt?.toISOString() ?? null,
    },
  })
}

function intent(
  recordId: string, version: number, reason: string | null, groupId: string,
  attribute: LoadedAttribute, hash: string, before: ContactPointRow | null, after: ContactPointRow,
): ChangeIntent {
  return {
    recordId, kind: 'set', attributeSlug: null, relationTypeId: null, linkId: null, groupId,
    oldValue: snapshot(attribute, hash, before), newValue: snapshot(attribute, hash, after),
    snapshot: null, resultingVersion: version, reason,
  }
}

/** The row for one value of one record, or — for a merge survivor — the row a merged-in record carried. */
async function rowFor(
  tx: ContactPointTx, ctx: ActorContext, recordId: string, attributeId: string, hash: string,
): Promise<ContactPointRow | null> {
  const own = await tx.recordContactPoint.findFirst({
    where: { ...tenantWhere(ctx.tenant), recordId, attributeId, valueHash: hash },
  })
  if (own !== null) return own
  return tx.recordContactPoint.findFirst({
    where: { ...tenantWhere(ctx.tenant), attributeId, valueHash: hash, record: { mergedIntoId: recordId } },
    orderBy: { updatedAt: 'desc' },
  })
}

/** The fields of a row that describe the value and its state. */
type State = Pick<ContactPointRow,
  | 'value' | 'valueHash' | 'confirmed' | 'addedAt' | 'addedByType' | 'addedById' | 'addedOnBehalfOf'
  | 'sourceKind' | 'sourceId' | 'sourceName' | 'reachedAt' | 'reachedByType' | 'reachedById'
  | 'reachedOnBehalfOf' | 'reachedNote' | 'archivedAt' | 'archivedByType' | 'archivedById' | 'archivedOnBehalfOf'>

function stateOf(row: ContactPointRow): State {
  return {
    value: row.value, valueHash: row.valueHash, confirmed: row.confirmed, addedAt: row.addedAt,
    addedByType: row.addedByType, addedById: row.addedById, addedOnBehalfOf: row.addedOnBehalfOf,
    sourceKind: row.sourceKind, sourceId: row.sourceId, sourceName: row.sourceName,
    reachedAt: row.reachedAt, reachedByType: row.reachedByType, reachedById: row.reachedById,
    reachedOnBehalfOf: row.reachedOnBehalfOf, reachedNote: row.reachedNote, archivedAt: row.archivedAt,
    archivedByType: row.archivedByType, archivedById: row.archivedById, archivedOnBehalfOf: row.archivedOnBehalfOf,
  }
}

/** Writes the state as the record's own row; a merged-in record's row is copied, never moved. */
async function save(
  tx: ContactPointTx, ctx: ActorContext, recordId: string, attribute: LoadedAttribute,
  existing: ContactPointRow | null, next: State,
): Promise<ContactPointRow> {
  if (existing !== null && existing.recordId === recordId) {
    return tx.recordContactPoint.update({ where: { id: existing.id }, data: next })
  }
  return tx.recordContactPoint.create({
    data: { ...tenantWhere(ctx.tenant), recordId, attributeId: attribute.id, ...next },
  })
}

function base(key: { value: string; hash: string }, existing: ContactPointRow | null): State {
  if (existing !== null) return stateOf(existing)
  // A value no tracked write added (from before contact points, or by a merge): provenance unknown.
  return {
    value: key.value, valueHash: key.hash, confirmed: true,
    addedAt: null, addedByType: null, addedById: null, addedOnBehalfOf: null,
    sourceKind: null, sourceId: null, sourceName: null,
    reachedAt: null, reachedByType: null, reachedById: null, reachedOnBehalfOf: null, reachedNote: null,
    archivedAt: null, archivedByType: null, archivedById: null, archivedOnBehalfOf: null,
  }
}

function stateChange(
  ctx: ActorContext, action: 'reach' | 'unreach' | 'confirm', row: State, note: string | null,
): State | null {
  const actor = actorColumns(ctx)
  if (action === 'confirm') return row.confirmed ? null : { ...row, confirmed: true }
  if (action === 'unreach') {
    return row.reachedAt === null ? null
      : {
        ...row, reachedAt: null, reachedByType: null, reachedById: null, reachedOnBehalfOf: null, reachedNote: null,
      }
  }
  return {
    ...row, confirmed: true, reachedAt: ctx.now, reachedByType: actor.type, reachedById: actor.id,
    reachedOnBehalfOf: actor.onBehalfOf, reachedNote: note,
  }
}

function version(record: { version: number }, expected: number | undefined): void {
  if (expected !== undefined && expected !== record.version) {
    throw new ServiceError(ErrorCode.VERSION_CONFLICT, 'Record version does not match', { current: record.version })
  }
}

async function bump(tx: ContactPointTx, ctx: ActorContext, recordId: string): Promise<number> {
  const updated = await tx.record.updateMany({
    where: { ...tenantWhere(ctx.tenant), id: recordId }, data: { version: { increment: 1 } },
  })
  if (updated.count !== 1) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const row = await tx.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: recordId }, select: { version: true },
  })
  if (row === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  return row.version
}

/**
 * Changes one email's or phone's state as `ctx` (schema-engine §4d‴), in the
 * caller's transaction, under the record's lock: reach (confirms it),
 * unreach, confirm — a state-only change with one system change row and one
 * version — or replace_others / restore, which write the attribute's active
 * values through the record write path and archive or restore the rows. A
 * change that changes nothing writes nothing.
 */
export async function changeContactPoint(
  tx: ContactPointTx, ctx: ActorContext, schema: LoadedSchema, change: ContactPointChange, linkWriter: LinkWriter,
): Promise<ContactPointResult> {
  await lockRecords(tx, ctx.tenant.teamId, [change.recordId])
  const record = await liveRecord(tx, ctx, change.recordId)
  version(record, change.expectedVersion)
  const { attribute } = change
  if (record.objectTypeId !== attribute.objectTypeId) throw notFound()
  if (change.note !== null && change.action !== 'reach') throw invalid('/note', 'a note goes with reach')
  let key: { value: string; hash: string }
  try {
    key = contactKey(attribute, change.value)
  } catch {
    throw invalid('/value', `must be a valid ${attribute.type}`)
  }
  const items = contactItems(attribute, record.data[attribute.slug])
  const active = items.map((item) => contactKey(attribute, item))
  const isActive = active.some((item) => item.hash === key.hash)
  const existing = await rowFor(tx, ctx, record.id, attribute.id, key.hash)
  const groupId = crypto.randomUUID()
  if (change.action === 'restore') {
    return restore(tx, ctx, schema, change, linkWriter, { key, items, isActive, existing, groupId })
  }
  if (!isActive) throw notFound()
  if (change.action === 'replace_others') {
    const plan = { key, active, existing, groupId, version: record.version }
    return replaceOthers(tx, ctx, schema, change, linkWriter, plan)
  }
  const next = stateChange(ctx, change.action, base(key, existing), change.note)
  if (next === null) return { version: record.version, sequences: [], touchedRecordIds: [] }
  const resulting = await bump(tx, ctx, record.id)
  const saved = await save(tx, ctx, record.id, attribute, existing, next)
  const sequences = await writeChanges(tx, ctx, [
    intent(record.id, resulting, change.reason, groupId, attribute, key.hash, existing, saved),
  ])
  return { version: resulting, sequences, touchedRecordIds: [record.id] }
}

type Plan = { key: { value: string; hash: string }; existing: ContactPointRow | null; groupId: string }

function unchanged(version: number): ContactPointResult {
  return { version, sequences: [], touchedRecordIds: [] }
}

async function replaceOthers(
  tx: ContactPointTx, ctx: ActorContext, schema: LoadedSchema, change: ContactPointChange, linkWriter: LinkWriter,
  plan: Plan & { active: Array<{ value: string; hash: string }>; version: number },
): Promise<ContactPointResult> {
  const { attribute, recordId } = change
  if (!attribute.isMulti) throw invalid('/action', 'replace_others needs a multi email or phone attribute')
  const others = plan.active.filter((item) => item.hash !== plan.key.hash)
  const actor = actorColumns(ctx)
  const kept = base(plan.key, plan.existing)
  if (others.length === 0 && kept.confirmed) return unchanged(plan.version)
  const written = await updateRecord(tx, ctx, schema, {
    recordId, data: { [attribute.slug]: [plan.key.value] }, reason: change.reason ?? undefined,
  }, linkWriter)
  const resulting = written.record.version
  const intents: ChangeIntent[] = []
  for (const other of others) {
    const existing = await rowFor(tx, ctx, recordId, attribute.id, other.hash)
    const saved = await save(tx, ctx, recordId, attribute, existing, {
      ...base(other, existing),
      archivedAt: ctx.now, archivedByType: actor.type, archivedById: actor.id, archivedOnBehalfOf: actor.onBehalfOf,
    })
    intents.push(intent(recordId, resulting, change.reason, plan.groupId, attribute, other.hash, existing, saved))
  }
  if (!kept.confirmed) {
    const saved = await save(tx, ctx, recordId, attribute, plan.existing, { ...kept, confirmed: true })
    intents.push(
      intent(recordId, resulting, change.reason, plan.groupId, attribute, plan.key.hash, plan.existing, saved),
    )
  }
  const sequences = await writeChanges(tx, ctx, intents)
  return {
    version: resulting, sequences: [...written.sequences, ...sequences],
    touchedRecordIds: [...written.touchedRecordIds],
  }
}

async function restore(
  tx: ContactPointTx, ctx: ActorContext, schema: LoadedSchema, change: ContactPointChange, linkWriter: LinkWriter,
  plan: Plan & { items: JsonValue[]; isActive: boolean },
): Promise<ContactPointResult> {
  const { attribute, recordId } = change
  if (!attribute.isMulti) throw invalid('/action', 'restore needs a multi email or phone attribute')
  if (plan.isActive || plan.existing === null || plan.existing.archivedAt === null) throw notFound()
  const written = await updateRecord(tx, ctx, schema, {
    recordId, data: { [attribute.slug]: [...plan.items, plan.key.value] }, reason: change.reason ?? undefined,
  }, linkWriter)
  const saved = await save(tx, ctx, recordId, attribute, plan.existing, {
    ...base(plan.key, plan.existing),
    archivedAt: null, archivedByType: null, archivedById: null, archivedOnBehalfOf: null,
  })
  const sequences = await writeChanges(tx, ctx, [
    intent(
      recordId, written.record.version, change.reason, plan.groupId, attribute, plan.key.hash, plan.existing, saved,
    ),
  ])
  return {
    version: written.record.version, sequences: [...written.sequences, ...sequences],
    touchedRecordIds: [...written.touchedRecordIds],
  }
}
