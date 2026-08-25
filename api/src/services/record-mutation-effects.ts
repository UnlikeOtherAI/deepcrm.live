import type { Db } from '@deepcrm/db'
import { enqueue, type QueueEnqueueTx } from '@deepcrm/queue'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

type MutationEffectsTx = QueueEnqueueTx & Pick<Db, 'webhook'>

export async function enqueueDerivedRefresh(
  tx: QueueEnqueueTx,
  ctx: ActorContext,
  touchedRecordIds: readonly string[],
  idempotencyKey: string,
): Promise<void> {
  const sourceRecordIds = [...new Set(touchedRecordIds)].sort()
  if (sourceRecordIds.length === 0) return
  await enqueue(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    type: 'derived.refresh',
    payload: {
      organizationId: ctx.tenant.organizationId,
      teamId: ctx.tenant.teamId,
      sourceRecordIds,
    },
    idempotencyKey,
    priority: 90,
  })
}

export async function enqueueRecordMutationEffects(
  tx: MutationEffectsTx,
  ctx: ActorContext,
  sequences: readonly number[],
  touchedRecordIds: readonly string[],
): Promise<void> {
  const lastSeq = sequences.at(-1)
  if (lastSeq === undefined || touchedRecordIds.length === 0) {
    throw new ServiceError(ErrorCode.INTERNAL, 'Changed record result is incomplete')
  }
  for (const recordId of touchedRecordIds) {
    await enqueue(tx, {
      organizationId: ctx.tenant.organizationId,
      teamId: ctx.tenant.teamId,
      type: 'record.reindex',
      payload: { organizationId: ctx.tenant.organizationId, teamId: ctx.tenant.teamId, recordId },
      idempotencyKey: `reindex:${recordId}:${lastSeq}`,
      priority: 100,
    })
  }
  await enqueueDerivedRefresh(tx, ctx, touchedRecordIds, `derived:${ctx.tenant.teamId}:${lastSeq}`)
  const activeWebhooks = await tx.webhook.count({
    where: { organizationId: ctx.tenant.organizationId, teamId: ctx.tenant.teamId, active: true },
  })
  if (activeWebhooks === 0) return
  const bucket = Math.floor(ctx.now.getTime() / 30_000)
  await enqueue(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    type: 'change.deliver',
    payload: { organizationId: ctx.tenant.organizationId, teamId: ctx.tenant.teamId },
    idempotencyKey: `deliver:${ctx.tenant.teamId}:${bucket}`,
    visibleAt: new Date(ctx.now.getTime() + 30_000),
    priority: 100,
    maxAttempts: 6,
  })
}
