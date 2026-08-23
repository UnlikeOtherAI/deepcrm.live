import { z } from 'zod'

import { canonicalDateTime } from './datetime.js'
import { orderedFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({
  source: z.enum(['created_at', 'updated_at', 'last_activity_at']),
}).strict()

const timestampValueSchema = z.string().transform((value, context) => {
  try {
    return canonicalDateTime(value)
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'invalid datetime' })
    return z.NEVER
  }
})

export const timestampSystem: AttributeTypeDef = {
  type: 'timestamp_system',
  configSchema,
  valueSchema: () => timestampValueSchema,
  normalize: () => null,
  toSearchText: () => null,
  supportsMulti: false,
  supportsUnique: false,
  supportsIndexed: false,
  filterOps: orderedFilterOps,
}
