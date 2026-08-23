import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({}).strict()
const valueSchema = z.boolean()

export const boolean: AttributeTypeDef = {
  type: 'boolean',
  configSchema,
  valueSchema: () => valueSchema,
  normalize: (value) => valueSchema.parse(value) ? 'true' : 'false',
  toSearchText: (value) => valueSchema.parse(value) ? 'true' : 'false',
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: true,
  filterOps: equalityFilterOps,
}
