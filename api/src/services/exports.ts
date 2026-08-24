import { createHash } from 'node:crypto'

import { canonicalJson, Prisma } from '@deepcrm/db'
import { enqueue, QueueIdempotencyMismatchError } from '@deepcrm/queue'
import { loadSchema } from '@deepcrm/schema-engine'
import {
  CrmExport,
  ErrorCode,
  ExportPayload,
  ServiceError,
  type ActorContext,
  type Filter,
  type Sort,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import type { ApprovalConsumption } from './approvals.js'
import { checkPolicy } from './policy.js'
import { EXPORT_JOB, getQueueTask } from './queue-tasks.js'
import { selectedAttribute, selectedObjectType } from './record-query-authorization.js'
import { getView } from './views.js'

export type ExportServiceInput = {
  objectType?: string
  view?: string
  format: 'jsonl' | 'csv'
  attributes?: readonly string[]
  reason?: string
  idempotencyKey?: string
}

type ResolvedExport = {
  objectType: string
  filter?: Filter
  sort: Sort
  attributes: string[]
}

function jsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(jsonValue)
  if (typeof value === 'object') {
    const result: Record<string, Prisma.InputJsonValue | null> = {}
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) result[key] = jsonValue(child)
    }
    return result
  }
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Export payload must be JSON')
}

function jsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  const result: Record<string, Prisma.InputJsonValue | null> = {}
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) result[key] = jsonValue(child)
  }
  return result
}

function digest(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(jsonObject(value)), 'utf8').digest('hex')
}

function actorContext(ctx: ActorContext) {
  return {
    tenant: ctx.tenant,
    app: ctx.app,
    actChain: ctx.actChain,
    actor: ctx.actor,
    onBehalfOf: ctx.onBehalfOf,
    provenance: ctx.provenance,
    requestId: ctx.requestId,
  }
}

async function authorize(deps: AppDeps, ctx: ActorContext): Promise<void> {
  const decision = await checkPolicy(deps.db, ctx, {
    resourceType: 'export',
    action: 'export',
    scopes: [{ scope: 'team', id: ctx.tenant.teamId }],
  })
  if (decision.allowed && !decision.requiresApproval) return
  throw new ServiceError(
    decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Export is not permitted',
  )
}

async function resolveExport(
  deps: AppDeps, ctx: ActorContext, input: ExportServiceInput,
): Promise<ResolvedExport> {
  const schema = await loadSchema(deps.db, ctx.tenant)
  const view = input.view === undefined ? undefined : await getView(deps, ctx, input.view)
  const objectType = selectedObjectType(schema, input.objectType ?? view?.object_type ?? '')
  const requested = input.attributes ?? (view !== undefined && view.attributes.length > 0
    ? view.attributes
    : objectType.attributes.map((attribute) => attribute.slug))
  const attributes = [...new Set(requested)]
  for (const attribute of attributes) selectedAttribute(schema, objectType, attribute)
  return {
    objectType: objectType.slug,
    ...(view === undefined ? {} : { filter: view.filter }),
    sort: view?.sort ?? [{ system: 'created_at', direction: 'desc' }],
    attributes,
  }
}

export async function enqueueExport(
  deps: AppDeps,
  ctx: ActorContext,
  input: ExportServiceInput,
  approval?: ApprovalConsumption,
): Promise<{ task: Awaited<ReturnType<typeof getQueueTask>> }> {
  const parsed = CrmExport.in.safeParse({
    object_type: input.objectType,
    view: input.view,
    format: input.format,
    attributes: input.attributes,
    reason: input.reason,
    idempotency_key: input.idempotencyKey,
  })
  if (!parsed.success) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Export input is invalid', {
      issues: parsed.error.issues,
    })
  }
  await authorize(deps, ctx)
  const resolved = await resolveExport(deps, ctx, input)
  const argumentsHash = digest(parsed.data)
  const payload = ExportPayload.parse({
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    objectType: resolved.objectType,
    filter: resolved.filter,
    sort: resolved.sort,
    attributes: resolved.attributes,
    format: input.format,
    reason: input.reason,
    argumentsHash,
    actorContext: actorContext(ctx),
  })
  const operationKey = input.idempotencyKey ?? ctx.requestId
  try {
    const job = await deps.db.$transaction(async (tx) => {
      await approval?.consume(tx)
      return enqueue(tx, {
        organizationId: ctx.tenant.organizationId,
        teamId: ctx.tenant.teamId,
        type: EXPORT_JOB,
        payload: jsonObject(payload),
        idempotencyKey: `export:${ctx.tenant.teamId}:${ctx.onBehalfOf.uoaUserId}:${operationKey}`,
        maxAttempts: 3,
        matchesExistingPayload: (stored) => {
          const existing = ExportPayload.safeParse(stored)
          return existing.success && existing.data.argumentsHash === argumentsHash
        },
      })
    })
    return { task: await getQueueTask(deps, ctx, job.id) }
  } catch (error) {
    if (error instanceof QueueIdempotencyMismatchError) {
      throw new ServiceError(ErrorCode.IDEMPOTENCY_MISMATCH, 'Idempotency key arguments do not match')
    }
    throw error
  }
}
