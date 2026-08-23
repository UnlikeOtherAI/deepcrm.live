import { z } from 'zod'

import { equalityFilterOps, normalizeWhitespace, type AttributeTypeDef } from './types.js'

const configSchema = z.object({}).strict()

function stripMarkdown(value: string): string {
  return normalizeWhitespace(value
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[`*_>#~-]/gu, ''))
}

export const richText: AttributeTypeDef = {
  type: 'rich_text',
  configSchema,
  valueSchema: () => z.string().max(100_000),
  normalize: () => null,
  toSearchText: (value) => stripMarkdown(z.string().max(100_000).parse(value)).slice(0, 2048),
  supportsMulti: true,
  supportsUnique: false,
  supportsIndexed: false,
  filterOps: [...equalityFilterOps, 'contains'],
}
