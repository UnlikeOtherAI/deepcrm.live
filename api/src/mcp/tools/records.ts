import {
  CrmRecordAssert, CrmRecordAt, CrmRecordCreate, CrmRecordDelete, CrmRecordGetInput,
  CrmRecordHistory, CrmRecordRestore, CrmRecordsQueryToolInput, CrmRecordUpdate, Filter,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { getRecord } from '../../services/record-read.js'
import { queryRecords } from '../../services/record-query.js'
import {
  assertRecord, createRecord, deleteRecord, recordAt, recordHistory, restoreRecord, updateRecord,
} from '../../services/records.js'
import { defineTool } from './register.js'
import { ok } from './result.js'

type ToolLink = {
  relation_type: string; to_record_id: string; data?: Record<string, unknown>; label?: string
}

function jsonResult(value: Record<string, unknown>) {
  return ok(value, JSON.stringify(value))
}

function inlineLinks(links: readonly ToolLink[] | undefined) {
  return links?.map((link) => ({
    relationType: link.relation_type, toRecordId: link.to_record_id,
    ...(link.data === undefined ? {} : { data: link.data }),
    ...(link.label === undefined ? {} : { label: link.label }),
  }))
}

export function registerRecordTools(
  server: Parameters<typeof defineTool>[0], ctx: ActorContext, deps: AppDeps,
): void {
  defineTool(server, {
    name: 'crm_record_create',
    description: 'Create one record. Use crm_record_assert for sync-safe upserts. Inline links are atomic. Unique or block collisions return DUPLICATE_FOUND; warn matches return duplicates.',
    input: CrmRecordCreate.in.shape,
    handler: async (args) => {
      const result = await createRecord(deps, ctx, {
        objectType: args.object_type, data: args.data, links: inlineLinks(args.links), owner: args.owner,
        visibility: args.visibility, visibleTo: args.visible_to, origin: args.origin, reason: args.reason,
        idempotencyKey: args.idempotency_key,
      })
      return jsonResult({
        record: result.record,
        ...(result.duplicates === undefined ? {} : { duplicates: result.duplicates }),
      })
    },
  })
  defineTool(server, {
    name: 'crm_record_update',
    description: 'Patch attributes; null clears an attribute. Supply expected_version for concurrency protection. Metadata changes are policy enforced.',
    input: CrmRecordUpdate.in.shape,
    handler: async (args) => {
      const result = await updateRecord(deps, ctx, {
        recordId: args.id, data: args.data, owner: args.owner, visibility: args.visibility,
        visibleTo: args.visible_to, origin: args.origin, expectedVersion: args.expected_version,
        reason: args.reason, idempotencyKey: args.idempotency_key,
      })
      return jsonResult({ record: result.record })
    },
  })
  defineTool(server, {
    name: 'crm_record_assert',
    description: 'Create or patch by a unique attribute for sync/import writes. Multiple multi-value matches return DUPLICATE_FOUND. Inline links are atomic.',
    input: CrmRecordAssert.in.shape,
    handler: async (args) => {
      const result = await assertRecord(deps, ctx, {
        objectType: args.object_type, matchAttribute: args.match_attribute, data: args.data,
        links: inlineLinks(args.links), owner: args.owner, reason: args.reason,
        idempotencyKey: args.idempotency_key,
      })
      return jsonResult({
        record: result.record, created: result.created,
        ...(result.duplicates === undefined ? {} : { duplicates: result.duplicates }),
      })
    },
  })
  defineTool(server, {
    name: 'crm_record_get',
    description: 'Fetch one visible record by id or a unique attribute. include_links groups active related records; include_timeline returns recent activity.',
    input: CrmRecordGetInput.shape,
    handler: async (args) => jsonResult(await getRecord(deps, ctx, {
      id: args.id, objectType: args.object_type, matchAttribute: args.match_attribute, value: args.value,
      includeLinks: args.include_links, includeTimeline: args.include_timeline,
    })),
  })
  defineTool(server, {
    name: 'crm_records_query',
    description: 'List visible records with exact structured filters, sort and opaque cursor. Use crm_record_get for a known record and crm_search for fuzzy text.',
    input: CrmRecordsQueryToolInput.shape,
    handler: async (args) => jsonResult(await queryRecords(deps, ctx, {
      objectType: args.object_type,
      filter: args.filter === undefined ? undefined : Filter.parse(args.filter),
      sort: args.sort, attributes: args.attributes, includeTotal: args.include_total,
      cursor: args.cursor, limit: args.limit,
    })),
  })
  defineTool(server, {
    name: 'crm_record_delete',
    description: 'Soft-delete a visible record and end links according to relation policy. Requires delete entitlement or approval.',
    input: CrmRecordDelete.in.shape,
    handler: async (args) => {
      await deleteRecord(deps, ctx, {
        recordId: args.id, expectedVersion: args.expected_version, reason: args.reason,
      })
      return jsonResult({ deleted: true })
    },
  })
  defineTool(server, {
    name: 'crm_record_restore',
    description: 'Restore a soft-deleted record and recoverable links. Restore conflicts identify a current unique-key holder.',
    input: CrmRecordRestore.in.shape,
    handler: async (args) => {
      const result = await restoreRecord(deps, ctx, {
        recordId: args.id,
      })
      return jsonResult({ record: result.record })
    },
  })
  defineTool(server, {
    name: 'crm_record_at',
    description: 'Reconstruct visible record values and reference links at an ISO timestamp from change history.',
    input: CrmRecordAt.in.shape,
    handler: async (args) => jsonResult(await recordAt(deps, ctx, { recordId: args.id, at: args.at })),
  })
  defineTool(server, {
    name: 'crm_record_history',
    description: 'Read field-level history for one visible record. Cursor is bound to id, attributes and limit.',
    input: CrmRecordHistory.in.shape,
    handler: async (args) => jsonResult(await recordHistory(deps, ctx, {
      recordId: args.id, attributes: args.attributes, cursor: args.cursor, limit: args.limit,
    })),
  })
}
