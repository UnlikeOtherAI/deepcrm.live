import { z } from 'zod'

import { Filter, Sort } from './filter.js'
import { ActorType, IdempotencyKey, IsoDateTime, Limit, Reason, Slug, Uuid } from './primitives.js'
import {
  EventDetail,
  EventTypeDetail,
  FileLinkDetail,
  FileLinkTargetType,
  FileObjectDetail,
} from './semantic-foundation.js'
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

const JsonObject = z.record(z.unknown())

export const CrmFileRegister = {
  in: z.object({
    provider: z.string().min(1).max(60)
      .describe('storage provider key; DeepCRM stores metadata only, never blobs'),
    provider_key: z.string().min(1).max(500)
      .describe('provider object key; never a signed URL or bearer token'),
    filename: z.string().min(1).max(255)
      .describe('original filename shown to agents'),
    mime_type: z.string().min(3).max(200)
      .describe('validated MIME type such as application/pdf'),
    size_bytes: z.string().regex(/^(0|[1-9]\d*)$/u)
      .describe('non-negative byte size as a decimal string'),
    checksum_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional()
      .describe('optional lowercase hex sha256 checksum of provider object bytes'),
    metadata: JsonObject.optional()
      .describe('redacted provider metadata; no tokens, URLs, or raw file content'),
  }),
  out: z.object({ file: FileObjectDetail }),
}

export const CrmFileLink = {
  in: z.object({
    file_id: Uuid.describe('file metadata id returned by crm_file_register'),
    target_type: FileLinkTargetType.describe('target kind: record, activity, or event'),
    record_id: Uuid.optional()
      .describe('visible record/activity target id when target_type is record or activity'),
    event_id: Uuid.optional()
      .describe('visible event target id when target_type is event'),
    purpose: z.string().min(1).max(80)
      .describe('typed attachment purpose such as contract, transcript, or evidence'),
    metadata: JsonObject.optional()
      .describe('redacted link metadata; no raw file content or secrets'),
  }),
  out: z.object({ link: FileLinkDetail }),
}

export const CrmFileList = {
  in: z.object({
    target_type: FileLinkTargetType.optional()
      .describe('optional target kind filter'),
    record_id: Uuid.optional()
      .describe('visible record/activity target id filter'),
    event_id: Uuid.optional()
      .describe('visible event target id filter'),
    limit: Limit.describe('maximum file links to return; defaults to 50'),
  }),
  out: z.object({
    files: z.array(z.object({
      file: FileObjectDetail,
      link: FileLinkDetail,
      access: z.object({
        url: z.string().url().describe('signed short-lived DeepCRM access URL; provider key is not embedded'),
        expires_at: IsoDateTime,
      }),
    })),
  }),
}

export const CrmEventTypeDefine = {
  in: z.object({
    slug: Slug.describe('stable event type slug such as product_feature_used'),
    name: z.string().min(1).max(120).describe('agent-facing event type name'),
    description: z.string().max(500).optional().describe('what this event means'),
    subject_object_type: Slug.optional()
      .describe('required subject record object type, when constrained'),
    property_schema: JsonObject.optional()
      .describe('closed JSON object schema for event properties'),
  }),
  out: z.object({ event_type: EventTypeDetail }),
}

export const CrmEventIngest = {
  in: z.object({
    event_type: Slug.describe('active event type slug'),
    source: z.string().min(1).max(120).describe('stable source or integration key'),
    external_id: z.string().min(1).max(200)
      .describe('source-scoped idempotency key'),
    occurred_at: IsoDateTime.describe('when the behaviour happened'),
    subject_record_id: Uuid.optional()
      .describe('visible subject record id, required when the event type has a subject object type'),
    actor: z.object({
      type: ActorType.describe('actor type recorded on the event'),
      id: z.string().min(1).max(200).describe('actor id recorded on the event'),
    }).optional().describe('optional product actor responsible for the event'),
    properties: JsonObject.optional()
      .describe('typed event properties validated against the event type schema'),
    correction_of_event_id: Uuid.optional()
      .describe('event id corrected by this append-only correction event'),
  }),
  out: z.object({ event: EventDetail, created: z.boolean() }),
}

export const CrmEventsQuery = {
  in: z.object({
    event_type: Slug.optional().describe('optional event type slug filter'),
    subject_record_id: Uuid.optional().describe('visible subject record id filter'),
    source: z.string().min(1).max(120).optional().describe('optional source key filter'),
    cursor: z.string().optional().describe('opaque cursor returned by a previous crm_events_query page'),
    limit: Limit.describe('maximum events to return; defaults to 50'),
  }),
  out: z.object({
    events: z.array(EventDetail),
    next_cursor: z.string().nullable(),
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
