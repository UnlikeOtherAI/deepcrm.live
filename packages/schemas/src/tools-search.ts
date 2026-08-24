import { z } from 'zod'

import { Slug, Uuid } from './primitives.js'
import { RecordSummary } from './tools-records.js'

export const SearchMode = z.enum(['keyword', 'semantic', 'hybrid'])
export type SearchModeValue = z.infer<typeof SearchMode>

export const CrmSearchInputShape = {
  query: z.string().min(1).max(500).optional()
    .describe('free text for keyword, semantic, or hybrid retrieval'),
  similar_to: Uuid.optional()
    .describe('visible record whose current-model embedding supplies a semantic query'),
  object_types: z.array(Slug).max(50).optional()
    .describe('explicit object type slug filter; omit to search all active types'),
  mode: SearchMode.default('hybrid')
    .describe('keyword, semantic, or reciprocal-rank-fused hybrid retrieval'),
  limit: z.number().int().min(1).max(50).default(10)
    .describe('maximum ranked hits, from 1 through 50'),
}

export const CrmSearchInput = z.object(CrmSearchInputShape).refine(
  (value) => (value.query === undefined) !== (value.similar_to === undefined), {
    message: 'Supply exactly one of query or similar_to',
  },
)

export const CrmSearch = {
  in: CrmSearchInput,
  out: z.object({
    hits: z.array(z.object({
      record: RecordSummary,
      score: z.number(),
      match: z.enum(['keyword', 'semantic', 'both']),
    })),
  }),
}
