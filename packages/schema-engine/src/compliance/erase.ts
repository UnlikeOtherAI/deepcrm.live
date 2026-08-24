import { tenantWhere, type Db, type SuppressionKind } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import { writeChanges } from '../records/changes.js'
import { canonicalJsonValue, type JsonValue } from '../records/json.js'
import { lockLinkTopology, lockRecords } from '../records/locks.js'
import type { RecordTx } from '../schema/tx.js'
import type { LoadedSchema } from '../schema/load.js'
import { suppressionHash } from './suppression.js'

export type EraseReason = 'gdpr_request' | 'retention_policy' | 'legal_order' | 'other'
export type EraseInput = { id: string; reason: EraseReason; suppress: boolean }
export type SuppressedCount = { kind: SuppressionKind; count: number }
export type EraseResult = {
  erased: true
  suppressed: SuppressedCount[]
  sequences: number[]
  touchedRecordIds: string[]
  neighbourCount: number
}

type EraseTx = RecordTx & Pick<Db, 'suppressionEntry' | 'recordSearch'>
type Data = Record<string, JsonValue>
type Contact = { kind: SuppressionKind; value: string }

function data(value: unknown): Data {
  const parsed = canonicalJsonValue(value)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new ServiceError(ErrorCode.INTERNAL, 'Stored record data is invalid')
  }
  return parsed
}

function strings(value: JsonValue | undefined): readonly string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => (typeof item === 'string' ? [item] : []))
}

function suppressionKind(attributeType: string): SuppressionKind | null {
  switch (attributeType) {
    case 'email': return 'email'
    case 'phone': return 'phone'
    case 'domain': return 'domain'
    case 'registry_id': return 'company_number'
    default: return null
  }
}

function contactValues(schema: LoadedSchema, record: { objectTypeId: string; data: unknown }): Contact[] {
  const objectType = schema.objectTypesById.get(record.objectTypeId)
  if (objectType === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Record object type is missing')
  const recordData = data(record.data)
  const contacts: Contact[] = []
  for (const attribute of objectType.attributes) {
    const kind = suppressionKind(attribute.type)
    if (kind === null) continue
    for (const value of strings(recordData[attribute.slug])) contacts.push({ kind, value })
  }
  return contacts
}

async function suppressContacts(
  tx: EraseTx,
  ctx: ActorContext,
  recordId: string,
  contacts: readonly Contact[],
): Promise<SuppressedCount[]> {
  const counts = new Map<SuppressionKind, number>()
  const seen = new Set<string>()
  for (const contact of contacts) {
    const keyHash = suppressionHash(contact.kind, contact.value)
    const key = `${contact.kind}:${keyHash}`
    if (seen.has(key)) continue
    seen.add(key)
    await tx.suppressionEntry.upsert({
      where: {
        teamId_kind_keyHash_channel: {
          teamId: ctx.tenant.teamId, kind: contact.kind, keyHash, channel: 'all',
        },
      },
      create: {
        ...tenantWhere(ctx.tenant),
        kind: contact.kind,
        channel: 'all',
        keyHash,
        reason: 'erasure',
        sourceRecordId: recordId,
        createdByType: ctx.actor.type,
        createdById: ctx.actor.id,
        onBehalfOf: ctx.onBehalfOf.uoaUserId,
      },
      update: {
        reason: 'erasure',
        expiresAt: null,
        sourceRecordId: recordId,
        createdByType: ctx.actor.type,
        createdById: ctx.actor.id,
        onBehalfOf: ctx.onBehalfOf.uoaUserId,
      },
    })
    counts.set(contact.kind, (counts.get(contact.kind) ?? 0) + 1)
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((left, right) => (
    left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0
  ))
}

async function neighbourIds(tx: EraseTx, ctx: ActorContext, recordId: string): Promise<string[]> {
  const links = await tx.recordLink.findMany({
    where: {
      ...tenantWhere(ctx.tenant),
      activeUntil: null,
      OR: [{ fromRecordId: recordId }, { toRecordId: recordId }],
    },
    select: { fromRecordId: true, toRecordId: true },
  })
  return [...new Set(links.map((link) => (
    link.fromRecordId === recordId ? link.toRecordId : link.fromRecordId
  )))].sort()
}

async function enqueueNeighbours(
  tx: EraseTx,
  ctx: ActorContext,
  recordId: string,
  neighbours: readonly string[],
  lastSeq: number,
): Promise<void> {
  if (neighbours.length === 0) return
  await tx.queueJob.create({
    data: {
      ...tenantWhere(ctx.tenant),
      type: 'record.reindex_neighbours',
      priority: 100,
      payload: {
        organizationId: ctx.tenant.organizationId,
        teamId: ctx.tenant.teamId,
        recordId,
        neighbourRecordIds: [...neighbours],
      },
      idempotencyKey: `reindex-neighbours:${recordId}:${lastSeq}`,
    },
  })
}

export async function eraseRecord(
  tx: EraseTx,
  ctx: ActorContext,
  schema: LoadedSchema,
  input: EraseInput,
): Promise<EraseResult> {
  await lockLinkTopology(tx, ctx.tenant.teamId)
  await lockRecords(tx, ctx.tenant.teamId, [input.id])
  const record = await tx.record.findFirst({ where: { ...tenantWhere(ctx.tenant), id: input.id } })
  if (record === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  if (record.mergedIntoId !== null) {
    throw new ServiceError(ErrorCode.MERGED, 'Record has been merged', { redirect_to: record.mergedIntoId })
  }
  if (record.erasedAt !== null) throw new ServiceError(ErrorCode.ERASED, 'Record has been erased')
  const contacts = input.suppress ? contactValues(schema, record) : []
  const suppressed = await suppressContacts(tx, ctx, record.id, contacts)
  const neighbours = await neighbourIds(tx, ctx, record.id)
  await tx.recordUniqueKey.deleteMany({ where: { ...tenantWhere(ctx.tenant), recordId: record.id } })
  await tx.recordMatchKey.deleteMany({ where: { ...tenantWhere(ctx.tenant), recordId: record.id } })
  await tx.recordMatchLookupKey.deleteMany({ where: { ...tenantWhere(ctx.tenant), recordId: record.id } })
  await tx.recordSearch.deleteMany({ where: { ...tenantWhere(ctx.tenant), recordId: record.id } })
  await tx.recordVisibilityGrant.deleteMany({ where: { recordId: record.id } })
  await tx.recordLink.updateMany({
    where: {
      ...tenantWhere(ctx.tenant),
      activeUntil: null,
      OR: [{ fromRecordId: record.id }, { toRecordId: record.id }],
    },
    data: { activeUntil: ctx.now },
  })
  await tx.recordLink.updateMany({
    where: { ...tenantWhere(ctx.tenant), OR: [{ fromRecordId: record.id }, { toRecordId: record.id }] },
    data: { data: {} },
  })
  await tx.$executeRaw`
    UPDATE list_entries
    SET data = '{}'::jsonb
    FROM lists
    WHERE list_entries.list_id = lists.id
      AND lists.organization_id = ${ctx.tenant.organizationId}::uuid
      AND lists.team_id = ${ctx.tenant.teamId}::uuid
      AND list_entries.record_id = ${record.id}::uuid
  `
  await tx.$executeRaw`
    UPDATE record_changes
    SET old_value = NULL, new_value = NULL, snapshot = NULL
    WHERE organization_id = ${ctx.tenant.organizationId}::uuid
      AND team_id = ${ctx.tenant.teamId}::uuid
      AND record_id = ${record.id}::uuid
  `
  const updated = await tx.record.update({
    where: { id: record.id },
    data: {
      data: {},
      displayName: '(erased)',
      ownerType: null,
      ownerId: null,
      visibility: 'team',
      createdOnBehalfOf: null,
      origin: null,
      erasedAt: ctx.now,
      deletedAt: ctx.now,
      version: { increment: 1 },
      lastActivityAt: null,
    },
    select: { version: true },
  })
  const sequences = await writeChanges(tx, ctx, [{
    recordId: record.id,
    kind: 'erase',
    attributeSlug: null,
    relationTypeId: null,
    linkId: null,
    groupId: null,
    oldValue: null,
    newValue: null,
    snapshot: null,
    resultingVersion: updated.version,
    reason: input.reason,
  }])
  const lastSeq = sequences.at(-1)
  if (lastSeq === undefined) throw new ServiceError(ErrorCode.INTERNAL, 'Erasure produced no feed sequence')
  await enqueueNeighbours(tx, ctx, record.id, neighbours, lastSeq)
  return {
    erased: true,
    suppressed,
    sequences,
    touchedRecordIds: [record.id],
    neighbourCount: neighbours.length,
  }
}
