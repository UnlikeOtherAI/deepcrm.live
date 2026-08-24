import type { Db, Prisma } from '@deepcrm/db'
import {
  executeMerge,
  executeUnmerge,
  loadSchema,
  type LoadedSchema,
  type MergePlanAuthorization,
  type RecordTx,
  type UnmergeConflict,
} from '@deepcrm/schema-engine'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { loadPolicyEvaluator, type PolicyRequest, type PolicyScopeRef } from './policy.js'
import { recordBoundary } from './record-boundary.js'
import { enqueueRecordMutationEffects } from './record-mutation-effects.js'
import { findVisibleLiveRecords, findVisibleRecord } from './record-visibility.js'
import { presentWriteRecord } from './record-write-presenter.js'

export type MergeRecordsInput = {
  survivorId: string
  mergedIds: readonly string[]
  fieldChoices?: Readonly<Record<string, string>>
  reason: string
}

export type MergeRecordsResult = {
  record: Awaited<ReturnType<typeof presentWriteRecord>>
  merge_change_id: string
  repointed_links: number
  ended_links: readonly string[]
}

export type UnmergeRecordsInput = {
  mergeChangeId: string
  reason: string
}

export type UnmergeRecordsResult = {
  restored: readonly string[]
  conflicts: readonly {
    kind: UnmergeConflict['kind']
    attribute?: string
    rule_position?: number
    link_id?: string
    held_by?: string
  }[]
}

type MergeServiceTx = RecordTx & Pick<Db, 'policyRule' | 'webhook'>

function auditMetadata(ctx: ActorContext, input: MergeRecordsInput): Prisma.InputJsonObject {
  return {
    app: ctx.app,
    actChain: ctx.actChain,
    provenance: ctx.provenance,
    mergedCount: input.mergedIds.length,
  }
}

async function writeAudit(
  deps: AppDeps, ctx: ActorContext, input: MergeRecordsInput,
  outcome: 'success' | 'denied', resourceId: string | null,
  action = 'crm_merge_records',
): Promise<void> {
  await deps.db.$transaction((tx) => deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action,
    resourceType: 'merge',
    resourceId,
    outcome,
    reason: input.reason,
    metadata: auditMetadata(ctx, input),
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  }))
}

function scopes(
  ctx: ActorContext, objectTypeId: string, recordIds: readonly string[],
): PolicyScopeRef[] {
  return [
    { scope: 'team', id: ctx.tenant.teamId },
    { scope: 'object_type', id: objectTypeId },
    ...recordIds.map((id) => ({ scope: 'record' as const, id })),
  ]
}

async function authorizeMerge(
  db: Pick<Db, 'policyRule'>, ctx: ActorContext,
  objectTypeId: string, recordIds: readonly string[],
): Promise<void> {
  const request: PolicyRequest = {
    resourceType: 'merge', action: 'merge', scopes: scopes(ctx, objectTypeId, recordIds),
  }
  const evaluator = await loadPolicyEvaluator(db, ctx, [request])
  const decision = evaluator.evaluate(request)
  if (decision.allowed && !decision.requiresApproval) return
  throw new ServiceError(
    decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Record merge is not permitted', { resource: 'merge', action: 'merge' },
  )
}

async function authorizeAttributes(
  tx: MergeServiceTx, ctx: ActorContext, schema: LoadedSchema,
  recordIds: readonly string[], plan: MergePlanAuthorization,
): Promise<void> {
  const attributes = schema.attributesByObjectTypeId.get(plan.objectTypeId)
  if (attributes === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Merge schema is missing')
  const requests: PolicyRequest[] = plan.changedAttributeSlugs.flatMap((slug) => {
    const attribute = attributes.get(slug)
    if (attribute === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Merge attribute is missing')
    return attribute.sensitivity === 'confidential' || attribute.sensitivity === 'restricted'
      ? [{
          resourceType: 'attribute' as const,
          action: 'edit' as const,
          scopes: scopes(ctx, plan.objectTypeId, recordIds),
          sensitivity: attribute.sensitivity,
        }]
      : []
  })
  const evaluator = await loadPolicyEvaluator(tx, ctx, requests)
  for (const request of requests) {
    const decision = evaluator.evaluate(request)
    if (decision.allowed && !decision.requiresApproval) continue
    throw new ServiceError(
      decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
      'Merge attribute edit is not permitted', { resource: 'attribute', action: 'edit' },
    )
  }
}

async function visibleMergeSet(
  deps: AppDeps, ctx: ActorContext, input: MergeRecordsInput,
): Promise<{ ids: string[]; objectTypeId: string }> {
  const ids = [input.survivorId, ...input.mergedIds]
  if (new Set(ids).size !== ids.length) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Merge record ids must be distinct')
  }
  const records = await findVisibleLiveRecords(deps.db, ctx, ids)
  if (records.length !== ids.length) throw new ServiceError(ErrorCode.NOT_FOUND, 'Merge record not found')
  const objectTypeId = records[0]?.objectTypeId
  if (objectTypeId === undefined) throw new ServiceError(ErrorCode.NOT_FOUND, 'Merge record not found')
  if (records.some((record) => record.objectTypeId !== objectTypeId)) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Merge records must share one object type')
  }
  return { ids, objectTypeId }
}

export async function mergeRecords(
  deps: AppDeps, ctx: ActorContext, input: MergeRecordsInput,
): Promise<MergeRecordsResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const visible = await visibleMergeSet(deps, ctx, input)
    try {
      await authorizeMerge(deps.db, ctx, visible.objectTypeId, visible.ids)
      const schema = await loadSchema(deps.db, ctx.tenant)
      return await deps.db.$transaction(async (tx) => {
        const serviceTx: MergeServiceTx = tx
        const result = await executeMerge(serviceTx, ctx, schema, {
          survivorId: input.survivorId,
          mergedIds: input.mergedIds,
          ...(input.fieldChoices === undefined ? {} : { fieldChoices: input.fieldChoices }),
          reason: input.reason,
        }, (plan) => authorizeAttributes(serviceTx, ctx, schema, visible.ids, plan))
        await enqueueRecordMutationEffects(
          serviceTx, ctx, result.sequences, result.touchedRecordIds,
        )
        const record = await presentWriteRecord(serviceTx, ctx, schema, result.record.id)
        await deps.writeAudit(serviceTx, {
          organizationId: ctx.tenant.organizationId,
          teamId: ctx.tenant.teamId,
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
          onBehalfOf: ctx.onBehalfOf.uoaUserId,
          action: 'crm_merge_records',
          resourceType: 'merge',
          resourceId: result.mergeChangeId,
          outcome: 'success',
          reason: input.reason,
          metadata: auditMetadata(ctx, input),
          requestId: ctx.requestId,
          ipAddress: null,
          userAgent: null,
        })
        return {
          record,
          merge_change_id: result.mergeChangeId,
          repointed_links: result.repointedLinks,
          ended_links: result.endedLinks,
        }
      })
    } catch (error) {
      if (error instanceof ServiceError && (
        error.code === ErrorCode.POLICY_DENIED || error.code === ErrorCode.APPROVAL_REQUIRED
      )) await writeAudit(deps, ctx, input, 'denied', input.survivorId)
      throw error
    }
  })
}

async function visibleUnmergeMarker(
  deps: AppDeps, ctx: ActorContext, mergeChangeId: string,
): Promise<{ survivorId: string; objectTypeId: string; recordIds: string[] }> {
  const marker = await deps.db.recordChange.findFirst({
    where: { ...ctx.tenant, id: mergeChangeId, kind: 'merge' },
    select: { recordId: true, groupId: true, snapshot: true },
  })
  if (marker?.recordId === null || marker?.recordId === undefined
    || marker.groupId === null || marker.snapshot === null) {
    throw new ServiceError(ErrorCode.NOT_FOUND, 'Merge change not found')
  }
  const group = await deps.db.recordChange.findMany({
    where: { ...ctx.tenant, groupId: marker.groupId, kind: 'merge', recordId: { not: null } },
    select: { recordId: true },
  })
  const recordIds = group.flatMap((change) => change.recordId ?? [])
  const visible = await Promise.all(recordIds.map((id) => findVisibleRecord(deps.db, ctx, id)))
  if (recordIds.length < 2 || visible.some((record) => record === null)) {
    throw new ServiceError(ErrorCode.NOT_FOUND, 'Merge change not found')
  }
  const survivor = visible.find((record) => record?.id === marker.recordId)
  if (survivor === undefined || survivor === null
    || visible.some((record) => record?.objectTypeId !== survivor.objectTypeId)) {
    throw new ServiceError(ErrorCode.NOT_FOUND, 'Merge change not found')
  }
  const live = await findVisibleLiveRecords(deps.db, ctx, [marker.recordId])
  if (live.length !== 1) throw new ServiceError(ErrorCode.NOT_FOUND, 'Merge change not found')
  return { survivorId: survivor.id, objectTypeId: survivor.objectTypeId, recordIds }
}

async function presentConflict(
  deps: AppDeps, ctx: ActorContext, conflict: UnmergeConflict,
): Promise<UnmergeRecordsResult['conflicts'][number]> {
  const holderVisible = conflict.heldBy === undefined
    ? false
    : await findVisibleRecord(deps.db, ctx, conflict.heldBy) !== null
  return {
    kind: conflict.kind,
    ...(conflict.attribute === undefined ? {} : { attribute: conflict.attribute }),
    ...(conflict.rulePosition === undefined ? {} : { rule_position: conflict.rulePosition }),
    ...(conflict.linkId === undefined ? {} : { link_id: conflict.linkId }),
    ...(holderVisible ? { held_by: conflict.heldBy } : {}),
  }
}

export async function unmergeRecords(
  deps: AppDeps, ctx: ActorContext, input: UnmergeRecordsInput,
): Promise<UnmergeRecordsResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const marker = await visibleUnmergeMarker(deps, ctx, input.mergeChangeId)
    try {
      await authorizeMerge(deps.db, ctx, marker.objectTypeId, marker.recordIds)
      const schema = await loadSchema(deps.db, ctx.tenant)
      return await deps.db.$transaction(async (tx) => {
        const serviceTx: MergeServiceTx = tx
        const result = await executeUnmerge(serviceTx, ctx, schema, {
          mergeChangeId: input.mergeChangeId,
          reason: input.reason,
        })
        await enqueueRecordMutationEffects(
          serviceTx, ctx, result.sequences, result.touchedRecordIds,
        )
        await deps.writeAudit(serviceTx, {
          organizationId: ctx.tenant.organizationId,
          teamId: ctx.tenant.teamId,
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
          onBehalfOf: ctx.onBehalfOf.uoaUserId,
          action: 'crm_unmerge',
          resourceType: 'merge',
          resourceId: input.mergeChangeId,
          outcome: 'success',
          reason: input.reason,
          metadata: {
            app: ctx.app,
            actChain: ctx.actChain,
            provenance: ctx.provenance,
            restoredCount: result.restored.length,
            conflictCount: result.conflicts.length,
          },
          requestId: ctx.requestId,
          ipAddress: null,
          userAgent: null,
        })
        return {
          restored: result.restored,
          conflicts: await Promise.all(result.conflicts.map((conflict) => (
            presentConflict(deps, ctx, conflict)
          ))),
        }
      })
    } catch (error) {
      if (error instanceof ServiceError && (
        error.code === ErrorCode.POLICY_DENIED || error.code === ErrorCode.APPROVAL_REQUIRED
      )) {
        await writeAudit(deps, ctx, {
          survivorId: marker.survivorId,
          mergedIds: [],
          reason: input.reason,
        }, 'denied', input.mergeChangeId, 'crm_unmerge')
      }
      throw error
    }
  })
}
