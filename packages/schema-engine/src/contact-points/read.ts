import { tenantWhere, type Db, type TenantRef } from '@deepcrm/db'

import type { ContactPointRow } from './state.js'

/**
 * The contact-point rows that describe a record's values: its own, and those
 * of records merged into it (a merge unions the emails and phones; their
 * rows stay with the merged record, so an unmerge needs no repair). Its own
 * row wins for a value both hold.
 */
export async function contactPointRows(
  db: Pick<Db, 'recordContactPoint'>, tenant: TenantRef, recordId: string,
): Promise<ContactPointRow[]> {
  const rows = await db.recordContactPoint.findMany({
    where: { ...tenantWhere(tenant), OR: [{ recordId }, { record: { mergedIntoId: recordId } }] },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
  })
  const chosen = new Map<string, ContactPointRow>()
  for (const row of rows) {
    const key = `${row.attributeId}:${row.valueHash}`
    const held = chosen.get(key)
    if (held === undefined || (held.recordId !== recordId && row.recordId === recordId)) chosen.set(key, row)
  }
  return [...chosen.values()]
}

/**
 * The live records an archived value of the attribute belongs to — a person
 * with an old number is still that person — following a merged record to
 * the record it was merged into.
 */
export async function archivedHolders(
  db: Pick<Db, 'recordContactPoint' | 'record'>, tenant: TenantRef, attributeId: string, valueHash: string,
): Promise<string[]> {
  const rows = await db.recordContactPoint.findMany({
    where: { ...tenantWhere(tenant), attributeId, valueHash, archivedAt: { not: null } },
    select: { recordId: true, record: { select: { mergedIntoId: true } } },
    take: 50,
  })
  const ids = [...new Set(rows.map((row) => row.record.mergedIntoId ?? row.recordId))]
  if (ids.length === 0) return []
  const live = await db.record.findMany({
    where: { ...tenantWhere(tenant), id: { in: ids }, deletedAt: null, mergedIntoId: null, erasedAt: null },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  return live.map((row) => row.id)
}
