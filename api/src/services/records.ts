import { createHash } from 'node:crypto'

import {
  canonicalJson, tenantWhere, type Db, type PolicyAction, type Prisma,
} from '@deepcrm/db'
import { enqueue, type QueueEnqueueTx } from '@deepcrm/queue'
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
  type LinkWriter,
  type LoadedSchema,
  type RecordTx,
  type RecordWriteResult,
  type UpdateRecordInput,
} from '@deepcrm/schema-engine'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { checkPolicy, type PolicyRequest, type PolicyScopeRef } from './policy.js'
import { recordBoundary } from './record-boundary.js'
import { requireVisibleRecord, type VisibleRecord } from './record-visibility.js'

type RecordServiceTx = RecordTx & QueueEnqueueTx & Pick<Db, 'webhook'>
type CommonWriteInput = { idempotencyKey?: string; reason?: string }
export type CreateRecordServiceInput = CreateRecordInput & CommonWriteInput
export type UpdateRecordServiceInput = UpdateRecordInput & CommonWriteInput
export type AssertRecordServiceInput = AssertRecordInput & CommonWriteInput
export type DeleteRecordServiceInput = {
  recordId: string; expectedVersion?: number; idempotencyKey?: string; reason?: string
}

export type RecordServiceResult = {
  record: {
    id: string; version: number; data: Prisma.JsonObject
    displayName: string; deletedAt: string | null
  }
  created: boolean; changed: boolean
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

function isJsonValue(value: unknown): value is Prisma.JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isObject(value) && Object.values(value).every(isJsonValue)
}

function isJsonObject(value: unknown): value is Prisma.JsonObject {
  return isObject(value) && Object.values(value).every(isJsonValue)
}

function replayResult(value: unknown): RecordServiceResult {
  if (!isObject(value)) throw new ServiceError(ErrorCode.INTERNAL, 'Stored replay result is invalid')
  const record = value['record']
  if (
    !isObject(record) ||
    typeof record['id'] !== 'string' ||
    typeof record['version'] !== 'number' ||
    !Number.isInteger(record['version']) ||
    !isJsonObject(record['data']) ||
    typeof record['displayName'] !== 'string' ||
    !(record['deletedAt'] === null || typeof record['deletedAt'] === 'string') ||
    typeof value['created'] !== 'boolean' ||
    typeof value['changed'] !== 'boolean'
  ) throw new ServiceError(ErrorCode.INTERNAL, 'Stored replay result is invalid')
  return {
    record: {
      id: record['id'], version: record['version'], data: record['data'],
      displayName: record['displayName'], deletedAt: record['deletedAt'],
    },
    created: value['created'], changed: value['changed'],
  }
}

function serviceResult(result: RecordWriteResult): RecordServiceResult {
  return {
    record: {
      id: result.record.id, version: result.record.version, data: result.record.data,
      displayName: result.record.displayName,
      deletedAt: result.record.deletedAt?.toISOString() ?? null,
    },
    created: result.created, changed: result.changed,
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

function auditMetadata(ctx: ActorContext): Prisma.InputJsonObject {
  return {
    app: ctx.app,
    actChain: ctx.actChain,
    provenance: ctx.provenance,
  }
}

async function writeDeniedAudit(
  deps: AppDeps, ctx: ActorContext, descriptor: WriteDescriptor,
): Promise<void> {
  await deps.db.$transaction((tx) => deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action: descriptor.tool,
    resourceType: 'record',
    resourceId: descriptor.resourceId,
    outcome: 'denied',
    reason: descriptor.reason ?? null,
    metadata: auditMetadata(ctx),
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  }))
}

async function authorize(
  deps: AppDeps, ctx: ActorContext, descriptor: WriteDescriptor,
  requests: readonly PolicyRequest[],
): Promise<void> {
  const checked = await Promise.all(requests.map(async (request) => ({
    request,
    decision: await checkPolicy(deps.db, ctx, request),
  })))
  const hardDenied = checked.find(({ decision }) => !decision.allowed && !decision.requiresApproval)
  const rejected = hardDenied ?? checked.find(({ decision }) => (
    !decision.allowed || decision.requiresApproval
  ))
  if (rejected === undefined) return
  await writeDeniedAudit(deps, ctx, descriptor)
  throw new ServiceError(
    rejected.decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Record operation is not permitted',
    { resource: rejected.request.resourceType, action: rejected.request.action },
  )
}

async function enqueueChanges(
  tx: RecordServiceTx, ctx: ActorContext, result: RecordWriteResult,
): Promise<void> {
  const lastSeq = result.sequences.at(-1)
  if (lastSeq === undefined || result.touchedRecordIds.length === 0) {
    throw new ServiceError(ErrorCode.INTERNAL, 'Changed record result is incomplete')
  }
  for (const recordId of result.touchedRecordIds) {
    await enqueue(tx, {
      organizationId: ctx.tenant.organizationId,
      teamId: ctx.tenant.teamId,
      type: 'record.reindex',
      payload: { organizationId: ctx.tenant.organizationId, teamId: ctx.tenant.teamId, recordId },
      idempotencyKey: `reindex:${recordId}:${lastSeq}`,
      priority: 100,
    })
  }
  const activeWebhooks = await tx.webhook.count({
    where: { ...tenantWhere(ctx.tenant), active: true },
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
  })
}

async function runWrite(
  deps: AppDeps, ctx: ActorContext, descriptor: WriteDescriptor,
  authorization: readonly PolicyRequest[] | null,
  operation: (tx: RecordTx) => Promise<RecordWriteResult>,
): Promise<RecordServiceResult> {
  if (authorization !== null) await authorize(deps, ctx, descriptor, authorization)
  const hash = argumentHash(descriptor.args)
  return deps.db.$transaction(async (tx) => {
    const serviceTx: RecordServiceTx = tx
    const reservation = await reserve(serviceTx, ctx, descriptor, hash)
    if (reservation.kind === 'replay') return reservation.result
    const engineResult = await operation(serviceTx)
    const result = serviceResult(engineResult)
    if (engineResult.changed) await enqueueChanges(serviceTx, ctx, engineResult)
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
      metadata: auditMetadata(ctx),
      requestId: ctx.requestId,
      ipAddress: null,
      userAgent: null,
    })
    return result
  })
}

function teamScopes(ctx: ActorContext): PolicyScopeRef[] {
  return [{ scope: 'team', id: ctx.tenant.teamId }]
}

function objectScopes(ctx: ActorContext, schema: LoadedSchema, slug: string): PolicyScopeRef[] {
  const selected = schema.objectTypesBySlug.get(slug)
  const scopes = teamScopes(ctx)
  if (selected !== undefined) scopes.push({ scope: 'object_type', id: selected.id })
  return scopes
}

function objectIdScopes(ctx: ActorContext, objectTypeId: string): PolicyScopeRef[] {
  return [...teamScopes(ctx), { scope: 'object_type', id: objectTypeId }]
}

function recordScopes(ctx: ActorContext, record: VisibleRecord): PolicyScopeRef[] {
  return [
    ...teamScopes(ctx),
    { scope: 'object_type', id: record.objectTypeId },
    { scope: 'record', id: record.id },
  ]
}

function recordPolicy(action: PolicyAction, scopes: PolicyScopeRef[]): PolicyRequest {
  return { resourceType: 'record', action, scopes }
}

function attributePolicies(
  schema: LoadedSchema,
  objectTypeId: string | undefined,
  data: Record<string, unknown>,
  scopes: PolicyScopeRef[],
): PolicyRequest[] {
  if (objectTypeId === undefined) return []
  const attributes = schema.attributesByObjectTypeId.get(objectTypeId)
  if (attributes === undefined) return []
  const requests: PolicyRequest[] = []
  for (const slug of Object.keys(data).sort()) {
    const sensitivity = attributes.get(slug)?.sensitivity
    if (sensitivity !== 'confidential' && sensitivity !== 'restricted') continue
    requests.push({ resourceType: 'attribute', action: 'edit', scopes, sensitivity })
  }
  return requests
}

function commonArgs(input: CommonWriteInput): Record<string, unknown> {
  return {
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  }
}

export async function createRecord(
  deps: AppDeps, ctx: ActorContext, input: CreateRecordServiceInput, linkWriter: LinkWriter,
): Promise<RecordServiceResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const schema = await loadSchema(deps.db, ctx.tenant)
    const { reason, idempotencyKey, ...engineInput } = input
    const descriptor: WriteDescriptor = {
      tool: 'crm_record_create', action: 'create',
      scopes: objectScopes(ctx, schema, input.objectType),
      args: { objectType: input.objectType, data: input.data, ...commonArgs(input) },
      idempotencyKey, reason, resourceId: null,
    }
    const objectTypeId = schema.objectTypesBySlug.get(input.objectType)?.id
    const authorization = [
      recordPolicy(descriptor.action, descriptor.scopes),
      ...attributePolicies(schema, objectTypeId, input.data, descriptor.scopes),
    ]
    return runWrite(deps, ctx, descriptor, authorization, (tx) => (
      engineCreateRecord(tx, ctx, schema, { ...engineInput, reason }, linkWriter)
    ))
  })
}

export async function updateRecord(
  deps: AppDeps, ctx: ActorContext, input: UpdateRecordServiceInput, linkWriter: LinkWriter,
): Promise<RecordServiceResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const [schema, record] = await Promise.all([
      loadSchema(deps.db, ctx.tenant), requireVisibleRecord(deps.db, ctx, input.recordId),
    ])
    const scopes = recordScopes(ctx, record)
    const { reason, idempotencyKey, ...engineInput } = input
    const descriptor: WriteDescriptor = {
      tool: 'crm_record_update', action: 'edit', scopes,
      args: {
        recordId: input.recordId, data: input.data,
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
        ...commonArgs(input),
      },
      idempotencyKey, reason, resourceId: input.recordId,
    }
    const authorization = [
      recordPolicy(descriptor.action, scopes),
      ...attributePolicies(schema, record.objectTypeId, input.data, scopes),
    ]
    return runWrite(deps, ctx, descriptor, authorization, (tx) => (
      engineUpdateRecord(tx, ctx, schema, { ...engineInput, reason }, linkWriter)
    ))
  })
}

export async function assertRecord(
  deps: AppDeps, ctx: ActorContext, input: AssertRecordServiceInput, linkWriter: LinkWriter,
): Promise<RecordServiceResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const schema = await loadSchema(deps.db, ctx.tenant)
    const { reason, idempotencyKey, ...engineInput } = input
    const scopes = objectScopes(ctx, schema, input.objectType)
    const args: Record<string, unknown> = {
      objectType: input.objectType, matchAttribute: input.matchAttribute, data: input.data,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      ...commonArgs(input),
    }
    const descriptor: WriteDescriptor = {
      tool: 'crm_record_assert', action: 'create', scopes, args,
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
      await authorize(deps, ctx, resolved, [
        recordPolicy(resolution.action, resolvedScopes),
        ...attributePolicies(schema, resolution.objectTypeId, input.data, resolvedScopes),
      ])
    }
    return runWrite(deps, ctx, descriptor, null, (tx) => engineAssertRecord(
      tx, ctx, schema, { ...engineInput, reason }, linkWriter, onResolved,
    ))
  })
}

async function changeDeletedState(
  deps: AppDeps, ctx: ActorContext, input: DeleteRecordServiceInput,
  linkWriter: LinkWriter, restore: boolean,
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
    return runWrite(deps, ctx, descriptor, [recordPolicy(action, scopes)], (tx) => (
      restore
        ? engineRestoreRecord(
          tx, ctx, schema, input.recordId, input.expectedVersion, linkWriter, input.reason,
        )
        : engineDeleteRecord(
          tx, ctx, schema, input.recordId, input.expectedVersion, linkWriter, input.reason,
        )
    ))
  })
}

export function deleteRecord(
  deps: AppDeps, ctx: ActorContext, input: DeleteRecordServiceInput, linkWriter: LinkWriter,
): Promise<RecordServiceResult> {
  return changeDeletedState(deps, ctx, input, linkWriter, false)
}

export function restoreRecord(
  deps: AppDeps, ctx: ActorContext, input: DeleteRecordServiceInput, linkWriter: LinkWriter,
): Promise<RecordServiceResult> {
  return changeDeletedState(deps, ctx, input, linkWriter, true)
}
