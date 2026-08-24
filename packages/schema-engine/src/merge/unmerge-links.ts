import { tenantWhere } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'
import { z } from 'zod'

import type { ChangeIntent } from '../records/changes.js'
import { canonicalJsonValue, type JsonValue } from '../records/json.js'
import type { LoadedRelationType, LoadedSchema } from '../schema/load.js'
import type { RecordTx } from '../schema/tx.js'
import type { MergeSnapshot, UnmergeConflict } from './types.js'

type StoredLink = {
  id: string
  relationTypeId: string
  fromRecordId: string
  toRecordId: string
  data: unknown
  position: number | null
  activeUntil: Date | null
}

export type RestoredLink = StoredLink & {
  originalFrom: string
  originalTo: string
  originalPosition: number | null
  wasEnded: boolean
  changedAfterMerge: boolean
}

export type PreparedLinks = {
  links: readonly RestoredLink[]
  positionAdjustments: readonly PositionAdjustment[]
  conflicts: readonly UnmergeConflict[]
  touchedRecordIds: readonly string[]
  projectionSourceIds: readonly string[]
}

type PositionAdjustment = StoredLink & { finalPosition: number }

const oldLinkValue = z.object({
  from_record_id: z.string().uuid(),
  to_record_id: z.string().uuid(),
  data: z.unknown(),
  position: z.number().int().nonnegative().nullable(),
}).strict()

function relation(schema: LoadedSchema, id: string): LoadedRelationType {
  const found = schema.relationTypesById.get(id)
  if (found === undefined || found.archivedAt !== null) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Unmerge link relation is not active')
  }
  return found
}

async function originalPosition(
  tx: RecordTx, ctx: ActorContext, linkId: string, requestId: string, mergeSeq: bigint,
): Promise<number | null> {
  const change = await tx.recordChange.findFirst({
    where: {
      ...tenantWhere(ctx.tenant), linkId, kind: 'unlink', requestId, seq: { lt: mergeSeq },
    },
    select: { oldValue: true },
    orderBy: { seq: 'desc' },
  })
  const parsed = oldLinkValue.safeParse(change?.oldValue)
  if (!parsed.success) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Unmerge link history is invalid')
  }
  return parsed.data.position
}

async function loadLinks(
  tx: RecordTx, ctx: ActorContext, snapshot: MergeSnapshot, requestId: string, mergeSeq: bigint,
  survivorId: string,
): Promise<RestoredLink[]> {
  const repointed = new Map(snapshot.repointedLinks.map((link) => [link.linkId, link]))
  const ids = [...new Set([...repointed.keys(), ...snapshot.endedLinks])].sort()
  if (ids.length === 0) return []
  const rows = await tx.recordLink.findMany({
    where: { ...tenantWhere(ctx.tenant), id: { in: ids } },
    select: {
      id: true, relationTypeId: true, fromRecordId: true, toRecordId: true,
      data: true, position: true, activeUntil: true,
    },
  })
  if (rows.length !== ids.length) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Unmerge link no longer exists')
  }
  const result: RestoredLink[] = []
  const loserIds = new Set(snapshot.losers.map((loser) => loser.id))
  for (const row of rows) {
    const prior = repointed.get(row.id)
    const wasEnded = snapshot.endedLinks.includes(row.id)
    if (prior === undefined && !wasEnded) {
      throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Unmerge link snapshot is inconsistent')
    }
    const laterChange = await tx.recordChange.findFirst({
      where: {
        ...tenantWhere(ctx.tenant), linkId: row.id, seq: { gt: mergeSeq },
        kind: { in: ['link', 'unlink'] },
      },
      select: { id: true },
    })
    const expectedFrom = prior !== undefined && loserIds.has(prior.originalFrom)
      ? survivorId : prior?.originalFrom
    const expectedTo = prior !== undefined && loserIds.has(prior.originalTo)
      ? survivorId : prior?.originalTo
    const unexpectedState = prior === undefined
      ? row.activeUntil === null
      : row.activeUntil !== null || row.fromRecordId !== expectedFrom || row.toRecordId !== expectedTo
    result.push({
      ...row,
      originalFrom: prior?.originalFrom ?? row.fromRecordId,
      originalTo: prior?.originalTo ?? row.toRecordId,
      originalPosition: prior === undefined
        ? row.position
        : await originalPosition(tx, ctx, row.id, requestId, mergeSeq),
      wasEnded,
      changedAfterMerge: laterChange !== null || unexpectedState,
    })
  }
  return result.sort((left, right) => left.id.localeCompare(right.id))
}

async function linkConflict(
  tx: RecordTx, ctx: ActorContext, schema: LoadedSchema,
  link: RestoredLink, restoringIds: readonly string[],
): Promise<UnmergeConflict | null> {
  if (link.changedAfterMerge) {
    return { kind: 'link', linkId: link.id, heldBy: link.fromRecordId }
  }
  const excluded = { notIn: [...restoringIds] }
  const duplicate = await tx.recordLink.findFirst({
    where: {
      ...tenantWhere(ctx.tenant), id: excluded, activeUntil: null,
      relationTypeId: link.relationTypeId,
      fromRecordId: link.originalFrom, toRecordId: link.originalTo,
    },
    select: { id: true, fromRecordId: true },
  })
  if (duplicate !== null) {
    return { kind: 'link', linkId: link.id, heldBy: duplicate.fromRecordId }
  }
  if (link.originalPosition !== null) {
    const positioned = await tx.recordLink.findFirst({
      where: {
        ...tenantWhere(ctx.tenant), id: excluded, activeUntil: null,
        relationTypeId: link.relationTypeId, fromRecordId: link.originalFrom,
        position: link.originalPosition,
      },
      select: { fromRecordId: true },
    })
    if (positioned !== null) {
      return { kind: 'link', linkId: link.id, heldBy: positioned.fromRecordId }
    }
  }
  const cardinality = relation(schema, link.relationTypeId).cardinality
  if (cardinality === 'many_to_one' || cardinality === 'one_to_one') {
    const fromHeld = await tx.recordLink.findFirst({
      where: {
        ...tenantWhere(ctx.tenant), id: excluded, activeUntil: null,
        relationTypeId: link.relationTypeId, fromRecordId: link.originalFrom,
      },
      select: { fromRecordId: true },
    })
    if (fromHeld !== null) return { kind: 'link', linkId: link.id, heldBy: fromHeld.fromRecordId }
  }
  if (cardinality === 'one_to_many' || cardinality === 'one_to_one') {
    const toHeld = await tx.recordLink.findFirst({
      where: {
        ...tenantWhere(ctx.tenant), id: excluded, activeUntil: null,
        relationTypeId: link.relationTypeId, toRecordId: link.originalTo,
      },
      select: { toRecordId: true },
    })
    if (toHeld !== null) return { kind: 'link', linkId: link.id, heldBy: toHeld.toRecordId }
  }
  return null
}

export async function prepareUnmergeLinks(
  tx: RecordTx, ctx: ActorContext, schema: LoadedSchema, snapshot: MergeSnapshot,
  requestId: string, mergeSeq: bigint, survivorId: string,
): Promise<PreparedLinks> {
  const links = await loadLinks(tx, ctx, snapshot, requestId, mergeSeq, survivorId)
  const restoringIds = links.map((link) => link.id)
  const conflicts: UnmergeConflict[] = []
  for (const link of links) {
    const conflict = await linkConflict(tx, ctx, schema, link, restoringIds)
    if (conflict !== null) conflicts.push(conflict)
  }
  const groups = [...new Map(links.flatMap((link) => [
    ...(link.position === null ? [] : [{ fromRecordId: link.fromRecordId, relationTypeId: link.relationTypeId }]),
    ...(link.originalPosition === null ? [] : [{
      fromRecordId: link.originalFrom, relationTypeId: link.relationTypeId,
    }]),
  ]).map((group) => [`${group.fromRecordId}:${group.relationTypeId}`, group])).values()]
  const existing = groups.length === 0 ? [] : await tx.recordLink.findMany({
    where: {
      ...tenantWhere(ctx.tenant), activeUntil: null, position: { not: null },
      id: { notIn: restoringIds },
      OR: groups,
    },
    select: {
      id: true, relationTypeId: true, fromRecordId: true, toRecordId: true,
      data: true, position: true, activeUntil: true,
    },
  })
  const positionAdjustments: PositionAdjustment[] = []
  for (const group of groups) {
    const values = [
      ...existing.filter((link) => (
        link.fromRecordId === group.fromRecordId && link.relationTypeId === group.relationTypeId
      )),
      ...links.filter((link) => (
        link.originalFrom === group.fromRecordId && link.relationTypeId === group.relationTypeId
        && link.originalPosition !== null
      )).map((link) => ({
        ...link,
        fromRecordId: link.originalFrom,
        toRecordId: link.originalTo,
        position: link.originalPosition,
      })),
    ].sort((left, right) => (
      (left.position ?? 0) - (right.position ?? 0) || left.id.localeCompare(right.id)
    ))
    for (const [position, link] of values.entries()) {
      if (!restoringIds.includes(link.id) && link.position !== position) {
        positionAdjustments.push({ ...link, finalPosition: position })
      }
    }
  }
  return {
    links,
    positionAdjustments,
    conflicts,
    touchedRecordIds: [...new Set([
      ...links.flatMap((link) => [
        link.fromRecordId, link.toRecordId, link.originalFrom, link.originalTo,
      ]),
      ...positionAdjustments.flatMap((link) => [link.fromRecordId, link.toRecordId]),
    ])].sort(),
    projectionSourceIds: [...new Set([
      ...links.flatMap((link) => [link.fromRecordId, link.originalFrom]),
      ...positionAdjustments.map((link) => link.fromRecordId),
    ])].sort(),
  }
}

export async function restoreLinks(
  tx: RecordTx, ctx: ActorContext, prepared: PreparedLinks,
): Promise<void> {
  const { links, positionAdjustments } = prepared
  if (links.length === 0) return
  const ids = links.map((link) => link.id)
  await tx.recordLink.updateMany({
    where: { ...tenantWhere(ctx.tenant), id: { in: ids } },
    data: { activeUntil: ctx.now, position: null },
  })
  if (positionAdjustments.length > 0) {
    await tx.recordLink.updateMany({
      where: {
        ...tenantWhere(ctx.tenant),
        id: { in: positionAdjustments.map((link) => link.id) },
      },
      data: { position: null },
    })
  }
  for (const link of links) {
    await tx.recordLink.update({
      where: { id: link.id },
      data: {
        fromRecordId: link.originalFrom,
        toRecordId: link.originalTo,
        position: link.originalPosition,
        activeUntil: null,
      },
    })
  }
  for (const link of positionAdjustments) {
    await tx.recordLink.update({
      where: { id: link.id }, data: { position: link.finalPosition },
    })
  }
}

function linkValue(
  link: Pick<StoredLink, 'data'>,
  fromRecordId: string, toRecordId: string, position: number | null,
): JsonValue {
  return canonicalJsonValue({
    from_record_id: fromRecordId,
    to_record_id: toRecordId,
    data: link.data,
    position,
  })
}

export function unmergeLinkChanges(
  prepared: PreparedLinks, versions: ReadonlyMap<string, number>, reason: string,
): ChangeIntent[] {
  const changes: ChangeIntent[] = []
  const { links, positionAdjustments } = prepared
  for (const link of links) {
    const groupId = crypto.randomUUID()
    if (!link.wasEnded) {
      for (const recordId of new Set([link.fromRecordId, link.toRecordId])) {
        const version = versions.get(recordId)
        if (version === undefined) continue
        changes.push({
          recordId, kind: 'unlink', attributeSlug: null, relationTypeId: link.relationTypeId,
          linkId: link.id, groupId,
          oldValue: linkValue(link, link.fromRecordId, link.toRecordId, link.position),
          newValue: null, snapshot: null, resultingVersion: version, reason,
        })
      }
    }
    for (const recordId of new Set([link.originalFrom, link.originalTo])) {
      const version = versions.get(recordId)
      if (version === undefined) continue
      changes.push({
        recordId, kind: 'link', attributeSlug: null, relationTypeId: link.relationTypeId,
        linkId: link.id, groupId, oldValue: null,
        newValue: linkValue(link, link.originalFrom, link.originalTo, link.originalPosition),
        snapshot: null, resultingVersion: version, reason,
      })
    }
  }
  for (const link of positionAdjustments) {
    const groupId = crypto.randomUUID()
    for (const recordId of new Set([link.fromRecordId, link.toRecordId])) {
      const recordVersion = versions.get(recordId)
      if (recordVersion === undefined) continue
      changes.push({
        recordId, kind: 'unlink', attributeSlug: null, relationTypeId: link.relationTypeId,
        linkId: link.id, groupId,
        oldValue: linkValue(link, link.fromRecordId, link.toRecordId, link.position),
        newValue: null, snapshot: null, resultingVersion: recordVersion, reason,
      }, {
        recordId, kind: 'link', attributeSlug: null, relationTypeId: link.relationTypeId,
        linkId: link.id, groupId, oldValue: null,
        newValue: linkValue(link, link.fromRecordId, link.toRecordId, link.finalPosition),
        snapshot: null, resultingVersion: recordVersion, reason,
      })
    }
  }
  return changes
}
