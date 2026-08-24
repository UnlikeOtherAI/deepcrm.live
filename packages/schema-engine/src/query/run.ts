import type { Db, TenantRef } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import { projectLinksIntoData } from '../links/projection.js'
import { canonicalJsonValue, type JsonValue } from '../records/json.js'
import type { LoadedObjectType, LoadedSchema } from '../schema/load.js'
import { compileQuery } from './compile.js'
import type { QueryCursorState, QueryInput } from './types.js'

export type QueryTx = Pick<Db, '$queryRaw' | 'recordLink'>
export type QueryRecord = {
  id: string
  objectTypeId: string
  data: { [key: string]: JsonValue }
  displayName: string
  ownerType: 'human' | 'agent' | 'system' | null
  ownerId: string | null
  visibility: 'team' | 'users' | 'private'
  createdOnBehalfOf: string | null
  origin: string | null
  version: number
  lastActivityAt: Date | null
  createdAt: Date
  updatedAt: Date
}
export type QueryPage = { records: readonly QueryRecord[]; next: QueryCursorState | null; total?: number }
type QueryRow = QueryRecord & { cursorValues: unknown }

function nextCursor(values: unknown, id: string): QueryCursorState {
  const parsed = canonicalJsonValue(values)
  if (!Array.isArray(parsed)) throw new ServiceError(ErrorCode.INTERNAL, 'Invalid query cursor row')
  const result: Array<{ isNull: boolean; value: JsonValue }> = []
  for (const value of parsed) {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof value.isNull !== 'boolean' || !Object.hasOwn(value, 'value')) {
      throw new ServiceError(ErrorCode.INTERNAL, 'Invalid query cursor row')
    }
    const cursorValue = value.value
    if (cursorValue === undefined) throw new ServiceError(ErrorCode.INTERNAL, 'Invalid query cursor row')
    result.push({ isNull: value.isNull, value: cursorValue })
  }
  return { values: result, id }
}

export async function queryRecords(
  tx: QueryTx,
  tenant: TenantRef,
  ctx: ActorContext,
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  input: QueryInput,
): Promise<QueryPage> {
  const compiled = compileQuery(tenant, ctx, schema, objectType, input)
  const limit = input.limit ?? 50
  const rows = await tx.$queryRaw<QueryRow[]>(compiled.sql)
  const page = rows.slice(0, limit)
  const links = page.length === 0 ? [] : await tx.recordLink.findMany({
    where: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      fromRecordId: { in: page.map((record) => record.id) },
      activeUntil: null,
    },
    select: { fromRecordId: true, relationTypeId: true, toRecordId: true, position: true },
  })
  const linksByRecord = new Map<string, typeof links>()
  for (const link of links) {
    linksByRecord.set(link.fromRecordId, [...(linksByRecord.get(link.fromRecordId) ?? []), link])
  }
  const records = page.map(({ cursorValues: _cursorValues, ...record }) => ({
    ...record,
    data: {
      ...record.data,
      ...projectLinksIntoData(schema, objectType.slug, linksByRecord.get(record.id) ?? []),
    },
  }))
  const nextRow = rows.at(limit)
  const totalRows = input.includeTotal
    ? await tx.$queryRaw<Array<{ total: number }>>(compiled.countSql)
    : []
  return {
    records,
    next: nextRow === undefined ? null : nextCursor(page.at(-1)?.cursorValues, page.at(-1)?.id ?? ''),
    ...(input.includeTotal ? { total: totalRows[0]?.total ?? 0 } : {}),
  }
}
