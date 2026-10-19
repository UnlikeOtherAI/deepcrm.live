import type { AuditTx, Db } from '@deepcrm/db'
import {
  ConsentSource, ConsentState, ErrorCode, ServiceError, type ActorContext,
} from '@deepcrm/schemas'

import { type ConsentCaller } from './consent-data.js'
import { applyConsentSuppression, type ConsentSuppressionChange } from './consent-suppression.js'
import type { ConsentTarget } from './consent-target.js'

/**
 * One marketing-consent act (schema-engine §4d′), as crm_consent_set and
 * crm_intake_submit both apply it: who acted, the state and source, when, and
 * the email it is about. The decision and the suppression rules live here
 * once; each tool decides only which record the act lands on.
 */
export type ConsentAct = {
  caller: ConsentCaller
  state: ConsentState
  source: ConsentSource
  at: string
  email: { value: string; hash: string }
}

export type StoredConsent = { state: ConsentState | null; at: string | null; source: ConsentSource | null }

type SuppressionTx = AuditTx & Pick<Db, 'suppressionEntry'>

// An act cannot be dated later than now: a future `at` would freeze the state.
const FUTURE_SKEW_MS = 60_000

/** The act's time: `at` or now, refused when later than now plus 60 s (`path` names the argument). */
export function consentAt(ctx: ActorContext, at: string | undefined, path: string): string {
  const when = new Date(at ?? ctx.now.toISOString())
  if (when.getTime() > ctx.now.getTime() + FUTURE_SKEW_MS) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Consent time is in the future', {
      issues: [{ path, message: 'must not be later than now (60 seconds of clock skew allowed)' }],
    })
  }
  return when.toISOString()
}

export function storedConsent(consent: ConsentTarget, data: unknown): StoredConsent {
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
function unverifiedOverDeclined(act: ConsentAct, stored: StoredConsent): boolean {
  return act.caller === 'subject' && act.state === 'not_confirmed' && stored.state === 'declined'
}

/** Whether the act replaces the consent a record holds. */
export function consentWrites(act: ConsentAct, stored: StoredConsent): boolean {
  return stored.state === null || (supersedes(stored, act.at) && !unverifiedOverDeclined(act, stored))
}

function liftsOptOut(act: ConsentAct): boolean {
  return !(act.caller === 'subject' && act.state === 'not_confirmed')
}

/**
 * The suppression step of an act: a written act adds (`declined`) or lifts
 * (any other state but a subject's `not_confirmed`) the opt-out; a kept act,
 * or one for an address no record holds, still adds a `declined` — an
 * objection holds whatever order the acts arrive in.
 */
export async function settleConsentSuppression(
  tx: SuppressionTx, ctx: ActorContext, act: ConsentAct, recordId: string | null, written: boolean,
): Promise<ConsentSuppressionChange> {
  if (written && (act.state === 'declined' || liftsOptOut(act))) {
    return applyConsentSuppression(tx, ctx, act.email.value, act.state, recordId)
  }
  if (act.state !== 'declined') return 'none'
  return applyConsentSuppression(tx, ctx, act.email.value, 'declined', recordId)
}
