import {
  canonicalJsonValue,
  CONSENT_ATTRIBUTE_SLUGS,
  FIRST_SOURCE_ATTRIBUTE_SLUGS,
  getAttributeType,
  keyHash,
  normalizedAttributeValue,
  validateRecordData,
  type JsonValue,
  type LoadedAttribute,
} from '@deepcrm/schema-engine'
import { ErrorCode, ServiceError } from '@deepcrm/schemas'

import type { IntakeTarget } from './intake-target.js'

/**
 * A submission as DeepCRM holds it (schema-engine §4d″): the normalised email
 * and E.164 phone with their key hashes, and the other mapped values,
 * validated by their attributes. Empty values are dropped first: an empty or
 * missing value never proposes, fills or clears anything.
 */
export type Submission = {
  email: { value: string; hash: string } | null
  phone: { value: string; hash: string } | null
  data: Record<string, JsonValue>
}

export type RawSubmission = { email?: string; phone?: string; data?: Record<string, unknown> }

// What a public form or chat widget maps to a person: the name and plain,
// rich and choice values. Email and phone have their own arguments.
const SUBJECT_TYPES: ReadonlySet<string> = new Set(['personal_name', 'text', 'rich_text', 'select'])
const SYSTEM_SLUGS: ReadonlySet<string> = new Set([
  ...Object.values(CONSENT_ATTRIBUTE_SLUGS), ...Object.values(FIRST_SOURCE_ATTRIBUTE_SLUGS),
])

function refused(path: string, message: string): ServiceError {
  return new ServiceError(ErrorCode.VALIDATION_FAILED, 'Submission is invalid', { issues: [{ path, message }] })
}

/** Absent, null, blank text, an empty list, or a name with no part. */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.every(isEmptyValue)
  if (typeof value === 'object') return Object.values(value).every(isEmptyValue)
  return false
}

function withoutEmptyItems(value: unknown): unknown {
  return Array.isArray(value) ? value.filter((item) => !isEmptyValue(item)) : value
}

function contactPoint(attribute: LoadedAttribute, raw: string, path: string): { value: string; hash: string } {
  try {
    const value = normalizedAttributeValue(attribute, raw)
    return { value, hash: keyHash(value) }
  } catch {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Submission is invalid', {
      issues: [{
        path, message: attribute.type === 'email' ? 'must be an RFC 5322 email address' : 'must be an E.164 phone number',
        type: attribute.type, expected: getAttributeType(attribute.type).example(attribute.config),
      }],
    })
  }
}

function admitted(target: IntakeTarget, slug: string): void {
  const attribute = target.objectType.attributes.find((candidate) => candidate.slug === slug)
  if (attribute === undefined) return // validateRecordData names an unknown or archived attribute
  const path = `/data/${slug}`
  if (attribute.id === target.email.id || attribute.type === 'email' || attribute.type === 'phone') {
    throw refused(path, 'email and phone are given in their own arguments')
  }
  if (SYSTEM_SLUGS.has(slug)) throw refused(path, 'consent and source are set by their own arguments')
  if (!SUBJECT_TYPES.has(attribute.type) || attribute.valueSource !== 'stored') {
    throw refused(path, 'a submission sets only personal_name, text, rich_text and select attributes')
  }
  if (attribute.isUnique) throw refused(path, 'a submission never sets a unique attribute')
}

/** Normalises and validates a submission against the target type; one of email and phone is required. */
export function normalizeSubmission(target: IntakeTarget, raw: RawSubmission): Submission {
  const email = raw.email === undefined || isEmptyValue(raw.email) ? null
    : contactPoint(target.email, raw.email, '/email')
  const phone = raw.phone === undefined || isEmptyValue(raw.phone) || target.phone === null ? null
    : contactPoint(target.phone, raw.phone, '/phone')
  if (email === null && phone === null) throw refused('', 'give the email or the phone the person submitted')
  const given: Record<string, unknown> = {}
  for (const [slug, value] of Object.entries(raw.data ?? {})) {
    if (isEmptyValue(value)) continue
    admitted(target, slug)
    given[slug] = withoutEmptyItems(value)
  }
  const validated = validateRecordData(target.schema, target.objectType, {}, given, 'update')
  const data: Record<string, JsonValue> = {}
  for (const [slug, value] of Object.entries(validated.data)) data[slug] = canonicalJsonValue(value)
  return { email, phone, data }
}

function values(attribute: LoadedAttribute, value: JsonValue): JsonValue[] {
  return attribute.isMulti && Array.isArray(value) ? value : [value]
}

function key(attribute: LoadedAttribute, value: JsonValue): string {
  return normalizedAttributeValue(attribute, value)
}

/**
 * The submission's values by attribute: its email and phone on their
 * attributes (as one-item lists for a multi attribute) and the mapped data.
 */
export function submittedValues(target: IntakeTarget, submission: Submission): Array<[LoadedAttribute, JsonValue]> {
  const entries: Array<[LoadedAttribute, JsonValue]> = []
  const point = (attribute: LoadedAttribute, value: string): JsonValue => attribute.isMulti ? [value] : value
  if (submission.email !== null) entries.push([target.email, point(target.email, submission.email.value)])
  if (submission.phone !== null && target.phone !== null) {
    entries.push([target.phone, point(target.phone, submission.phone.value)])
  }
  for (const [slug, value] of Object.entries(submission.data)) {
    const attribute = target.objectType.attributes.find((candidate) => candidate.slug === slug)
    if (attribute !== undefined) entries.push([attribute, value])
  }
  return entries
}

export type PairChange = { attribute: LoadedAttribute; value: JsonValue }
export type PairChanges = {
  /** Empty on the record: written with the submitted value. */
  fills: PairChange[]
  /** A multi attribute's submitted items it lacks: appended after the stored ones, in submitted order. */
  additions: PairChange[]
  /** A single-valued attribute whose non-empty stored value differs: waits for a person. */
  amendments: PairChange[]
}

/**
 * What pairing a submission with a stored record changes (schema-engine
 * §4d″). Nothing ever replaces or removes a stored value: an empty field is
 * filled; a multi attribute (emails, phones) keeps every stored item and gains
 * the submitted ones it lacks, side by side; a single-valued attribute whose
 * stored value differs, after the attribute's own normalisation (E.164,
 * normalised email, whitespace and case for text), is an amendment for a
 * person. An equal value changes nothing.
 */
export function planPairChanges(
  target: IntakeTarget, submission: Submission, stored: Readonly<Record<string, JsonValue>>,
): PairChanges {
  const changes: PairChanges = { fills: [], additions: [], amendments: [] }
  for (const [attribute, value] of submittedValues(target, submission)) {
    const current = stored[attribute.slug]
    if (current === undefined || isEmptyValue(current)) {
      changes.fills.push({ attribute, value })
      continue
    }
    const held = new Set(values(attribute, current).map((item) => key(attribute, item)))
    if (attribute.isMulti) {
      const missing = values(attribute, value).filter((item) => !held.has(key(attribute, item)))
      if (missing.length > 0) changes.additions.push({ attribute, value: [...values(attribute, current), ...missing] })
    } else if (!held.has(key(attribute, value))) {
      changes.amendments.push({ attribute, value })
    }
  }
  return changes
}
