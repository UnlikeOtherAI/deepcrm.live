import { z } from 'zod'

import { Cursor, IdempotencyKey, Limit, Reason, Slug, Uuid } from './primitives.js'
import { LinkOut, RecordSummary } from './tools-records.js'

export const CrmLink = {
  in: z.object({
    relation_type: Slug.describe('active relation type slug'),
    from_record_id: Uuid.describe('source record id'),
    to_record_id: Uuid.describe('target record id'),
    data: z.record(Slug, z.unknown()).optional().describe('typed edge attribute values'),
    label: z.string().max(120).optional().describe('optional link label'),
    reason: Reason,
    idempotency_key: IdempotencyKey,
  }),
  out: z.object({
    link: LinkOut,
    ended_links: z.array(Uuid).describe('links ended by cardinality replacement'),
  }),
}

export const CrmUnlinkInput = z.object({
  link_id: Uuid.optional().describe('active link id; use instead of the relation triple when known'),
  relation_type: Slug.optional().describe('relation type slug for triple lookup'),
  from_record_id: Uuid.optional().describe('source record id for triple lookup'),
  to_record_id: Uuid.optional().describe('target record id for triple lookup'),
  reason: Reason,
})

export const CrmUnlink = {
  in: CrmUnlinkInput.refine((args) => (
    args.link_id !== undefined
    || (args.relation_type !== undefined
      && args.from_record_id !== undefined
      && args.to_record_id !== undefined)
  ), 'link_id or relation_type + from_record_id + to_record_id is required'),
  out: z.object({
    link_id: Uuid.describe('ended link id; newest active link when the triple was ambiguous'),
  }),
}

export const CrmLinksList = {
  in: z.object({
    record_id: Uuid.describe('record whose visible links are listed'),
    relation_type: Slug.optional().describe('relation type slug to include'),
    direction: z.enum(['from', 'to', 'both']).default('both')
      .describe('link direction relative to record_id'),
    include_history: z.boolean().default(false)
      .describe('include ended links as well as active links'),
    cursor: Cursor,
    limit: Limit,
  }),
  out: z.object({
    links: z.array(z.object({ link: LinkOut, related: RecordSummary })),
    next_cursor: z.string().nullable(),
  }),
}
