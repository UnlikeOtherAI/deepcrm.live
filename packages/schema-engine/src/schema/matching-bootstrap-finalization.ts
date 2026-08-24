import { Prisma, tenantWhere, writeAudit, type TenantRef } from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import { matchingCollisionCounts } from '../matching/keys.js'
import type { AuditActor } from './mutation-types.js'
import type {
  MatchingAuditMetadata,
  MatchingBackfillFinalResult,
} from './matching-rules.js'
import type { SchemaTx } from './tx.js'

function failure(detail: string): ServiceError {
  return new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Matching rule update conflicts with current schema', { detail })
}

async function lockTopology(tx: SchemaTx, teamId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7::integer, hashtext(${`${teamId}:topology`}))`
}

async function terminalize(
  tx: SchemaTx, tenant: TenantRef, jobId: string, workerId: string, result: Prisma.InputJsonObject,
): Promise<boolean> {
  const update = await tx.queueJob.updateMany({
    where: { id: jobId, organizationId: tenant.organizationId, teamId: tenant.teamId, status: 'running', lockedBy: workerId },
    data: { status: 'completed', lockedAt: null, lockedBy: null, result },
  })
  return update.count === 1
}

async function audit(
  tx: SchemaTx, tenant: TenantRef, actor: AuditActor, action: string, objectTypeId: string,
  metadata: MatchingAuditMetadata,
): Promise<void> {
  await writeAudit(tx, {
    organizationId: tenant.organizationId, teamId: tenant.teamId, actorType: actor.type, actorId: actor.id,
    onBehalfOf: actor.onBehalfOf, action, resourceType: 'object_type', resourceId: objectTypeId,
    outcome: 'success', reason: null, metadata, requestId: actor.requestId, ipAddress: null, userAgent: null,
  })
}

export async function finalizeMatchingBootstrap(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  input: Readonly<{
    generationId: string
    attempt: number
    jobId: string
    workerId: string
    processed: number
    auditMetadata: MatchingAuditMetadata
  }>,
): Promise<MatchingBackfillFinalResult> {
  await lockTopology(tx, tenant.teamId)
  const generation = await tx.matchingRuleGeneration.findFirst({
    where: {
      ...tenantWhere(tenant), id: input.generationId, state: 'active', keysReadyAt: null,
      bootstrapAttempt: input.attempt, bootstrapJobId: input.jobId,
    },
    include: { rules: { orderBy: { position: 'asc' } } },
  })
  if (generation === null) return { terminalized: false, state: 'stale' }
  const collisions = await matchingCollisionCounts(tx, tenant, generation.id)
  if (collisions.groupCount > 0) {
    const changed = await tx.matchingRuleGeneration.updateMany({
      where: {
        ...tenantWhere(tenant), id: generation.id, state: 'active', keysReadyAt: null,
        bootstrapAttempt: input.attempt, bootstrapJobId: input.jobId,
      },
      data: {
        processedRecords: input.processed,
        collisionGroups: collisions.groupCount, collisionRecords: collisions.recordCount,
      },
    })
    if (changed.count !== 1) return { terminalized: false, state: 'stale' }
    const terminalized = await terminalize(tx, tenant, input.jobId, input.workerId, {
      state: 'collisions',
      group_count: collisions.groupCount, record_count: collisions.recordCount,
    })
    if (!terminalized) throw failure('matching_bootstrap_job_not_running')
    await audit(tx, tenant, actor, 'schema.matching_rules.bootstrap', generation.objectTypeId, input.auditMetadata)
    return {
      terminalized: true, state: 'collision_blocked', processed: input.processed,
      groupCount: collisions.groupCount, recordCount: collisions.recordCount,
    }
  }
  const blockRules = generation.rules.filter((rule) => rule.action === 'block')
  await tx.recordMatchKey.deleteMany({
    where: { ...tenantWhere(tenant), matchingRuleId: { in: blockRules.map((rule) => rule.id) } },
  })
  const lookupRows = await tx.recordMatchLookupKey.findMany({
    where: { ...tenantWhere(tenant), matchingRuleId: { in: blockRules.map((rule) => rule.id) } },
    select: { matchingRuleId: true, normalizedHash: true, recordId: true },
  })
  try {
    for (const row of lookupRows) await tx.recordMatchKey.create({ data: { ...tenantWhere(tenant), ...row } })
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')) throw error
    throw failure('matching_bootstrap_collision')
  }
  const changed = await tx.matchingRuleGeneration.updateMany({
    where: {
      ...tenantWhere(tenant), id: generation.id, state: 'active', keysReadyAt: null,
      bootstrapAttempt: input.attempt, bootstrapJobId: input.jobId,
    },
    data: { keysReadyAt: new Date(), activatedAt: new Date(), processedRecords: input.processed },
  })
  if (changed.count !== 1) throw failure('matching_bootstrap_generation_changed')
  const team = await tx.team.updateMany({
    where: { id: tenant.teamId, organizationId: tenant.organizationId }, data: { schemaVersion: { increment: 1 } },
  })
  if (team.count !== 1) throw failure('tenant_not_found')
  const terminalized = await terminalize(tx, tenant, input.jobId, input.workerId, { state: 'active', processed: input.processed })
  if (!terminalized) throw failure('matching_bootstrap_job_not_running')
  await audit(tx, tenant, actor, 'schema.matching_rules.bootstrap', generation.objectTypeId, input.auditMetadata)
  return { terminalized: true, state: 'active', processed: input.processed }
}
