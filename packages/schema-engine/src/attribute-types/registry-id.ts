import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

const configSchema = z.object({
  jurisdiction: z.string().length(2).optional(),
}).strict()

function canonicalRegistryId(value: string): string {
  const canonical = value.toLocaleUpperCase().replace(/[\s.-]/gu, '').replace(/^0+/u, '')
  if (canonical === '') throw new Error('must contain a non-zero registry identifier')
  return canonical
}

const registryIdValueSchema = z.string().min(1).transform((value, context) => {
  try {
    return canonicalRegistryId(value)
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'invalid registry id' })
    return z.NEVER
  }
})

export const registryId: AttributeTypeDef = {
  type: 'registry_id',
  configSchema,
  valueSchema: () => registryIdValueSchema,
  normalize: (value) => registryIdValueSchema.parse(value),
  toSearchText: (value) => registryIdValueSchema.parse(value),
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: true,
  filterOps: [...equalityFilterOps, 'contains', 'starts_with'],
}
