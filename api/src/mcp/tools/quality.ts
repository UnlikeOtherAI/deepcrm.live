import { CrmMergeRecords, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { mergeRecords } from '../../services/merge.js'
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
}
