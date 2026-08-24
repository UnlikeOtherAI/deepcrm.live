import { createHash } from 'node:crypto'
import {
  canonicalJson, tenantWhere, type Db, type PolicyAction, type Prisma,
} from '@deepcrm/db'
import type { QueueEnqueueTx } from '@deepcrm/queue'
import {
  assertRecord as engineAssertRecord,
  createRecord as engineCreateRecord,
  deleteRecord as engineDeleteRecord,
  loadSchema,
  restoreRecord as engineRestoreRecord,
  updateRecord as engineUpdateRecord,
  type AssertResolvedAction,
  type AssertRecordInput,
  type CreateRecordInput,
  type InlineLinkAuthorizer,
  type LoadedSchema,
  type RecordTx,
  type RecordWriteResult,
  type UpdateRecordInput,
} from '@deepcrm/schema-engine'
import { Candidate, ErrorCode, RecordOut as RecordOutSchema, ServiceError, type ActorContext } from '@deepcrm/schemas'
import type { AppDeps } from '../deps.js'
import { type PolicyEvaluator, type PolicyRequest, type PolicyScopeRef } from './policy.js'
import {
  asInlineLinkPolicyError,
  createInlineLinkAuthorizer,
  isInlineLinkPolicyError,
  preflightInlineLinks,
  reauthorizeAssertReplay,
} from './record-inline-links.js'
import {
  authorizeRecordWrite,
  attributePolicies,
  commonArgs,
  metadataArgs,
  objectIdScopes,
  objectScopes,
  recordAuditMetadata,
  recordPolicy,
  recordScopes,
  writeRecordDeniedAudit,
} from './record-write-authorization.js'
import { recordBoundary } from './record-boundary.js'
import { enqueueRecordMutationEffects } from './record-mutation-effects.js'
import { loadDuplicateEvaluator, presentDuplicates, type PresentedDuplicates } from './record-results.js'
import { requireVisibleRecord } from './record-visibility.js'
import { presentWriteRecord } from './record-write-presenter.js'
import { standardRecordWrite, type RecordWriteIntegration } from './record-write-integration.js'
type RecordServiceTx = RecordTx & QueueEnqueueTx & Pick<Db, 'webhook' | 'policyRule'>
type CommonWriteInput = { idempotencyKey?: string; reason?: string }
export type CreateRecordServiceInput = CreateRecordInput & CommonWriteInput
export type UpdateRecordServiceInput = UpdateRecordInput & CommonWriteInput
export type AssertRecordServiceInput = AssertRecordInput & CommonWriteInput
export type DeleteRecordServiceInput = {
  recordId: string; expectedVersion?: number; idempotencyKey?: string; reason?: string
}
type EngineServiceResult = { record: {
    id: string; version: number; data: Prisma.JsonObject
    displayName: string; deletedAt: string | null
  }
  created: boolean; changed: boolean; duplicates?: PresentedDuplicates
}
export type RecordServiceResult = { record: ReturnType<typeof RecordOutSchema.parse>
  created: boolean; changed: boolean; duplicates?: PresentedDuplicates
}
type WriteDescriptor = {
  tool: string; action: PolicyAction; scopes: PolicyScopeRef[]
  args: Record<string, unknown>; idempotencyKey: string | undefined
  reason: string | undefined; resourceId: string | null
}
type Reservation =
  | { kind: 'none' }
  | { kind: 'replay'; result: RecordServiceResult }
  | { kind: 'reserved'; id: string }
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function replayResult(value: unknown): RecordServiceResult {
  if (!isObject(value)) throw new ServiceError(ErrorCode.INTERNAL, 'Stored replay result is invalid')
  const record = value['record']
  if (
    !isObject(record) ||
    typeof value['created'] !== 'boolean' ||
    typeof value['changed'] !== 'boolean'
  ) throw new ServiceError(ErrorCode.INTERNAL, 'Stored replay result is invalid')
  const duplicates = value['duplicates'] === undefined ? undefined : Candidate.array().parse(value['duplicates'])
  const recordOut = RecordOutSchema.parse(record)
  return {
    record: recordOut,
    created: value['created'], changed: value['changed'],
    ...(duplicates === undefined ? {} : { duplicates }),
  }
}
function serviceResult(result: RecordWriteResult, duplicates: PresentedDuplicates): EngineServiceResult {
  return {
    record: {
      id: result.record.id, version: result.record.version, data: result.record.data,
      displayName: result.record.displayName,
      deletedAt: result.record.deletedAt?.toISOString() ?? null,
    },
    created: result.created, changed: result.changed,
    ...(duplicates.length === 0 ? {} : { duplicates }),
  }
}
function argumentHash(args: Record<string, unknown>): string {
  try {
    return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex')
  } catch {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Record arguments are invalid', {
      issues: [{ path: '', message: 'Arguments must be valid JSON' }],
    })
  }
}
function idempotencyLock(ctx: ActorContext, tool: string, key: string): string {
  return [ctx.tenant.teamId, ctx.onBehalfOf.uoaUserId, tool, key].join(':')
}
async function reserve(
  tx: RecordServiceTx, ctx: ActorContext, descriptor: WriteDescriptor, hash: string,
): Promise<Reservation> {
  const key = descriptor.idempotencyKey
  if (key === undefined) return { kind: 'none' }
  const locks = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock(6::integer, hashtext(${idempotencyLock(ctx, descriptor.tool, key)})) AS locked
  `
  if (locks[0]?.locked !== true) {
    throw new ServiceError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'Idempotent operation is in progress')
  }
  const existing = await tx.idempotencyReplay.findFirst({
    where: {
      ...tenantWhere(ctx.tenant),
      principalUserId: ctx.onBehalfOf.uoaUserId,
      tool: descriptor.tool,
      key,
    },
  })
  if (existing !== null) {
    if (existing.argumentsHash !== hash) {
      throw new ServiceError(ErrorCode.IDEMPOTENCY_MISMATCH, 'Idempotency key arguments do not match')
    }
    if (existing.result === null) {
      throw new ServiceError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'Idempotent operation is in progress')
    }
    return { kind: 'replay', result: replayResult(existing.result) }
  }
  const created = await tx.idempotencyReplay.create({
    data: {
      ...tenantWhere(ctx.tenant),
      principalUserId: ctx.onBehalfOf.uoaUserId,
      tool: descriptor.tool,
      key,
      argumentsHash: hash,
    },
    select: { id: true },
  })
  return { kind: 'reserved', id: created.id }
}
async function storeReplay(
  tx: RecordServiceTx, ctx: ActorContext, reservation: Reservation, result: RecordServiceResult,
): Promise<void> {
  if (reservation.kind !== 'reserved') return
  const updated = await tx.idempotencyReplay.updateMany({
    where: {
      ...tenantWhere(ctx.tenant),
      id: reservation.id,
    },
    data: { result },
  })
  if (updated.count !== 1) throw new ServiceError(ErrorCode.INTERNAL, 'Idempotency result was not stored')
}
async function runWrite(
  deps: AppDeps, ctx: ActorContext, descriptor: WriteDescriptor,
  authorization: readonly PolicyRequest[] | null,
  duplicateEvaluator: PolicyEvaluator | null,
  schema: LoadedSchema,
  operation: (tx: RecordServiceTx) => Promise<RecordWriteResult>,
  replayAuthorizer?: (tx: RecordServiceTx, result: RecordServiceResult) => Promise<void>,
): Promise<RecordServiceResult> {
  if (authorization !== null) await authorizeRecordWrite(deps, ctx, descriptor, authorization)
  const hash = argumentHash(descriptor.args)
  try {
    return await deps.db.$transaction(async (tx) => {
      const serviceTx: RecordServiceTx = tx
      const reservation = await reserve(serviceTx, ctx, descriptor, hash)
      if (reservation.kind === 'replay') {
        if (replayAuthorizer !== undefined) await replayAuthorizer(serviceTx, reservation.result)
        return reservation.result
      }
      const engineResult = await operation(serviceTx)
      const duplicates = duplicateEvaluator === null
        ? [] : await presentDuplicates(serviceTx, ctx, duplicateEvaluator, schema, engineResult.duplicates)
      const initial = serviceResult(engineResult, duplicates)
      const result: RecordServiceResult = {
        record: await presentWriteRecord(serviceTx, ctx, schema, initial.record.id),
        created: initial.created, changed: initial.changed,
        ...(initial.duplicates === undefined ? {} : { duplicates: initial.duplicates }),
      }
      if (engineResult.changed) await enqueueRecordMutationEffects(
        serviceTx, ctx, engineResult.sequences, engineResult.touchedRecordIds,
      )
      await storeReplay(serviceTx, ctx, reservation, result)
      if (!engineResult.changed) return result
      await deps.writeAudit(serviceTx, {
        organizationId: ctx.tenant.organizationId,
        teamId: ctx.tenant.teamId,
        actorType: ctx.actor.type,
        actorId: ctx.actor.id,
        onBehalfOf: ctx.onBehalfOf.uoaUserId,
        action: descriptor.tool,
        resourceType: 'record',
        resourceId: result.record.id,
        outcome: 'success',
        reason: descriptor.reason ?? null,
        metadata: recordAuditMetadata(ctx),
        requestId: ctx.requestId,
        ipAddress: null,
        userAgent: null,
      })
      return result
    })
  } catch (error) {
    if (isInlineLinkPolicyError(error)) await writeRecordDeniedAudit(deps, ctx, descriptor)
    throw error
  }
}

async function inlineAuthorizer(
  tx: RecordServiceTx, ctx: ActorContext, schema: LoadedSchema,
): Promise<InlineLinkAuthorizer> {
  return createInlineLinkAuthorizer(tx, ctx, schema)
}

async function createRecordOperation(
  deps: AppDeps, ctx: ActorContext, input: CreateRecordServiceInput,
  integration: RecordWriteIntegration,
): Promise<RecordServiceResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const schema = await loadSchema(deps.db, ctx.tenant)
    const { reason, idempotencyKey, ...engineInput } = input
    const descriptor: WriteDescriptor = {
      tool: integration.tool, action: 'create',
      scopes: objectScopes(ctx, schema, input.objectType),
      args: { objectType: input.objectType, data: input.data, ...metadataArgs(input), ...commonArgs(input) },
      idempotencyKey, reason, resourceId: null,
    }
    const objectTypeId = schema.objectTypesBySlug.get(input.objectType)?.id
    const authorization = [
      recordPolicy(descriptor.action, descriptor.scopes),
      ...attributePolicies(schema, objectTypeId, input.data, descriptor.scopes),
    ]
    try {
      await preflightInlineLinks(deps.db, ctx, schema, input.links)
    } catch (error) {
      if (error instanceof ServiceError && (
        error.code === ErrorCode.POLICY_DENIED || error.code === ErrorCode.APPROVAL_REQUIRED
      )) await writeRecordDeniedAudit(deps, ctx, descriptor)
      throw error
    }
    return runWrite(
      deps, ctx, descriptor, authorization, await loadDuplicateEvaluator(deps.db, ctx), schema,
      async (tx) => {
        const inlineLinkAuthorizer = await inlineAuthorizer(tx, ctx, schema)
        const result = await engineCreateRecord(
          tx, ctx, schema, { ...engineInput, reason, inlineLinkAuthorizer }, deps.linkWriter,
        )
        await integration.afterWrite(tx)
        return result
      },
    )
  })
}

export function createRecord(
  deps: AppDeps, ctx: ActorContext, input: CreateRecordServiceInput,
): Promise<RecordServiceResult> {
  return createRecordOperation(deps, ctx, input, standardRecordWrite('crm_record_create'))
}

export function createRecordWithIntegration(
  deps: AppDeps, ctx: ActorContext, input: CreateRecordServiceInput,
  integration: RecordWriteIntegration,
): Promise<RecordServiceResult> {
  return createRecordOperation(deps, ctx, input, integration)
}

async function updateRecordOperation(
  deps: AppDeps, ctx: ActorContext, input: UpdateRecordServiceInput,
  integration: RecordWriteIntegration,
): Promise<RecordServiceResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const [schema, record] = await Promise.all([
      loadSchema(deps.db, ctx.tenant), requireVisibleRecord(deps.db, ctx, input.recordId),
    ])
    const scopes = recordScopes(ctx, record)
    const { reason, idempotencyKey, ...engineInput } = input
    const descriptor: WriteDescriptor = {
      tool: integration.tool, action: 'edit', scopes,
      args: {
        recordId: input.recordId, data: input.data,
        ...metadataArgs(input),
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
        ...commonArgs(input),
      },
      idempotencyKey, reason, resourceId: input.recordId,
    }
    const authorization = [
      recordPolicy(descriptor.action, scopes),
      ...attributePolicies(schema, record.objectTypeId, input.data, scopes),
    ]
    try {
      await preflightInlineLinks(deps.db, ctx, schema, input.links, input.recordId)
    } catch (error) {
      if (error instanceof ServiceError && (
        error.code === ErrorCode.POLICY_DENIED || error.code === ErrorCode.APPROVAL_REQUIRED
      )) await writeRecordDeniedAudit(deps, ctx, descriptor)
      throw error
    }
    return runWrite(deps, ctx, descriptor, authorization, null, schema, async (tx) => {
      const inlineLinkAuthorizer = await inlineAuthorizer(tx, ctx, schema)
      const result = await engineUpdateRecord(
        tx, ctx, schema, { ...engineInput, reason, inlineLinkAuthorizer }, deps.linkWriter)
      await integration.afterWrite(tx)
      return result
    })
  })
}
export function updateRecord(
  deps: AppDeps, ctx: ActorContext, input: UpdateRecordServiceInput,
): Promise<RecordServiceResult> {
  return updateRecordOperation(deps, ctx, input, standardRecordWrite('crm_record_update'))
}
export function updateRecordWithIntegration(
  deps: AppDeps, ctx: ActorContext, input: UpdateRecordServiceInput, integration: RecordWriteIntegration,
): Promise<RecordServiceResult> {
  return updateRecordOperation(deps, ctx, input, integration)
}
async function assertRecordOperation(
  deps: AppDeps, ctx: ActorContext, input: AssertRecordServiceInput,
  integration: RecordWriteIntegration,
): Promise<RecordServiceResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const schema = await loadSchema(deps.db, ctx.tenant)
    const { reason, idempotencyKey, ...engineInput } = input
    const scopes = objectScopes(ctx, schema, input.objectType)
    const args: Record<string, unknown> = {
      objectType: input.objectType, matchAttribute: input.matchAttribute, data: input.data,
      ...metadataArgs(input),
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      ...commonArgs(input),
    }
    const descriptor: WriteDescriptor = {
      tool: integration.tool, action: 'create', scopes, args,
      idempotencyKey, reason, resourceId: null,
    }
    const onResolved = async (resolution: AssertResolvedAction): Promise<void> => {
      const record = resolution.recordId === null
        ? null
        : await requireVisibleRecord(deps.db, ctx, resolution.recordId)
      const resolvedScopes = record === null
        ? objectIdScopes(ctx, resolution.objectTypeId)
        : recordScopes(ctx, record)
      const resolved = {
        ...descriptor, action: resolution.action,
        scopes: resolvedScopes, resourceId: resolution.recordId,
      }
      await authorizeRecordWrite(deps, ctx, resolved, [
        recordPolicy(resolution.action, resolvedScopes),
        ...attributePolicies(schema, resolution.objectTypeId, input.data, resolvedScopes),
      ])
    }
    const evaluator = await loadDuplicateEvaluator(deps.db, ctx)
    try {
      await preflightInlineLinks(deps.db, ctx, schema, input.links)
    } catch (error) {
      if (error instanceof ServiceError && (
        error.code === ErrorCode.POLICY_DENIED || error.code === ErrorCode.APPROVAL_REQUIRED
      )) await writeRecordDeniedAudit(deps, ctx, descriptor)
      throw error
    }
    return runWrite(
      deps,
      ctx,
      descriptor,
      null,
      evaluator,
      schema,
      async (tx) => {
        const inlineLinkAuthorizer = await inlineAuthorizer(tx, ctx, schema)
        const result = await engineAssertRecord(
          tx, ctx, schema, { ...engineInput, reason, inlineLinkAuthorizer }, deps.linkWriter, onResolved,
        )
        await integration.afterWrite(tx)
        return result
      },
      async (tx, result) => {
        try {
          await reauthorizeAssertReplay(
            tx, ctx, schema, result.record.id, result.created, input.links,
          )
        } catch (error) {
          asInlineLinkPolicyError(error)
        }
      },
    )
  })
}

export function assertRecord(
  deps: AppDeps, ctx: ActorContext, input: AssertRecordServiceInput,
): Promise<RecordServiceResult> {
  return assertRecordOperation(deps, ctx, input, standardRecordWrite('crm_record_assert'))
}

export function assertRecordWithIntegration(
  deps: AppDeps, ctx: ActorContext, input: AssertRecordServiceInput,
  integration: RecordWriteIntegration,
): Promise<RecordServiceResult> {
  return assertRecordOperation(deps, ctx, input, integration)
}

async function changeDeletedState(
  deps: AppDeps, ctx: ActorContext, input: DeleteRecordServiceInput,
  restore: boolean,
): Promise<RecordServiceResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const [schema, record] = await Promise.all([
      loadSchema(deps.db, ctx.tenant), requireVisibleRecord(deps.db, ctx, input.recordId),
    ])
    const scopes = recordScopes(ctx, record)
    const tool = restore ? 'crm_record_restore' : 'crm_record_delete'
    const action: PolicyAction = restore ? 'restore' : 'delete'
    const descriptor: WriteDescriptor = {
      tool, action, scopes,
      args: {
        recordId: input.recordId,
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
        ...commonArgs(input),
      },
      idempotencyKey: input.idempotencyKey, reason: input.reason, resourceId: input.recordId,
    }
    return runWrite(deps, ctx, descriptor, [recordPolicy(action, scopes)], null, schema, (tx) => (
      restore
        ? engineRestoreRecord(
          tx, ctx, schema, input.recordId, input.expectedVersion, deps.linkWriter, input.reason,
        )
        : engineDeleteRecord(
          tx, ctx, schema, input.recordId, input.expectedVersion, deps.linkWriter, input.reason,
        )
    ))
  })
}

export function deleteRecord(
  deps: AppDeps, ctx: ActorContext, input: DeleteRecordServiceInput,
): Promise<RecordServiceResult> {
  return changeDeletedState(deps, ctx, input, false)
}

export function restoreRecord(
  deps: AppDeps, ctx: ActorContext, input: DeleteRecordServiceInput,
): Promise<RecordServiceResult> {
  return changeDeletedState(deps, ctx, input, true)
}

export { recordAt, recordHistory } from './record-history.js'
export type {
  RecordAtServiceInput,
  RecordAtServiceResult,
  RecordHistoryServiceInput,
  RecordHistoryServiceResult,
} from './record-history.js'
