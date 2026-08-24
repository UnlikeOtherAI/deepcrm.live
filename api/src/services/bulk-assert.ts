import { createHash } from 'node:crypto'

import { canonicalJson, Prisma } from '@deepcrm/db'
import { enqueue, QueueIdempotencyMismatchError } from '@deepcrm/queue'
import { loadSchema } from '@deepcrm/schema-engine'
import {
  BulkAssertPayload,
  ErrorCode,
  ServiceError,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { BULK_ASSERT_JOB, getQueueTask } from './queue-tasks.js'

type BulkLink = {
  relationType: string
  toRecordId: string
  data?: Record<string, unknown>
  label?: string
}

export type BulkAssertServiceInput = {
  objectType: string
  matchAttribute: string
  rows: ReadonlyArray<{ data: Record<string, unknown>; links?: readonly BulkLink[] }>
  reason?: string
  idempotencyKey?: string
}

function limitExceeded(limit: number): never {
  throw new ServiceError(ErrorCode.LIMIT_EXCEEDED, 'Bulk row limit exceeded', { limit })
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inputJson(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(inputJson)
  if (jsonObject(value)) return inputJsonObject(value)
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Bulk row data must be JSON')
}

function inputJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  const result: Record<string, Prisma.InputJsonValue | null> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = inputJson(item)
  }
  return result
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

function payload(ctx: ActorContext, input: BulkAssertServiceInput, operationKey: string) {
  const logicalRows = input.rows.map((row) => ({
    data: row.data,
    ...(row.links === undefined ? {} : { links: row.links.map((link) => ({
      relation_type: link.relationType,
      to_record_id: link.toRecordId,
      ...(link.data === undefined ? {} : { data: link.data }),
      ...(link.label === undefined ? {} : { label: link.label }),
    })) }),
  }))
  const rows = logicalRows.map((row, index) => ({
    ...row,
    idempotencyKey: digest({ operationKey, index }),
  }))
  return BulkAssertPayload.parse({
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    objectType: input.objectType,
    matchAttribute: input.matchAttribute,
    rows,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    argumentsHash: digest({
      objectType: input.objectType,
      matchAttribute: input.matchAttribute,
      rows: logicalRows,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
    actorContext: actorContext(ctx),
  })
}

async function validateMatchAttribute(
  deps: AppDeps,
  ctx: ActorContext,
  input: BulkAssertServiceInput,
): Promise<void> {
  const schema = await loadSchema(deps.db, ctx.tenant)
  const objectType = schema.objectTypesBySlug.get(input.objectType)
  if (objectType === undefined || objectType.archivedAt !== null) {
    throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type does not exist')
  }
  const attribute = schema.attributesByObjectTypeId.get(objectType.id)?.get(input.matchAttribute)
  if (attribute === undefined) {
    throw new ServiceError(ErrorCode.UNKNOWN_ATTRIBUTE, 'Attribute does not exist', {
      attribute: input.matchAttribute,
    })
  }
  if (attribute.archivedAt !== null) {
    throw new ServiceError(ErrorCode.ATTRIBUTE_ARCHIVED, 'Attribute is archived', {
      attribute: input.matchAttribute,
    })
  }
  if (!attribute.isUnique) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Match attribute must be unique', {
      issues: [{ path: '/match_attribute', message: 'Attribute must be unique' }],
    })
  }
}

export async function enqueueBulkAssert(
  deps: AppDeps,
  ctx: ActorContext,
  input: BulkAssertServiceInput,
): Promise<{ task: Awaited<ReturnType<typeof getQueueTask>> }> {
  if (input.rows.length === 0) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Bulk rows must not be empty')
  }
  if (input.rows.length > deps.maxBulkRows) limitExceeded(deps.maxBulkRows)
  await validateMatchAttribute(deps, ctx, input)
  const operationKey = input.idempotencyKey ?? ctx.requestId
  const jobPayload = payload(ctx, input, operationKey)
  const queueKey = `bulk-assert:${ctx.tenant.teamId}:${ctx.onBehalfOf.uoaUserId}:${operationKey}`
  try {
    const job = await enqueue(deps.db, {
      organizationId: ctx.tenant.organizationId,
      teamId: ctx.tenant.teamId,
      type: BULK_ASSERT_JOB,
      payload: inputJsonObject(jobPayload),
      idempotencyKey: queueKey,
      maxAttempts: 3,
      matchesExistingPayload: (stored) => {
        const parsed = BulkAssertPayload.safeParse(stored)
        return parsed.success && parsed.data.argumentsHash === jobPayload.argumentsHash
      },
    })
    return { task: await getQueueTask(deps, ctx, job.id) }
  } catch (error) {
    if (error instanceof QueueIdempotencyMismatchError) {
      throw new ServiceError(
        ErrorCode.IDEMPOTENCY_MISMATCH,
        'Idempotency key arguments do not match',
      )
    }
    throw error
  }
}
