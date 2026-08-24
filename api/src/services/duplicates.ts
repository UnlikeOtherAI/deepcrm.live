import { Prisma } from '@deepcrm/db'
import { enqueue } from '@deepcrm/queue'
import { loadSchema } from '@deepcrm/schema-engine'
import {
  ErrorCode,
  Filter,
  FindDuplicatesPayload,
  ServiceError,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { DEDUP_SCAN_JOB, getQueueTask } from './queue-tasks.js'

export type FindDuplicatesInput = {
  objectType: string
  filter?: unknown
  includeSemantic?: boolean
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

function inputJson(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(inputJson)
  if (typeof value === 'object') return inputJsonObject(value)
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Dedup scan payload must be JSON')
}

function inputJsonObject(value: object): Prisma.InputJsonObject {
  const result: Record<string, Prisma.InputJsonValue | null> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = inputJson(item)
  }
  return result
}

export async function enqueueFindDuplicates(
  deps: AppDeps,
  ctx: ActorContext,
  input: FindDuplicatesInput,
): Promise<{ task: Awaited<ReturnType<typeof getQueueTask>> }> {
  const schema = await loadSchema(deps.db, ctx.tenant)
  const objectType = schema.objectTypesBySlug.get(input.objectType)
  if (objectType === undefined || objectType.archivedAt !== null) {
    throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type does not exist')
  }
  const filter = input.filter === undefined ? undefined : Filter.parse(input.filter)
  const jobPayload = FindDuplicatesPayload.parse({
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    objectType: input.objectType,
    ...(filter === undefined ? {} : { filter }),
    includeSemantic: input.includeSemantic ?? true,
    embeddingModel: deps.embedder.model,
    requestedAt: deps.clock().toISOString(),
    actorContext: actorContext(ctx),
  })
  const job = await deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7, hashtext(${ctx.tenant.teamId}))`
    const active = await tx.queueJob.findFirst({
      where: {
        organizationId: ctx.tenant.organizationId,
        teamId: ctx.tenant.teamId,
        type: DEDUP_SCAN_JOB,
        status: { in: ['queued', 'running'] },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (active !== null) return active
    return enqueue(tx, {
      organizationId: ctx.tenant.organizationId,
      teamId: ctx.tenant.teamId,
      type: DEDUP_SCAN_JOB,
      payload: inputJsonObject(jobPayload),
      maxAttempts: 3,
    })
  })
  return { task: await getQueueTask(deps, ctx, job.id) }
}
