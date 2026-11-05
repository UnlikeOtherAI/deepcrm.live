import { z } from 'zod'

import { orderedFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({}).strict()
export const GregorianDateSchema = z.string().date('must be a real Gregorian YYYY-MM-DD date')

export const date: AttributeTypeDef = {
  type: 'date',
  configSchema,
  valueSchema: () => GregorianDateSchema,
  example: () => '2026-01-15',
  normalize: (value) => GregorianDateSchema.parse(value),
  toSearchText: (value) => GregorianDateSchema.parse(value),
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: true,
  filterOps: orderedFilterOps,
}
