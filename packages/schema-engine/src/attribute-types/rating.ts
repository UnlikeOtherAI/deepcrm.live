import { z } from 'zod'

import { orderedFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({
  max: z.number().int().min(1).max(10).default(5),
}).strict()

function ratingValue(config: unknown) {
  return z.number().int().min(0).max(configSchema.parse(config).max)
}

export const rating: AttributeTypeDef = {
  type: 'rating',
  configSchema,
  valueSchema: ratingValue,
  normalize: () => null,
  toSearchText: (value, config) => String(ratingValue(config).parse(value)),
  supportsMulti: true,
  supportsUnique: false,
  supportsIndexed: true,
  filterOps: orderedFilterOps,
}
