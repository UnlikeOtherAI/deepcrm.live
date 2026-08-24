import { tenantWhere } from '@deepcrm/db'
import type { ActorContext } from '@deepcrm/schemas'

import type { ChangeIntent } from '../records/changes.js'
import { canonicalJsonValue, type JsonValue } from '../records/json.js'
import { lockRecords } from '../records/locks.js'
import type { LoadedRelationType, LoadedSchema } from '../schema/load.js'
import type { RecordTx } from '../schema/tx.js'

type LinkRow = {
  id: string
  relationTypeId: string
  fromRecordId: string
  toRecordId: string
  data: unknown
  label: string | null
  position: number | null
  activeFrom: Date
  createdAt: Date
}

type PlannedLink = LinkRow & { finalFrom: string; finalTo: string; finalPosition: number | null }

export type MergeLinksResult = {
  repointed: Array<{ linkId: string; originalFrom: string; originalTo: string }>
  ended: string[]
  changes: ChangeIntent[]
  touchedRecordIds: string[]
  projectionSourceIds: string[]
}

function relation(schema: LoadedSchema, id: string): LoadedRelationType {
  const found = schema.relationTypesById.get(id)
  if (found === undefined || found.archivedAt !== null) throw new Error('Active link has no active relation')
  return found
}

function oldest(left: LinkRow, right: LinkRow): number {
  const active = left.activeFrom.getTime() - right.activeFrom.getTime()
  if (active !== 0) return active
  const created = left.createdAt.getTime() - right.createdAt.getTime()
  return created !== 0 ? created : left.id.localeCompare(right.id)
}

function cardinalityRank(link: PlannedLink, survivorId: string, endpoint: 'from' | 'to'): number {
  const original = endpoint === 'from' ? link.fromRecordId : link.toRecordId
  return original === survivorId ? 0 : 1
}

function endDuplicateGroups(planned: readonly PlannedLink[], ended: Set<string>): void {
  const groups = new Map<string, PlannedLink[]>()
  for (const link of planned) {
    if (link.finalFrom === link.finalTo) {
      ended.add(link.id)
      continue
    }
    const key = `${link.relationTypeId}:${link.finalFrom}:${link.finalTo}`
    const values = groups.get(key) ?? []
    values.push(link)
    groups.set(key, values)
  }
  for (const values of groups.values()) {
    values.sort(oldest)
    for (const duplicate of values.slice(1)) ended.add(duplicate.id)
  }
}

function endCardinalityConflicts(
  planned: readonly PlannedLink[], schema: LoadedSchema, survivorId: string, ended: Set<string>,
): void {
  const group = (endpoint: 'from' | 'to', relationTypeId: string): void => {
    const groups = new Map<string, PlannedLink[]>()
    for (const link of planned) {
      if (ended.has(link.id) || link.relationTypeId !== relationTypeId) continue
      const id = endpoint === 'from' ? link.finalFrom : link.finalTo
      const values = groups.get(id) ?? []
      values.push(link)
      groups.set(id, values)
    }
    for (const values of groups.values()) {
      values.sort((left, right) => (
        cardinalityRank(left, survivorId, endpoint) - cardinalityRank(right, survivorId, endpoint)
        || oldest(left, right)
      ))
      for (const conflict of values.slice(1)) ended.add(conflict.id)
    }
  }
  for (const relationId of new Set(planned.map((link) => link.relationTypeId))) {
    const cardinality = relation(schema, relationId).cardinality
    if (cardinality === 'many_to_one' || cardinality === 'one_to_one') group('from', relationId)
    if (cardinality === 'one_to_many' || cardinality === 'one_to_one') group('to', relationId)
  }
}

function value(
  link: LinkRow, fromRecordId: string, toRecordId: string, position: number | null,
): JsonValue {
  return canonicalJsonValue({
    from_record_id: fromRecordId,
    to_record_id: toRecordId,
    data: link.data,
    position,
  })
}

function change(
  recordId: string, kind: 'link' | 'unlink', link: LinkRow,
  fromRecordId: string, toRecordId: string, position: number | null,
  version: number, groupId: string,
): ChangeIntent {
  const linkValue = value(link, fromRecordId, toRecordId, position)
  return {
    recordId, kind, attributeSlug: null, relationTypeId: link.relationTypeId, linkId: link.id,
    groupId, oldValue: kind === 'unlink' ? linkValue : null,
    newValue: kind === 'link' ? linkValue : null, snapshot: null, resultingVersion: version, reason: null,
  }
}

function linkChanges(
  planned: readonly PlannedLink[], ended: ReadonlySet<string>, versions: ReadonlyMap<string, number>,
): ChangeIntent[] {
  const changes: ChangeIntent[] = []
  for (const link of planned) {
    const changed = link.fromRecordId !== link.finalFrom
      || link.toRecordId !== link.finalTo || link.position !== link.finalPosition
    if (!changed && !ended.has(link.id)) continue
    const groupId = crypto.randomUUID()
    for (const recordId of new Set([link.fromRecordId, link.toRecordId])) {
      const version = versions.get(recordId)
      if (version !== undefined) changes.push(change(
        recordId, 'unlink', link, link.fromRecordId, link.toRecordId, link.position, version, groupId,
      ))
    }
    if (ended.has(link.id)) continue
    for (const recordId of new Set([link.finalFrom, link.finalTo])) {
      const version = versions.get(recordId)
      if (version !== undefined) changes.push(change(
        recordId, 'link', link, link.finalFrom, link.finalTo, link.finalPosition, version, groupId,
      ))
    }
  }
  return changes
}

export async function mergeLinks(
  tx: RecordTx, ctx: ActorContext, schema: LoadedSchema,
  survivorId: string, loserIds: ReadonlySet<string>,
): Promise<MergeLinksResult> {
  const affected = await tx.recordLink.findMany({
    where: {
      ...tenantWhere(ctx.tenant), activeUntil: null,
      OR: [{ fromRecordId: { in: [...loserIds] } }, { toRecordId: { in: [...loserIds] } }],
    },
    select: {
      id: true, relationTypeId: true, fromRecordId: true, toRecordId: true, data: true,
      label: true, position: true, activeFrom: true, createdAt: true,
    },
  })
  if (affected.length === 0) {
    return { repointed: [], ended: [], changes: [], touchedRecordIds: [], projectionSourceIds: [] }
  }
  const relationIds = [...new Set(affected.map((link) => link.relationTypeId))]
  const endpointIds = new Set([
    survivorId,
    ...affected.map((link) => loserIds.has(link.fromRecordId) ? survivorId : link.fromRecordId),
    ...affected.map((link) => loserIds.has(link.toRecordId) ? survivorId : link.toRecordId),
  ])
  const candidates = await tx.recordLink.findMany({
    where: {
      ...tenantWhere(ctx.tenant), activeUntil: null, relationTypeId: { in: relationIds },
      OR: [{ fromRecordId: { in: [...endpointIds] } }, { toRecordId: { in: [...endpointIds] } }],
    },
    select: {
      id: true, relationTypeId: true, fromRecordId: true, toRecordId: true, data: true,
      label: true, position: true, activeFrom: true, createdAt: true,
    },
  })
  await lockRecords(tx, ctx.tenant.teamId, candidates.flatMap((link) => [
    link.fromRecordId, link.toRecordId,
  ]))
  const planned: PlannedLink[] = candidates.map((link) => ({
    ...link,
    finalFrom: loserIds.has(link.fromRecordId) ? survivorId : link.fromRecordId,
    finalTo: loserIds.has(link.toRecordId) ? survivorId : link.toRecordId,
    finalPosition: link.position,
  }))
  const affectedIds = new Set(affected.map((link) => link.id))
  const ended = new Set<string>()
  endDuplicateGroups(planned, ended)
  endCardinalityConflicts(planned, schema, survivorId, ended)
  const sourceOrder = new Map([survivorId, ...loserIds].map((id, index) => [id, index]))
  const positionGroups = new Map<string, PlannedLink[]>()
  for (const link of planned) {
    if (ended.has(link.id) || link.position === null) continue
    const key = `${link.relationTypeId}:${link.finalFrom}`
    const values = positionGroups.get(key) ?? []
    values.push(link)
    positionGroups.set(key, values)
  }
  for (const values of positionGroups.values()) {
    values.sort((left, right) => (
      (sourceOrder.get(left.fromRecordId) ?? Number.MAX_SAFE_INTEGER)
      - (sourceOrder.get(right.fromRecordId) ?? Number.MAX_SAFE_INTEGER)
      || (left.position ?? 0) - (right.position ?? 0)
      || oldest(left, right)
    ))
    for (const [position, link] of values.entries()) link.finalPosition = position
  }
  const ending = planned.filter((link) => ended.has(link.id) && (
    affectedIds.has(link.id) || link.fromRecordId === survivorId || link.toRecordId === survivorId
  ))
  const changing = planned.filter((link) => (
    !ended.has(link.id) && (
      link.fromRecordId !== link.finalFrom || link.toRecordId !== link.finalTo
      || link.position !== link.finalPosition
    )
  ))
  const endedIds = ending.map((link) => link.id).sort()
  if (endedIds.length > 0) {
    await tx.recordLink.updateMany({
      where: { ...tenantWhere(ctx.tenant), id: { in: endedIds }, activeUntil: null },
      data: { activeUntil: ctx.now },
    })
  }
  const positioned = changing.filter((link) => link.position !== null)
  if (positioned.length > 0) {
    await tx.recordLink.updateMany({
      where: { ...tenantWhere(ctx.tenant), id: { in: positioned.map((link) => link.id) } },
      data: { position: null },
    })
  }
  for (const link of changing.sort(oldest)) {
    await tx.recordLink.update({
      where: { id: link.id },
      data: {
        fromRecordId: link.finalFrom, toRecordId: link.finalTo, position: link.finalPosition,
      },
    })
  }
  const changedRows = [...ending, ...changing]
  const touchedRecordIds = [...new Set(changedRows.flatMap((link) => [
    link.fromRecordId, link.toRecordId, link.finalFrom, link.finalTo,
  ]))].sort()
  const versions = new Map<string, number>()
  for (const recordId of touchedRecordIds) {
    await tx.record.updateMany({
      where: { ...tenantWhere(ctx.tenant), id: recordId }, data: { version: { increment: 1 } },
    })
    const row = await tx.record.findFirst({
      where: { ...tenantWhere(ctx.tenant), id: recordId }, select: { version: true },
    })
    if (row !== null) versions.set(recordId, row.version)
  }
  return {
    repointed: changing.filter((link) => (
      link.fromRecordId !== link.finalFrom || link.toRecordId !== link.finalTo
    )).map((link) => ({
      linkId: link.id, originalFrom: link.fromRecordId, originalTo: link.toRecordId,
    })).sort((left, right) => left.linkId.localeCompare(right.linkId)),
    ended: endedIds,
    changes: linkChanges(changedRows, new Set(endedIds), versions),
    touchedRecordIds,
    projectionSourceIds: [...new Set(changedRows.flatMap((link) => [link.fromRecordId, link.finalFrom]))].sort(),
  }
}
