import { CrmMergeRecords, CrmUnmerge, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { mergeRecords, unmergeRecords } from '../../services/merge.js'
import { defineTool } from './register.js'
import { ok } from './result.js'

export function registerQualityTools(
  server: Parameters<typeof defineTool>[0], ctx: ActorContext, deps: AppDeps,
): void {
  defineTool(server, {
    name: 'crm_merge_records',
    description: 'Merge visible same-type duplicates into one survivor. Re-points links and lists, moves surviving unique keys, and leaves reversible redirects. Requires merge entitlement; use crm_find_duplicates first.',
    input: CrmMergeRecords.in.shape,
    handler: async (args) => {
      const result = await mergeRecords(deps, ctx, {
        survivorId: args.survivor_id,
        mergedIds: args.merged_ids,
        ...(args.field_choices === undefined ? {} : { fieldChoices: args.field_choices }),
        reason: args.reason,
      })
      return ok(result, JSON.stringify(result))
    },
  })
  defineTool(server, {
    name: 'crm_unmerge',
    description: 'Undo one crm_merge_records operation from its merge_change_id. Restores records, links, lists, and derived keys atomically; returns conflicts without partial restoration.',
    input: CrmUnmerge.in.shape,
    handler: async (args) => {
      const result = await unmergeRecords(deps, ctx, {
        mergeChangeId: args.merge_change_id,
        reason: args.reason,
      })
      return ok(result, JSON.stringify(result))
    },
  })
}
