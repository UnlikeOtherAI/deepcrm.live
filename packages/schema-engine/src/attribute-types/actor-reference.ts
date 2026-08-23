import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

const actorType = z.enum(['human', 'agent'])
const configSchema = z.object({
  allow: z.array(actorType).min(1).default(['human', 'agent']),
}).strict().superRefine((config, context) => {
  if (new Set(config.allow).size !== config.allow.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'allow entries must be unique', path: ['allow'] })
  }
})

function actorValue(config: unknown) {
  const parsedConfig = configSchema.parse(config)
  return z.object({ type: actorType, id: z.string().min(1) }).strict().refine(
    (value) => parsedConfig.allow.includes(value.type),
    'actor type is not allowed for this attribute',
  )
}

export const actorReference: AttributeTypeDef = {
  type: 'actor_reference',
  configSchema,
  valueSchema: actorValue,
  normalize: (value, config) => {
    const parsed = actorValue(config).parse(value)
    return `${parsed.type}:${parsed.id}`
  },
  toSearchText: (value, config) => {
    const parsed = actorValue(config).parse(value)
    return `${parsed.type} ${parsed.id}`
  },
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: false,
  filterOps: [...equalityFilterOps, 'contains'],
}
