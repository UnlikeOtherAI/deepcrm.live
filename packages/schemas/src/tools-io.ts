import { z } from 'zod'

import { Filter, Sort } from './filter.js'
import { IdempotencyKey, IsoDateTime, Limit, Reason, Slug, Uuid } from './primitives.js'
import { BulkAssertActorContext, McpTask } from './tools-bulk.js'
import { Change } from './tools-records.js'

export const ExportFormat = z.enum(['jsonl', 'csv'])

export const CrmExportInputShape = {
  object_type: Slug.optional()
    .describe('active object type to export; mutually exclusive with view'),
  view: Slug.optional()
    .describe('saved view whose object type, filter, and sort define the export'),
  format: ExportFormat.describe('jsonl emits one attribute object per line; csv uses RFC 4180'),
  attributes: z.array(Slug).max(100).optional()
    .describe('exact attribute columns; defaults to the view projection or all active attributes'),
  reason: Reason,
  idempotency_key: IdempotencyKey,
}

export const CrmExport = {
  in: z.object(CrmExportInputShape).strict()
    .refine((input) => (input.object_type === undefined) !== (input.view === undefined), {
      message: 'exactly one of object_type or view is required',
    }),
  out: z.object({ task: McpTask }).strict(),
}

export const ExportProgress = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict()

export const ExportResult = z.object({
  url: z.string().url(),
  rows: z.number().int().nonnegative(),
  expires_at: IsoDateTime,
}).strict()

export const ExportPayload = z.object({
  organizationId: Uuid,
  teamId: Uuid,
  objectType: Slug,
  filter: Filter.optional(),
  sort: Sort,
  attributes: z.array(Slug).max(100),
  format: ExportFormat,
  reason: z.string().max(500).optional(),
  argumentsHash: z.string().regex(/^[a-f0-9]{64}$/u),
  actorContext: BulkAssertActorContext,
}).strict()

export const FeedChangeKind = z.enum([
  'create', 'set', 'unset', 'link', 'unlink', 'delete', 'restore', 'merge', 'unmerge', 'erase', 'schema',
])
export type FeedChangeKindValue = z.infer<typeof FeedChangeKind>

export const FeedEventName = z.enum([
  'record.created', 'record.updated', 'record.deleted', 'record.merged', 'record.erased',
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

export const WebhookEvent = FeedEventName
export type WebhookEventValue = z.infer<typeof WebhookEvent>

export const WebhookOut = z.object({
  id: Uuid,
  url: z.string().url(),
  events: z.array(WebhookEvent),
  active: z.boolean(),
  last_error: z.string().nullable(),
})

export const CrmWebhookSet = {
  in: z.object({
    url: z.string().url()
      .describe('public HTTPS webhook URL on port 443; identity for upsert'),
    events: z.array(WebhookEvent).min(1)
      .describe('event names delivered to this webhook'),
    active: z.boolean().default(true)
      .describe('enable delivery; re-enabling resumes from the stored cursor'),
    rotate_secret: z.boolean().default(false)
      .describe('mint and return a new secret for an existing webhook'),
  }),
  out: z.object({
    webhook: WebhookOut,
    secret: z.string().optional(),
  }),
}

export const CrmWebhookList = {
  in: z.object({}),
  out: z.object({ webhooks: z.array(WebhookOut) }),
}

export const CrmWebhookDelete = {
  in: z.object({ id: Uuid.describe('webhook id returned by crm_webhook_list') }),
  out: z.object({ deleted: z.literal(true) }),
}
