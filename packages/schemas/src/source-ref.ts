import { z } from 'zod'

/**
 * Where a record came from (schema-engine §4d″): the kind of form, widget or
 * import, the calling product's stable id for it, and its display name at the
 * time. The name is display text only — DeepCRM never matches, compares or
 * interprets it; the id is opaque and compared exactly.
 */
export const SOURCE_KINDS = ['contact_form', 'signup_form', 'website_chat', 'import'] as const
export const SourceKind = z.enum(SOURCE_KINDS)
export type SourceKind = z.infer<typeof SourceKind>

/** A data subject's own act comes through a form or a chat widget; an import is a person's act. */
export const SubjectSourceKind = z.enum(['contact_form', 'signup_form', 'website_chat'])

export const SOURCE_ID_MAX_LENGTH = 128
export const SOURCE_NAME_MAX_LENGTH = 120
// Control characters, line and paragraph separators, and bidirectional
// embeddings, overrides and isolates: a display name renders as one plain line.
const REFUSED_NAME_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]/u

export const SourceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)
  .describe('the product\'s stable id for the form, widget or import: 1–128 of A-Z a-z 0-9 . _ -, compared exactly')
export const SourceName = z.string().trim().min(1).max(SOURCE_NAME_MAX_LENGTH)
  .refine((value) => !REFUSED_NAME_CHARACTERS.test(value), 'must not hold control characters or line breaks')
  .describe('its current display name, e.g. "Spring newsletter form": trimmed, 1–120 characters, one line; '
    + 'display text only, never matched')

export const SourceRef = z.object({
  kind: SourceKind.describe('contact_form, signup_form, website_chat or import'),
  id: SourceId,
  name: SourceName,
}).strict()
export type SourceRef = z.output<typeof SourceRef>

export const SubjectSourceRef = SourceRef.extend({
  kind: SubjectSourceKind.describe('contact_form, signup_form or website_chat'),
}).strict()
