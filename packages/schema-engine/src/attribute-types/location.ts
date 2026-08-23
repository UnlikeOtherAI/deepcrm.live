import { z } from 'zod'

import { equalityFilterOps, normalizeWhitespace, type AttributeTypeDef } from './types.js'

const locationValueSchema = z.object({
  line1: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  country: z.string().regex(/^[a-z]{2}$/iu).transform((value) => value.toLocaleUpperCase()).optional(),
  postal: z.string().min(1).optional(),
  lat: z.number().finite().min(-90).max(90).optional(),
  lng: z.number().finite().min(-180).max(180).optional(),
}).strict()

const configSchema = z.object({}).strict()

export const location: AttributeTypeDef = {
  type: 'location',
  configSchema,
  valueSchema: () => locationValueSchema,
  normalize: () => null,
  toSearchText: (value) => {
    const locationValue = locationValueSchema.parse(value)
    return normalizeWhitespace([
      locationValue.line1,
      locationValue.city,
      locationValue.region,
      locationValue.country,
      locationValue.postal,
    ].filter((part): part is string => part !== undefined).join(' ')) || null
  },
  supportsMulti: true,
  supportsUnique: false,
  supportsIndexed: false,
  filterOps: equalityFilterOps,
}
