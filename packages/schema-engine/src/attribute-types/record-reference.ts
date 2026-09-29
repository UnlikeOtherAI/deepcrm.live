import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

const slug = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/u)
const configSchema = z.object({
  objectTypes: z.array(slug).min(1),
  relationTypeSlug: slug.optional(),
}).strict().superRefine((config, context) => {
  if (new Set(config.objectTypes).size !== config.objectTypes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'objectTypes must be unique', path: ['objectTypes'] })
  }
})

const recordReferenceValueSchema = z.string().uuid().transform((value) => value.toLocaleLowerCase())

export const recordReference: AttributeTypeDef = {
  type: 'record_reference',
  configSchema,
  valueSchema: () => recordReferenceValueSchema,
  example: () => '0b6f3c2e-8d4a-4f1b-9c5e-2a7d1e3f4b60',
  normalize: (value) => recordReferenceValueSchema.parse(value),
  toSearchText: () => null,
  supportsMulti: true,
  supportsUnique: false,
  supportsIndexed: true,
  filterOps: [...equalityFilterOps, 'contains'],
}
