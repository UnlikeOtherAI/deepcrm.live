import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

const slug = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/u)
const optionSchema = z.object({
  id: slug,
  label: z.string().min(1).max(120),
  color: z.string().min(1).max(32).optional(),
  archived: z.boolean().optional(),
  category: z.enum(['open', 'won', 'lost', 'neutral']),
  position: z.number().int().min(0),
}).strict()

const configSchema = z.object({
  options: z.array(optionSchema).min(2).max(50),
}).strict().superRefine((config, context) => {
  const ids = new Set<string>()
  const positions = new Set<number>()
  for (const [index, option] of config.options.entries()) {
    if (ids.has(option.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'option ids must be unique', path: ['options', index, 'id'] })
    }
    if (positions.has(option.position)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'positions must be unique', path: ['options', index, 'position'] })
    }
    ids.add(option.id)
    positions.add(option.position)
  }
  for (let position = 0; position < config.options.length; position += 1) {
    if (!positions.has(position)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'positions must be contiguous from zero', path: ['options'] })
      break
    }
  }
})

function statusValue(config: unknown, includeArchived: boolean) {
  const parsedConfig = configSchema.parse(config)
  const ids = new Set(parsedConfig.options
    .filter((option) => includeArchived || option.archived !== true)
    .map((option) => option.id))
  return z.string().refine((value) => ids.has(value), 'must be a configured status id')
}

export const status: AttributeTypeDef = {
  type: 'status',
  configSchema,
  valueSchema: (config) => statusValue(config, false),
  normalize: (value, config) => statusValue(config, true).parse(value),
  toSearchText: (value, config) => {
    const id = statusValue(config, true).parse(value)
    const option = configSchema.parse(config).options.find((candidate) => candidate.id === id)
    return option?.label ?? id
  },
  supportsMulti: false,
  supportsUnique: false,
  supportsIndexed: true,
  filterOps: equalityFilterOps,
}
