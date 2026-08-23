import { parsePhoneNumberFromString } from 'libphonenumber-js'
import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({}).strict()

function canonicalPhone(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('+')) throw new Error('phone input must already be international E.164')
  const parsed = parsePhoneNumberFromString(trimmed)
  if (parsed === undefined || !parsed.isValid()) throw new Error('must be a valid E.164 phone number')
  return parsed.number
}

const phoneValueSchema = z.string().transform((value, context) => {
  try {
    return canonicalPhone(value)
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'invalid phone' })
    return z.NEVER
  }
})

export const phone: AttributeTypeDef = {
  type: 'phone',
  configSchema,
  valueSchema: () => phoneValueSchema,
  normalize: (value) => phoneValueSchema.parse(value),
  toSearchText: (value) => phoneValueSchema.parse(value),
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: true,
  filterOps: equalityFilterOps,
}
