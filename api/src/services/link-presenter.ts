import { tenantWhere, type Db } from '@deepcrm/db'
import { ErrorCode, LinkOut, ServiceError, type ActorContext } from '@deepcrm/schemas'

export type PublicLink = ReturnType<typeof LinkOut.parse>

type LinkReadTx = Pick<Db, 'recordLink'>

export async function presentLink(
  tx: LinkReadTx,
  ctx: ActorContext,
  linkId: string,
): Promise<PublicLink> {
  const row = await tx.recordLink.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: linkId },
    select: {
      id: true,
      fromRecordId: true,
      toRecordId: true,
      label: true,
      data: true,
      activeFrom: true,
      activeUntil: true,
      relationType: { select: { slug: true } },
    },
  })
  if (row === null) throw new ServiceError(ErrorCode.INTERNAL, 'Link result is missing')
  return LinkOut.parse({
    id: row.id,
    relation_type: row.relationType.slug,
    from_record_id: row.fromRecordId,
    to_record_id: row.toRecordId,
    label: row.label,
    data: row.data,
    active_from: row.activeFrom.toISOString(),
    active_until: row.activeUntil?.toISOString() ?? null,
  })
}
