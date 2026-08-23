import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
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

function statusValue(config: unknown) {
  const parsedConfig = configSchema.parse(config)
  const ids = new Set(parsedConfig.options.map((option) => option.id))
  return z.string().refine((value) => ids.has(value), 'must be a configured status id')
}

export const status: AttributeTypeDef = {
  type: 'status',
  configSchema,
  valueSchema: statusValue,
  normalize: (value, config) => statusValue(config).parse(value),
  toSearchText: (value, config) => {
    const id = statusValue(config).parse(value)
    const option = configSchema.parse(config).options.find((candidate) => candidate.id === id)
    return option?.label ?? id
  },
  supportsMulti: false,
  supportsUnique: false,
  supportsIndexed: true,
  filterOps: equalityFilterOps,
}
