import { z } from 'zod'

import { equalityFilterOps, normalizeWhitespace, type AttributeTypeDef } from './types.js'

const configSchema = z.object({}).strict()
const namePart = z.string().max(120).transform(normalizeWhitespace)
const fullName = z.string().max(250).transform(normalizeWhitespace)

const personalNameValueSchema = z.object({
  first: namePart.optional(),
  last: namePart.optional(),
  full: fullName.optional(),
}).strict().transform((value, context) => {
  const full = value.full ?? [value.first, value.last]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' ')
  if (full === '') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must include full, first, or last' })
    return z.NEVER
  }
  return { first: value.first, last: value.last, full }
})

export const personalName: AttributeTypeDef = {
  type: 'personal_name',
  configSchema,
  valueSchema: () => personalNameValueSchema,
  normalize: (value) => personalNameValueSchema.parse(value).full.toLocaleLowerCase(),
  toSearchText: (value) => personalNameValueSchema.parse(value).full,
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: false,
  filterOps: [...equalityFilterOps, 'contains', 'starts_with'],
}
