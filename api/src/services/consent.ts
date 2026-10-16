import { createHash } from 'node:crypto'
import { canonicalJson, tenantWhere, type Db } from '@deepcrm/db'
import type { QueueEnqueueTx } from '@deepcrm/queue'
import {
  createRecord as engineCreateRecord,
  findUniqueRecord,
  lockKeys,
  updateRecord as engineUpdateRecord,
  type RecordTx,
  type RecordWriteResult,
} from '@deepcrm/schema-engine'
import {
  ConsentSource,
  ConsentState,
  CrmConsentSet,
  ErrorCode,
  isSubjectActor,
  onBehalfOfUserId,
  requireOnBehalfOf,
  ServiceError,
  type ActorContext,
  type CrmConsentGetInput,
  type CrmConsentGetOutput,
  type CrmConsentSetInput,
  type CrmConsentSetOutput,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { checkPolicy, type PolicyRequest } from './policy.js'
import { createConsentData, consentPatch, type ConsentCaller } from './consent-data.js'
import { applyConsentSuppression, emailSuppressed, type ConsentSuppressionChange } from './consent-suppression.js'
import { normalizedEmail, resolveConsentTarget, type ConsentTarget } from './consent-target.js'
import { validateActorReferences } from './principals.js'
import { enqueueRecordMutationEffects } from './record-mutation-effects.js'
import { findVisibleRecord, redactInvisibleDuplicate, type VisibleRecord } from './record-visibility.js'
import {
  attributePolicies,
  authorizeRecordWrite,
  objectIdScopes,
  recordAuditMetadata,
  recordPolicy,
  recordScopes,
  writeRecordDeniedAudit,
} from './record-write-authorization.js'

const TOOL = 'crm_consent_set'
// An act cannot be dated later than now: a future `at` would freeze the state.
const FUTURE_SKEW_MS = 60_000
type ConsentTx = RecordTx & QueueEnqueueTx & Pick<Db, 'webhook' | 'list' | 'suppressionEntry' | 'record'>
type StoredConsent = { state: ConsentState | null; at: string | null; source: ConsentSource | null }
type SetPlan = {
  input: CrmConsentSetInput
  caller: ConsentCaller
  target: ConsentTarget
  email: { value: string; hash: string }
  at: string
}

function callerOf(ctx: ActorContext): ConsentCaller {
  if (isSubjectActor(ctx)) return 'subject'
  return ctx.actor.type === 'agent' ? 'agent' : 'person'
}

function storedConsent(consent: ConsentTarget, data: unknown): StoredConsent {
  const values = typeof data === 'object' && data !== null && !Array.isArray(data)
    ? new Map(Object.entries(data)) : new Map<string, unknown>()
  const state = ConsentState.safeParse(values.get(consent.state.slug))
  const at = values.get(consent.at.slug)
  const source = ConsentSource.safeParse(values.get(consent.source.slug))
  return {
    state: state.success ? state.data : null,
    at: typeof at === 'string' ? at : null,
    source: source.success ? source.data : null,
  }
}

// Only a newer act is written. Consent writes for one address arrive
// unordered and late, so `at` alone decides: an older or equal `at` never
// replaces the stored consent, whatever state it carries.
function supersedes(stored: StoredConsent, at: string): boolean {
  if (stored.state === null || stored.at === null) return true
  return Date.parse(at) > Date.parse(stored.at)
}

// A subject's `not_confirmed` is an unverified act (anyone can type an address
// into a form): it never replaces `declined` and never lifts an opt-out. Only a
// confirmed act, or a person's decision, does.
function unverifiedOverDeclined(plan: SetPlan, stored: StoredConsent): boolean {
  return plan.caller === 'subject' && plan.input.state === 'not_confirmed' && stored.state === 'declined'
}

function liftsOptOut(plan: SetPlan): boolean {
  return !(plan.caller === 'subject' && plan.input.state === 'not_confirmed')
}

function refuseAgentConfirmation(): ServiceError {
  return new ServiceError(ErrorCode.POLICY_DENIED, 'An agent may record only declined marketing consent', {
    resource: 'record', action: 'edit',
  })
}

function argumentsHash(input: CrmConsentSetInput): string {
  const args = Object.fromEntries(Object.entries(input).filter(([key, value]) => (
    value !== undefined && key !== 'idempotency_key'
  )))
  return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex')
}

// Replays are bound to the principal they were made for: the person, or for a
// subject-attested call the app's subject actor (no person acts there).
function replayPrincipal(ctx: ActorContext): string {
  return isSubjectActor(ctx) ? ctx.actor.id : requireOnBehalfOf(ctx).uoaUserId
}

type Reservation = { kind: 'none' } | { kind: 'replay'; result: CrmConsentSetOutput } | { kind: 'reserved'; id: string }

async function reserve(tx: ConsentTx, ctx: ActorContext, input: CrmConsentSetInput): Promise<Reservation> {
  const key = input.idempotency_key
  if (key === undefined) return { kind: 'none' }
  const principalUserId = replayPrincipal(ctx)
  const lock = [ctx.tenant.teamId, principalUserId, TOOL, key].join(':')
  const locks = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock(6::integer, hashtext(${lock})) AS locked
  `
  if (locks[0]?.locked !== true) {
    throw new ServiceError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'Idempotent operation is in progress')
  }
  const hash = argumentsHash(input)
  const where = { ...tenantWhere(ctx.tenant), principalUserId, tool: TOOL, key }
  const existing = await tx.idempotencyReplay.findFirst({ where })
  if (existing !== null) {
    if (existing.argumentsHash !== hash) {
      throw new ServiceError(ErrorCode.IDEMPOTENCY_MISMATCH, 'Idempotency key arguments do not match')
    }
    if (existing.result === null) {
      throw new ServiceError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'Idempotent operation is in progress')
    }
    return { kind: 'replay', result: CrmConsentSet.out.parse(existing.result) }
  }
  const created = await tx.idempotencyReplay.create({
    data: { ...tenantWhere(ctx.tenant), principalUserId, tool: TOOL, key, argumentsHash: hash },
    select: { id: true },
  })
  return { kind: 'reserved', id: created.id }
}

async function storeReplay(
  tx: ConsentTx, ctx: ActorContext, reservation: Reservation, result: CrmConsentSetOutput,
): Promise<void> {
  if (reservation.kind !== 'reserved') return
  const updated = await tx.idempotencyReplay.updateMany({
    where: { ...tenantWhere(ctx.tenant), id: reservation.id }, data: { result },
  })
  if (updated.count !== 1) throw new ServiceError(ErrorCode.INTERNAL, 'Idempotency result was not stored')
}

// A person or agent reaches only a record they may see; an invisible match
// reads exactly like no match (no existence oracle), and a `create` against
// it meets the unique key as a redacted DUPLICATE_FOUND.
async function authorizeEdit(
  deps: AppDeps, ctx: ActorContext, plan: SetPlan, recordId: string,
): Promise<'visible' | 'invisible'> {
  if (plan.caller === 'subject') return 'visible'
  const visible = await findVisibleRecord(deps.db, ctx, recordId)
  if (visible === null) return 'invisible'
  const scopes = recordScopes(ctx, visible)
  await authorizeRecordWrite(deps, ctx, { tool: TOOL, reason: plan.input.reason, resourceId: recordId }, [
    recordPolicy('edit', scopes),
    ...attributePolicies(plan.target.schema, plan.target.objectType.id, consentPatch(plan.target, plan), scopes),
  ])
  return 'visible'
}

async function authorizeCreate(
  deps: AppDeps, ctx: ActorContext, plan: SetPlan, data: Record<string, unknown>,
): Promise<void> {
  if (plan.caller === 'subject') return
  const scopes = objectIdScopes(ctx, plan.target.objectType.id)
  await authorizeRecordWrite(deps, ctx, { tool: TOOL, reason: plan.input.reason, resourceId: null }, [
    recordPolicy('create', scopes),
    ...attributePolicies(plan.target.schema, plan.target.objectType.id, data, scopes),
  ])
  await validateActorReferences(deps.db, ctx, plan.target.schema, { objectType: plan.target.objectType.slug, data })
}

type ConsentOutcome = {
  kind: 'written' | 'kept' | 'no_record'
  recordId: string | null
  created: boolean
  previous: ConsentState | null
}

async function auditConsent(
  deps: AppDeps, tx: ConsentTx, ctx: ActorContext, plan: SetPlan,
  outcome: ConsentOutcome, suppression: ConsentSuppressionChange,
): Promise<void> {
  await deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: onBehalfOfUserId(ctx),
    action: TOOL,
    resourceType: 'record',
    resourceId: outcome.recordId,
    outcome: 'success',
    reason: plan.input.reason ?? null,
    metadata: {
      ...recordAuditMetadata(ctx),
      consent: outcome.kind, state: plan.input.state, previousState: outcome.previous,
      source: plan.input.source, at: plan.at, created: outcome.created, suppression,
    },
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  })
}

// An objection holds whatever order the acts arrive in: `declined` is always
// suppressed, even when the record keeps a newer state or there is no record.
async function suppressDecline(
  tx: ConsentTx, ctx: ActorContext, plan: SetPlan, recordId: string | null,
): Promise<ConsentSuppressionChange> {
  if (plan.input.state !== 'declined') return 'none'
  return applyConsentSuppression(tx, ctx, plan.email.value, 'declined', recordId)
}

async function finishWrite(
  deps: AppDeps, tx: ConsentTx, ctx: ActorContext, plan: SetPlan,
  written: RecordWriteResult, previous: ConsentState | null,
): Promise<CrmConsentSetOutput> {
  const recordId = written.record.id
  const suppression: ConsentSuppressionChange = plan.input.state === 'declined' || liftsOptOut(plan)
    ? await applyConsentSuppression(tx, ctx, plan.email.value, plan.input.state, recordId)
    : 'none'
  if (written.changed) await enqueueRecordMutationEffects(tx, ctx, written.sequences, written.touchedRecordIds)
  await auditConsent(deps, tx, ctx, plan, { kind: 'written', recordId, created: written.created, previous }, suppression)
  return {
    record_id: recordId,
    created: written.created,
    state: plan.input.state,
    previous_state: previous,
    at: plan.at,
    suppressed: await emailSuppressed(tx, ctx, plan.email.value),
  }
}

async function writeMatched(
  deps: AppDeps, tx: ConsentTx, ctx: ActorContext, plan: SetPlan, recordId: string,
): Promise<CrmConsentSetOutput> {
  if (await authorizeEdit(deps, ctx, plan, recordId) === 'invisible') return writeUnmatched(deps, tx, ctx, plan)
  const row = await tx.record.findFirst({ where: { ...tenantWhere(ctx.tenant), id: recordId }, select: { data: true } })
  if (row === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const stored = storedConsent(plan.target, row.data)
  const kept = stored.state !== null
    && (!supersedes(stored, plan.at) || unverifiedOverDeclined(plan, stored))
  if (kept && stored.state !== null) {
    const suppression = await suppressDecline(tx, ctx, plan, recordId)
    await auditConsent(deps, tx, ctx, plan, { kind: 'kept', recordId, created: false, previous: stored.state },
      suppression)
    return {
      record_id: recordId, created: false, state: stored.state, previous_state: stored.state,
      at: stored.at ?? plan.at, suppressed: await emailSuppressed(tx, ctx, plan.email.value),
    }
  }
  const written = await engineUpdateRecord(tx, ctx, plan.target.schema, {
    recordId, data: consentPatch(plan.target, plan), reason: plan.input.reason, originRequirement: 'waived',
  }, deps.linkWriter)
  return finishWrite(deps, tx, ctx, plan, written, stored.state)
}

async function writeUnmatched(
  deps: AppDeps, tx: ConsentTx, ctx: ActorContext, plan: SetPlan,
): Promise<CrmConsentSetOutput> {
  const create = plan.input.create
  if (create === undefined) {
    const suppression = await suppressDecline(tx, ctx, plan, null)
    await auditConsent(deps, tx, ctx, plan, { kind: 'no_record', recordId: null, created: false, previous: null },
      suppression)
    return {
      record_id: null, created: false, state: plan.input.state, previous_state: null, at: plan.at,
      suppressed: await emailSuppressed(tx, ctx, plan.email.value),
    }
  }
  const data = createConsentData(plan, create.data ?? {})
  await authorizeCreate(deps, ctx, plan, data)
  // A subject's own act declares where the person came from, so a team that
  // requires an origin still takes it; a colleague's create declares none.
  const origin = plan.caller === 'subject' ? { origin: ctx.actor.id } : {}
  const written = await engineCreateRecord(tx, ctx, plan.target.schema, {
    objectType: plan.target.objectType.slug, data, reason: plan.input.reason, ...origin,
  }, deps.linkWriter)
  return finishWrite(deps, tx, ctx, plan, written, null)
}

// A subject sees no record: a duplicate it collides with is named by neither
// id nor candidates. A person gets the usual visibility-redacted form.
async function consentBoundary<T>(
  deps: AppDeps, ctx: ActorContext, operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ServiceError && error.code === ErrorCode.DUPLICATE_FOUND) {
      if (!isSubjectActor(ctx)) return redactInvisibleDuplicate(deps.db, ctx, error)
      throw new ServiceError(error.code, error.message, { attribute: error.details['attribute'] })
    }
    if (error instanceof ServiceError) throw error
    throw new ServiceError(ErrorCode.INTERNAL, 'Consent operation failed', { correlation_id: deps.ids() })
  }
}

/**
 * Records the marketing consent state of the person holding `email`
 * (schema-engine §4d′): matched on the email attribute's unique key, created
 * only when `create` is given, written only when the act supersedes the
 * stored one, with the opt-out suppression kept in step — record changes,
 * suppression and audit in one transaction.
 */
export async function setConsent(
  deps: AppDeps, ctx: ActorContext, input: CrmConsentSetInput,
): Promise<CrmConsentSetOutput> {
  const caller = callerOf(ctx)
  if (caller === 'agent' && input.state !== 'declined') {
    await writeRecordDeniedAudit(deps, ctx, { tool: TOOL, reason: input.reason, resourceId: null })
    throw refuseAgentConfirmation()
  }
  if (caller === 'person' && input.state === 'confirmed' && input.reason === undefined) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Recording consent needs a reason', {
      issues: [{ path: '/reason', message: 'say where the consent came from when a person records confirmed' }],
    })
  }
  const at = new Date(input.at ?? ctx.now.toISOString())
  if (at.getTime() > ctx.now.getTime() + FUTURE_SKEW_MS) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Consent time is in the future', {
      issues: [{ path: '/at', message: 'must not be later than now (60 seconds of clock skew allowed)' }],
    })
  }
  const target = await resolveConsentTarget(deps, ctx, input.object_type)
  const plan: SetPlan = { input, caller, target, email: normalizedEmail(target, input.email), at: at.toISOString() }
  return consentBoundary(deps, ctx, () => deps.db.$transaction(async (tx) => {
    const reservation = await reserve(tx, ctx, input)
    if (reservation.kind === 'replay') return reservation.result
    await lockKeys(tx, ctx.tenant.teamId, [`${target.email.id}:${plan.email.hash}`])
    const recordId = await findUniqueRecord(tx, ctx.tenant, target.email.id, plan.email.hash)
    const result = recordId === null
      ? await writeUnmatched(deps, tx, ctx, plan)
      : await writeMatched(deps, tx, ctx, plan, recordId)
    await storeReplay(tx, ctx, reservation, result)
    return result
  }))
}

async function authorizeRead(
  deps: AppDeps, ctx: ActorContext, consent: ConsentTarget, record: VisibleRecord | null,
): Promise<void> {
  const scopes = record === null ? objectIdScopes(ctx, consent.objectType.id) : recordScopes(ctx, record)
  const requests: PolicyRequest[] = [
    { resourceType: 'record', action: 'view', scopes },
    ...[consent.state, consent.at, consent.source].flatMap((attribute) => (
      attribute.sensitivity === 'confidential' || attribute.sensitivity === 'restricted'
        ? [{ resourceType: 'attribute' as const, action: 'view' as const, scopes, sensitivity: attribute.sensitivity }]
        : []
    )),
  ]
  for (const request of requests) {
    const decision = await checkPolicy(deps.db, ctx, request)
    if (!decision.allowed || decision.requiresApproval) {
      throw new ServiceError(ErrorCode.POLICY_DENIED, 'Consent is not readable by this caller', {
        resource: request.resourceType, action: request.action,
      })
    }
  }
}

/**
 * Reads the marketing consent of the person holding `email`. A record the
 * caller cannot see reads as no record; a subject-attested call reads the
 * subject's own fact regardless of record visibility.
 */
export async function getConsent(
  deps: AppDeps, ctx: ActorContext, input: CrmConsentGetInput,
): Promise<CrmConsentGetOutput> {
  const caller = callerOf(ctx)
  const target = await resolveConsentTarget(deps, ctx, input.object_type)
  const email = normalizedEmail(target, input.email)
  const recordId = await findUniqueRecord(deps.db, ctx.tenant, target.email.id, email.hash)
  const record = recordId === null ? null
    : caller === 'subject' ? { id: recordId, objectTypeId: target.objectType.id }
      : await findVisibleRecord(deps.db, ctx, recordId)
  if (caller !== 'subject') await authorizeRead(deps, ctx, target, record)
  const row = record === null ? null : await deps.db.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: record.id }, select: { data: true },
  })
  const stored = row === null ? null : storedConsent(target, row.data)
  return {
    record_id: row === null || record === null ? null : record.id,
    state: stored?.state ?? null,
    at: stored?.at ?? null,
    source: stored?.source ?? null,
    suppressed: await emailSuppressed(deps.db, ctx, email.value),
  }
}
