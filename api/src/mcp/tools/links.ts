import {
  CrmLink,
  CrmLinksList,
  CrmUnlinkInput,
  ErrorCode,
  ServiceError,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { listRecordLinks } from '../../services/link-read.js'
import { linkRecords, unlinkRecords } from '../../services/links.js'
import { defineTool } from './register.js'
import { ok } from './result.js'

function jsonResult(value: Record<string, unknown>) {
  return ok(value, JSON.stringify(value))
}

export function registerLinkTools(
  server: Parameters<typeof defineTool>[0], ctx: ActorContext, deps: AppDeps,
): void {
  defineTool(server, {
    name: 'crm_link',
    description: 'Relate two visible records with optional edge data. Cardinality replacements are returned in ended_links. Reusing an idempotency key with changed arguments fails.',
    input: CrmLink.in.shape,
    handler: async (args) => {
      const result = await linkRecords(deps, ctx, {
        relationType: args.relation_type,
        fromRecordId: args.from_record_id,
        toRecordId: args.to_record_id,
        data: args.data,
        label: args.label,
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      })
      return jsonResult({ link: result.link, ended_links: result.ended_links })
    },
  })

  defineTool(server, {
    name: 'crm_unlink',
    description: 'End an active link while retaining history. Identify it by link_id or a full relation triple; an ambiguous triple ends the newest active link.',
    input: CrmUnlinkInput.shape,
    handler: async (args) => {
      const common = { reason: args.reason }
      let result
      if (args.link_id !== undefined) {
        result = await unlinkRecords(deps, ctx, { ...common, linkId: args.link_id })
      } else if (
        args.relation_type !== undefined
        && args.from_record_id !== undefined
        && args.to_record_id !== undefined
      ) {
        result = await unlinkRecords(deps, ctx, {
          ...common,
          relationType: args.relation_type,
          fromRecordId: args.from_record_id,
          toRecordId: args.to_record_id,
        })
      } else {
        throw new ServiceError(
          ErrorCode.VALIDATION_FAILED,
          'link_id or relation_type + from_record_id + to_record_id is required',
        )
      }
      return jsonResult({ link_id: result.link.id })
    },
  })

  defineTool(server, {
    name: 'crm_links_list',
    description: 'List visible links for one visible record with related record summaries. Filter by relation and direction; include_history adds ended links. Cursor binds all filters.',
    input: CrmLinksList.in.shape,
    handler: async (args) => jsonResult(await listRecordLinks(deps, ctx, {
      recordId: args.record_id,
      relationType: args.relation_type,
      direction: args.direction,
      includeHistory: args.include_history,
      cursor: args.cursor,
      limit: args.limit,
    })),
  })
}
