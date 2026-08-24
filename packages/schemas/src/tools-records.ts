import { z } from 'zod'
import { Actor, Cursor, ExpectedVersion, IdempotencyKey, IsoDateTime, Limit, Reason, Slug, Uuid } from './primitives.js'
import { Filter, Sort } from './filter.js'
import { Candidate } from './matching.js'

export const Visibility = z.enum(['team', 'users', 'private'])
  .describe('who can see this record; admins do not bypass record visibility')
export const RecordData = z.record(Slug, z.unknown()).describe('attribute slug to typed value')
export const RecordSummary = z.object({ id: Uuid, object_type: Slug, display_name: z.string() })
export const RecordOut = RecordSummary.extend({
  version: z.number().int(), data: RecordData, visibility: Visibility, origin: z.string().nullable(),
  owner: Actor.nullable(), created_at: IsoDateTime, updated_at: IsoDateTime,
  last_activity_at: IsoDateTime.nullable(), redacted_attributes: z.array(Slug),
  redirected_from: Uuid.optional(),
})
export const LinkInput = z.object({
  relation_type: Slug.describe('active relation slug from the new record to to_record_id'),
  to_record_id: Uuid.describe('existing target record id'),
  data: z.record(Slug, z.unknown()).optional().describe('typed edge values'),
  label: z.string().max(120).optional().describe('optional link label'),
})
const Common = { reason: Reason, idempotency_key: IdempotencyKey }
export const LinkOut = z.object({
  id: Uuid, relation_type: Slug, from_record_id: Uuid, to_record_id: Uuid,
  label: z.string().nullable(), data: z.record(Slug, z.unknown()),
  active_from: IsoDateTime, active_until: IsoDateTime.nullable(),
})
export const Change = z.object({
  id: Uuid, seq: z.string(), resulting_version: z.number().int(), record: RecordSummary.nullable(),
  group_id: Uuid.nullable(), kind: z.enum(['create', 'set', 'unset', 'link', 'unlink', 'delete', 'restore', 'merge', 'unmerge', 'erase', 'schema']),
  attribute: Slug.nullable(), relation_type: Slug.nullable(), link_id: Uuid.nullable(),
  old_value: z.unknown().optional(), new_value: z.unknown().optional(),
  actor: z.object({ type: z.enum(['human', 'agent', 'system']), id: z.string() }), on_behalf_of: z.string().nullable(),
  provenance: z.object({
    run_id: z.string().nullable(), tool_call_id: z.string().nullable(), request_id: z.string(),
  }),
  reason: z.string().nullable(), occurred_at: IsoDateTime,
})
export const TimelineItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('activity'), record: RecordOut, about: z.array(RecordSummary), occurred_at: IsoDateTime }),
  z.object({ kind: z.literal('note'), record: RecordOut, about: z.array(RecordSummary), occurred_at: IsoDateTime }),
  z.object({ kind: z.literal('task'), record: RecordOut, about: z.array(RecordSummary), occurred_at: IsoDateTime }),
  z.object({ kind: z.literal('change'), change: Change, occurred_at: IsoDateTime }),
])
const VisibilityArgs = {
  visibility: Visibility.optional().describe('record visibility; defaults to team'),
  visible_to: z.array(z.string().min(1)).max(100).optional().describe('UOA users granted access; implies users visibility'),
  origin: z.string().max(64).optional().describe('set-once source class checked by the write guard'),
}
export const CrmRecordCreate = { in: z.object({
  object_type: Slug.describe('object type slug'), data: RecordData, links: z.array(LinkInput).max(50).optional().describe('links created atomically with the record'),
  owner: Actor.optional().describe('record owner'), ...VisibilityArgs, ...Common,
}), out: z.object({ record: RecordOut, duplicates: z.array(Candidate).optional() }) }
export const CrmRecordUpdate = { in: z.object({
  id: Uuid.describe('record id'), data: RecordData.describe('patch; null clears a field'), owner: Actor.nullable().optional().describe('replacement owner or null'),
  ...VisibilityArgs, expected_version: ExpectedVersion, ...Common,
}), out: z.object({ record: RecordOut }) }
export const CrmRecordAssert = { in: z.object({
  object_type: Slug.describe('object type slug'), match_attribute: Slug.describe('unique attribute in data'), data: RecordData,
  links: z.array(LinkInput).max(50).optional().describe('links created or applied atomically'), owner: Actor.optional().describe('owner on create'), ...Common,
}), out: z.object({ record: RecordOut, created: z.boolean(), duplicates: z.array(Candidate).optional() }) }
export const CrmRecordGetInput = z.object({
  id: Uuid.optional().describe('record id'), object_type: Slug.optional().describe('object type for unique lookup'),
  match_attribute: Slug.optional().describe('unique attribute for lookup'), value: z.unknown().optional().describe('unique attribute value'),
  include_links: z.boolean().default(false).describe('group active visible links by relation'),
  include_timeline: z.number().int().min(0).max(50).default(0).describe('recent timeline item count'),
})
export const CrmRecordGet = { in: CrmRecordGetInput.refine((value) => value.id !== undefined || (value.object_type !== undefined && value.match_attribute !== undefined && value.value !== undefined), 'id, or object_type + match_attribute + value'), out: z.object({ record: RecordOut, links: z.record(Slug, z.array(z.object({ link: LinkOut, related: RecordSummary }))).optional(), timeline: z.array(TimelineItem).optional() }) }
export const CrmRecordsQuery = { in: z.object({ object_type: Slug.describe('object type slug'), filter: Filter.optional().describe('structured exact filter'), sort: Sort.optional().describe('ordered sort keys'), attributes: z.array(Slug).max(50).optional().describe('attributes to project'), include_total: z.boolean().default(false).describe('include exact total'), cursor: Cursor, limit: Limit }), out: z.object({ records: z.array(RecordOut), next_cursor: z.string().nullable(), total: z.number().int().optional() }) }
// The MCP SDK's JSON-schema exporter cannot traverse z.lazy(Filter). The service parses this
// field again with Filter, while discovery receives a bounded opaque JSON argument description.
export const CrmRecordsQueryToolInput = CrmRecordsQuery.in.extend({
  filter: z.record(z.unknown()).optional().describe('structured filter; recursive grammar/operators in crm://help/filtering'),
})
export const CrmRecordsCount = {
  in: z.object({
    object_type: Slug.describe('object type slug to count'),
    filter: Filter.optional().describe('structured exact filter'),
  }),
  out: z.object({ count: z.number().int().nonnegative() }),
}
export const CrmRecordsCountToolInput = CrmRecordsCount.in.extend({
  filter: z.record(z.unknown()).optional()
    .describe('structured filter; recursive grammar/operators in crm://help/filtering'),
})
export const CrmRecordsGetMany = {
  in: z.object({
    ids: z.array(Uuid).min(1).max(100)
      .describe('one to 100 record ids; records and missing preserve input order'),
  }),
  out: z.object({
    records: z.array(RecordOut),
    missing: z.array(Uuid),
  }),
}
export const CrmRecordDelete = { in: z.object({ id: Uuid.describe('record id'), expected_version: ExpectedVersion, reason: Reason }), out: z.object({ deleted: z.literal(true) }) }
export const CrmRecordRestore = { in: z.object({ id: Uuid.describe('soft-deleted record id') }), out: z.object({ record: RecordOut }) }
export const CrmRecordAt = { in: z.object({ id: Uuid.describe('record id'), at: IsoDateTime.describe('point in time') }), out: z.object({ record_at: z.object({ data: RecordData, links: z.record(Slug, z.array(LinkOut)), version_at: z.number().int(), as_of: IsoDateTime }) }) }
export const CrmRecordHistory = { in: z.object({ id: Uuid.describe('record id'), attributes: z.array(Slug).optional().describe('attribute history to include'), cursor: Cursor, limit: Limit }), out: z.object({ changes: z.array(Change), next_cursor: z.string().nullable() }) }
