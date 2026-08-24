import { CrmFindDuplicatesToolInputShape, CrmSearchInputShape, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { searchRecords } from '../../services/search.js'
import { enqueueFindDuplicates } from '../../services/duplicates.js'
import { defineTool } from './register.js'
import { ok, taskCreated } from './result.js'

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
  defineTool(server, {
    name: 'crm_find_duplicates',
    description: 'Scan visible records of one object type using active matching rules and optional semantic similarity. Returns a Task; poll it for evidence groups. Never merges records.',
    input: CrmFindDuplicatesToolInputShape,
    handler: async (args) => {
      const result = await enqueueFindDuplicates(deps, ctx, {
        objectType: args.object_type,
        filter: args.filter,
        includeSemantic: args.include_semantic,
      })
      return taskCreated(result.task)
    },
  })
}
