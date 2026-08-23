import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({}).strict()

function addressOnly(value: string): string {
  const trimmed = value.trim()
  const match = /^(?:[^<>]+\s+)?<([^<>]+)>$/u.exec(trimmed)
  return (match?.[1] ?? trimmed).trim().toLocaleLowerCase()
}

const emailValueSchema = z.string().transform((value, context) => {
  const address = addressOnly(value)
  const parsed = z.string().email().safeParse(address)
  if (!parsed.success) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be an RFC 5322 email address' })
    return z.NEVER
  }
  return parsed.data
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
