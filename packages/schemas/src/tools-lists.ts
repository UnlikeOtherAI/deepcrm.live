import { z } from 'zod'

import { Filter, Sort } from './filter.js'
import { Cursor, Limit, Slug, Uuid } from './primitives.js'
import { AttributeDetail, AttributeSpec } from './schema-specs.js'
import { DynamicListDefinitionState, ListKind, ListRefreshState } from './semantic-foundation.js'
import { CrmRecordsQuery, RecordOut } from './tools-records.js'

export const ListDetail = z.object({
  id: Uuid,
  slug: Slug,
  name: z.string(),
  description: z.string(),
  kind: ListKind,
  object_type: Slug.nullable(),
  definition: DynamicListDefinitionState.nullable(),
  refresh_state: ListRefreshState,
  refresh_error_code: z.string().nullable(),
  last_evaluated_at: z.string().nullable(),
  attributes: z.array(AttributeDetail),
  entry_count: z.number().int().nonnegative(),
})

export const CrmListCreate = {
  in: z.object({
    slug: Slug.describe('stable list slug'),
    name: z.string().min(1).max(120).describe('agent-facing list name'),
    description: z.string().max(500).optional().describe('what membership in this list means'),
    kind: ListKind.default('static').describe('static curated list or dynamic segment'),
    object_type: Slug.optional().describe('restrict entries to one active object type; omit for mixed'),
    filter: z.record(z.unknown()).optional()
      .describe('dynamic-list structured filter; recursive grammar/operators in crm://help/filtering'),
    attributes: z.array(AttributeSpec).max(20).optional()
      .describe('typed values stored per list entry, such as priority'),
  }),
  out: ListDetail,
}

export const CrmListUpdate = {
  in: z.object({
    list: Slug.describe('list slug to update'),
    name: z.string().min(1).max(120).optional().describe('replacement agent-facing list name'),
    description: z.string().max(500).optional().describe('replacement list description'),
    filter: z.record(z.unknown()).optional()
      .describe('replacement dynamic-list structured filter; only valid for dynamic lists'),
  }),
  out: ListDetail,
}

export const CrmListStatus = {
  in: z.object({
    list: Slug.describe('dynamic list slug whose evaluation status should be read'),
  }),
  out: z.object({ status: DynamicListDefinitionState }),
}

export const CrmListAdd = {
  in: z.object({
    list: Slug.describe('target list slug'),
    entries: z.array(z.object({
      record_id: Uuid.describe('visible live record to add'),
      data: z.record(Slug, z.unknown()).optional()
        .describe('values validated against this list entry schema'),
    })).min(1).max(500).describe('one to 500 entries'),
  }),
  out: z.object({ added: z.number().int().nonnegative() }),
}

export const CrmListRemove = {
  in: z.object({
    list: Slug.describe('target list slug'),
    record_ids: z.array(Uuid).min(1).max(500).describe('records to remove from the list'),
  }),
  out: z.object({ removed: z.number().int().nonnegative() }),
}

export const CrmListEntries = {
  in: z.object({
    list: Slug.describe('list slug to read'),
    cursor: Cursor,
    limit: Limit,
  }),
  out: z.object({
    entries: z.array(z.object({
      entry: z.object({
        id: Uuid,
        data: z.record(Slug, z.unknown()),
        position: z.number().int(),
      }),
      record: RecordOut,
    })),
    next_cursor: z.string().nullable(),
    list: z.object({
      kind: ListKind,
      refresh_state: ListRefreshState,
      evaluation_version: z.number().int().nonnegative(),
    }),
  }),
}

export const ViewDetail = z.object({
  id: Uuid,
  slug: Slug,
  name: z.string(),
  description: z.string(),
  object_type: Slug,
  filter: Filter,
  sort: Sort,
  attributes: z.array(Slug),
})

export const CrmViewSave = {
  in: z.object({
    slug: Slug.describe('stable saved-view slug'),
    name: z.string().min(1).max(120).describe('agent-facing view name'),
    object_type: Slug.describe('active object type queried by the view'),
    filter: Filter.describe('stored structured exact filter'),
    sort: Sort.optional().describe('stored sort; defaults to created_at descending'),
    attributes: z.array(Slug).max(100).optional().describe('stored output attribute projection'),
    description: z.string().max(500).optional().describe('when an agent should use this view'),
  }),
  out: ViewDetail,
}

// The MCP SDK JSON-schema exporter cannot traverse the recursive Filter schema.
export const CrmViewSaveToolInput = CrmViewSave.in.extend({
  filter: z.record(z.unknown())
    .describe('structured filter; recursive grammar/operators in crm://help/filtering'),
})

export const CrmViewRun = {
  in: z.object({
    view: Slug.describe('saved-view slug to execute'),
    cursor: Cursor,
    limit: Limit,
  }),
  out: CrmRecordsQuery.out,
}

export const CrmViewDelete = {
  in: z.object({ view: Slug.describe('saved-view slug to delete') }),
  out: z.object({ deleted: z.literal(true) }),
}
