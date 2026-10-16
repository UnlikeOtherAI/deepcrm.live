import { z } from 'zod'
import { IdempotencyKey, IsoDateTime, Slug, Uuid } from './primitives.js'

/**
 * Marketing consent is a state of the person (schema-engine §4d′):
 * `not_confirmed` — never confirmed, the default; `confirmed` — they confirmed,
 * or a colleague recorded consent they hold; `declined` — they asked not to be
 * written to, which is also an `email`/`email`/`objection`/`opt_out` suppression.
 */
export const ConsentState = z.enum(['not_confirmed', 'confirmed', 'declined'])
export type ConsentState = z.infer<typeof ConsentState>
export const ConsentSource = z.enum([
  'signup_form', 'contact_form', 'unsubscribe', 'resubscribe', 'import', 'manual',
])
export type ConsentSource = z.infer<typeof ConsentSource>

const consentEmail = z.string().min(1).max(320)
  .describe("the person's email address; normalised by the email attribute and matched on its unique key")
const consentObjectType = Slug.optional()
  .describe("person-kind object type; default: the one type whose primary is a personal_name with a unique email")

export const CrmConsentSet = {
  in: z.object({
    email: consentEmail,
    state: ConsentState.describe('not_confirmed, confirmed (needs reason from a person) or declined'),
    source: ConsentSource.describe('where the consent came from'),
    at: IsoDateTime.optional()
      .describe('when the person acted; default now. Written only when later than the stored at'),
    object_type: consentObjectType,
    create: z.object({
      data: z.record(z.unknown()).optional()
        .describe('attribute values for the new record, e.g. name; the email and consent are added'),
    }).strict().optional()
      .describe('create the person when no record holds the email; omitted ⇒ no match writes nothing'),
    reason: z.string().min(1).max(500).regex(/\S/u).optional()
      .describe('where the consent came from; required when a person records confirmed'),
    idempotency_key: IdempotencyKey,
  }),
  out: z.object({
    record_id: Uuid.nullable(),
    created: z.boolean(),
    state: ConsentState,
    previous_state: ConsentState.nullable(),
    at: IsoDateTime,
    suppressed: z.boolean(),
  }),
}

export const CrmConsentGet = {
  in: z.object({
    email: consentEmail,
    object_type: consentObjectType,
  }),
  out: z.object({
    record_id: Uuid.nullable(),
    state: ConsentState.nullable(),
    at: IsoDateTime.nullable(),
    source: ConsentSource.nullable(),
    suppressed: z.boolean(),
  }),
}

export type CrmConsentSetInput = z.output<typeof CrmConsentSet.in>
export type CrmConsentSetOutput = z.output<typeof CrmConsentSet.out>
export type CrmConsentGetInput = z.output<typeof CrmConsentGet.in>
export type CrmConsentGetOutput = z.output<typeof CrmConsentGet.out>
