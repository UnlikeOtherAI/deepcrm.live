import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

const slug = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/u)
const optionSchema = z.object({
  id: slug,
  label: z.string().min(1).max(120),
  color: z.string().min(1).max(32).optional(),
  archived: z.boolean().optional(),
}).strict()

const configSchema = z.object({
  options: z.array(optionSchema).min(1).max(200),
}).strict().superRefine((config, context) => {
  const ids = new Set<string>()
  for (const [index, option] of config.options.entries()) {
    if (ids.has(option.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'option ids must be unique', path: ['options', index, 'id'] })
    }
    ids.add(option.id)
  }
})

function selectedValue(config: unknown, includeArchived: boolean) {
  const parsedConfig = configSchema.parse(config)
  const ids = new Set(parsedConfig.options
    .filter((option) => includeArchived || option.archived !== true)
    .map((option) => option.id))
  return z.string().refine((value) => ids.has(value), 'must be a configured option id')
}

export const select: AttributeTypeDef = {
  type: 'select',
  configSchema,
  valueSchema: (config) => selectedValue(config, false),
  normalize: (value, config) => selectedValue(config, true).parse(value),
  toSearchText: (value, config) => {
    const id = selectedValue(config, true).parse(value)
    const option = configSchema.parse(config).options.find((candidate) => candidate.id === id)
    return option?.label ?? id
  },
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: true,
  filterOps: [...equalityFilterOps, 'contains', 'starts_with'],
}
