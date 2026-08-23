import { z } from 'zod'

import { orderedFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({}).strict()
const valueSchema = z.number().finite().min(0).max(100)

export const percent: AttributeTypeDef = {
  type: 'percent',
  configSchema,
  valueSchema: () => valueSchema,
  normalize: () => null,
  toSearchText: (value) => `${valueSchema.parse(value)}%`,
  supportsMulti: true,
  supportsUnique: false,
  supportsIndexed: true,
  filterOps: orderedFilterOps,
}
