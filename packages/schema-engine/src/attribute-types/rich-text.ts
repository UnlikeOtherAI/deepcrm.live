import { Parser } from 'commonmark'
import { z } from 'zod'

import { equalityFilterOps, normalizeWhitespace, type AttributeTypeDef } from './types.js'

const configSchema = z.object({}).strict()
const markdownParser = new Parser()

function stripMarkdown(value: string): string {
  const parts: string[] = []
  const walker = markdownParser.parse(value).walker()
  let step = walker.next()
  while (step !== null) {
    if (step.entering) {
      if (step.node.type === 'text' || step.node.type === 'code' || step.node.type === 'code_block') {
        if (step.node.literal !== null) parts.push(step.node.literal)
      } else if (step.node.type === 'softbreak' || step.node.type === 'linebreak') {
        parts.push(' ')
      }
    } else if (
      step.node.type === 'paragraph' ||
      step.node.type === 'heading' ||
      step.node.type === 'item' ||
      step.node.type === 'code_block'
    ) {
      parts.push(' ')
    }
    step = walker.next()
  }
  return normalizeWhitespace(parts.join(''))
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
