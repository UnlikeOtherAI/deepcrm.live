import { tenantWhere, type Db } from '@deepcrm/db'
import type { QueueEnqueueTx } from '@deepcrm/queue'
import {
  ACTIVITY_SOURCE_ATTRIBUTE_SLUGS,
  canonicalJsonValue,
  createRecord as engineCreateRecord,
  FIRST_SOURCE_ATTRIBUTE_SLUGS,
  findUniqueRecord,
  lockRecords,
  updateRecord as engineUpdateRecord,
  type InlineLinkAuthorizer,
  type JsonValue,
  type RecordTx,
  type RecordWriteResult,
} from '@deepcrm/schema-engine'
import { ErrorCode, ServiceError, type ActorContext, type SourceRef } from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { touchLastActivity } from './activity.js'
import {
  consentWrites, settleConsentSuppression, storedConsent, type ConsentAct,
} from './consent-act.js'
import { consentPatch } from './consent-data.js'
import type { ConsentSuppressionChange } from './consent-suppression.js'
import { planPairChanges, submittedValues, type Submission } from './intake-submission.js'
import type { IntakeTarget } from './intake-target.js'
import { proposeAmendments, type MatchCandidate, type ProposalOrigin } from './proposal-store.js'

export type IntakeTx = RecordTx & QueueEnqueueTx
  & Pick<Db, 'webhook' | 'list' | 'suppressionEntry' | 'record' | 'recordProposal' | 'policyRule'>

/** The inbound activity and optional note a submission logs on its person. */
export type IntakeLog = {
  activity: { kind: 'message' | 'custom'; occurred_at: string; subject: string; body?: string }
  note: { title?: string; body: string } | null
}

/**
 * How one writer writes a submission: the subject itself, or the person who
 * resolves a pending match. `origin` is the subject actor the data came
 * from; `reason` names the source on every change row.
 */
export type IntakeWriter = {
  deps: AppDeps
  tx: IntakeTx
  ctx: ActorContext
  target: IntakeTarget
  source: SourceRef
  origin: string
  reason: string
  inlineLinkAuthorizer?: InlineLinkAuthorizer
  proposal: ProposalOrigin
}

export type ConsentOutcome = 'written' | 'kept' | 'no_record' | 'none'

/** Every committed write of one submission, for the effects and the audit. */
export type IntakeTrail = { sequences: number[]; touched: string[] }

/** The change-history reason a submission's writes carry: the source that brought them in. */
export function sourceReason(source: SourceRef): string {
  return `Submitted through ${source.kind} ${source.id} "${source.name}"`
}

function record(trail: IntakeTrail, written: RecordWriteResult): void {
  trail.sequences.push(...written.sequences)
  trail.touched.push(...written.touchedRecordIds)
}

function firstSource(source: SourceRef): Record<string, string> {
  return {
    [FIRST_SOURCE_ATTRIBUTE_SLUGS.kind]: source.kind,
    [FIRST_SOURCE_ATTRIBUTE_SLUGS.id]: source.id,
    [FIRST_SOURCE_ATTRIBUTE_SLUGS.name]: source.name,
  }
}

/** The people the submission's email and phone point at, each found structurally. */
export async function findCandidates(
  tx: IntakeTx, ctx: ActorContext, target: IntakeTarget, submission: Submission,
): Promise<MatchCandidate[]> {
  const found = new Map<string, Set<'email' | 'phone'>>()
  const add = (id: string, on: 'email' | 'phone') => found.set(id, (found.get(id) ?? new Set()).add(on))
  if (submission.email !== null) {
    const holder = await findUniqueRecord(tx, ctx.tenant, target.email.id, submission.email.hash)
    if (holder !== null) add(holder, 'email')
  }
  if (submission.phone !== null && target.phone !== null) {
    const phone = submission.phone.value
    const containment = { [target.phone.slug]: target.phone.isMulti ? [phone] : phone }
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM records
      WHERE organization_id = ${ctx.tenant.organizationId}::uuid AND team_id = ${ctx.tenant.teamId}::uuid
        AND object_type_id = ${target.objectType.id}::uuid
        AND deleted_at IS NULL AND merged_into_id IS NULL AND erased_at IS NULL
        AND data @> ${JSON.stringify(containment)}::jsonb
      ORDER BY id ASC LIMIT 20
    `
    for (const row of rows) add(row.id, 'phone')
  }
  return [...found].sort(([left], [right]) => left.localeCompare(right))
    .map(([recordId, on]) => ({ record_id: recordId, matched_on: [...on].sort() }))
}

/** The record whose email key the submission's email holds, before anything is written. */
export function emailHolder(candidates: readonly MatchCandidate[]): string | null {
  return candidates.find((candidate) => candidate.matched_on.includes('email'))?.record_id ?? null
}

async function logSubmission(writer: IntakeWriter, recordId: string, log: IntakeLog, trail: IntakeTrail) {
  const { deps, tx, ctx, target, source } = writer
  const activity = await engineCreateRecord(tx, ctx, target.schema, {
    objectType: target.activity.slug,
    data: {
      kind: log.activity.kind, occurred_at: log.activity.occurred_at, direction: 'inbound',
      subject: log.activity.subject,
      ...(log.activity.body === undefined ? {} : { body: log.activity.body }),
      [ACTIVITY_SOURCE_ATTRIBUTE_SLUGS.kind]: source.kind,
      [ACTIVITY_SOURCE_ATTRIBUTE_SLUGS.id]: source.id,
      [ACTIVITY_SOURCE_ATTRIBUTE_SLUGS.name]: source.name,
    },
    links: [{ relationType: 'activity_about', toRecordId: recordId }],
    inlineLinkAuthorizer: writer.inlineLinkAuthorizer, reason: writer.reason, origin: writer.origin,
  }, deps.linkWriter)
  record(trail, activity)
  await touchLastActivity(tx, ctx, [recordId], new Date(log.activity.occurred_at))
  if (log.note === null) return
  const note = await engineCreateRecord(tx, ctx, target.schema, {
    objectType: 'note',
    data: { body: log.note.body, ...(log.note.title === undefined ? {} : { title: log.note.title }) },
    links: [{ relationType: 'note_about', toRecordId: recordId }],
    inlineLinkAuthorizer: writer.inlineLinkAuthorizer, reason: writer.reason, origin: writer.origin,
  }, deps.linkWriter)
  record(trail, note)
  await touchLastActivity(tx, ctx, [recordId], ctx.now)
}

/**
 * No one matched: the person is created from every submitted value, with
 * the first source and, when the submission carries consent, the consent
 * values; then the activity and note are logged on them.
 */
export async function createPerson(
  writer: IntakeWriter, submission: Submission, log: IntakeLog, act: ConsentAct | null, trail: IntakeTrail,
): Promise<{ recordId: string; consent: ConsentOutcome; suppression: ConsentSuppressionChange }> {
  const { deps, tx, ctx, target } = writer
  const data: Record<string, JsonValue> = {}
  for (const [attribute, value] of submittedValues(target, submission)) data[attribute.slug] = value
  const consent = act === null || target.consent === null ? {} : consentPatch(target.consent, {
    input: { state: act.state, source: act.source }, at: act.at,
  })
  const created = await engineCreateRecord(tx, ctx, target.schema, {
    objectType: target.objectType.slug, data: { ...data, ...firstSource(writer.source), ...consent },
    reason: writer.reason, origin: writer.origin,
  }, deps.linkWriter)
  record(trail, created)
  const recordId = created.record.id
  const suppression = act === null ? 'none' : await settleConsentSuppression(tx, ctx, act, recordId, true)
  await logSubmission(writer, recordId, log, trail)
  return { recordId, consent: act === null ? 'none' : 'written', suppression }
}

async function liveData(tx: IntakeTx, ctx: ActorContext, recordId: string): Promise<Record<string, JsonValue>> {
  const row = await tx.record.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: recordId, deletedAt: null, mergedIntoId: null, erasedAt: null },
    select: { data: true },
  })
  if (row === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const data = canonicalJsonValue(row.data)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ServiceError(ErrorCode.INTERNAL, 'Stored record data is invalid')
  }
  return data
}

/**
 * Applies a consent act to the person who held its email before the
 * submission (crm_consent_set semantics): the consent values when the act is
 * newer; the caller writes the patch and takes the suppression step.
 */
async function consentOnHolder(
  writer: IntakeWriter, act: ConsentAct, stored: Record<string, JsonValue>,
): Promise<{ patch: Record<string, string>; consent: ConsentOutcome }> {
  if (writer.target.consent === null) throw new ServiceError(ErrorCode.INTERNAL, 'Consent target is missing')
  if (!consentWrites(act, storedConsent(writer.target.consent, stored))) return { patch: {}, consent: 'kept' }
  return {
    patch: consentPatch(writer.target.consent, { input: { state: act.state, source: act.source }, at: act.at }),
    consent: 'written',
  }
}

export type PairResult = {
  filled: string[]; added: string[]; amendments: number; consent: ConsentOutcome; suppression: ConsentSuppressionChange
}

/**
 * Pairs the submission with one person (a 100% match, or the person a
 * resolver chose): empty fields are filled and new emails, phones and other
 * multi items are added beside the stored ones straight away, in one change
 * that names the source; a real change to a single-valued field becomes a
 * pending amendment; consent
 * lands only when this person held the email before, and the activity and
 * note are logged on them.
 */
export async function pairWithRecord(
  writer: IntakeWriter, recordId: string, submission: Submission, log: IntakeLog,
  consent: { act: ConsentAct; heldBefore: boolean } | null, trail: IntakeTrail,
): Promise<PairResult> {
  const { deps, tx, ctx, target } = writer
  await lockRecords(tx, ctx.tenant.teamId, [recordId])
  const stored = await liveData(tx, ctx, recordId)
  const changes = planPairChanges(target, submission, stored)
  const held = consent !== null && consent.heldBefore
    ? await consentOnHolder(writer, consent.act, stored) : null
  const patch: Record<string, JsonValue> = { ...(held?.patch ?? {}) }
  for (const change of [...changes.fills, ...changes.additions]) patch[change.attribute.slug] = change.value
  if (Object.keys(patch).length > 0) {
    // A subject's own act carries its provenance (actor, source, reason), so
    // the team's require_origin does not apply; rejected origins still do.
    const written = await engineUpdateRecord(tx, ctx, target.schema, {
      recordId, data: patch, reason: writer.reason, originRequirement: 'waived',
    }, deps.linkWriter)
    record(trail, written)
  }
  const suppression = consent === null ? 'none'
    : await settleConsentSuppression(tx, ctx, consent.act, consent.heldBefore ? recordId : null, held?.consent === 'written')
  const amendments = await proposeAmendments(tx, ctx, writer.proposal, recordId, changes.amendments)
  await logSubmission(writer, recordId, log, trail)
  return {
    filled: changes.fills.map((fill) => fill.attribute.slug).sort(),
    added: changes.additions.map((addition) => addition.attribute.slug).sort(),
    amendments,
    consent: consent === null ? 'none' : held?.consent ?? 'no_record',
    suppression,
  }
}

/**
 * A pending match pairs nothing, but its consent act is still the subject's
 * own: applied to the person who holds the email (crm_consent_set semantics),
 * or, for an address no record holds, as its suppression step alone.
 */
export async function consentWithoutPairing(
  writer: IntakeWriter, holder: string | null, act: ConsentAct, trail: IntakeTrail,
): Promise<{ consent: ConsentOutcome; suppression: ConsentSuppressionChange }> {
  const { deps, tx, ctx, target } = writer
  if (holder === null) {
    return { consent: 'no_record', suppression: await settleConsentSuppression(tx, ctx, act, null, false) }
  }
  await lockRecords(tx, ctx.tenant.teamId, [holder])
  const held = await consentOnHolder(writer, act, await liveData(tx, ctx, holder))
  if (held.consent === 'written') {
    const written = await engineUpdateRecord(tx, ctx, target.schema, {
      recordId: holder, data: held.patch, reason: writer.reason, originRequirement: 'waived',
    }, deps.linkWriter)
    record(trail, written)
  }
  return {
    consent: held.consent,
    suppression: await settleConsentSuppression(tx, ctx, act, holder, held.consent === 'written'),
  }
}
