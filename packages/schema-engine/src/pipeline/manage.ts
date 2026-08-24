import { tenantWhere, writeAudit, type TenantRef } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import { canonicalJsonValue, type JsonValue } from '../records/json.js'
import { lockRecords } from '../records/locks.js'
import { writeChanges } from '../records/changes.js'
import type { LoadedObjectType, LoadedSchema } from '../schema/load.js'
import type { AuditActor } from '../schema/mutation-types.js'
import { bumpSchemaVersion } from '../schema/mutate.js'
import type { RecordTx, SchemaTx } from '../schema/tx.js'

export type PipelineStageInput = {
  slug: string
  name: string
  position: number
  probability?: number
  category: 'open' | 'won' | 'lost' | 'neutral'
}
export type PipelineDefineInput = {
  objectType: string
  slug: string
  name: string
  description?: string
  isDefault: boolean
  stages: readonly PipelineStageInput[]
}
export type PipelineUpdateInput = {
  objectType: string
  pipeline: string
  name?: string
  description?: string
  isDefault?: boolean
}
export type PipelineStageSetInput = {
  recordId: string
  pipeline: string
  stage: string
  occurredAt?: Date
  reason?: string
  beforeTerminalAudit?: (result: PipelineStageSetResult) => Promise<void>
}
export type PipelineStageSetResult = {
  recordId: string
  pipeline: string
  stage: string
  changed: boolean
  intervalId: string | null
}

type PipelineDetail = Awaited<ReturnType<typeof listPipeline>>

function schemaConflict(detail: string): never {
  throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Pipeline schema metadata is inconsistent', { detail })
}

function unknownPipeline(): never {
  throw new ServiceError(ErrorCode.NOT_FOUND, 'Pipeline not found')
}

function objectType(schema: LoadedSchema, slug: string): LoadedObjectType {
  const found = schema.objectTypesBySlug.get(slug)
  if (found === undefined || found.archivedAt !== null) {
    throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type does not exist', { object_type: slug })
  }
  return found
}

function validateStages(stages: readonly PipelineStageInput[]): void {
  const slugs = new Set<string>()
  const positions = new Set<number>()
  for (const stage of stages) {
    if (slugs.has(stage.slug) || positions.has(stage.position)) schemaConflict('duplicate_stage')
    if (stage.probability !== undefined && (stage.probability < 0 || stage.probability > 1)) {
      schemaConflict('stage_probability')
    }
    slugs.add(stage.slug)
    positions.add(stage.position)
  }
  for (let position = 0; position < stages.length; position += 1) {
    if (!positions.has(position)) schemaConflict('stage_positions_not_contiguous')
  }
}

async function clearDefault(tx: SchemaTx, tenant: TenantRef, objectTypeId: string): Promise<void> {
  await tx.pipeline.updateMany({
    where: { ...tenantWhere(tenant), objectTypeId, archivedAt: null, isDefault: true },
    data: { isDefault: false },
  })
}

async function auditSchema(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  action: string,
  resourceId: string,
): Promise<void> {
  await writeAudit(tx, {
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    actorType: actor.type,
    actorId: actor.id,
    onBehalfOf: actor.onBehalfOf,
    action,
    resourceType: 'pipeline',
    resourceId,
    outcome: 'success',
    reason: null,
    metadata: null,
    requestId: actor.requestId,
    ipAddress: null,
    userAgent: null,
  })
}

export async function definePipeline(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  schema: LoadedSchema,
  input: PipelineDefineInput,
): Promise<PipelineDetail> {
  validateStages(input.stages)
  const object = objectType(schema, input.objectType)
  if (input.isDefault) await clearDefault(tx, tenant, object.id)
  const pipeline = await tx.pipeline.create({
    data: {
      ...tenantWhere(tenant),
      objectTypeId: object.id,
      slug: input.slug,
      name: input.name,
      description: input.description ?? '',
      isDefault: input.isDefault,
      createdByType: actor.type,
      createdById: actor.id,
    },
  })
  for (const stage of input.stages) {
    await tx.pipelineStage.create({
      data: {
        ...tenantWhere(tenant),
        pipelineId: pipeline.id,
        slug: stage.slug,
        name: stage.name,
        position: stage.position,
        probability: stage.probability,
        category: stage.category,
      },
    })
  }
  await bumpSchemaVersion(tx, tenant)
  await auditSchema(tx, tenant, actor, 'define', pipeline.id)
  return listPipeline(tx, tenant, input.objectType, input.slug)
}

export async function updatePipeline(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  schema: LoadedSchema,
  input: PipelineUpdateInput,
): Promise<PipelineDetail> {
  const object = objectType(schema, input.objectType)
  const pipeline = await tx.pipeline.findFirst({
    where: { ...tenantWhere(tenant), objectTypeId: object.id, slug: input.pipeline, archivedAt: null },
  })
  if (pipeline === null) unknownPipeline()
  if (input.isDefault === true) await clearDefault(tx, tenant, object.id)
  const updated = await tx.pipeline.update({
    where: { id: pipeline.id },
    data: {
      name: input.name,
      description: input.description,
      isDefault: input.isDefault,
    },
  })
  await bumpSchemaVersion(tx, tenant)
  await auditSchema(tx, tenant, actor, 'update', updated.id)
  return listPipeline(tx, tenant, input.objectType, input.pipeline)
}

export async function listPipeline(
  tx: Pick<SchemaTx, 'pipeline' | 'pipelineStage'>,
  tenant: TenantRef,
  objectSlug: string,
  pipelineSlug: string,
): Promise<{
  id: string
  objectType: string
  slug: string
  name: string
  description: string
  isDefault: boolean
  stages: Array<{
    id: string
    slug: string
    name: string
    position: number
    probability: number | null
    category: 'open' | 'won' | 'lost' | 'neutral'
    archivedAt: Date | null
  }>
  archivedAt: Date | null
}> {
  const pipeline = await tx.pipeline.findFirst({
    where: { ...tenantWhere(tenant), slug: pipelineSlug, archivedAt: null },
    select: {
      id: true, slug: true, name: true, description: true, isDefault: true, archivedAt: true,
      objectType: { select: { slug: true } },
    },
  })
  if (pipeline === null || pipeline.objectType.slug !== objectSlug) unknownPipeline()
  const stages = await tx.pipelineStage.findMany({
    where: { ...tenantWhere(tenant), pipelineId: pipeline.id, archivedAt: null },
    orderBy: [{ position: 'asc' }, { slug: 'asc' }],
    select: {
      id: true, slug: true, name: true, position: true, probability: true, category: true, archivedAt: true,
    },
  })
  return { ...pipeline, objectType: pipeline.objectType.slug, stages }
}

function json(value: unknown): JsonValue {
  const parsed = canonicalJsonValue(value)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') schemaConflict('invalid_stage_json')
  return parsed
}

export async function setRecordStage(
  tx: RecordTx,
  ctx: ActorContext,
  schema: LoadedSchema,
  input: PipelineStageSetInput,
): Promise<PipelineStageSetResult> {
  const at = input.occurredAt ?? ctx.now
  await lockRecords(tx, ctx.tenant.teamId, [input.recordId])
  const record = await tx.record.findFirst({ where: { ...tenantWhere(ctx.tenant), id: input.recordId } })
  if (record === null || record.deletedAt !== null || record.mergedIntoId !== null) {
    throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  }
  const object = schema.objectTypesById.get(record.objectTypeId)
  if (object === undefined || object.archivedAt !== null) schemaConflict('object_type')
  const pipeline = await tx.pipeline.findFirst({
    where: { ...tenantWhere(ctx.tenant), objectTypeId: object.id, slug: input.pipeline, archivedAt: null },
  })
  if (pipeline === null) unknownPipeline()
  const stage = await tx.pipelineStage.findFirst({
    where: { ...tenantWhere(ctx.tenant), pipelineId: pipeline.id, slug: input.stage, archivedAt: null },
  })
  if (stage === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Pipeline stage not found')
  const current = await tx.recordStageHistory.findFirst({
    where: { ...tenantWhere(ctx.tenant), recordId: record.id, pipelineId: pipeline.id, endedAt: null },
  })
  if (current?.stageId === stage.id) {
    const unchanged = {
      recordId: record.id, pipeline: pipeline.slug, stage: stage.slug, changed: false, intervalId: current.id,
    }
    await input.beforeTerminalAudit?.(unchanged)
    return unchanged
  }
  if (current !== null) {
    await tx.recordStageHistory.update({ where: { id: current.id }, data: { endedAt: at } })
  }
  const updated = await tx.record.update({
    where: { id: record.id },
    data: { version: { increment: 1 } },
    select: { version: true },
  })
  const interval = await tx.recordStageHistory.create({
    data: {
      ...tenantWhere(ctx.tenant),
      recordId: record.id,
      pipelineId: pipeline.id,
      stageId: stage.id,
      startedAt: at,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      requestId: ctx.requestId,
    },
  })
  const oldValue = current === null ? null : json({ pipeline: pipeline.slug, stage_id: current.stageId })
  const newValue = json({ pipeline: pipeline.slug, stage: stage.slug })
  const [changeSeq] = await writeChanges(tx, ctx, [{
    recordId: record.id,
    kind: 'set',
    attributeSlug: null,
    relationTypeId: null,
    linkId: null,
    groupId: null,
    oldValue,
    newValue,
    snapshot: null,
    resultingVersion: updated.version,
    reason: input.reason ?? null,
  }])
  if (changeSeq === undefined) schemaConflict('missing_change_sequence')
  const change = await tx.recordChange.findFirst({
    where: { ...tenantWhere(ctx.tenant), recordId: record.id, seq: BigInt(changeSeq) },
    select: { id: true },
  })
  if (change !== null) {
    await tx.recordStageHistory.update({ where: { id: interval.id }, data: { changeId: change.id } })
  }
  const result = { recordId: record.id, pipeline: pipeline.slug, stage: stage.slug, changed: true, intervalId: interval.id }
  await input.beforeTerminalAudit?.(result)
  await writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action: 'stage.set',
    resourceType: 'record',
    resourceId: record.id,
    outcome: 'success',
    reason: input.reason ?? null,
    metadata: { pipeline_id: pipeline.id, stage_id: stage.id },
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  })
  return result
}
