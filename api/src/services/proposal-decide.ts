import { tenantWhere, type AuditTx, type Prisma } from '@deepcrm/db'
import { loadSchema, lockKeys, lockLinkTopology, type LoadedSchema } from '@deepcrm/schema-engine'
import {
  ErrorCode,
  ServiceError,
  SourceRef,
  requireOnBehalfOf,
  type ActorContext,
  type CrmProposalDecideInput,
  type CrmProposalDecideOutput,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { normalizeSubmission, submittedValues, type Submission } from './intake-submission.js'
import { resolveIntakeTarget, type IntakeTarget } from './intake-target.js'
import {
  createPerson, pairWithRecord, sourceReason, type IntakeLog, type IntakeTrail, type IntakeTx,
} from './intake-write.js'
import type { PolicyRequest } from './policy.js'
import { PendingSubmission } from './proposal-store.js'
import { recordBoundary } from './record-boundary.js'
import { createInlineLinkAuthorizer, preflightInlineLinks } from './record-inline-links.js'
import { enqueueRecordMutationEffects } from './record-mutation-effects.js'
import { requireVisibleRecord } from './record-visibility.js'
import {
  attributePolicies, authorizeRecordWrite, objectIdScopes, objectScopes, recordAuditMetadata, recordPolicy,
  recordScopes,
} from './record-write-authorization.js'
import { updateRecordWithIntegration } from './records.js'

const TOOL = 'crm_proposal_decide'
const TRANSACTION = { timeout: 30_000 }

type ProposalRow = Prisma.RecordProposalGetPayload<Record<string, never>>

function notPending(): ServiceError {
  return new ServiceError(ErrorCode.NOT_FOUND, 'Pending proposal not found')
}

function sourceOf(row: ProposalRow): SourceRef {
  return SourceRef.parse({ kind: row.sourceKind, id: row.sourceId, name: row.sourceName })
}

/**
 * Settles a pending proposal in the caller's transaction, as the deciding
 * person, with its audit row; a proposal another decision settled first is
 * `NOT_FOUND`, and the whole transaction rolls back.
 */
async function settle(
  deps: AppDeps, tx: AuditTx, ctx: ActorContext, row: ProposalRow,
  status: 'approved' | 'rejected', recordId: string | null, reason: string | undefined,
): Promise<void> {
  const resolver = requireOnBehalfOf(ctx).uoaUserId
  const updated = await tx.$executeRaw`
    UPDATE record_proposals
    SET status = ${status}::"ApprovalStatus", resolver_uoa_user_id = ${resolver},
        resolved_at = ${ctx.now}, resolved_record_id = ${recordId}::uuid
    WHERE organization_id = ${ctx.tenant.organizationId}::uuid AND team_id = ${ctx.tenant.teamId}::uuid
      AND id = ${row.id}::uuid AND status = 'pending'::"ApprovalStatus"
  `
  if (updated !== 1) throw notPending()
  await deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: resolver,
    action: status === 'approved' ? 'proposal.approved' : 'proposal.rejected',
    resourceType: 'record_proposal',
    resourceId: row.id,
    outcome: 'success',
    reason: reason ?? null,
    metadata: {
      ...recordAuditMetadata(ctx), kind: row.kind, record_id: recordId ?? row.recordId,
      attribute: row.attributeSlug, source: { kind: row.sourceKind, id: row.sourceId, name: row.sourceName },
    },
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  })
}

async function approveAmendment(
  deps: AppDeps, ctx: ActorContext, row: ProposalRow, input: CrmProposalDecideInput,
): Promise<CrmProposalDecideOutput> {
  if (row.recordId === null || row.attributeSlug === null) throw new ServiceError(ErrorCode.INTERNAL, 'Amendment is incomplete')
  const recordId = row.recordId
  const record = await requireVisibleRecord(deps.db, ctx, recordId)
  const live = await deps.db.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: record.id, deletedAt: null, mergedIntoId: null, erasedAt: null },
    select: { version: true },
  })
  if (live === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  if (input.expected_version !== undefined && input.expected_version !== live.version) {
    throw new ServiceError(ErrorCode.VERSION_CONFLICT, 'Record version does not match', { current: live.version })
  }
  // The version read here guards the write: a change in between is VERSION_CONFLICT.
  await updateRecordWithIntegration(deps, ctx, {
    recordId, data: { [row.attributeSlug]: row.proposed }, expectedVersion: live.version,
    reason: input.reason ?? sourceReason(sourceOf(row)),
  }, { tool: TOOL, afterWrite: (tx) => settle(deps, tx, ctx, row, 'approved', recordId, input.reason) })
  return { id: row.id, status: 'approved', record_id: recordId }
}

async function reject(
  deps: AppDeps, ctx: ActorContext, row: ProposalRow, input: CrmProposalDecideInput,
): Promise<CrmProposalDecideOutput> {
  const request = row.recordId === null
    ? recordPolicy('create', objectIdScopes(ctx, row.objectTypeId))
    : recordPolicy('edit', recordScopes(ctx, await requireVisibleRecord(deps.db, ctx, row.recordId)))
  await authorizeRecordWrite(deps, ctx, { tool: TOOL, reason: input.reason, resourceId: row.recordId }, [request])
  await deps.db.$transaction((tx) => settle(deps, tx, ctx, row, 'rejected', null, input.reason))
  return { id: row.id, status: 'rejected', record_id: null }
}

function valuesData(target: IntakeTarget, submission: Submission): Record<string, unknown> {
  return Object.fromEntries(submittedValues(target, submission).map(([attribute, value]) => [attribute.slug, value]))
}

function logRequests(ctx: ActorContext, schema: LoadedSchema, log: IntakeLog): PolicyRequest[] {
  return [
    recordPolicy('create', objectScopes(ctx, schema, 'activity')),
    ...(log.note === null ? [] : [recordPolicy('create', objectScopes(ctx, schema, 'note'))]),
  ]
}

async function authorizeMatch(
  deps: AppDeps, ctx: ActorContext, target: IntakeTarget, submission: Submission, log: IntakeLog,
  pairWith: string | undefined,
): Promise<void> {
  const data = valuesData(target, submission)
  const descriptor = { tool: TOOL, reason: undefined, resourceId: pairWith ?? null }
  if (pairWith === undefined) {
    const scopes = objectIdScopes(ctx, target.objectType.id)
    await authorizeRecordWrite(deps, ctx, descriptor, [
      recordPolicy('create', scopes), ...attributePolicies(target.schema, target.objectType.id, data, scopes),
      ...logRequests(ctx, target.schema, log),
    ])
    return
  }
  const record = await requireVisibleRecord(deps.db, ctx, pairWith)
  if (record.objectTypeId !== target.objectType.id) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Proposal decision is invalid', {
      issues: [{ path: '/record_id', message: `must be a ${target.objectType.slug} record` }],
    })
  }
  const scopes = recordScopes(ctx, record)
  await authorizeRecordWrite(deps, ctx, descriptor, [
    recordPolicy('edit', scopes), ...attributePolicies(target.schema, target.objectType.id, data, scopes),
    ...logRequests(ctx, target.schema, log),
  ])
  await preflightInlineLinks(deps.db, ctx, target.schema, [
    { relationType: 'activity_about', toRecordId: pairWith },
    ...(log.note === null ? [] : [{ relationType: 'note_about', toRecordId: pairWith }]),
  ])
}

async function approveMatch(
  deps: AppDeps, ctx: ActorContext, row: ProposalRow, input: CrmProposalDecideInput,
): Promise<CrmProposalDecideOutput> {
  const schema = await loadSchema(deps.db, ctx.tenant)
  const objectType = schema.objectTypesById.get(row.objectTypeId)
  if (objectType === undefined) throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Unknown object type')
  const stored = PendingSubmission.parse(row.proposed)
  const target = await resolveIntakeTarget(deps, ctx, {
    objectType: objectType.slug, consent: false, phone: stored.phone !== undefined,
  })
  const submission = normalizeSubmission(target, { email: stored.email, phone: stored.phone, data: stored.data })
  const log: IntakeLog = { activity: stored.activity, note: stored.note }
  await authorizeMatch(deps, ctx, target, submission, log, input.record_id)
  const source = sourceOf(row)
  return recordBoundary(deps.db, deps.ids, ctx, () => deps.db.$transaction(async (tx: IntakeTx) => {
    await lockLinkTopology(tx, ctx.tenant.teamId)
    await lockKeys(tx, ctx.tenant.teamId, [
      ...(submission.email === null ? [] : [`${target.email.id}:${submission.email.hash}`]),
      ...(submission.phone === null || target.phone === null ? [] : [`${target.phone.id}:phone:${submission.phone.hash}`]),
    ])
    const trail: IntakeTrail = { sequences: [], touched: [] }
    const writer = {
      deps, tx, ctx, target, source, origin: row.requesterId, reason: input.reason ?? sourceReason(source),
      inlineLinkAuthorizer: await createInlineLinkAuthorizer(tx, ctx, target.schema),
      proposal: {
        source, requester: { type: row.requesterType, id: row.requesterId }, requestId: ctx.requestId,
        objectTypeId: target.objectType.id,
      },
    }
    const recordId = input.record_id === undefined
      ? (await createPerson(writer, submission, log, null, trail)).recordId
      : (await pairWithRecord(writer, input.record_id, submission, log, null, trail), input.record_id)
    if (trail.sequences.length > 0) {
      await enqueueRecordMutationEffects(tx, ctx, trail.sequences, [...new Set(trail.touched)].sort())
    }
    await deps.writeAudit(tx, {
      organizationId: ctx.tenant.organizationId, teamId: ctx.tenant.teamId,
      actorType: ctx.actor.type, actorId: ctx.actor.id, onBehalfOf: requireOnBehalfOf(ctx).uoaUserId,
      action: TOOL, resourceType: 'record', resourceId: recordId, outcome: 'success', reason: input.reason ?? null,
      metadata: { ...recordAuditMetadata(ctx), proposal: row.id, created: input.record_id === undefined },
      requestId: ctx.requestId, ipAddress: null, userAgent: null,
    })
    await settle(deps, tx, ctx, row, 'approved', recordId, input.reason)
    return { id: row.id, status: 'approved' as const, record_id: recordId }
  }, TRANSACTION))
}

/**
 * Decides one pending proposal as the calling person (schema-engine §4d″):
 * approving an amendment writes its value; approving a match pairs the
 * submission with `record_id` or creates the person; rejecting writes
 * nothing to the record. Policy, visibility and history are those of the
 * equivalent human writes.
 */
export async function decideProposal(
  deps: AppDeps, ctx: ActorContext, input: CrmProposalDecideInput,
): Promise<CrmProposalDecideOutput> {
  requireOnBehalfOf(ctx)
  const row = await deps.db.recordProposal.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: input.id, status: 'pending' },
  })
  if (row === null) throw notPending()
  if (row.kind === 'amendment' && input.record_id !== undefined) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Proposal decision is invalid', {
      issues: [{ path: '/record_id', message: 'only approving a match names a record' }],
    })
  }
  if (input.decision === 'reject') return reject(deps, ctx, row, input)
  return row.kind === 'amendment' ? approveAmendment(deps, ctx, row, input) : approveMatch(deps, ctx, row, input)
}
