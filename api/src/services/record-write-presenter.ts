import { tenantWhere } from '@deepcrm/db'
import { ErrorCode, RecordOut as RecordOutSchema, ServiceError, type ActorContext } from '@deepcrm/schemas'
import type { Db } from '@deepcrm/db'
import type { LoadedSchema, RecordTx } from '@deepcrm/schema-engine'

import { asQueryRecord, presentRecord } from './record-read.js'
import { loadPolicyEvaluator } from './policy.js'

export async function presentWriteRecord(
  tx: RecordTx & Pick<Db, 'policyRule'>,
  ctx: ActorContext,
  schema: LoadedSchema,
  recordId: string,
): Promise<ReturnType<typeof RecordOutSchema.parse>> {
  const row = await tx.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: recordId },
    select: {
      id: true, objectTypeId: true, data: true, displayName: true, ownerType: true, ownerId: true,
      visibility: true, createdOnBehalfOf: true, origin: true, version: true, lastActivityAt: true,
      createdAt: true, updatedAt: true,
    },
  })
  if (row === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const record = asQueryRecord(row)
  const scopes = [
    { scope: 'team' as const, id: ctx.tenant.teamId },
    { scope: 'object_type' as const, id: record.objectTypeId },
    { scope: 'record' as const, id: record.id },
  ]
  const evaluator = await loadPolicyEvaluator(tx, ctx, [
    { resourceType: 'record', action: 'view', scopes },
    { resourceType: 'attribute', action: 'view', scopes: [{ scope: 'team', id: ctx.tenant.teamId }] },
  ])
  return RecordOutSchema.parse(presentRecord(ctx, schema, record, evaluator))
}
