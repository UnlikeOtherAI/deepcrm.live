import { z } from 'zod'

import { SlugSchema, UuidSchema } from './ids.js'

export const MatchingRule = z.object({
  attributes: z.array(SlugSchema).min(1).max(4)
    .describe('attribute slugs compared in declared order'),
  method: z.enum(['exact', 'normalized', 'fuzzy'])
    .describe('comparison method'),
  threshold: z.number().min(0.5).max(1).optional()
    .describe('fuzzy-only trigram threshold'),
  action: z.enum(['block', 'warn'])
    .describe('block rejects a collision; warn returns candidates'),
})
export type MatchingRule = z.infer<typeof MatchingRule>

export const MatchingRuleActivation = z.discriminatedUnion('state', [
  z.object({ state: z.literal('active').describe('rules are effective'), taskId: z.null() }),
  z.object({ state: z.literal('pending_backfill').describe('old generation remains effective'), taskId: z.string().uuid() }),
  z.object({
    state: z.literal('collision_blocked').describe('replacement cannot activate until collisions are resolved'),
    taskId: z.string().uuid(),
    group_count: z.number().int().nonnegative(),
    record_count: z.number().int().nonnegative(),
  }),
])
export type MatchingRuleActivation = z.infer<typeof MatchingRuleActivation>

export const CandidateEvidence = z.object({
  kind: z.enum(['unique', 'exact', 'normalized', 'fuzzy', 'semantic']),
  attribute: SlugSchema.nullable(),
  matched: z.literal(true),
  value: z.unknown().optional(),
  score: z.number().optional(),
})
export const Candidate = z.object({
  record: z.object({ id: UuidSchema, object_type: SlugSchema, display_name: z.string() }),
  rule_position: z.number().int().nullable(),
  evidence: z.array(CandidateEvidence),
})
export type Candidate = z.infer<typeof Candidate>
