import { z } from 'zod'

import { ExpectedVersion, IsoDateTime, Reason, Slug, Uuid } from './primitives.js'
import { SourceRef } from './source-ref.js'

/**
 * The state of each email and phone a record holds (schema-engine §4d‴):
 * where it came from and when, whether it is confirmed, whether someone
 * reached the person on it, and — for a value replaced by another — when it
 * was archived. Archived values are no longer among the record's active
 * values but stay readable here.
 */
export const ContactActor = z.object({ type: z.enum(['human', 'agent', 'system']), id: z.string() })

export const ContactPointValue = z.object({
  value: z.string().describe('the normalised email or E.164 phone'),
  confirmed: z.boolean().describe('false until a person confirms, reaches or keeps it; true for a value a person added'),
  added: z.object({ at: IsoDateTime, by: ContactActor, source: SourceRef.nullable() }).nullable()
    .describe('when and by whom it was added, and through which form, widget or import; null when unknown'),
  reached: z.object({ at: IsoDateTime, by: ContactActor, note: z.string().nullable() }).nullable()
    .describe('the last successful contact on it; null when not reached'),
  archived: z.object({ at: IsoDateTime, by: ContactActor }).nullable()
    .describe('when another value replaced it; null for an active value'),
})

export const ContactPointAttribute = z.object({
  slug: Slug,
  name: z.string(),
  type: z.enum(['email', 'phone']),
  is_multi: z.boolean(),
  /** the active values, in stored order (the first is the primary) */
  values: z.array(ContactPointValue),
  /** values replaced by another, newest first */
  archived: z.array(ContactPointValue),
})

export const CrmContactPointsGet = {
  in: z.object({
    record_id: Uuid.describe('visible record whose emails and phones to read'),
  }),
  out: z.object({
    record: z.object({ id: Uuid, object_type: Slug, display_name: z.string(), version: z.number().int() }),
    attributes: z.array(ContactPointAttribute),
    redacted_attributes: z.array(Slug),
  }),
}

export const ContactPointAction = z.enum(['reach', 'unreach', 'confirm', 'replace_others', 'restore'])

export const CrmContactPointSet = {
  in: z.object({
    record_id: Uuid.describe('visible record holding the value'),
    attribute: Slug.describe('its email or phone attribute, e.g. phones'),
    value: z.string().min(1).max(320).describe('the email or phone, in any format the attribute normalises'),
    action: ContactPointAction.describe(
      'reach: a successful contact on it (confirms it; note optional); unreach: undo a mistaken reach; '
      + 'confirm: keep it as an additional value; replace_others: keep it and archive every other active value; '
      + 'restore: make an archived value active again, after the others',
    ),
    note: z.string().trim().min(1).max(2_000).optional().describe('with reach: what happened, e.g. "Called, booked a demo"'),
    expected_version: ExpectedVersion,
    reason: Reason,
  }),
  out: z.object({
    record_id: Uuid,
    version: z.number().int(),
    attribute: ContactPointAttribute,
  }),
}

export type ContactPointValue = z.output<typeof ContactPointValue>
export type ContactPointAttribute = z.output<typeof ContactPointAttribute>
export type ContactPointAction = z.output<typeof ContactPointAction>
export type CrmContactPointsGetInput = z.output<typeof CrmContactPointsGet.in>
export type CrmContactPointsGetOutput = z.output<typeof CrmContactPointsGet.out>
export type CrmContactPointSetInput = z.output<typeof CrmContactPointSet.in>
export type CrmContactPointSetOutput = z.output<typeof CrmContactPointSet.out>
