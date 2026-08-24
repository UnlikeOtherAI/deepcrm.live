import { createHash } from 'node:crypto'
import { canonicalJson, tenantWhere } from '@deepcrm/db'
import {
  canSee,
  definePipeline as engineDefinePipeline,
  listPipeline as engineListPipeline,
  loadSchema,
  pipelineSummary as enginePipelineSummary,
  setRecordStage as engineSetRecordStage,
  updatePipeline as engineUpdatePipeline,
} from '@deepcrm/schema-engine'
import {
  CrmPipelineDefine,
  CrmPipelineStageSet,
  CrmPipelineStagesList,
  CrmPipelineSummary,
  CrmPipelineUpdate,
  ErrorCode,
  Filter as FilterSchema,
  IsoDateTime,
  ServiceError,
  Slug,
  type ActorContext,
  type Filter,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { checkPolicy, loadPolicyEvaluator, type PolicyRequest } from './policy.js'
import { recordBoundary } from './record-boundary.js'
import {
  attributeRequest,
  filterAttributes,
  preauthorize,
  queryScopes,
  selectedAttribute,
  selectedObjectType,
} from './record-query-authorization.js'
import { runSchemaDefine } from './schema.js'

export type PipelineSummaryInput = {
  objectType: string
  pipeline?: string
  amountAttribute?: string
  filter?: Filter
  since?: string
}
type StageSetResult = {
  record_id: string
  pipeline: string
  stage: string
  changed: boolean
  interval_id: string | null
}
type StageSetReservation =
  | { kind: 'none' }
  | { kind: 'replay'; result: StageSetResult }
  | { kind: 'reserved'; id: string }
type StageSetTx = Parameters<typeof engineSetRecordStage>[0] & Pick<AppDeps['db'], 'idempotencyReplay'>

function invalid(path: string, message: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Pipeline arguments are invalid', {
    issues: [{ path, message }],
  })
}

function pointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) return ''
  return `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`
}

function optionalDate(value: string | undefined, path = '/occurred_at'): Date | undefined {
  if (value === undefined) return undefined
  const parsed = IsoDateTime.safeParse(value)
  if (!parsed.success) invalid(path, 'Must be ISO 8601 with an offset')
  return new Date(parsed.data)
}

function argumentHash(args: Record<string, unknown>): string {
  try {
    return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex')
  } catch {
    invalid('', 'Arguments must be valid JSON')
  }
}

function idempotencyLock(ctx: ActorContext, tool: string, key: string): string {
  return [ctx.tenant.teamId, ctx.onBehalfOf.uoaUserId, tool, key].join(':')
}

function stageSetReplay(value: unknown): StageSetResult {
  return CrmPipelineStageSet.out.parse(value)
}

async function reserveStageSet(
  tx: StageSetTx,
  ctx: ActorContext,
  key: string | undefined,
  argsHash: string,
): Promise<StageSetReservation> {
  if (key === undefined) return { kind: 'none' }
  const locks = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock(6::integer, hashtext(${idempotencyLock(ctx, 'crm_pipeline_stage_set', key)})) AS locked
  `
  if (locks[0]?.locked !== true) {
    throw new ServiceError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'Idempotent operation is in progress')
  }
  const existing = await tx.idempotencyReplay.findFirst({
    where: {
      ...tenantWhere(ctx.tenant),
      principalUserId: ctx.onBehalfOf.uoaUserId,
      tool: 'crm_pipeline_stage_set',
      key,
    },
  })
  if (existing !== null) {
    if (existing.argumentsHash !== argsHash) {
      throw new ServiceError(ErrorCode.IDEMPOTENCY_MISMATCH, 'Idempotency key arguments do not match')
    }
    if (existing.result === null) {
      throw new ServiceError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'Idempotent operation is in progress')
    }
    return { kind: 'replay', result: stageSetReplay(existing.result) }
  }
  const created = await tx.idempotencyReplay.create({
    data: {
      ...tenantWhere(ctx.tenant),
      principalUserId: ctx.onBehalfOf.uoaUserId,
      tool: 'crm_pipeline_stage_set',
      key,
      argumentsHash: argsHash,
    },
    select: { id: true },
  })
  return { kind: 'reserved', id: created.id }
}

async function storeStageSetReplay(
  tx: StageSetTx,
  ctx: ActorContext,
  reservation: StageSetReservation,
  result: StageSetResult,
): Promise<void> {
  if (reservation.kind !== 'reserved') return
  const updated = await tx.idempotencyReplay.updateMany({
    where: { ...tenantWhere(ctx.tenant), id: reservation.id },
    data: { result },
  })
  if (updated.count !== 1) throw new ServiceError(ErrorCode.INTERNAL, 'Idempotency result was not stored')
}

function presentStageSet(result: Awaited<ReturnType<typeof engineSetRecordStage>>): StageSetResult {
  return {
    record_id: result.recordId,
    pipeline: result.pipeline,
    stage: result.stage,
    changed: result.changed,
    interval_id: result.intervalId,
  }
}

function parseSummary(input: PipelineSummaryInput): {
  objectType: string
  pipeline?: string
  amountAttribute?: string
  filter?: Filter
  since?: Date
} {
  const objectType = Slug.safeParse(input.objectType)
  if (!objectType.success) invalid('/object_type', 'Must be a valid object type slug')
  const pipeline = input.pipeline === undefined ? undefined : Slug.safeParse(input.pipeline)
  if (pipeline !== undefined && !pipeline.success) invalid('/pipeline', 'Must be a valid pipeline slug')
  const amount = input.amountAttribute === undefined ? undefined : Slug.safeParse(input.amountAttribute)
  if (amount !== undefined && !amount.success) invalid('/amount_attribute', 'Must be a valid attribute slug')
  let filter: Filter | undefined
  if (input.filter !== undefined) {
    const parsed = FilterSchema.safeParse(input.filter)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      invalid(pointer(issue?.path ?? []), issue?.message ?? 'Invalid filter')
    }
    filter = parsed.data
  }
  return {
    objectType: objectType.data,
    ...(pipeline === undefined ? {} : { pipeline: pipeline.data }),
    ...(amount === undefined ? {} : { amountAttribute: amount.data }),
    ...(filter === undefined ? {} : { filter }),
    ...(input.since === undefined ? {} : { since: optionalDate(input.since, '/since') }),
  }
}

function presentPipeline(value: Awaited<ReturnType<typeof engineListPipeline>>) {
  return {
    id: value.id,
    object_type: value.objectType,
    slug: value.slug,
    name: value.name,
    description: value.description,
    is_default: value.isDefault,
    stages: value.stages.map((stage) => ({
      id: stage.id,
      slug: stage.slug,
      name: stage.name,
      position: stage.position,
      probability: stage.probability,
      category: stage.category,
      archived_at: stage.archivedAt?.toISOString() ?? null,
    })),
    archived_at: value.archivedAt?.toISOString() ?? null,
  }
}

export async function definePipeline(deps: AppDeps, ctx: ActorContext, input: unknown) {
  const parsed = CrmPipelineDefine.in.parse(input)
  const schema = await loadSchema(deps.db, ctx.tenant)
  return runSchemaDefine(deps, ctx, async (tx, actor) => {
    const result = await engineDefinePipeline(tx, ctx.tenant, actor, schema, {
      objectType: parsed.object_type,
      slug: parsed.slug,
      name: parsed.name,
      description: parsed.description,
      isDefault: parsed.is_default,
      stages: parsed.stages.map((stage) => ({
        slug: stage.slug,
        name: stage.name,
        position: stage.position,
        probability: stage.probability,
        category: stage.category,
      })),
    })
    return CrmPipelineDefine.out.parse(presentPipeline(result))
  })
}

export async function updatePipeline(deps: AppDeps, ctx: ActorContext, input: unknown) {
  const parsed = CrmPipelineUpdate.in.parse(input)
  const schema = await loadSchema(deps.db, ctx.tenant)
  return runSchemaDefine(deps, ctx, async (tx, actor) => {
    const result = await engineUpdatePipeline(tx, ctx.tenant, actor, schema, {
      objectType: parsed.object_type,
      pipeline: parsed.pipeline,
      name: parsed.name,
      description: parsed.description,
      isDefault: parsed.is_default,
    })
    return CrmPipelineUpdate.out.parse(presentPipeline(result))
  })
}

export async function listPipelineStages(deps: AppDeps, ctx: ActorContext, input: unknown) {
  const parsed = CrmPipelineStagesList.in.parse(input)
  await checkPolicyOrThrow(deps, ctx, 'schema', 'view')
  const result = await engineListPipeline(deps.db, ctx.tenant, parsed.object_type, parsed.pipeline)
  const pipeline = CrmPipelineDefine.out.parse(presentPipeline(result))
  return CrmPipelineStagesList.out.parse({ pipeline, stages: pipeline.stages })
}

async function checkPolicyOrThrow(
  deps: AppDeps,
  ctx: ActorContext,
  resourceType: 'schema' | 'record',
  action: 'view' | 'edit',
): Promise<void> {
  const decision = await checkPolicy(deps.db, ctx, {
    resourceType,
    action,
    scopes: [{ scope: 'team', id: ctx.tenant.teamId }],
  })
  if (!decision.allowed || decision.requiresApproval) {
    throw new ServiceError(decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
      'Pipeline operation is not permitted')
  }
}

export async function setPipelineStage(deps: AppDeps, ctx: ActorContext, input: unknown) {
  const parsed = CrmPipelineStageSet.in.parse(input)
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const schema = await loadSchema(deps.db, ctx.tenant)
    const record = await deps.db.record.findFirst({
      where: { id: parsed.record_id, organizationId: ctx.tenant.organizationId, teamId: ctx.tenant.teamId },
      include: { visibilityGrants: true },
    })
    if (record === null || record.deletedAt !== null || record.mergedIntoId !== null || !canSee(ctx, record)) {
      throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
    }
    const objectType = schema.objectTypesById.get(record.objectTypeId)
    if (objectType === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema metadata is inconsistent')
    const decision = await checkPolicy(deps.db, ctx, {
      resourceType: 'record',
      action: 'edit',
      scopes: [{ scope: 'team', id: ctx.tenant.teamId }, { scope: 'object_type', id: objectType.id }],
    })
    if (!decision.allowed || decision.requiresApproval) {
      throw new ServiceError(decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
        'Pipeline stage update is not permitted')
    }
    const hash = argumentHash({
      record_id: parsed.record_id,
      pipeline: parsed.pipeline,
      stage: parsed.stage,
      ...(parsed.occurred_at === undefined ? {} : { occurred_at: parsed.occurred_at }),
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
    })
    const result = await deps.db.$transaction(async (tx) => {
      const reservation = await reserveStageSet(tx, ctx, parsed.idempotency_key, hash)
      if (reservation.kind === 'replay') return reservation.result
      const engineResult = await engineSetRecordStage(tx, ctx, schema, {
        recordId: parsed.record_id,
        pipeline: parsed.pipeline,
        stage: parsed.stage,
        occurredAt: optionalDate(parsed.occurred_at),
        reason: parsed.reason,
        beforeTerminalAudit: async (pending) => {
          await storeStageSetReplay(tx, ctx, reservation, presentStageSet(pending))
        },
      })
      return presentStageSet(engineResult)
    })
    return CrmPipelineStageSet.out.parse(result)
  })
}

export async function pipelineSummary(
  deps: AppDeps,
  ctx: ActorContext,
  input: PipelineSummaryInput,
) {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const normalized = parseSummary(input)
    const schema = await loadSchema(deps.db, ctx.tenant)
    const objectType = selectedObjectType(schema, normalized.objectType)
    const selectedAmount = normalized.amountAttribute === undefined
      ? undefined
      : selectedAttribute(schema, objectType, normalized.amountAttribute)
    const sensitiveSlugs = filterAttributes(normalized.filter)
    if (selectedAmount !== undefined) sensitiveSlugs.add(selectedAmount.slug)
    const sensitiveAttributes = [...sensitiveSlugs].sort().map((slug) => selectedAttribute(schema, objectType, slug))
    const scopes = queryScopes(ctx, objectType)
    const recordRequest: PolicyRequest = { resourceType: 'record', action: 'view', scopes }
    const attributeRequests = sensitiveAttributes.map((attribute) => attributeRequest(scopes, attribute))
    const evaluator = await loadPolicyEvaluator(deps.db, ctx, [recordRequest, ...attributeRequests])
    await preauthorize(deps, ctx, objectType, evaluator, [recordRequest, ...attributeRequests], 'crm_pipeline_summary')
    const result = await enginePipelineSummary(deps.db, ctx.tenant, ctx, schema, objectType, normalized)
    return CrmPipelineSummary.out.parse({
      stages: result.stages.map((stage) => ({
        id: stage.id,
        label: stage.label,
        category: stage.category,
        count: stage.count,
        amount_sum: stage.amountSum,
        avg_days_in_stage: stage.averageDaysInStage,
      })),
      conversions: result.conversions,
    })
  })
}
