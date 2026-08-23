import { z } from 'zod'

import { equalityFilterOps, type AttributeTypeDef } from './types.js'

const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  color: z.string().min(1).optional(),
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

function selectedValue(config: unknown) {
  const parsedConfig = configSchema.parse(config)
  const ids = new Set(parsedConfig.options.map((option) => option.id))
  return z.string().refine((value) => ids.has(value), 'must be a configured option id')
}

export const select: AttributeTypeDef = {
  type: 'select',
  configSchema,
  valueSchema: selectedValue,
  normalize: (value, config) => selectedValue(config).parse(value),
  toSearchText: (value, config) => {
    const id = selectedValue(config).parse(value)
    const option = configSchema.parse(config).options.find((candidate) => candidate.id === id)
    return option?.label ?? id
  },
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: true,
  filterOps: [...equalityFilterOps, 'contains'],
}
