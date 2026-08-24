import { tenantWhere } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import { refreshMatchingRecords, removeMatchingKeys } from '../matching/index.js'
import { diffChanges, writeChanges, type ChangeIntent } from '../records/changes.js'
import { computeDisplayName } from '../records/display-name.js'
import { canonicalJsonValue, type JsonValue } from '../records/json.js'
import { lockLinkTopology, lockRecords } from '../records/locks.js'
import { syncUniqueKeys } from '../records/unique-keys.js'
import type { LoadedObjectType, LoadedSchema } from '../schema/load.js'
import type { RecordTx } from '../schema/tx.js'
import { mergeLinks } from './links.js'
import { planMerge, type MergeLastSetAt, type MergeRecord } from './plan.js'
import type {
  ExecuteMergeInput, ExecuteMergeResult, MergeSnapshot, MergeUniqueKeySnapshot,
  MergePlanAuthorizer,
} from './types.js'

type StoredRecord = {
  id: string
  objectTypeId: string
  data: unknown
  displayName: string
  visibility: 'team' | 'users' | 'private'
  createdOnBehalfOf: string | null
  version: number
  deletedAt: Date | null
  mergedIntoId: string | null
  erasedAt: Date | null
}

function data(value: unknown): Record<string, JsonValue> {
  const parsed = canonicalJsonValue(value)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Stored merge record data is invalid')
  }
  return parsed
}

function validateInput(input: ExecuteMergeInput): string[] {
  const loserIds = [...input.mergedIds]
  if (loserIds.length < 1 || loserIds.length > 10) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Merge requires one to ten merged records')
  }
  const ids = [input.survivorId, ...loserIds]
  if (new Set(ids).size !== ids.length) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Merge record ids must be distinct')
  }
  return loserIds.sort()
}

function objectType(schema: LoadedSchema, id: string): LoadedObjectType {
  const object = schema.objectTypesById.get(id)
  if (object === undefined || object.archivedAt !== null) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Merge object type is not active')
  }
  return object
}

async function loadInputs(
  tx: RecordTx, ctx: ActorContext, ids: readonly string[], survivorId: string,
): Promise<{ survivor: StoredRecord; losers: StoredRecord[] }> {
  const rows = await tx.record.findMany({
    where: { ...tenantWhere(ctx.tenant), id: { in: [...ids] } },
    select: {
      id: true, objectTypeId: true, data: true, displayName: true, visibility: true,
      createdOnBehalfOf: true, version: true, deletedAt: true, mergedIntoId: true, erasedAt: true,
    },
  })
  if (rows.length !== ids.length) throw new ServiceError(ErrorCode.NOT_FOUND, 'Merge record not found')
  if (rows.some((record) => (
    record.deletedAt !== null || record.mergedIntoId !== null || record.erasedAt !== null
  ))) throw new ServiceError(ErrorCode.NOT_FOUND, 'Merge record not found')
  const survivor = rows.find((record) => record.id === survivorId)
  if (survivor === undefined) throw new ServiceError(ErrorCode.NOT_FOUND, 'Merge survivor not found')
  if (rows.some((record) => record.objectTypeId !== survivor.objectTypeId)) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Merge records must share one object type')
  }
  const losers = rows.filter((record) => record.id !== survivorId)
    .sort((left, right) => left.id.localeCompare(right.id))
  return { survivor, losers }
}

async function lastSetAt(
  tx: RecordTx, ctx: ActorContext, recordIds: readonly string[],
): Promise<MergeLastSetAt> {
  const rows = await tx.recordChange.findMany({
    where: {
      ...tenantWhere(ctx.tenant), recordId: { in: [...recordIds] }, kind: 'set',
      attributeSlug: { not: null },
    },
    select: { recordId: true, attributeSlug: true, occurredAt: true },
    orderBy: [{ seq: 'desc' }],
  })
  const result = new Map<string, Map<string, Date>>()
  for (const row of rows) {
    if (row.recordId === null || row.attributeSlug === null) continue
    const attributes = result.get(row.recordId) ?? new Map<string, Date>()
    if (!attributes.has(row.attributeSlug)) attributes.set(row.attributeSlug, row.occurredAt)
    result.set(row.recordId, attributes)
  }
  return result
}

async function uniqueKeySnapshots(
  tx: RecordTx, ctx: ActorContext, loserIds: readonly string[],
): Promise<ReadonlyMap<string, MergeUniqueKeySnapshot[]>> {
  const rows = await tx.recordUniqueKey.findMany({
    where: { ...tenantWhere(ctx.tenant), recordId: { in: [...loserIds] } },
    select: { recordId: true, attributeId: true, normalizedHash: true, normalizedValue: true },
    orderBy: [{ recordId: 'asc' }, { attributeId: 'asc' }, { normalizedHash: 'asc' }],
  })
  const result = new Map<string, MergeUniqueKeySnapshot[]>()
  for (const row of rows) {
    const keys = result.get(row.recordId) ?? []
    keys.push({
      attributeId: row.attributeId,
      normalizedHash: row.normalizedHash,
      normalizedValue: row.normalizedValue,
    })
    result.set(row.recordId, keys)
  }
  return result
}

async function mergeListEntries(
  tx: RecordTx, ctx: ActorContext, survivorId: string, loserIds: readonly string[],
): Promise<Array<{ listId: string; recordId: string }>> {
  const entries = await tx.$queryRaw<Array<{ id: string; listId: string; recordId: string }>>`
    SELECT le.id, le.list_id AS "listId", le.record_id AS "recordId"
    FROM list_entries le JOIN lists l ON l.id = le.list_id
    WHERE l.organization_id = ${ctx.tenant.organizationId}::uuid
      AND l.team_id = ${ctx.tenant.teamId}::uuid
      AND le.record_id = ANY(${[...loserIds]}::uuid[])
    ORDER BY le.list_id ASC, le.created_at ASC, le.id ASC
    FOR UPDATE OF le
  `
  const moved: Array<{ listId: string; recordId: string }> = []
  for (const entry of entries) {
    const survivorEntries = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT le.id FROM list_entries le JOIN lists l ON l.id = le.list_id
      WHERE l.organization_id = ${ctx.tenant.organizationId}::uuid
        AND l.team_id = ${ctx.tenant.teamId}::uuid
        AND le.list_id = ${entry.listId}::uuid AND le.record_id = ${survivorId}::uuid
    `
    if (survivorEntries.length > 0) continue
    await tx.$executeRaw`
      UPDATE list_entries SET record_id = ${survivorId}::uuid
      WHERE id = ${entry.id}::uuid AND list_id = ${entry.listId}::uuid
    `
    moved.push({ listId: entry.listId, recordId: entry.recordId })
  }
  return moved
}

function restrictiveVisibility(records: readonly StoredRecord[]): StoredRecord['visibility'] {
  if (records.some((record) => record.visibility === 'private')) return 'private'
  if (records.some((record) => record.visibility === 'users')) return 'users'
  return 'team'
}

async function mergeVisibility(
  tx: RecordTx, records: readonly StoredRecord[], survivorId: string,
): Promise<{ visibility: StoredRecord['visibility']; createdOnBehalfOf?: string }> {
  const grants = await tx.recordVisibilityGrant.findMany({
    where: { recordId: { in: records.map((record) => record.id) } }, select: { uoaUserId: true },
  })
  await tx.recordVisibilityGrant.createMany({
    data: [...new Set([
      ...grants.map((grant) => grant.uoaUserId),
      ...(restrictiveVisibility(records) === 'users'
        ? records.flatMap((record) => record.createdOnBehalfOf ?? []) : []),
    ])].map((uoaUserId) => ({
      recordId: survivorId, uoaUserId,
    })),
    skipDuplicates: true,
  })
  const visibility = restrictiveVisibility(records)
  const privateCreator = visibility === 'private'
    ? records.find((record) => record.visibility === 'private')?.createdOnBehalfOf
    : undefined
  return {
    visibility,
    ...(privateCreator === null || privateCreator === undefined ? {} : { createdOnBehalfOf: privateCreator }),
  }
}

async function bumpMergeRecords(
  tx: RecordTx, ctx: ActorContext, survivor: StoredRecord, losers: readonly StoredRecord[],
  object: LoadedObjectType, schema: LoadedSchema, mergedData: Record<string, JsonValue>,
): Promise<ReadonlyMap<string, number>> {
  const visibility = await mergeVisibility(tx, [survivor, ...losers], survivor.id)
  await tx.record.update({
    where: { id: survivor.id },
    data: {
      data: mergedData, displayName: computeDisplayName(schema, object, mergedData),
      visibility: visibility.visibility,
      ...(visibility.createdOnBehalfOf === undefined ? {} : { createdOnBehalfOf: visibility.createdOnBehalfOf }),
      version: { increment: 1 },
    },
  })
  for (const loser of losers) {
    await tx.record.update({
      where: { id: loser.id },
      data: { mergedIntoId: survivor.id, deletedAt: ctx.now, version: { increment: 1 } },
    })
  }
  await tx.record.updateMany({
    where: { ...tenantWhere(ctx.tenant), mergedIntoId: { in: losers.map((record) => record.id) } },
    data: { mergedIntoId: survivor.id },
  })
  const rows = await tx.record.findMany({
    where: { ...tenantWhere(ctx.tenant), id: { in: [survivor.id, ...losers.map((record) => record.id)] } },
    select: { id: true, version: true },
  })
  return new Map(rows.map((row) => [row.id, row.version]))
}

function mergeChanges(
  snapshot: MergeSnapshot, survivorId: string, loserIds: readonly string[],
  versions: ReadonlyMap<string, number>, reason: string,
): ChangeIntent[] {
  const groupId = crypto.randomUUID()
  return [survivorId, ...loserIds].map((recordId) => {
    const resultingVersion = versions.get(recordId)
    if (resultingVersion === undefined) throw new ServiceError(ErrorCode.INTERNAL, 'Merge version is missing')
    const loser = recordId !== survivorId
    return {
      recordId, kind: 'merge' as const, attributeSlug: null, relationTypeId: null, linkId: null,
      groupId, oldValue: null,
      newValue: loser ? canonicalJsonValue({ redirect_to: survivorId }) : null,
      snapshot: recordId === survivorId ? canonicalJsonValue(snapshot) : null,
      resultingVersion, reason,
    }
  })
}

function requiredVersion(versions: ReadonlyMap<string, number>, recordId: string): number {
  const value = versions.get(recordId)
  if (value === undefined) throw new ServiceError(ErrorCode.INTERNAL, 'Merge version is missing')
  return value
}

export async function executeMerge(
  tx: RecordTx, ctx: ActorContext, schema: LoadedSchema, input: ExecuteMergeInput,
  authorizePlan?: MergePlanAuthorizer,
): Promise<ExecuteMergeResult> {
  const loserIds = validateInput(input)
  const allIds = [input.survivorId, ...loserIds].sort()
  await lockLinkTopology(tx, ctx.tenant.teamId)
  await lockRecords(tx, ctx.tenant.teamId, allIds)
  const { survivor, losers } = await loadInputs(tx, ctx, allIds, input.survivorId)
  const object = objectType(schema, survivor.objectTypeId)
  const [timestamps, uniqueKeys] = await Promise.all([
    lastSetAt(tx, ctx, allIds), uniqueKeySnapshots(tx, ctx, loserIds),
  ])
  const mergeRecords = (records: readonly StoredRecord[]): MergeRecord[] => records.map((record) => ({
    id: record.id, data: data(record.data),
  }))
  const survivorPlan = mergeRecords([survivor])[0]
  if (survivorPlan === undefined) throw new ServiceError(ErrorCode.INTERNAL, 'Merge survivor is missing')
  const loserPlans = mergeRecords(losers)
  const plan = planMerge(schema, object, survivorPlan, loserPlans, timestamps, input.fieldChoices)
  if (authorizePlan !== undefined) {
    const changedAttributeSlugs = diffChanges(
      data(survivor.data), plan.data, survivor.id, survivor.version,
    ).flatMap((change) => change.attributeSlug ?? [])
    await authorizePlan({ objectTypeId: object.id, changedAttributeSlugs })
  }
  const linkResult = await mergeLinks(tx, ctx, schema, survivor.id, new Set(loserIds))
  const movedEntries = await mergeListEntries(tx, ctx, survivor.id, loserIds)
  await tx.recordUniqueKey.deleteMany({
    where: { ...tenantWhere(ctx.tenant), recordId: { in: loserIds } },
  })
  await syncUniqueKeys(tx, schema, object, survivor.id, plan.data)
  await removeMatchingKeys(tx, ctx.tenant, loserIds)
  const versions = await bumpMergeRecords(tx, ctx, survivor, losers, object, schema, plan.data)
  await refreshMatchingRecords(tx, ctx.tenant, schema, [
    survivor.id, ...linkResult.projectionSourceIds,
  ])
  const movedSet = new Set(plan.uniqueKeyMoves.map((key) => (
    `${key.attributeId}:${key.normalizedHash}:${key.fromRecordId}`
  )))
  const loserSnapshot = losers.map((record) => ({
    id: record.id, data: data(record.data), uniqueKeys: uniqueKeys.get(record.id) ?? [],
  }))
  const allLoserKeys = loserSnapshot.flatMap((record) => record.uniqueKeys.map((key) => ({
    attributeId: key.attributeId, normalizedHash: key.normalizedHash, fromRecordId: record.id,
  })))
  const snapshot: MergeSnapshot = {
    survivorBefore: data(survivor.data), losers: loserSnapshot,
    repointedLinks: linkResult.repointed, endedLinks: linkResult.ended,
    movedKeys: allLoserKeys.filter((key) => movedSet.has(
      `${key.attributeId}:${key.normalizedHash}:${key.fromRecordId}`,
    )),
    droppedKeys: allLoserKeys.filter((key) => !movedSet.has(
      `${key.attributeId}:${key.normalizedHash}:${key.fromRecordId}`,
    )),
    movedEntries,
  }
  const changes = [
    ...diffChanges(data(survivor.data), plan.data, survivor.id, requiredVersion(versions, survivor.id))
      .map((change) => ({ ...change, reason: input.reason })),
    ...linkResult.changes.map((change) => ({ ...change, reason: input.reason })),
    ...mergeChanges(snapshot, survivor.id, loserIds, versions, input.reason),
  ]
  const sequences = await writeChanges(tx, ctx, changes)
  const mergeSequence = sequences[changes.length - loserIds.length - 1]
  if (mergeSequence === undefined) throw new ServiceError(ErrorCode.INTERNAL, 'Merge change sequence is missing')
  const mergeChange = await tx.recordChange.findFirst({
    where: { ...tenantWhere(ctx.tenant), recordId: survivor.id, seq: BigInt(mergeSequence), kind: 'merge' },
    select: { id: true },
  })
  const row = await tx.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: survivor.id },
    select: { id: true, version: true, data: true, displayName: true, deletedAt: true },
  })
  if (mergeChange === null || row === null) throw new ServiceError(ErrorCode.INTERNAL, 'Merge result is missing')
  return {
    record: { ...row, data: data(row.data) }, mergeChangeId: mergeChange.id,
    repointedLinks: linkResult.repointed.length, endedLinks: linkResult.ended,
    sequences, touchedRecordIds: [...new Set([survivor.id, ...linkResult.touchedRecordIds])].sort(),
  }
}
