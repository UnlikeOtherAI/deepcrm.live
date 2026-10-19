import { createHash } from 'node:crypto'

import { canonicalJson, tenantWhere } from '@deepcrm/db'
import { lockKeys, lockLinkTopology } from '@deepcrm/schema-engine'
import {
  CrmIntakeSubmit,
  ErrorCode,
  isSubjectActor,
  ServiceError,
  type ActorContext,
  type CrmIntakeSubmitInput,
  type CrmIntakeSubmitOutput,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { consentAt, type ConsentAct } from './consent-act.js'
import type { ConsentSuppressionChange } from './consent-suppression.js'
import { isEmptyValue, normalizeSubmission, submittedValues, type Submission } from './intake-submission.js'
import { resolveIntakeTarget, type IntakeTarget } from './intake-target.js'
import {
  activelyMatched, consentWithoutPairing, createPerson, emailHolder, findCandidates, pairWithRecord, sourceReason,
  type ConsentOutcome, type IntakeLog, type IntakeTrail, type IntakeTx, type IntakeWriter,
} from './intake-write.js'
import { proposeMatch, type PendingSubmission } from './proposal-store.js'
import { enqueueRecordMutationEffects } from './record-mutation-effects.js'
import { recordAuditMetadata, writeRecordDeniedAudit } from './record-write-authorization.js'

const TOOL = 'crm_intake_submit'
// Several engine writes in one commit (person, activity, note, proposals).
const TRANSACTION = { timeout: 30_000 }

type Reservation = { kind: 'none' } | { kind: 'replay'; result: CrmIntakeSubmitOutput } | { kind: 'reserved'; id: string }

type Outcome = {
  result: CrmIntakeSubmitOutput
  filled: string[]
  added: string[]
  amendments: number
  candidates: number
  consent: ConsentOutcome
  suppression: ConsentSuppressionChange
}

function argumentsHash(input: CrmIntakeSubmitInput): string {
  const args = Object.fromEntries(Object.entries(input).filter(([key, value]) => (
    value !== undefined && key !== 'idempotency_key'
  )))
  return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex')
}

// Replays are bound to the app's subject actor: no person acts here.
async function reserve(tx: IntakeTx, ctx: ActorContext, input: CrmIntakeSubmitInput): Promise<Reservation> {
  const key = input.idempotency_key
  if (key === undefined) return { kind: 'none' }
  const principalUserId = ctx.actor.id
  const lock = [ctx.tenant.teamId, principalUserId, TOOL, key].join(':')
  const locks = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock(6::integer, hashtext(${lock})) AS locked
  `
  if (locks[0]?.locked !== true) throw new ServiceError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'Idempotent operation is in progress')
  const hash = argumentsHash(input)
  const where = { ...tenantWhere(ctx.tenant), principalUserId, tool: TOOL, key }
  const existing = await tx.idempotencyReplay.findFirst({ where })
  if (existing !== null) {
    if (existing.argumentsHash !== hash) {
      throw new ServiceError(ErrorCode.IDEMPOTENCY_MISMATCH, 'Idempotency key arguments do not match')
    }
    if (existing.result === null) throw new ServiceError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'Idempotent operation is in progress')
    return { kind: 'replay', result: CrmIntakeSubmit.out.parse(existing.result) }
  }
  const created = await tx.idempotencyReplay.create({
    data: { ...where, argumentsHash: hash }, select: { id: true },
  })
  return { kind: 'reserved', id: created.id }
}

function invalid(path: string, message: string): ServiceError {
  return new ServiceError(ErrorCode.VALIDATION_FAILED, 'Submission is invalid', { issues: [{ path, message }] })
}

function log(input: CrmIntakeSubmitInput): IntakeLog {
  return {
    activity: {
      kind: input.activity.kind, occurred_at: new Date(input.activity.occurred_at).toISOString(),
      subject: input.activity.subject, ...(input.activity.body === undefined ? {} : { body: input.activity.body }),
    },
    note: input.note === undefined ? null : {
      body: input.note.body, ...(input.note.title === undefined ? {} : { title: input.note.title }),
    },
  }
}

/** The submission as a pending match stores it: normalised values and what it would log. */
function pendingSubmission(target: IntakeTarget, submission: Submission, intakeLog: IntakeLog): PendingSubmission {
  return {
    ...(submission.email === null ? {} : { email: submission.email.value }),
    ...(submission.phone === null ? {} : { phone: submission.phone.value }),
    data: submission.data,
    values: Object.fromEntries(submittedValues(target, submission)
      .map(([attribute, value]) => [attribute.slug, value])),
    activity: intakeLog.activity,
    note: intakeLog.note,
  }
}

async function write(
  writer: IntakeWriter, submission: Submission, intakeLog: IntakeLog, act: ConsentAct | null, trail: IntakeTrail,
): Promise<Outcome> {
  const { tx, ctx, target } = writer
  const keys = [
    ...(submission.email === null ? [] : [`${target.email.id}:${submission.email.hash}`]),
    ...(submission.phone === null || target.phone === null ? [] : [`${target.phone.id}:phone:${submission.phone.hash}`]),
  ]
  await lockKeys(tx, ctx.tenant.teamId, keys)
  const candidates = await findCandidates(tx, ctx, target, submission)
  const holder = emailHolder(candidates)
  const [only, second] = candidates
  if (only === undefined) {
    const created = await createPerson(writer, submission, intakeLog, act, trail)
    return {
      result: { outcome: 'created', record_id: created.recordId }, filled: [], added: [], amendments: 0,
      candidates: 0,
      consent: created.consent, suppression: created.suppression,
    }
  }
  if (second === undefined && activelyMatched(only)) {
    const consent = act === null ? null : { act, heldBefore: holder === only.record_id }
    const paired = await pairWithRecord(writer, only.record_id, submission, intakeLog, consent, trail)
    return {
      result: { outcome: 'paired', record_id: only.record_id }, filled: paired.filled, added: paired.added,
      amendments: paired.amendments, candidates: 1, consent: paired.consent, suppression: paired.suppression,
    }
  }
  await proposeMatch(tx, ctx, writer.proposal, pendingSubmission(target, submission, intakeLog), candidates)
  const consent = act === null ? { consent: 'none' as const, suppression: 'none' as const }
    : await consentWithoutPairing(writer, holder, act, trail)
  return {
    result: { outcome: 'pending', record_id: null }, filled: [], added: [], amendments: 0,
    candidates: candidates.length,
    ...consent,
  }
}

async function audit(
  deps: AppDeps, tx: IntakeTx, ctx: ActorContext, input: CrmIntakeSubmitInput, outcome: Outcome,
): Promise<void> {
  await deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: null,
    action: TOOL,
    resourceType: 'record',
    resourceId: outcome.result.record_id,
    outcome: 'success',
    reason: null,
    metadata: {
      ...recordAuditMetadata(ctx),
      outcome: outcome.result.outcome,
      source: { kind: input.source.kind, id: input.source.id, name: input.source.name },
      filled: outcome.filled, added: outcome.added, amendments: outcome.amendments, candidates: outcome.candidates,
      consent: outcome.consent, suppression: outcome.suppression,
    },
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  })
}

// The subject sees no record: a unique collision names neither a record nor
// candidates, and an unexpected failure only its correlation id.
async function boundary<T>(deps: AppDeps, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ServiceError && error.code === ErrorCode.DUPLICATE_FOUND) {
      throw new ServiceError(error.code, error.message, { attribute: error.details['attribute'] })
    }
    if (error instanceof ServiceError) throw error
    throw new ServiceError(ErrorCode.INTERNAL, 'Intake operation failed', { correlation_id: deps.ids() })
  }
}

function target(deps: AppDeps, ctx: ActorContext, input: CrmIntakeSubmitInput): Promise<IntakeTarget> {
  return resolveIntakeTarget(deps, ctx, {
    objectType: input.object_type, consent: input.consent !== undefined,
    phone: input.phone !== undefined && !isEmptyValue(input.phone),
  })
}

async function commit(
  deps: AppDeps, tx: IntakeTx, ctx: ActorContext, input: CrmIntakeSubmitInput, resolved: IntakeTarget,
  submission: Submission, intakeLog: IntakeLog, act: ConsentAct | null,
): Promise<CrmIntakeSubmitOutput> {
  const reservation = await reserve(tx, ctx, input)
  if (reservation.kind === 'replay') return reservation.result
  await lockLinkTopology(tx, ctx.tenant.teamId)
  const trail: IntakeTrail = { sequences: [], touched: [] }
  const writer: IntakeWriter = {
    deps, tx, ctx, target: resolved, source: input.source, origin: ctx.actor.id, reason: sourceReason(input.source),
    proposal: {
      source: input.source, requester: ctx.actor, requestId: ctx.requestId, objectTypeId: resolved.objectType.id,
    },
  }
  const outcome = await write(writer, submission, intakeLog, act, trail)
  if (trail.sequences.length > 0) {
    await enqueueRecordMutationEffects(tx, ctx, trail.sequences, [...new Set(trail.touched)].sort())
  }
  await audit(deps, tx, ctx, input, outcome)
  if (reservation.kind === 'reserved') {
    const stored = await tx.idempotencyReplay.updateMany({
      where: { ...tenantWhere(ctx.tenant), id: reservation.id }, data: { result: outcome.result },
    })
    if (stored.count !== 1) throw new ServiceError(ErrorCode.INTERNAL, 'Idempotency result was not stored')
  }
  return outcome.result
}

/**
 * Records a data subject's own submission through a form or chat widget
 * (schema-engine §4d″), in one transaction: no match creates the person; a
 * 100% match pairs (fills empty fields, queues real changes as amendments);
 * anything ambiguous is held as a pending match. Answers the outcome only.
 */
export async function submitIntake(
  deps: AppDeps, ctx: ActorContext, input: CrmIntakeSubmitInput,
): Promise<CrmIntakeSubmitOutput> {
  if (!isSubjectActor(ctx)) {
    await writeRecordDeniedAudit(deps, ctx, { tool: TOOL, reason: undefined, resourceId: null })
    throw new ServiceError(ErrorCode.POLICY_DENIED, 'Only a data subject\'s own submission may use this tool', {
      resource: 'record', action: 'create',
    })
  }
  return boundary(deps, async () => {
    if (input.consent !== undefined && (input.email === undefined || isEmptyValue(input.email))) {
      throw invalid('/consent', 'consent is about an email: give the email')
    }
    const at = input.consent === undefined ? null : consentAt(ctx, input.consent.at, '/consent/at')
    const resolved = await target(deps, ctx, input)
    const submission = normalizeSubmission(resolved, input)
    const act: ConsentAct | null = input.consent === undefined || at === null || submission.email === null ? null : {
      caller: 'subject', state: input.consent.state, source: input.consent.source, at, email: submission.email,
    }
    const intakeLog = log(input)
    return deps.db.$transaction((tx) => commit(deps, tx, ctx, input, resolved, submission, intakeLog, act), TRANSACTION)
  })
}
