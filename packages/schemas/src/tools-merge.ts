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

const UnmergeConflict = z.object({
  kind: z.enum(['unique_key', 'matching_rule', 'link', 'list_entry'])
    .describe('constraint that prevents restoration'),
  attribute: Slug.optional().describe('attribute involved in a key or matching collision'),
  rule_position: z.number().int().nonnegative().optional()
    .describe('matching-rule tuple position involved in the collision'),
  link_id: Uuid.optional().describe('link that cannot be restored'),
  held_by: Uuid.optional().describe('visible record currently holding the conflicting value or edge'),
}).strict()

export const CrmUnmerge = {
  in: z.object({
    merge_change_id: Uuid.describe('merge change id returned by crm_merge_records'),
    reason: z.string().min(1).max(500).describe('required audit reason for undoing the merge'),
  }).strict(),
  out: z.object({
    restored: z.array(Uuid).describe('loser record ids restored to live records'),
    conflicts: z.array(UnmergeConflict)
      .describe('collisions that prevented restoration; restored is empty when present'),
  }).strict(),
}
