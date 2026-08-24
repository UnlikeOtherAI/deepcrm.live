import { z } from 'zod'

import { Limit, Slug } from './primitives.js'
import { Change } from './tools-records.js'

export const FeedChangeKind = z.enum([
  'create', 'set', 'unset', 'link', 'unlink', 'delete', 'restore', 'merge', 'unmerge', 'schema',
])
export type FeedChangeKindValue = z.infer<typeof FeedChangeKind>

export const FeedEventName = z.enum([
  'record.created', 'record.updated', 'record.deleted', 'record.merged',
  'link.created', 'link.ended', 'schema.changed',
])

export const FeedChange = Change.extend({
  event: FeedEventName,
})
export type FeedChangeValue = z.infer<typeof FeedChange>

export const CrmChangesSince = {
  in: z.object({
    cursor: z.string().regex(/^\d+$/u).optional()
      .describe('last per-team decimal sequence seen; omit to start at now'),
    from: z.literal('beginning').optional()
      .describe('explicitly replay retained history; cannot be combined with cursor'),
    object_types: z.array(Slug).max(50).optional()
      .describe('optional object type slugs; no ambient object filter is applied'),
    kinds: z.array(FeedChangeKind).max(10).optional()
      .describe('optional change kinds; schema is the external name for schema changes'),
    limit: Limit.describe('maximum visible changes to return; defaults to 50, maximum 200'),
  }),
  out: z.object({
    changes: z.array(FeedChange),
    next_cursor: z.string(),
    has_more: z.boolean(),
  }),
}
