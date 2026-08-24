import { z } from 'zod'

import { IsoDateTime, Slug, Uuid } from './primitives.js'
import { RecordSummary } from './tools-records.js'
import { Filter } from './filter.js'
import { CandidateEvidence } from './matching.js'

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

export const CrmFindDuplicatesInputShape = {
  object_type: Slug.describe('object type to scan using its active matching rules'),
  filter: Filter.optional().describe('optional visible-record filter limiting the scan population'),
  include_semantic: z.boolean().default(true)
    .describe('include current-model embedding pairs with cosine distance below 0.08'),
}

export const CrmFindDuplicatesToolInputShape = {
  ...CrmFindDuplicatesInputShape,
  filter: z.record(z.unknown()).optional()
    .describe('structured filter; recursive grammar/operators in crm://help/filtering'),
}

export const CrmFindDuplicates = {
  in: z.object(CrmFindDuplicatesInputShape).strict(),
  out: z.object({ taskId: Uuid }),
}

export const FindDuplicatesProgress = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().positive(),
}).strict()

export const FindDuplicatesResult = z.object({
  groups: z.array(z.object({
    records: z.array(RecordSummary).min(2),
    evidence: z.array(CandidateEvidence).min(1),
  }).strict()),
}).strict()

export const FindDuplicatesActorContext = z.object({
  tenant: z.object({ organizationId: Uuid, teamId: Uuid }).strict(),
  app: z.string().min(1),
  actChain: z.array(z.object({ sub: z.string(), product: z.string() }).strict()),
  actor: z.object({ type: z.enum(['human', 'agent', 'system']), id: z.string().min(1) }).strict(),
  onBehalfOf: z.object({
    uoaUserId: z.string().min(1),
    role: z.enum(['owner', 'admin', 'member']).nullable(),
  }).strict(),
  provenance: z.object({
    runId: z.string(), toolCallId: z.string(), requestId: z.string(),
  }).strict().nullable(),
  requestId: z.string().min(1),
}).strict()

export const FindDuplicatesPayload = z.object({
  organizationId: Uuid,
  teamId: Uuid,
  objectType: Slug,
  filter: Filter.optional(),
  includeSemantic: z.boolean(),
  embeddingModel: z.string().min(1),
  requestedAt: IsoDateTime,
  actorContext: FindDuplicatesActorContext,
}).strict()
