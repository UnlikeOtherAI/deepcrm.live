import { normalizedAttributeValue } from '@deepcrm/schema-engine'
import { ErrorCode, ServiceError, type ConsentSource, type ConsentState } from '@deepcrm/schemas'

import type { ConsentTarget } from './consent-target.js'

/** Who records consent: the data subject (attested), an agent, or a person. */
export type ConsentCaller = 'subject' | 'agent' | 'person'

type ConsentAct = {
  input: { state: ConsentState; source: ConsentSource }
  caller: ConsentCaller
  target: ConsentTarget
  email: { value: string }
  at: string
}

/** The three consent attribute values one act writes. */
export function consentPatch(target: ConsentTarget, act: Pick<ConsentAct, 'input' | 'at'>): Record<string, string> {
  return {
    [target.state.slug]: act.input.state,
    [target.at.slug]: act.at,
    [target.source.slug]: act.input.source,
  }
}

function refused(path: string, message: string): ServiceError {
  return new ServiceError(ErrorCode.VALIDATION_FAILED, 'Consent record data is invalid', {
    issues: [{ path: `/create/data/${path}`, message }],
  })
}

/**
 * The data of a person created by a consent write: the caller's `create.data`
 * with the email and the consent attributes set. Consent is set by `state`,
 * `source` and `at` alone; a given email attribute must hold the email. A
 * subject's own act names facts about the subject, never links to other
 * records or people.
 */
export function createConsentData(act: ConsentAct, data: Record<string, unknown>): Record<string, unknown> {
  const { target } = act
  for (const slug of [target.state.slug, target.at.slug, target.source.slug]) {
    if (Object.hasOwn(data, slug)) refusedSlug(slug)
  }
  if (act.caller === 'subject') {
    for (const attribute of target.objectType.attributes) {
      const reference = attribute.type === 'record_reference' || attribute.type === 'actor_reference'
      if (reference && Object.hasOwn(data, attribute.slug)) {
        throw refused(attribute.slug, 'a subject-attested record names no other records or people')
      }
    }
  }
  return { ...data, [target.email.slug]: emailValue(act, data[target.email.slug]), ...consentPatch(target, act) }
}

function refusedSlug(slug: string): never {
  throw refused(slug, 'consent is set by state, source and at')
}

function sameEmail(act: ConsentAct, value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    return normalizedAttributeValue(act.target.email, value) === act.email.value
  } catch {
    return false
  }
}

function emailValue(act: ConsentAct, given: unknown): unknown {
  const { email } = act.target
  if (given === undefined) return email.isMulti ? [act.email.value] : act.email.value
  if (!email.isMulti) {
    if (!sameEmail(act, given)) throw refused(email.slug, 'must be the email the consent is recorded for')
    return given
  }
  if (!Array.isArray(given)) throw refused(email.slug, 'must be an array of email addresses')
  return given.some((value) => sameEmail(act, value)) ? given : [act.email.value, ...given]
}
