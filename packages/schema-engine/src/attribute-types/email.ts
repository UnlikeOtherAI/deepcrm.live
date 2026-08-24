import emailAddresses from 'email-addresses'
import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({}).strict()
const dotAtom = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/iu

function canonicalLocalPart(local: string): string {
  if (dotAtom.test(local)) return local
  const escaped = local.replace(/(["\\])/gu, '\\$1')
  return `"${escaped}"`
}

const emailValueSchema = z.string().transform((value, context) => {
  const parsed = emailAddresses.parseOneAddress({ input: value.trim(), strict: true })
  if (parsed === null || parsed.type !== 'mailbox') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be an RFC 5322 email address' })
    return z.NEVER
  }
  return `${canonicalLocalPart(parsed.local)}@${parsed.domain}`.toLocaleLowerCase()
})

export const email: AttributeTypeDef = {
  type: 'email',
  configSchema,
  valueSchema: () => emailValueSchema,
  normalize: (value) => emailValueSchema.parse(value),
  toSearchText: (value) => emailValueSchema.parse(value),
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: true,
  filterOps: [...equalityFilterOps, 'contains', 'starts_with'],
}
