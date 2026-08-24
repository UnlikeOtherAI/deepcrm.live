import { tenantWhere } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import { refreshMatchingRecords, removeMatchingKeys } from '../matching/index.js'
import { computeDisplayName } from '../records/display-name.js'
import { diffChanges, writeChanges, type ChangeIntent } from '../records/changes.js'
import { canonicalJsonValue, type JsonValue } from '../records/json.js'
import { lockKeys, lockLinkTopology, lockRecords } from '../records/locks.js'
import { syncUniqueKeys, uniqueKeysForData } from '../records/unique-keys.js'
import type { LoadedObjectType, LoadedSchema } from '../schema/load.js'
import type { RecordTx } from '../schema/tx.js'
import { parseMergeSnapshot } from './unmerge-snapshot.js'
import {
  prepareUnmergeLinks, restoreLinks, unmergeLinkChanges, type PreparedLinks,
} from './unmerge-links.js'
import type {
  ExecuteUnmergeInput, ExecuteUnmergeResult, MergeSnapshot, UnmergeConflict,
} from './types.js'

type MergeMarker = {
  id: string
  recordId: string
  groupId: string
  requestId: string
  seq: bigint
  occurredAt: Date
  snapshot: MergeSnapshot
}

type StoredRecord = {
  id: string
  objectTypeId: string
  data: unknown
  version: number
  deletedAt: Date | null
  mergedIntoId: string | null
  erasedAt: Date | null
}

type MovedEntry = { id: string; listId: string; recordId: string; originalRecordId: string }

function data(value: unknown): Record<string, JsonValue> {
  const parsed = canonicalJsonValue(value)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Stored unmerge record data is invalid')
  }
  return parsed
}

async function loadMarker(
  tx: RecordTx, ctx: ActorContext, mergeChangeId: string,
): Promise<MergeMarker> {
  const change = await tx.recordChange.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: mergeChangeId, kind: 'merge' },
    select: {
      recordId: true, groupId: true, requestId: true, seq: true, occurredAt: true, snapshot: true,
    },
  })
  if (change?.recordId === null || change?.recordId === undefined || change.groupId === null
    || change.snapshot === null) {
    throw new ServiceError(ErrorCode.NOT_FOUND, 'Merge change not found')
  }
  const already = await tx.recordChange.findFirst({
    where: { ...tenantWhere(ctx.tenant), kind: 'unmerge', groupId: change.groupId },
    select: { id: true },
  })
  if (already !== null) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Merge has already been undone')
  }
  return {
    id: mergeChangeId,
    recordId: change.recordId,
    groupId: change.groupId,
    requestId: change.requestId,
    seq: change.seq,
    occurredAt: change.occurredAt,
    snapshot: parseMergeSnapshot(change.snapshot),
  }
}

async function loadRecords(
  tx: RecordTx, ctx: ActorContext, marker: MergeMarker,
): Promise<{ survivor: StoredRecord; losers: StoredRecord[] }> {
  const loserIds = marker.snapshot.losers.map((loser) => loser.id)
  const ids = [marker.recordId, ...loserIds]
  const rows = await tx.record.findMany({
    where: { ...tenantWhere(ctx.tenant), id: { in: ids } },
    select: {
      id: true, objectTypeId: true, data: true, version: true,
      deletedAt: true, mergedIntoId: true, erasedAt: true,
    },
  })
  if (rows.length !== ids.length) throw new ServiceError(ErrorCode.NOT_FOUND, 'Merged record not found')
  const survivor = rows.find((record) => record.id === marker.recordId)
  if (survivor === undefined || survivor.deletedAt !== null || survivor.mergedIntoId !== null
    || survivor.erasedAt !== null) {
    throw new ServiceError(ErrorCode.NOT_FOUND, 'Merge survivor is not live')
  }
  const presentLosers: StoredRecord[] = []
  for (const id of loserIds) {
    const record = rows.find((row) => row.id === id)
    if (record === undefined) throw new ServiceError(ErrorCode.NOT_FOUND, 'Merged record not found')
    presentLosers.push(record)
  }
  if (presentLosers.some((record) => (
    record.objectTypeId !== survivor.objectTypeId || record.mergedIntoId !== survivor.id
    || record.deletedAt === null || record.erasedAt !== null
  ))) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Merged record state has changed')
  return { survivor, losers: presentLosers }
}

function activeObject(schema: LoadedSchema, objectTypeId: string): LoadedObjectType {
  const object = schema.objectTypesById.get(objectTypeId)
  if (object === undefined || object.archivedAt !== null) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Unmerge object type is not active')
  }
  return object
}

async function survivorData(
  tx: RecordTx, ctx: ActorContext, marker: MergeMarker, current: Record<string, JsonValue>,
): Promise<Record<string, JsonValue>> {
  const changes = await tx.recordChange.findMany({
    where: {
      ...tenantWhere(ctx.tenant), recordId: marker.recordId, seq: { gt: marker.seq },
      kind: { in: ['set', 'unset'] }, attributeSlug: { not: null },
    },
    select: { attributeSlug: true },
  })
  const result: Record<string, JsonValue> = { ...marker.snapshot.survivorBefore }
  for (const slug of new Set(changes.flatMap((change) => change.attributeSlug ?? []))) {
    const value = current[slug]
    if (value === undefined) delete result[slug]
    else result[slug] = value
  }
  return result
}

async function prepareMovedEntries(
  tx: RecordTx, ctx: ActorContext, snapshot: MergeSnapshot, survivorId: string,
  mergeOccurredAt: Date,
): Promise<{ entries: MovedEntry[]; conflicts: UnmergeConflict[] }> {
  const entries: MovedEntry[] = []
  const conflicts: UnmergeConflict[] = []
  const listIds = [...new Set(snapshot.movedEntries.map((entry) => entry.listId))].sort()
  if (listIds.length > 0) {
    const lists = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM lists
      WHERE organization_id = ${ctx.tenant.organizationId}::uuid
        AND team_id = ${ctx.tenant.teamId}::uuid
        AND id = ANY(${listIds}::uuid[])
      ORDER BY id FOR UPDATE
    `
    if (lists.length !== listIds.length) {
      throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Unmerge list no longer exists')
    }
  }
  for (const moved of snapshot.movedEntries) {
    const rows = await tx.$queryRaw<Array<{
      id: string; listId: string; recordId: string; createdAt: Date
    }>>`
      SELECT le.id, le.list_id AS "listId", le.record_id AS "recordId", le.created_at AS "createdAt"
      FROM list_entries le JOIN lists l ON l.id = le.list_id
      WHERE l.organization_id = ${ctx.tenant.organizationId}::uuid
        AND l.team_id = ${ctx.tenant.teamId}::uuid
        AND le.list_id = ${moved.listId}::uuid
        AND le.record_id = ANY(${[survivorId, moved.recordId]}::uuid[])
      FOR UPDATE OF le
    `
    const survivor = rows.find((row) => row.recordId === survivorId)
    const restored = rows.find((row) => row.recordId === moved.recordId)
    if (survivor === undefined || restored !== undefined || survivor.createdAt > mergeOccurredAt) {
      conflicts.push({
        kind: 'list_entry',
        heldBy: restored?.recordId ?? survivorId,
      })
      continue
    }
    entries.push({ ...survivor, originalRecordId: moved.recordId })
  }
  return { entries, conflicts }
}

async function restoreEntries(tx: RecordTx, entries: readonly MovedEntry[]): Promise<void> {
  for (const entry of entries) {
    await tx.listEntry.update({
      where: { id: entry.id }, data: { recordId: entry.originalRecordId },
    })
  }
}

async function restoreUniqueKeys(
  tx: RecordTx, ctx: ActorContext, schema: LoadedSchema, object: LoadedObjectType,
  survivorId: string, nextSurvivorData: Record<string, JsonValue>, snapshot: MergeSnapshot,
  hint: { key?: MergeSnapshot['losers'][number]['uniqueKeys'][number] },
): Promise<void> {
  const recordIds = [survivorId, ...snapshot.losers.map((loser) => loser.id)]
  const survivorKeys = uniqueKeysForData(object, nextSurvivorData)
  const loserKeys = snapshot.losers.flatMap((loser) => loser.uniqueKeys)
  await lockKeys(tx, ctx.tenant.teamId, [
    ...survivorKeys.map((key) => `${key.attributeId}:${key.normalizedHash}`),
    ...loserKeys.map((key) => `${key.attributeId}:${key.normalizedHash}`),
  ])
  await tx.recordUniqueKey.deleteMany({
    where: { ...tenantWhere(ctx.tenant), recordId: { in: recordIds } },
  })
  await syncUniqueKeys(tx, schema, object, survivorId, nextSurvivorData)
  for (const loser of snapshot.losers) {
    for (const key of loser.uniqueKeys) {
      hint.key = key
      await tx.recordUniqueKey.create({
        data: {
          organizationId: ctx.tenant.organizationId,
          teamId: ctx.tenant.teamId,
          attributeId: key.attributeId,
          recordId: loser.id,
          normalizedHash: key.normalizedHash,
          normalizedValue: key.normalizedValue,
        },
      })
    }
  }
}

async function chainedPointers(
  tx: RecordTx, ctx: ActorContext, marker: MergeMarker,
): Promise<Map<string, string>> {
  const loserIds = new Set(marker.snapshot.losers.map((loser) => loser.id))
  const candidates = await tx.record.findMany({
    where: {
      ...tenantWhere(ctx.tenant), mergedIntoId: marker.recordId,
      id: { notIn: [...loserIds] },
    },
    select: { id: true },
  })
  const result = new Map<string, string>()
  for (const candidate of candidates) {
    const prior = await tx.recordChange.findFirst({
      where: {
        ...tenantWhere(ctx.tenant), recordId: candidate.id, kind: 'merge', seq: { lt: marker.seq },
      },
      select: { newValue: true }, orderBy: { seq: 'desc' },
    })
    const value = canonicalJsonValue(prior?.newValue ?? null)
    if (value === null || Array.isArray(value) || typeof value !== 'object') continue
    const redirect = value['redirect_to']
    if (typeof redirect === 'string' && loserIds.has(redirect)) result.set(candidate.id, redirect)
  }
  return result
}

function version(map: ReadonlyMap<string, number>, id: string): number {
  const found = map.get(id)
  if (found === undefined) throw new ServiceError(ErrorCode.INTERNAL, 'Unmerge version is missing')
  return found
}

function unmergeChanges(
  marker: MergeMarker, survivorBefore: Record<string, JsonValue>, survivorAfter: Record<string, JsonValue>,
  versions: ReadonlyMap<string, number>, links: PreparedLinks, reason: string,
  chains: ReadonlyMap<string, string>,
): ChangeIntent[] {
  const markerValue = canonicalJsonValue({ merge_change_id: marker.id })
  const changes: ChangeIntent[] = diffChanges(
    survivorBefore, survivorAfter, marker.recordId, version(versions, marker.recordId),
  )
    .map((change) => ({ ...change, reason }))
  changes.push(...unmergeLinkChanges(links, versions, reason))
  for (const recordId of [marker.recordId, ...marker.snapshot.losers.map((loser) => loser.id)]) {
    changes.push({
      recordId, kind: 'unmerge', attributeSlug: null, relationTypeId: null, linkId: null,
      groupId: marker.groupId,
      oldValue: recordId === marker.recordId ? null : canonicalJsonValue({ redirect_to: marker.recordId }),
      newValue: markerValue, snapshot: null, resultingVersion: version(versions, recordId), reason,
    })
  }
  for (const [recordId, redirectTo] of chains) {
    changes.push({
      recordId, kind: 'unmerge', attributeSlug: null, relationTypeId: null, linkId: null,
      groupId: marker.groupId, oldValue: canonicalJsonValue({ redirect_to: marker.recordId }),
      newValue: canonicalJsonValue({ redirect_to: redirectTo }), snapshot: null,
      resultingVersion: version(versions, recordId), reason,
    })
  }
  return changes
}

function duplicateConflict(
  error: ServiceError, stage: 'unique_key' | 'matching_rule',
): UnmergeConflict {
  const heldBy = error.details['record_id']
  if (typeof heldBy !== 'string') {
    throw new ServiceError(ErrorCode.INTERNAL, 'Unmerge collision holder is missing')
  }
  return {
    kind: stage,
    ...(typeof error.details['attribute'] === 'string'
      ? { attribute: error.details['attribute'] } : {}),
    heldBy,
  }
}

export async function executeUnmerge(
  tx: RecordTx, ctx: ActorContext, schema: LoadedSchema, input: ExecuteUnmergeInput,
): Promise<ExecuteUnmergeResult> {
  await lockLinkTopology(tx, ctx.tenant.teamId)
  const marker = await loadMarker(tx, ctx, input.mergeChangeId)
  const initialIds = [marker.recordId, ...marker.snapshot.losers.map((loser) => loser.id)].sort()
  await lockRecords(tx, ctx.tenant.teamId, initialIds)
  const loaded = await loadRecords(tx, ctx, marker)
  const object = activeObject(schema, loaded.survivor.objectTypeId)
  const links = await prepareUnmergeLinks(
    tx, ctx, schema, marker.snapshot, marker.requestId, marker.seq, marker.recordId,
  )
  const movedEntries = await prepareMovedEntries(
    tx, ctx, marker.snapshot, marker.recordId, marker.occurredAt,
  )
  const chains = await chainedPointers(tx, ctx, marker)
  const allTouched = [...new Set([
    ...initialIds, ...links.touchedRecordIds, ...chains.keys(),
  ])].sort()
  await lockRecords(tx, ctx.tenant.teamId, allTouched)
  const preflightConflicts = [...links.conflicts, ...movedEntries.conflicts]
  if (preflightConflicts.length > 0) {
    return { restored: [], conflicts: preflightConflicts, sequences: [], touchedRecordIds: [] }
  }
  const currentSurvivorData = data(loaded.survivor.data)
  const nextSurvivorData = await survivorData(tx, ctx, marker, currentSurvivorData)
  let stage: 'unique_key' | 'matching_rule' = 'unique_key'
  const uniqueHint: { key?: MergeSnapshot['losers'][number]['uniqueKeys'][number] } = {}
  await tx.$executeRaw`SAVEPOINT unmerge_apply`
  try {
    await tx.record.update({
      where: { id: marker.recordId },
      data: {
        data: nextSurvivorData,
        displayName: computeDisplayName(schema, object, nextSurvivorData),
      },
    })
    for (const loser of marker.snapshot.losers) {
      await tx.record.update({
        where: { id: loser.id },
        data: {
          data: loser.data,
          displayName: computeDisplayName(schema, object, loser.data),
          deletedAt: null,
          mergedIntoId: null,
        },
      })
    }
    await restoreLinks(tx, ctx, links)
    await restoreEntries(tx, movedEntries.entries)
    await restoreUniqueKeys(
      tx, ctx, schema, object, marker.recordId, nextSurvivorData, marker.snapshot, uniqueHint,
    )
    stage = 'matching_rule'
    const matchingIds = [...new Set([...initialIds, ...links.projectionSourceIds])].sort()
    await removeMatchingKeys(tx, ctx.tenant, matchingIds)
    await refreshMatchingRecords(tx, ctx.tenant, schema, matchingIds)
    for (const [recordId, redirectTo] of chains) {
      await tx.record.update({ where: { id: recordId }, data: { mergedIntoId: redirectTo } })
    }
    for (const recordId of allTouched) {
      await tx.record.updateMany({
        where: { ...tenantWhere(ctx.tenant), id: recordId }, data: { version: { increment: 1 } },
      })
    }
    await tx.$executeRaw`RELEASE SAVEPOINT unmerge_apply`
  } catch (error) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT unmerge_apply`
    await tx.$executeRaw`RELEASE SAVEPOINT unmerge_apply`
    if (error instanceof ServiceError && error.code === ErrorCode.DUPLICATE_FOUND) {
      return {
        restored: [], conflicts: [duplicateConflict(error, stage)],
        sequences: [], touchedRecordIds: [],
      }
    }
    if (stage === 'unique_key' && uniqueHint.key !== undefined) {
      const holder = await tx.recordUniqueKey.findFirst({
        where: {
          ...tenantWhere(ctx.tenant), attributeId: uniqueHint.key.attributeId,
          normalizedHash: uniqueHint.key.normalizedHash,
        }, select: { recordId: true },
      })
      if (holder !== null) {
        const attribute = object.attributes.find((item) => item.id === uniqueHint.key?.attributeId)
        return {
          restored: [],
          conflicts: [{
            kind: 'unique_key', ...(attribute === undefined ? {} : { attribute: attribute.slug }),
            heldBy: holder.recordId,
          }],
          sequences: [], touchedRecordIds: [],
        }
      }
    }
    throw error
  }
  const rows = await tx.record.findMany({
    where: { ...tenantWhere(ctx.tenant), id: { in: allTouched } },
    select: { id: true, version: true },
  })
  const versions = new Map(rows.map((row) => [row.id, row.version]))
  const changes = unmergeChanges(
    marker, currentSurvivorData, nextSurvivorData, versions, links, input.reason, chains,
  )
  const sequences = await writeChanges(tx, ctx, changes)
  return {
    restored: marker.snapshot.losers.map((loser) => loser.id),
    conflicts: [], sequences, touchedRecordIds: allTouched,
  }
}
