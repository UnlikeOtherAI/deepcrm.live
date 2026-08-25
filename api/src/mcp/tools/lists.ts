import {
  CrmListAdd,
  CrmListCreate,
  CrmListEntries,
  CrmListRemove,
  CrmListStatus,
  CrmListUpdate,
  CrmViewDelete,
  CrmViewRun,
  CrmViewSaveToolInput,
  Filter,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import {
  addListEntries,
  createList,
  deleteView,
  listStatus,
  listEntries,
  removeListEntries,
  runView,
  saveView,
  updateList,
} from '../../services/lists.js'
import { defineTool } from './register.js'
import { ok } from './result.js'

function jsonResult(value: Record<string, unknown>) {
  return ok(value, JSON.stringify(value))
}

export function registerListTools(
  server: Parameters<typeof defineTool>[0], ctx: ActorContext, deps: AppDeps,
): void {
  defineTool(server, {
    name: 'crm_list_create',
    description: 'Create a curated single-object or mixed-record list with optional typed entry attributes. Entry metadata uses the same validation rules as record data. Errors: policy denial, unknown object type, or schema conflict.',
    input: CrmListCreate.in.shape,
    handler: async (args) => jsonResult(await createList(deps, ctx, {
      slug: args.slug, name: args.name, description: args.description,
      kind: args.kind, objectType: args.object_type, filter: args.filter, attributes: args.attributes,
    })),
  })
  defineTool(server, {
    name: 'crm_list_update',
    description: 'Update list metadata; for dynamic lists, replacing filter schedules a membership refresh and advances evaluation_version. Static lists reject filter changes.',
    input: CrmListUpdate.in.shape,
    handler: async (args) => jsonResult(await updateList(deps, ctx, {
      list: args.list, name: args.name, description: args.description, filter: args.filter,
    })),
  })
  defineTool(server, {
    name: 'crm_list_status',
    description: 'Read dynamic-list evaluation state, object scope, filter, version, error code and last completed evaluation time.',
    input: CrmListStatus.in.shape,
    handler: async (args) => jsonResult(await listStatus(deps, ctx, args.list)),
  })
  defineTool(server, {
    name: 'crm_list_add',
    description: 'Add visible live records to a curated list. Data is validated against list attributes; existing memberships are unchanged and excluded from added. Errors: policy denial, NOT_FOUND, or invalid object type/data.',
    input: CrmListAdd.in.shape,
    handler: async (args) => jsonResult(await addListEntries(deps, ctx, {
      list: args.list,
      entries: args.entries.map((entry) => ({ recordId: entry.record_id, data: entry.data })),
    })),
  })
  defineTool(server, {
    name: 'crm_list_remove',
    description: 'Remove visible record memberships from a curated list. Missing memberships are ignored. Errors: policy denial or NOT_FOUND for the list or a hidden/foreign record.',
    input: CrmListRemove.in.shape,
    handler: async (args) => jsonResult(await removeListEntries(
      deps, ctx, args.list, args.record_ids,
    )),
  })
  defineTool(server, {
    name: 'crm_list_entries',
    description: 'Read a cursor page of list entries joined to visible, policy-permitted live records. Entry attributes and record data are redacted independently. Errors: policy denial, NOT_FOUND, or cursor mismatch.',
    input: CrmListEntries.in.shape,
    handler: async (args) => jsonResult(await listEntries(deps, ctx, {
      list: args.list, cursor: args.cursor, limit: args.limit,
    })),
  })
  defineTool(server, {
    name: 'crm_view_save',
    description: 'Create or replace a reusable structured record query. Filters, sort keys and projected attributes are validated against the active schema. Exact replays are no-ops. Errors: policy denial or invalid query metadata.',
    input: CrmViewSaveToolInput.shape,
    handler: async (args) => jsonResult(await saveView(deps, ctx, {
      slug: args.slug, name: args.name, objectType: args.object_type,
      filter: Filter.parse(args.filter), sort: args.sort, attributes: args.attributes,
      description: args.description,
    })),
  })
  defineTool(server, {
    name: 'crm_view_run',
    description: 'Run a saved view with current row visibility, policy and attribute redaction. The opaque cursor is bound to the saved definition. Use crm_records_query for an ad hoc filter. Errors: policy denial, NOT_FOUND, or cursor mismatch.',
    input: CrmViewRun.in.shape,
    handler: async (args) => jsonResult(await runView(
      deps, ctx, args.view, args.cursor, args.limit,
    )),
  })
  defineTool(server, {
    name: 'crm_view_delete',
    description: 'Delete a saved view by slug and invalidate the schema resource version. This does not delete records. Errors: policy denial or NOT_FOUND.',
    input: CrmViewDelete.in.shape,
    handler: async (args) => jsonResult(await deleteView(deps, ctx, args.view)),
  })
}
