import { z } from 'zod'

import { CurrencyValue, StatusOption } from './attribute-values.js'
import { Filter } from './filter.js'
import { IsoDateTime, Slug } from './primitives.js'

export const CrmPipelineSummary = {
  in: z.object({
    object_type: Slug.describe('object type whose status pipeline should be summarized'),
    status_attribute: Slug.optional()
      .describe('status attribute slug; omitted selects the only active status attribute'),
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
      category: StatusOption.shape.category,
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
