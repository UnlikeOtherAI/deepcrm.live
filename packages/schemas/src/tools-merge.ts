import { z } from 'zod'

import { Slug, Uuid } from './primitives.js'
import { RecordOut } from './tools-records.js'

export const CrmMergeRecords = {
  in: z.object({
    survivor_id: Uuid.describe('visible record that remains active after the merge'),
    merged_ids: z.array(Uuid).min(1).max(10)
      .describe('one to ten visible same-type records that become redirects'),
    field_choices: z.record(Slug, Uuid).optional()
      .describe('attribute slug to merge-set record id whose value wins wholesale'),
    reason: z.string().min(1).max(500).describe('required audit reason for merging the records'),
  }).strict(),
  out: z.object({
    record: RecordOut.describe('policy-redacted surviving record'),
    merge_change_id: Uuid.describe('change id accepted by crm_unmerge'),
    repointed_links: z.number().int().nonnegative().describe('active links re-pointed to the survivor'),
    ended_links: z.array(Uuid).describe('links ended for self, duplicate, or cardinality conflicts'),
  }).strict(),
}
