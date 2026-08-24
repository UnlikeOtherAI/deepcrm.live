import { tenantWhere } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import { canonicalJsonValue, type JsonValue } from '../records/json.js'
import type { LoadedSchema } from '../schema/load.js'
import type { RecordTx } from '../schema/tx.js'

export type LinkDirection = 'from' | 'to' | 'both'
export type ListLinksInput = {
  recordId: string
  relationType?: string
  direction?: LinkDirection
  includeHistory?: boolean
}
export type LinkOut = {
  id: string
  relationTypeId: string
  relationType: string
  fromRecordId: string
  toRecordId: string
  data: JsonValue
  label: string | null
  position: number | null
  activeFrom: Date
  activeUntil: Date | null
  createdByType: 'human' | 'agent' | 'system'
  createdById: string
  createdAt: Date
}
export type ListedLink = { link: LinkOut; relatedRecordId: string }

async function anchor(tx: RecordTx, ctx: ActorContext, recordId: string): Promise<string> {
  const record = await tx.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: recordId },
    select: { id: true, deletedAt: true, mergedIntoId: true },
  })
  if (record === null)
    throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  if (record.mergedIntoId === null) {
    if (record.deletedAt !== null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
    return recordId
  }
  const survivor = await tx.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: record.mergedIntoId },
    select: { id: true, deletedAt: true, mergedIntoId: true },
  })
  if (survivor === null || survivor.deletedAt !== null || survivor.mergedIntoId !== null) {
    throw new ServiceError(ErrorCode.MERGED, 'Merged record survivor is unavailable', {
      redirect_to: record.mergedIntoId,
    })
  }
  return survivor.id
}

function relationTypeId(schema: LoadedSchema, slug: string | undefined): string | undefined {
  if (slug === undefined) return undefined
  const relation = schema.relationTypesBySlug.get(slug)
  if (relation === undefined || relation.archivedAt !== null)
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Relation type is not active')
  return relation.id
}

export async function listLinks(
  tx: RecordTx,
  ctx: ActorContext,
  schema: LoadedSchema,
  input: ListLinksInput,
): Promise<readonly ListedLink[]> {
  const anchorId = await anchor(tx, ctx, input.recordId)
  const direction = input.direction ?? 'both'
  const relationId = relationTypeId(schema, input.relationType)
  const links = await tx.recordLink.findMany({
    where: {
      ...tenantWhere(ctx.tenant),
      ...(relationId === undefined ? {} : { relationTypeId: relationId }),
      ...(input.includeHistory === true ? {} : { activeUntil: null }),
      ...(direction === 'from' ? { fromRecordId: anchorId } : {}),
      ...(direction === 'to' ? { toRecordId: anchorId } : {}),
      ...(direction === 'both' ? { OR: [{ fromRecordId: anchorId }, { toRecordId: anchorId }] } : {}),
    },
    select: {
      id: true, relationTypeId: true, fromRecordId: true, toRecordId: true, data: true,
      label: true, position: true, activeFrom: true, activeUntil: true,
      createdByType: true, createdById: true, createdAt: true,
      relationType: { select: { slug: true } },
    },
    orderBy: [{ activeFrom: 'desc' }, { id: 'desc' }],
  })
  return links.map((link) => ({
    link: {
      id: link.id,
      relationTypeId: link.relationTypeId,
      relationType: link.relationType.slug,
      fromRecordId: link.fromRecordId,
      toRecordId: link.toRecordId,
      data: canonicalJsonValue(link.data), label: link.label, position: link.position,
      activeFrom: link.activeFrom, activeUntil: link.activeUntil,
      createdByType: link.createdByType, createdById: link.createdById, createdAt: link.createdAt,
    },
    relatedRecordId: link.fromRecordId === anchorId ? link.toRecordId : link.fromRecordId,
  }))
}
