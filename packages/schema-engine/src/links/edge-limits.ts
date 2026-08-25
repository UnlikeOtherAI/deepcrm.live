import { tenantWhere } from '@deepcrm/db'
import { ErrorCode, RelationEdgeLimit, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { LoadedRelationType } from '../schema/load.js'
import type { RecordTx } from '../schema/tx.js'

type Direction = 'from' | 'to'

function limits(relationType: LoadedRelationType) {
  return RelationEdgeLimit.parse({
    max_active_edges_from: relationType.maxActiveEdgesFrom,
    max_active_edges_to: relationType.maxActiveEdgesTo,
    label_limits: relationType.edgeLimitConfig,
  })
}

async function enforceOne(
  tx: RecordTx,
  ctx: ActorContext,
  relationType: LoadedRelationType,
  direction: Direction,
  recordId: string,
  label: string | null,
  bound: number | null | undefined,
): Promise<void> {
  if (bound === null || bound === undefined) return
  const count = await tx.recordLink.count({
    where: {
      ...tenantWhere(ctx.tenant),
      relationTypeId: relationType.id,
      activeUntil: null,
      ...(direction === 'from' ? { fromRecordId: recordId } : { toRecordId: recordId }),
      ...(label === null ? {} : { label }),
    },
  })
  if (count < bound) return
  throw new ServiceError(ErrorCode.CARDINALITY_VIOLATION, 'Relation edge limit would be exceeded', {
    relation_type: relationType.slug,
    direction,
    label,
    bound,
  })
}

export async function enforceRelationEdgeLimits(
  tx: RecordTx,
  ctx: ActorContext,
  relationType: LoadedRelationType,
  fromRecordId: string,
  toRecordId: string,
  label: string | null,
): Promise<void> {
  const parsed = limits(relationType)
  const labelLimit = label === null ? undefined : parsed.label_limits[label]
  await enforceOne(tx, ctx, relationType, 'from', fromRecordId, null, parsed.max_active_edges_from)
  await enforceOne(tx, ctx, relationType, 'to', toRecordId, null, parsed.max_active_edges_to)
  await enforceOne(tx, ctx, relationType, 'from', fromRecordId, label, labelLimit?.max_active_edges_from)
  await enforceOne(tx, ctx, relationType, 'to', toRecordId, label, labelLimit?.max_active_edges_to)
}
