import { z } from 'zod'

import { equalityFilterOps, normalizeWhitespace, type AttributeTypeDef } from './types.js'

const configSchema = z.object({
  maxLength: z.number().int().min(1).max(4000).default(4000),
}).strict()

function normalizedText(value: unknown, config: unknown): string {
  const parsedConfig = configSchema.parse(config)
  const text = z.string().max(parsedConfig.maxLength).parse(value)
  return normalizeWhitespace(text).toLocaleLowerCase()
}

export const text: AttributeTypeDef = {
  type: 'text',
  configSchema,
  valueSchema: (config) => {
    const parsedConfig = configSchema.parse(config)
    return z.string().max(parsedConfig.maxLength)
  },
  normalize: normalizedText,
  toSearchText: normalizedText,
  supportsMulti: true,
  supportsUnique: true,
  supportsIndexed: true,
  filterOps: [...equalityFilterOps, 'contains', 'starts_with'],
}
