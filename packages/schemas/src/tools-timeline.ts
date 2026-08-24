import { z } from 'zod'

import { Cursor, IsoDateTime, Limit, Slug, Uuid } from './primitives.js'
import { TimelineItem } from './tools-records.js'

export const TimelineKind = z.enum(['activity', 'change', 'note', 'task'])

export const CrmRecordTimeline = {
  in: z.object({
    id: Uuid.describe('visible record id whose timeline should be read'),
    hops: z.union([z.literal(0), z.literal(1)]).default(0)
      .describe('0 reads this record; 1 also merges policy-visible linked records into the same page'),
    relation_types: z.array(Slug).max(50).optional()
      .describe('with hops 1, traverse only these active relation slugs; order does not affect cursors'),
    kinds: z.array(TimelineKind).max(4).optional()
      .describe('include only these timeline item kinds; omitted includes all kinds'),
    since: IsoDateTime.optional().describe('include items occurring at or after this timestamp'),
    cursor: Cursor,
    limit: Limit,
  }).strict(),
  out: z.object({
    items: z.array(TimelineItem),
    next_cursor: z.string().nullable(),
  }).strict(),
}
