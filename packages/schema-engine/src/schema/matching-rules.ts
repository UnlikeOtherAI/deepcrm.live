import { createHash } from 'node:crypto'

import { Prisma, canonicalJson, tenantWhere, type TenantRef, writeAudit } from '@deepcrm/db'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'
import { validateMatchingRule } from '../matching/keys.js'
export { finalizeMatchingBackfill } from './matching-backfill-finalization.js'
export { finalizeMatchingBootstrap } from './matching-bootstrap-finalization.js'
import type { AuditActor } from './mutation-types.js'
import type { SchemaTx } from './tx.js'

export type MatchingRuleInput = {
  attributes: string[]
  method: 'exact' | 'normalized' | 'fuzzy'
  threshold?: number
  action: 'block' | 'warn'
}
type TemplateMatchingRuleInput = Omit<MatchingRuleInput, 'action'> & { action: MatchingRuleInput['action'] | 'allow' }

function isMatchingRuleInput(rule: TemplateMatchingRuleInput): rule is MatchingRuleInput {
  return rule.action === 'block' || rule.action === 'warn'
}

export type MatchingRuleActivation =
  | { state: 'active'; taskId: null }
  | { state: 'pending_backfill'; taskId: string }
  | { state: 'collision_blocked'; taskId: string; group_count: number; record_count: number }

export type SetMatchingRulesResult = { rules: readonly MatchingRuleInput[]; activation: MatchingRuleActivation }
export type MatchingRulesSetInput = Readonly<{
  rules: readonly MatchingRuleInput[]
  retryBackfill?: boolean
}>

export type MatchingProvenance = Readonly<{
  runId: string
  toolCallId: string
  requestId: string
}>

export type MatchingBackfillRequest = Readonly<{
  organizationId: string
  teamId: string
  objectTypeId: string
  generationId: string
  attempt: number
  actor: AuditActor
  onBehalfOf: Readonly<{
    uoaUserId: string
    role: 'owner' | 'admin' | 'member' | null
  }>
  provenance: MatchingProvenance
  auditMetadata: MatchingAuditMetadata
}>

export type MatchingAuditMetadata = Readonly<{
  app: string
  actChain: readonly { sub: string; product: string }[]
  provenance: MatchingProvenance
}>

export type MatchingBackfillIdentity = Readonly<{
  onBehalfOf: MatchingBackfillRequest['onBehalfOf']
  auditMetadata: MatchingAuditMetadata
}>

export type MatchingBackfillFinalResult =
  | Readonly<{ terminalized: true; state: 'active'; processed: number }>
  | Readonly<{ terminalized: true; state: 'collision_blocked'; processed: number; groupCount: number; recordCount: number }>
  | Readonly<{ terminalized: false; state: 'stale' }>

function failure(detail: string): ServiceError {
  return new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Matching rule update conflicts with current schema', { detail })
}

function fingerprint(rules: readonly MatchingRuleInput[]): string {
  return createHash('sha256').update(canonicalJson(rules), 'utf8').digest('hex')
}

async function lockTopology(tx: SchemaTx, teamId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7::integer, hashtext(${`${teamId}:topology`}))`
}

async function activeObject(tx: SchemaTx, tenant: TenantRef, slug: string) {
  const objectType = await tx.objectType.findFirst({ where: { ...tenantWhere(tenant), slug, archivedAt: null } })
  if (objectType === null) throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type is not active in this tenant')
  return objectType
}

async function audit(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  action: string,
  objectTypeId: string,
  metadata: Prisma.InputJsonValue | null = null,
): Promise<void> {
  await writeAudit(tx, {
    organizationId: tenant.organizationId, teamId: tenant.teamId, actorType: actor.type, actorId: actor.id,
    onBehalfOf: actor.onBehalfOf, action, resourceType: 'object_type', resourceId: objectTypeId,
    outcome: 'success', reason: null, metadata, requestId: actor.requestId, ipAddress: null, userAgent: null,
  })
}

async function bump(tx: SchemaTx, tenant: TenantRef): Promise<void> {
  const result = await tx.team.updateMany({
    where: { id: tenant.teamId, organizationId: tenant.organizationId }, data: { schemaVersion: { increment: 1 } },
  })
  if (result.count !== 1) throw failure('tenant_not_found')
}

function backfillKey(request: MatchingBackfillRequest): string {
  return [
    'match-key-backfill', request.teamId, request.objectTypeId, request.generationId, request.attempt,
  ].join(':')
}

function queuePayload(request: MatchingBackfillRequest): Prisma.InputJsonObject {
  return {
    organizationId: request.organizationId,
    teamId: request.teamId,
    objectTypeId: request.objectTypeId,
    generationId: request.generationId,
    attempt: request.attempt,
    actor: { type: request.actor.type, id: request.actor.id },
    onBehalfOf: request.onBehalfOf,
    requestId: request.actor.requestId,
    provenance: {
      runId: request.provenance.runId,
      toolCallId: request.provenance.toolCallId,
      requestId: request.provenance.requestId,
    },
    auditMetadata: {
      app: request.auditMetadata.app,
      actChain: request.auditMetadata.actChain,
      provenance: request.auditMetadata.provenance,
    },
  }
}

async function enqueueBackfill(
  tx: SchemaTx,
  request: MatchingBackfillRequest,
): Promise<string> {
  const idempotencyKey = backfillKey(request)
  const existing = await tx.queueJob.findUnique({ where: { idempotencyKey }, select: { id: true } })
  if (existing !== null) return existing.id
  try {
    const job = await tx.queueJob.create({
      data: {
        organizationId: request.organizationId,
        teamId: request.teamId,
        type: 'match-key-backfill',
        payload: queuePayload(request),
        idempotencyKey,
      },
      select: { id: true },
    })
    return job.id
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')) throw error
    const winner = await tx.queueJob.findUnique({ where: { idempotencyKey }, select: { id: true } })
    if (winner === null) throw error
    return winner.id
  }
}

async function validate(
  tx: SchemaTx,
  tenant: TenantRef,
  objectType: Awaited<ReturnType<typeof activeObject>>,
  rules: readonly MatchingRuleInput[],
): Promise<void> {
  if (rules.length > 10) throw failure('too_many_matching_rules')
  for (const rule of rules) {
    const attributes = await tx.attribute.findMany({
      where: { ...tenantWhere(tenant), objectTypeId: objectType.id, slug: { in: rule.attributes }, archivedAt: null },
    })
    validateMatchingRule(objectType, attributes, rule)
  }
}

async function createGeneration(
  tx: SchemaTx,
  tenant: TenantRef,
  objectTypeId: string,
  rules: readonly MatchingRuleInput[],
  state: 'active' | 'pending_backfill',
  actor: AuditActor,
  provenance: MatchingProvenance | null,
) {
  const hasKeys = rules.some((rule) => rule.method === 'exact' || rule.method === 'normalized')
  const generation = await tx.matchingRuleGeneration.create({
    data: {
      ...tenantWhere(tenant), objectTypeId, state, fingerprint: fingerprint(rules),
      keysReadyAt: state === 'active' && hasKeys ? new Date() : null,
      requestId: actor.requestId,
      provenance: provenance === null ? Prisma.JsonNull : {
        runId: provenance.runId, toolCallId: provenance.toolCallId, requestId: provenance.requestId,
      },
    },
  })
  if (rules.length > 0) {
    await tx.matchingRule.createMany({
      data: rules.map((rule, position) => ({
        ...tenantWhere(tenant), objectTypeId, generationId: generation.id, position, attributeSlugs: rule.attributes,
        method: rule.method, threshold: rule.threshold ?? null, action: rule.action,
      })),
    })
  }
  return generation
}

function requestProvenance(identity: MatchingBackfillIdentity): MatchingProvenance {
  const { runId, toolCallId, requestId } = identity.auditMetadata.provenance
  if (typeof runId !== 'string' || runId.length === 0) throw failure('matching_identity_provenance_required')
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) throw failure('matching_identity_provenance_required')
  if (typeof requestId !== 'string' || requestId.length === 0) throw failure('matching_identity_provenance_required')
  return { runId, toolCallId, requestId }
}

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function generationProvenance(generation: { provenance: Prisma.JsonValue }): MatchingProvenance {
  const provenance = generation.provenance
  if (!isJsonObject(provenance)) {
    throw failure('matching_generation_provenance_missing')
  }
  const runId = provenance['runId']
  const toolCallId = provenance['toolCallId']
  const requestId = provenance['requestId']
  if (typeof runId !== 'string' || runId.length === 0) throw failure('matching_generation_provenance_missing')
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) throw failure('matching_generation_provenance_missing')
  if (typeof requestId !== 'string' || requestId.length === 0) throw failure('matching_generation_provenance_missing')
  return { runId, toolCallId, requestId }
}

function replacementActivation(generation: {
  state: 'pending_backfill' | 'collision_blocked'
  backfillJobId: string | null
  collisionGroups: number
  collisionRecords: number
}): MatchingRuleActivation {
  if (generation.backfillJobId === null) throw failure('matching_generation_job_missing')
  if (generation.state === 'pending_backfill') {
    return { state: 'pending_backfill', taskId: generation.backfillJobId }
  }
  return {
    state: 'collision_blocked',
    taskId: generation.backfillJobId,
    group_count: generation.collisionGroups,
    record_count: generation.collisionRecords,
  }
}

function checkedReplacementState(state: string): 'pending_backfill' | 'collision_blocked' {
  if (state === 'pending_backfill' || state === 'collision_blocked') return state
  throw failure('matching_generation_state_invalid')
}

async function replacementCanBeSuperseded(
  tx: SchemaTx,
  tenant: TenantRef,
  generation: { state: 'pending_backfill' | 'collision_blocked'; backfillJobId: string | null },
): Promise<boolean> {
  if (generation.state === 'collision_blocked') return true
  if (generation.backfillJobId === null) return true
  const job = await tx.queueJob.findFirst({
    where: { ...tenantWhere(tenant), id: generation.backfillJobId },
    select: { status: true },
  })
  return job === null || job.status === 'failed' || job.status === 'cancelled'
}

export async function setMatchingRules(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  objectSlug: string,
  input: MatchingRulesSetInput,
  identity?: MatchingBackfillIdentity,
): Promise<SetMatchingRulesResult> {
  const { rules, retryBackfill = false } = input
  await lockTopology(tx, tenant.teamId)
  const objectType = await activeObject(tx, tenant, objectSlug)
  await validate(tx, tenant, objectType, rules)
  const nextFingerprint = fingerprint(rules)
  const active = await tx.matchingRuleGeneration.findFirst({
    where: { ...tenantWhere(tenant), objectTypeId: objectType.id, state: 'active' },
    include: { rules: { orderBy: { position: 'asc' } } },
  })
  const replacement = await tx.matchingRuleGeneration.findFirst({
    where: {
      ...tenantWhere(tenant),
      objectTypeId: objectType.id,
      state: { in: ['pending_backfill', 'collision_blocked'] },
    },
  })
  let removedReplacement = false
  if (replacement !== null) {
    const checkedReplacement = { ...replacement, state: checkedReplacementState(replacement.state) }
    if (checkedReplacement.fingerprint === nextFingerprint) {
      if (retryBackfill) {
        if (identity === undefined) throw failure('matching_backfill_identity_required')
        const retried = await retryMatchingRules(tx, tenant, actor, replacement.id, identity)
        return { rules, activation: { state: 'pending_backfill', taskId: retried.jobId } }
      }
      return { rules, activation: replacementActivation(checkedReplacement) }
    }
    if (!(await replacementCanBeSuperseded(tx, tenant, checkedReplacement))) {
      throw failure('matching_rule_backfill_in_progress')
    }
    await tx.matchingRuleGeneration.deleteMany({
      where: { ...tenantWhere(tenant), id: replacement.id },
    })
    removedReplacement = true
  }
  if (active !== null && active.fingerprint === nextFingerprint) {
    if (removedReplacement) {
      await bump(tx, tenant)
      await audit(
        tx,
        tenant,
        actor,
        'schema.matching_rules.set',
        objectType.id,
        identity?.auditMetadata ?? null,
      )
    }
    return { rules, activation: { state: 'active', taskId: null } }
  }
  const liveRecords = await tx.record.count({
    where: { ...tenantWhere(tenant), objectTypeId: objectType.id, deletedAt: null, mergedIntoId: null },
  })
  const needsBackfill = liveRecords > 0 && rules.some((rule) => rule.method !== 'fuzzy')
  if (needsBackfill) {
    if (identity === undefined) throw failure('matching_backfill_identity_required')
    if (identity.onBehalfOf.uoaUserId !== actor.onBehalfOf) {
      throw failure('matching_identity_actor_mismatch')
    }
    const provenance = requestProvenance(identity)
    const replacement = await createGeneration(tx, tenant, objectType.id, rules, 'pending_backfill', actor, provenance)
    const request: MatchingBackfillRequest = {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      objectTypeId: objectType.id,
      generationId: replacement.id,
      attempt: 0,
      actor,
      onBehalfOf: identity.onBehalfOf,
      provenance,
      auditMetadata: identity.auditMetadata,
    }
    const taskId = await enqueueBackfill(tx, request)
    await tx.matchingRuleGeneration.update({
      where: { id: replacement.id },
      data: { backfillAttempt: request.attempt, backfillJobId: taskId },
    })
    await bump(tx, tenant)
    await audit(
      tx,
      tenant,
      actor,
      'schema.matching_rules.set',
      objectType.id,
      identity.auditMetadata,
    )
    return { rules, activation: { state: 'pending_backfill', taskId } }
  }
  if (active !== null) {
    await tx.matchingRuleGeneration.deleteMany({
      where: { ...tenantWhere(tenant), id: active.id },
    })
  }
  await createGeneration(tx, tenant, objectType.id, rules, 'active', actor, null)
  await bump(tx, tenant)
  await audit(
    tx,
    tenant,
    actor,
    'schema.matching_rules.set',
    objectType.id,
    identity?.auditMetadata ?? null,
  )
  return { rules, activation: { state: 'active', taskId: null } }
}

export async function retryMatchingRules(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  generationId: string,
  identity: MatchingBackfillIdentity,
): Promise<MatchingBackfillRequest & { jobId: string }> {
  await lockTopology(tx, tenant.teamId)
  const generation = await tx.matchingRuleGeneration.findFirst({
    where: {
      ...tenantWhere(tenant),
      id: generationId,
      state: { in: ['pending_backfill', 'collision_blocked'] },
    },
  })
  if (generation === null) throw failure('matching_generation_not_retryable')
  if (identity.onBehalfOf.uoaUserId !== actor.onBehalfOf) {
    throw failure('matching_identity_actor_mismatch')
  }
  if (generation.backfillJobId !== null) {
    const currentJob = await tx.queueJob.findFirst({
      where: { ...tenantWhere(tenant), id: generation.backfillJobId },
      select: { status: true },
    })
    if (
      generation.state === 'pending_backfill'
      && currentJob !== null
      && (currentJob.status === 'queued' || currentJob.status === 'running')
    ) {
      throw failure('matching_rule_backfill_in_progress')
    }
    if (generation.state === 'pending_backfill' && currentJob?.status === 'completed') {
      throw failure('matching_generation_completed_without_activation')
    }
  }
  const request: MatchingBackfillRequest = {
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    objectTypeId: generation.objectTypeId,
    generationId,
    attempt: generation.backfillAttempt + 1,
    actor,
    onBehalfOf: identity.onBehalfOf,
    provenance: generationProvenance(generation),
    auditMetadata: identity.auditMetadata,
  }
  const jobId = await enqueueBackfill(tx, request)
  const updated = await tx.matchingRuleGeneration.updateMany({
    where: {
      ...tenantWhere(tenant),
      id: generationId,
      backfillAttempt: generation.backfillAttempt,
      state: { in: ['pending_backfill', 'collision_blocked'] },
    },
    data: { state: 'pending_backfill', backfillAttempt: request.attempt, backfillJobId: jobId },
  })
  if (updated.count !== 1) throw failure('matching_generation_changed')
  await audit(
    tx,
    tenant,
    actor,
    'schema.matching_rules.retry',
    generation.objectTypeId,
    identity.auditMetadata,
  )
  return { ...request, jobId }
}

export async function cancelMatchingRules(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  generationId: string,
): Promise<boolean> {
  await lockTopology(tx, tenant.teamId)
  const generation = await tx.matchingRuleGeneration.findFirst({
    where: { ...tenantWhere(tenant), id: generationId, state: { in: ['pending_backfill', 'collision_blocked'] } },
  })
  if (generation === null) return false
  if (generation.backfillJobId !== null) {
    await tx.queueJob.updateMany({
      where: {
        id: generation.backfillJobId,
        organizationId: tenant.organizationId,
        teamId: tenant.teamId,
        status: { in: ['queued', 'running'] },
      },
      data: { status: 'cancelled' },
    })
  }
  await tx.matchingRuleGeneration.delete({ where: { id: generation.id } })
  await audit(tx, tenant, actor, 'schema.matching_rules.cancel', generation.objectTypeId)
  return true
}

export async function setMatchingRulesBatch(
  tx: SchemaTx,
  tenant: TenantRef,
  actor: AuditActor,
  objectSlug: string,
  rules: readonly TemplateMatchingRuleInput[],
): Promise<void> {
  const objectType = await activeObject(tx, tenant, objectSlug)
  if (rules.some((rule) => rule.action === 'allow')) throw failure('matching_rule_allow_removed')
  const parsed = rules.filter(isMatchingRuleInput)
  await validate(tx, tenant, objectType, parsed)
  const existing = await tx.matchingRuleGeneration.findFirst({
    where: { ...tenantWhere(tenant), objectTypeId: objectType.id }, select: { id: true },
  })
  if (existing !== null) return
  await createGeneration(tx, tenant, objectType.id, parsed, 'active', actor, null)
}
