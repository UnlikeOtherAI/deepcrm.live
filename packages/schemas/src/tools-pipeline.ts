import { z } from 'zod'

import { CurrencyValue } from './attribute-values.js'
import { Filter } from './filter.js'
import { IdempotencyKey, IsoDateTime, Reason, Slug, Uuid } from './primitives.js'
import { PipelineDetail, PipelineStageCategory, PipelineStageDetail } from './semantic-foundation.js'

const StageSpec = z.object({
  slug: Slug.describe('stable stage slug'),
  name: z.string().min(1).max(120).describe('stage display name'),
  position: z.number().int().min(0).describe('zero-based order in the pipeline'),
  probability: z.number().min(0).max(1).optional().describe('optional expected close probability'),
  category: PipelineStageCategory.default('open').describe('open, won, lost or neutral category'),
}).strict()

export const CrmPipelineDefine = {
  in: z.object({
    object_type: Slug.describe('object type this pipeline applies to'),
    slug: Slug.describe('stable pipeline slug'),
    name: z.string().min(1).max(120).describe('agent-facing pipeline name'),
    description: z.string().max(500).optional().describe('when agents should use this pipeline'),
    is_default: z.boolean().default(false).describe('make this the default pipeline for the object type'),
    stages: z.array(StageSpec).min(1).max(100).describe('complete initial ordered stage catalog'),
  }).strict(),
  out: PipelineDetail,
}

export const CrmPipelineUpdate = {
  in: z.object({
    object_type: Slug.describe('object type that owns the pipeline'),
    pipeline: Slug.describe('pipeline slug to update'),
    name: z.string().min(1).max(120).optional().describe('new pipeline display name'),
    description: z.string().max(500).optional().describe('new agent-facing pipeline purpose'),
    is_default: z.boolean().optional().describe('make this pipeline the object type default'),
  }).strict(),
  out: PipelineDetail,
}

export const CrmPipelineStageSet = {
  in: z.object({
    record_id: Uuid.describe('visible live record whose stage should change'),
    pipeline: Slug.describe('pipeline slug'),
    stage: Slug.describe('target active stage slug'),
    occurred_at: IsoDateTime.optional().describe('effective transition time; defaults to now'),
    reason: Reason,
    idempotency_key: IdempotencyKey,
  }).strict(),
  out: z.object({
    record_id: Uuid,
    pipeline: Slug,
    stage: Slug,
    changed: z.boolean(),
    interval_id: Uuid.nullable(),
  }).strict(),
}

export const CrmPipelineStagesList = {
  in: z.object({
    object_type: Slug.describe('object type that owns the pipeline'),
    pipeline: Slug.describe('pipeline slug to inspect'),
  }).strict(),
  out: z.object({
    pipeline: PipelineDetail,
    stages: z.array(PipelineStageDetail),
  }).strict(),
}

export const CrmPipelineSummary = {
  in: z.object({
    object_type: Slug.describe('object type whose pipeline should be summarized'),
    pipeline: Slug.optional().describe('pipeline slug; omitted selects the default active pipeline'),
    amount_attribute: Slug.optional()
      .describe('currency attribute to sum per stage; requires a fixed currency'),
    filter: Filter.optional().describe('structured record filter applied before aggregation'),
    since: IsoDateTime.optional()
      .describe('include conversions occurring at or after this timestamp'),
  }).strict(),
  out: z.object({
    stages: z.array(z.object({
      id: Slug,
      label: z.string(),
      category: PipelineStageCategory,
      count: z.number().int().nonnegative(),
      amount_sum: CurrencyValue.nullable(),
      avg_days_in_stage: z.number().nonnegative().nullable(),
    }).strict()),
    conversions: z.array(z.object({
      from: Slug,
      to: Slug,
      count: z.number().int().nonnegative(),
    }).strict()),
  }).strict(),
}

// The MCP SDK cannot traverse recursive z.lazy(Filter); the service parses it again.
export const CrmPipelineSummaryToolInput = CrmPipelineSummary.in.extend({
  filter: z.record(z.unknown()).optional()
    .describe('structured filter; recursive grammar/operators in crm://help/filtering'),
})
