import { z } from 'zod'

import { Filter } from './filter.js'
import { Slug } from './primitives.js'
import { RecordSummary } from './tools-records.js'

export const CrmDataQualityInputShape = {
  object_type: Slug.optional()
    .describe('active object type to inspect; omit for a workspace-wide overview'),
  stale_days: z.number().int().min(1).max(3650).default(90)
    .describe('records with no activity inside this many days are stale'),
}

export const CrmDataQualityToolInputShape = CrmDataQualityInputShape

const QualityBucket = z.object({
  count: z.number().int().nonnegative().describe('visible records in this quality category'),
  items: z.array(z.object({
    record: RecordSummary.describe('visible record needing attention'),
    detail: z.string().min(1).describe('structural reason the record is in this category'),
  }).strict()).max(100).describe('first one hundred records in stable order'),
  query_filter: Filter.describe('pass to crm_records_query with the same object_type to paginate'),
}).strict()

export const CrmDataQuality = {
  in: z.object(CrmDataQualityInputShape).strict(),
  out: z.object({
    missing_required: QualityBucket,
    stale: QualityBucket,
    orphans: QualityBucket,
    collisions: QualityBucket,
  }).strict(),
}
