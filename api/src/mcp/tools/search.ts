import { CrmSearchInputShape, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { searchRecords } from '../../services/search.js'
import { defineTool } from './register.js'
import { ok } from './result.js'

export function registerSearchTools(
  server: Parameters<typeof defineTool>[0],
  ctx: ActorContext,
  deps: AppDeps,
): void {
  defineTool(server, {
    name: 'crm_search',
    description: 'Rank visible records by keyword, semantic similarity, or hybrid RRF. Use similar_to for indexed neighbours and crm_records_query for exact lookup. Recently changed linked names can lag indexing briefly.',
    input: CrmSearchInputShape,
    handler: async (args) => {
      const result = await searchRecords(deps, ctx, {
        query: args.query,
        similarTo: args.similar_to,
        objectTypes: args.object_types,
        mode: args.mode,
        limit: args.limit,
      })
      return ok(result, JSON.stringify(result))
    },
  })
}
