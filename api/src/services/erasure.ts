import {
  eraseRecord,
  loadSchema,
  type EraseInput,
  type EraseResult,
  type RecordTx,
} from '@deepcrm/schema-engine'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'
import type { Db } from '@deepcrm/db'
import type { QueueEnqueueTx } from '@deepcrm/queue'

import type { AppDeps } from '../deps.js'
import type { ApprovalConsumption } from './approvals.js'
import { enqueueRecordMutationEffects } from './record-mutation-effects.js'
import { checkPolicy } from './policy.js'
import { requireVisibleRecord } from './record-visibility.js'

type ErasureTx = RecordTx & QueueEnqueueTx & Pick<Db, 'recordSearch' | 'suppressionEntry' | 'webhook' | 'list'>
export type RecordEraseOutput = Pick<EraseResult, 'erased' | 'suppressed'>

async function deniedAudit(deps: AppDeps, ctx: ActorContext, recordId: string): Promise<void> {
  await deps.db.$transaction((tx) => deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action: 'crm_record_erase',
    resourceType: 'record',
    resourceId: recordId,
    outcome: 'denied',
    reason: null,
    metadata: { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance },
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  }))
}

async function authorize(
  deps: AppDeps,
  ctx: ActorContext,
  input: EraseInput,
  approval?: ApprovalConsumption,
): Promise<void> {
  const record = await requireVisibleRecord(deps.db, ctx, input.id)
  if (ctx.onBehalfOf.role !== 'owner') {
    await deniedAudit(deps, ctx, record.id)
    throw new ServiceError(ErrorCode.POLICY_DENIED, 'Record erasure requires an owner')
  }
  const decision = await checkPolicy(deps.db, ctx, {
    resourceType: 'record',
    action: 'erase',
    scopes: [
      { scope: 'team', id: ctx.tenant.teamId },
      { scope: 'object_type', id: record.objectTypeId },
      { scope: 'record', id: record.id },
    ],
  })
  if (decision.allowed && (!decision.requiresApproval || approval !== undefined)) return
  await deniedAudit(deps, ctx, record.id)
  throw new ServiceError(
    decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Record erasure is not permitted',
  )
}

function auditMetadata(ctx: ActorContext, result: EraseResult) {
  return {
    app: ctx.app,
    actChain: ctx.actChain,
    provenance: ctx.provenance,
    suppressed: result.suppressed,
    neighbourCount: result.neighbourCount,
  }
}

export async function eraseCrmRecord(
  deps: AppDeps,
  ctx: ActorContext,
  input: EraseInput,
  approval?: ApprovalConsumption,
): Promise<RecordEraseOutput> {
  await authorize(deps, ctx, input, approval)
  const schema = await loadSchema(deps.db, ctx.tenant)
  return deps.db.$transaction(async (tx) => {
    const serviceTx: ErasureTx = tx
    await approval?.consume(serviceTx)
    const result = await eraseRecord(serviceTx, ctx, schema, input)
    await enqueueRecordMutationEffects(serviceTx, ctx, result.sequences, result.touchedRecordIds)
    await deps.writeAudit(serviceTx, {
      organizationId: ctx.tenant.organizationId,
      teamId: ctx.tenant.teamId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      onBehalfOf: ctx.onBehalfOf.uoaUserId,
      action: 'crm_record_erase',
      resourceType: 'record',
      resourceId: input.id,
      outcome: 'success',
      reason: input.reason,
      metadata: auditMetadata(ctx, result),
      requestId: ctx.requestId,
      ipAddress: null,
      userAgent: null,
    })
    return { erased: result.erased, suppressed: result.suppressed }
  })
}
