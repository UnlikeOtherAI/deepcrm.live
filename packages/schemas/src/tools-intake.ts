import { z } from 'zod'

import { Cursor, ExpectedVersion, IdempotencyKey, IsoDateTime, Limit, Reason, Slug, Uuid } from './primitives.js'
import { SourceRef, SubjectSourceRef } from './source-ref.js'
import { ConsentSource, ConsentState } from './tools-consent.js'
import { RecordSummary } from './tools-records.js'

/**
 * A data subject's own submission through a form or chat widget
 * (schema-engine §4d″): created, paired on a 100% match, or held as a pending
 * match. The answer names only the outcome and the record written to.
 */
export const IntakeOutcome = z.enum(['created', 'paired', 'pending'])
export type IntakeOutcome = z.infer<typeof IntakeOutcome>

export const IntakeActivity = z.object({
  kind: z.enum(['message', 'custom']).describe('message (they wrote in) or custom'),
  occurred_at: IsoDateTime.describe('when the person submitted'),
  subject: z.string().trim().min(1).max(300).describe('one-line summary, e.g. "Website chat on example.com"'),
  body: z.string().max(100_000).optional().describe('what they wrote, in markdown'),
}).strict()

export const IntakeNote = z.object({
  title: z.string().max(300).optional().describe('short title'),
  body: z.string().min(1).max(100_000).describe('the note in markdown, e.g. the terms the person accepted'),
}).strict()

export const IntakeConsent = z.object({
  state: ConsentState.describe('not_confirmed, confirmed (only after the confirmation link) or declined'),
  source: ConsentSource.describe('where the consent came from'),
  at: IsoDateTime.optional().describe('when the person acted; default now'),
}).strict()

export const CrmIntakeSubmit = {
  in: z.object({
    source: SubjectSourceRef.describe('the form or widget used: kind, the product\'s stable id, its current name'),
    email: z.string().min(1).max(320).optional()
      .describe('the email the person gave; matched on the type\'s unique email attribute after normalisation'),
    phone: z.string().min(1).max(64).optional()
      .describe('the phone the person gave, international (+ and digits); matched as E.164 on the type\'s phone attribute'),
    data: z.record(Slug, z.unknown()).optional()
      .describe('other mapped values by attribute slug: the personal_name primary, text, rich_text and select '
        + 'attributes; empty values are ignored'),
    object_type: Slug.optional()
      .describe('person-kind object type; default: the one type whose primary is a personal_name with a unique email'),
    consent: IntakeConsent.optional()
      .describe('marketing consent given with the submission; needs email; crm_consent_set semantics'),
    activity: IntakeActivity.describe('the inbound activity logged on the person for this submission'),
    note: IntakeNote.optional().describe('a note logged on the person with the activity'),
    idempotency_key: IdempotencyKey,
  }),
  out: z.object({
    outcome: IntakeOutcome,
    record_id: Uuid.nullable(),
  }),
}

export const ProposalKind = z.enum(['amendment', 'match'])
/**
 * pending: in its window, waiting for a person; superseded: pushed out of a
 * window by newer submissions, still decidable until retention removes it;
 * approved / rejected: decided.
 */
export const ProposalStatus = z.enum(['pending', 'approved', 'rejected', 'superseded'])
/** What pointed at a candidate: one of its active values, or a value archived on it (schema-engine §4d‴). */
export const ProposalMatchedOn = z.enum(['email', 'phone', 'archived_email', 'archived_phone'])

export const ProposalAttribute = z.object({
  slug: Slug, name: z.string(), type: z.string(), is_multi: z.boolean(),
})

export const ProposalItem = z.object({
  id: Uuid,
  kind: ProposalKind,
  status: ProposalStatus,
  /** when the first of its identical submissions arrived */
  created_at: IsoDateTime,
  /** how many identical submissions (same field and value, or same match) it stands for */
  submissions: z.number().int().min(1),
  /** when the latest of them arrived */
  last_submitted_at: IsoDateTime,
  /** the latest identical submission's source */
  source: SourceRef,
  object_type: Slug,
  /** amendment: the person and its current version; match: null */
  record: RecordSummary.extend({ version: z.number().int() }).nullable(),
  attribute: ProposalAttribute.nullable(),
  /** amendment: the value an approval writes (the items it adds, for a multi attribute); absent when redacted */
  proposed_value: z.unknown().optional(),
  /** amendment: the value the record holds now; absent when redacted */
  current_value: z.unknown().optional(),
  /** match: the visible people the submission's email or phone points to */
  candidates: z.array(z.object({ record: RecordSummary, matched_on: z.array(ProposalMatchedOn) })).optional(),
  /** match: what the person submitted, by attribute slug (redacted attributes absent) */
  submitted: z.record(Slug, z.unknown()).optional(),
  activity: z.object({ subject: z.string(), occurred_at: IsoDateTime }).optional(),
  redacted_attributes: z.array(Slug),
  resolved_record_id: Uuid.nullable(),
})

export const CrmProposalsList = {
  in: z.object({
    status: ProposalStatus.optional().describe(
      'only proposals in this state: pending, superseded (pushed out of a window by newer submissions; still '
      + 'decidable), approved or rejected; omitted ⇒ every state',
    ),
    kind: ProposalKind.optional().describe('amendment (a change to one field) or match (an unresolved pairing)'),
    record_id: Uuid.optional().describe('only amendments to this visible record'),
    source_id: z.string().min(1).max(128).optional().describe('only proposals from this source id'),
    cursor: Cursor,
    limit: Limit,
  }),
  out: z.object({ proposals: z.array(ProposalItem), next_cursor: z.string().nullable() }),
}

export const CrmProposalDecide = {
  in: z.object({
    id: Uuid.describe('pending or superseded proposal id from crm_proposals_list'),
    decision: z.enum(['approve', 'reject']).describe('approve writes the change or resolves the match; reject drops it'),
    record_id: Uuid.optional()
      .describe('approving a match: the visible person to pair with; omitted ⇒ create a new person'),
    expected_version: ExpectedVersion,
    reason: Reason,
  }),
  out: z.object({
    id: Uuid,
    status: z.enum(['approved', 'rejected']),
    record_id: Uuid.nullable(),
  }),
}

export type CrmIntakeSubmitInput = z.output<typeof CrmIntakeSubmit.in>
export type CrmIntakeSubmitOutput = z.output<typeof CrmIntakeSubmit.out>
export type CrmProposalsListInput = z.output<typeof CrmProposalsList.in>
export type CrmProposalsListOutput = z.output<typeof CrmProposalsList.out>
export type CrmProposalDecideInput = z.output<typeof CrmProposalDecide.in>
export type CrmProposalDecideOutput = z.output<typeof CrmProposalDecide.out>
export type ProposalItem = z.output<typeof ProposalItem>
