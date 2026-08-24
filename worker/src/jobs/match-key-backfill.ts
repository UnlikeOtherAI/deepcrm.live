import { Prisma, tenantWhere } from '@deepcrm/db'
import {
  finalizeMatchingBackfill,
  finalizeMatchingBootstrap,
  loadSchema,
  loadSchemaForMatchingBootstrap,
  materializeMatchingRecordBatch,
  stageMatchingBootstrapBatch,
  type MatchingAuditMetadata,
  type MatchingBackfillFinalResult,
} from '@deepcrm/schema-engine'
import { ActorSchema, ServiceError, UuidSchema } from '@deepcrm/schemas'
import { z } from 'zod'

import type { JobHandler, JobHandlerInput } from '../index.js'

export const MATCH_KEY_BACKFILL_JOB = 'match-key-backfill'
export const MATCH_KEY_BACKFILL_BATCH_SIZE = 500

const RoleSchema = z.enum(['owner', 'admin', 'member']).nullable()
const OnBehalfOfSchema = z.object({
  uoaUserId: z.string().min(1),
  role: RoleSchema,
}).strict()
const ActChainStepSchema = z.object({ sub: z.string(), product: z.string() }).strict()
const ProvenanceSchema = z.object({
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
  requestId: z.string().min(1),
}).strict()
// The replacement handler refuses to invent attribution: without the exact
// app/actChain/provenance audit identity the job fails closed (T16 contract).
const MatchingAuditMetadataSchema = z.object({
  app: z.string().min(1),
  actChain: z.array(ActChainStepSchema),
  provenance: ProvenanceSchema,
}).strict() satisfies z.ZodType<MatchingAuditMetadata>
const TenantSchema = z.object({
  organizationId: UuidSchema,
  teamId: UuidSchema,
}).strict()

export const MatchingBootstrapContextSeedSchema = z.object({
  tenant: TenantSchema,
  app: z.literal('deepcrm:migration'),
  actChain: z.array(ActChainStepSchema),
  actor: z.object({
    type: z.literal('system'),
    id: z.literal('deepcrm:migration:t16'),
  }).strict(),
  onBehalfOf: OnBehalfOfSchema,
  provenance: ProvenanceSchema,
  requestId: z.string().min(1),
}).strict()
export type MatchingBootstrapContextSeed = z.infer<
  typeof MatchingBootstrapContextSeedSchema
>

export const ReplacementBackfillPayloadSchema = z.object({
  organizationId: UuidSchema,
  teamId: UuidSchema,
  objectTypeId: UuidSchema,
  generationId: UuidSchema,
  attempt: z.number().int().nonnegative(),
  actor: ActorSchema,
  // ActorContext-shaped identity: the strict schema owns the replacement
  // contract and never invents attribution a producer failed to send.
  onBehalfOf: OnBehalfOfSchema,
  requestId: z.string().min(1),
  provenance: ProvenanceSchema,
  auditMetadata: MatchingAuditMetadataSchema,
}).strict()
export type ReplacementBackfillPayload = z.infer<
  typeof ReplacementBackfillPayloadSchema
>

export const ActiveBootstrapPayloadSchema = z.object({
  mode: z.literal('active_bootstrap'),
  organizationId: UuidSchema,
  teamId: UuidSchema,
  objectTypeId: UuidSchema,
  generationId: UuidSchema,
  context: MatchingBootstrapContextSeedSchema,
  attempt: z.number().int().nonnegative(),
}).strict()
export type ActiveBootstrapPayload = z.infer<typeof ActiveBootstrapPayloadSchema>

export const MatchKeyBackfillPayloadSchema = z.union([
  ActiveBootstrapPayloadSchema,
  ReplacementBackfillPayloadSchema,
])
export type MatchKeyBackfillPayload = z.infer<typeof MatchKeyBackfillPayloadSchema>

export function replacementBackfillKey(payload: ReplacementBackfillPayload): string {
  return [
    'match-key-backfill',
    payload.teamId,
    payload.objectTypeId,
    payload.generationId,
    payload.attempt,
  ].join(':')
}

export function activeBootstrapKey(payload: ActiveBootstrapPayload): string {
  return [
    'match-key-bootstrap',
    payload.teamId,
    payload.objectTypeId,
    payload.generationId,
    payload.attempt,
  ].join(':')
}

export function parseMatchKeyBackfillPayload(payload: unknown): MatchKeyBackfillPayload {
  const parsed = MatchKeyBackfillPayloadSchema.safeParse(payload)
  if (!parsed.success) throw new Error('Invalid match-key-backfill payload')
  return parsed.data
}

type ScanTarget = {
  tenant: { organizationId: string; teamId: string }
  objectTypeId: string
  generationId: string
}

type ReplacementScanTarget = ScanTarget & {
  attempt: number
  jobId: string
}

type GenerationCountRow = { total: number }

async function scanReplacementGeneration(
  input: JobHandlerInput,
  target: ReplacementScanTarget,
): Promise<{ processed: number; total: number; cancelled: boolean; stale?: boolean }> {
  const schema = await loadSchema(input.db, target.tenant)
  const known = await input.db.matchingRuleGeneration.findFirst({
    where: {
      ...tenantWhere(target.tenant),
      id: target.generationId,
      objectTypeId: target.objectTypeId,
      state: 'pending_backfill',
      backfillAttempt: target.attempt,
      backfillJobId: target.jobId,
    },
    select: { totalRecords: true },
  })
  if (known === null) return { processed: 0, total: 0, cancelled: false, stale: true }
  const totalRows = await input.db.$queryRaw<GenerationCountRow[]>`
    SELECT count(*)::integer AS total
    FROM records
    WHERE organization_id = ${target.tenant.organizationId}::uuid
      AND team_id = ${target.tenant.teamId}::uuid
      AND object_type_id = ${target.objectTypeId}::uuid
      AND deleted_at IS NULL
      AND merged_into_id IS NULL
  `
  const total = totalRows[0]?.total ?? 0
  let processed = 0
  let after = ''
  let cancelled = false
  for (;;) {
    const batch = await input.db.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          7::integer,
          hashtext(${`${target.tenant.teamId}:topology`})
        )
      `
      const generation = await tx.matchingRuleGeneration.findFirst({
        where: {
          ...tenantWhere(target.tenant),
          id: target.generationId,
          objectTypeId: target.objectTypeId,
          state: 'pending_backfill',
          backfillAttempt: target.attempt,
          backfillJobId: target.jobId,
        },
        select: { id: true },
      })
      if (generation === null) return { ids: [] as string[], cancelled: false, stale: true }
      const records = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM records
        WHERE organization_id = ${target.tenant.organizationId}::uuid
          AND team_id = ${target.tenant.teamId}::uuid
          AND object_type_id = ${target.objectTypeId}::uuid
          AND deleted_at IS NULL
          AND merged_into_id IS NULL
          ${after === '' ? Prisma.empty : Prisma.sql`AND id > ${after}::uuid`}
        ORDER BY id
        LIMIT ${MATCH_KEY_BACKFILL_BATCH_SIZE}
      `
      if (records.length === 0) return { ids: [] as string[], cancelled: false }
      const outcome = await materializeMatchingRecordBatch(
        tx, target.tenant, schema, target.generationId, records.map((record) => record.id),
      )
      await tx.matchingRuleGeneration.updateMany({
        where: {
          ...tenantWhere(target.tenant),
          id: target.generationId,
          state: 'pending_backfill',
          backfillAttempt: target.attempt,
          backfillJobId: target.jobId,
        },
        data: { processedRecords: { increment: outcome.processed }, totalRecords: total },
      })
      const queued = await tx.queueJob.updateMany({
        where: {
          id: input.job.id,
          organizationId: target.tenant.organizationId,
          teamId: target.tenant.teamId,
          status: 'running',
          lockedBy: input.workerId,
        },
        data: {
          progress: {
            scanned: processed + outcome.processed,
            total,
          },
        },
      })
      return { ids: records.map((record) => record.id), cancelled: queued.count !== 1 }
    })
    if (batch.cancelled) {
      cancelled = true
      break
    }
    if (batch.stale === true) return { processed: 0, total: 0, cancelled: false, stale: true }
    if (batch.ids.length === 0) break
    processed += batch.ids.length
    after = batch.ids[batch.ids.length - 1] ?? after
    if (batch.ids.length < MATCH_KEY_BACKFILL_BATCH_SIZE) break
  }
  return { processed, total, cancelled }
}

async function scanBootstrapGeneration(
  input: JobHandlerInput,
  target: ScanTarget,
  attempt: number,
): Promise<{ processed: number; total: number; cancelled: boolean }> {
  const schema = await loadSchemaForMatchingBootstrap(input.db, target.tenant, target.generationId)
  const known = await input.db.matchingRuleGeneration.findFirst({
    where: {
      ...tenantWhere(target.tenant),
      id: target.generationId,
      objectTypeId: target.objectTypeId,
      state: 'active',
      keysReadyAt: null,
      bootstrapAttempt: attempt,
      bootstrapJobId: input.job.id,
    },
    select: { id: true },
  })
  if (known === null) return { processed: 0, total: 0, cancelled: false }
  const totalRows = await input.db.$queryRaw<GenerationCountRow[]>`
    SELECT count(*)::integer AS total
    FROM records
    WHERE organization_id = ${target.tenant.organizationId}::uuid
      AND team_id = ${target.tenant.teamId}::uuid
      AND object_type_id = ${target.objectTypeId}::uuid
      AND deleted_at IS NULL
      AND merged_into_id IS NULL
  `
  const total = totalRows[0]?.total ?? 0
  let processed = 0
  let after = ''
  let cancelled = false
  for (;;) {
    const batch = await input.db.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          7::integer,
          hashtext(${`${target.tenant.teamId}:topology`})
        )
      `
      const generation = await tx.matchingRuleGeneration.findFirst({
        where: {
          ...tenantWhere(target.tenant),
          id: target.generationId,
          objectTypeId: target.objectTypeId,
          state: 'active',
          keysReadyAt: null,
          bootstrapAttempt: attempt,
          bootstrapJobId: input.job.id,
        },
        select: { id: true },
      })
      if (generation === null) return { ids: [] as string[], cancelled: false }
      const records = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM records
        WHERE organization_id = ${target.tenant.organizationId}::uuid
          AND team_id = ${target.tenant.teamId}::uuid
          AND object_type_id = ${target.objectTypeId}::uuid
          AND deleted_at IS NULL
          AND merged_into_id IS NULL
          ${after === '' ? Prisma.empty : Prisma.sql`AND id > ${after}::uuid`}
        ORDER BY id
        LIMIT ${MATCH_KEY_BACKFILL_BATCH_SIZE}
      `
      if (records.length === 0) return { ids: [] as string[], cancelled: false }
      const outcome = await stageMatchingBootstrapBatch(
        tx, target.tenant, schema, target.generationId, records.map((record) => record.id),
      )
      await tx.matchingRuleGeneration.updateMany({
        where: {
          ...tenantWhere(target.tenant),
          id: target.generationId,
          state: 'active',
          keysReadyAt: null,
          bootstrapAttempt: attempt,
          bootstrapJobId: input.job.id,
        },
        data: { processedRecords: { increment: outcome.processed }, totalRecords: total },
      })
      const queued = await tx.queueJob.updateMany({
        where: {
          id: input.job.id,
          organizationId: target.tenant.organizationId,
          teamId: target.tenant.teamId,
          status: 'running',
          lockedBy: input.workerId,
        },
        data: {
          progress: {
            scanned: processed + outcome.processed,
            total,
          },
        },
      })
      return { ids: records.map((record) => record.id), cancelled: queued.count !== 1 }
    })
    if (batch.cancelled) {
      cancelled = true
      break
    }
    if (batch.ids.length === 0) break
    processed += batch.ids.length
    after = batch.ids[batch.ids.length - 1] ?? after
    if (batch.ids.length < MATCH_KEY_BACKFILL_BATCH_SIZE) break
  }
  return { processed, total, cancelled }
}

function runIdempotentFinalizer<Args extends unknown[]>(
  finalize: (...args: Args) => Promise<MatchingBackfillFinalResult>,
): (...args: Args) => Promise<MatchingBackfillFinalResult> {
  let outcome: MatchingBackfillFinalResult | undefined
  return async (...args: Args) => {
    if (outcome !== undefined) return outcome
    outcome = await finalize(...args)
    return outcome
  }
}

export const matchKeyBackfillHandler: JobHandler = async (input) => {
  const payload = parseMatchKeyBackfillPayload(input.job.payload)
  if (
    payload.organizationId !== input.job.organizationId
    || payload.teamId !== input.job.teamId
  ) {
    throw new Error('Match-key backfill payload tenant does not match the claimed job')
  }
  if (input.job.type !== MATCH_KEY_BACKFILL_JOB) {
    throw new Error('Match-key backfill handler claimed a foreign job type')
  }
  const tenant = { organizationId: payload.organizationId, teamId: payload.teamId }

  if ('mode' in payload) {
    const context = payload.context
    const target = {
      tenant,
      objectTypeId: payload.objectTypeId,
      generationId: payload.generationId,
    }
    const scanned = await scanBootstrapGeneration(input, target, payload.attempt)
    if (scanned.cancelled) return undefined
    const finalize = runIdempotentFinalizer(() => input.db.$transaction((tx) => (
      finalizeMatchingBootstrap(tx, tenant, {
        type: context.actor.type,
        id: context.actor.id,
        onBehalfOf: context.onBehalfOf.uoaUserId,
        requestId: context.requestId,
      }, {
        generationId: payload.generationId,
        attempt: payload.attempt,
        jobId: input.job.id,
        workerId: input.workerId,
        processed: scanned.processed,
        auditMetadata: {
          app: context.app,
          actChain: context.actChain,
          provenance: context.provenance,
        },
      })
    )))
    const outcome = await finalize()
    if (outcome.terminalized) return { terminalized: true }
    return undefined
  }

  const target = {
    tenant,
    objectTypeId: payload.objectTypeId,
    generationId: payload.generationId,
    attempt: payload.attempt,
    jobId: input.job.id,
  }
  const scanned = await scanReplacementGeneration(input, target)
  if (scanned.cancelled) return undefined
  const finalize = runIdempotentFinalizer(() => input.db.$transaction((tx) => (
    finalizeMatchingBackfill(tx, tenant, {
      type: payload.actor.type,
      id: payload.actor.id,
      onBehalfOf: payload.onBehalfOf.uoaUserId,
      requestId: payload.requestId,
    }, {
      generationId: payload.generationId,
      attempt: payload.attempt,
      jobId: input.job.id,
      workerId: input.workerId,
      processed: scanned.processed,
      auditMetadata: payload.auditMetadata,
    })
  )))
  const outcome = await finalize()
  if (outcome.terminalized) return { terminalized: true }
  return undefined
}

export function isMissingBackfillIdentity(error: unknown): boolean {
  return error instanceof ServiceError
    && error.details.detail === 'matching_backfill_identity_required'
}
