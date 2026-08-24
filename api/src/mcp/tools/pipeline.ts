import {
  CrmPipelineSummaryToolInput,
  Filter,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import { pipelineSummary } from '../../services/pipeline.js'
import { defineTool } from './register.js'
import { ok } from './result.js'

export function registerPipelineTools(
  server: Parameters<typeof defineTool>[0],
  ctx: ActorContext,
  deps: AppDeps,
): void {
  defineTool(server, {
    name: 'crm_pipeline_summary',
    description: 'Summarize visible live records by status stage with optional fixed-currency sums, closed stage durations, and conversions. Use crm_records_query for individual records. Returns every configured stage. Errors: policy errors, invalid attributes or filter.',
    input: CrmPipelineSummaryToolInput.shape,
    handler: async (args) => {
      const result = await pipelineSummary(deps, ctx, {
        objectType: args.object_type,
        statusAttribute: args.status_attribute,
        amountAttribute: args.amount_attribute,
        filter: args.filter === undefined ? undefined : Filter.parse(args.filter),
        since: args.since,
      })
      return ok(result, JSON.stringify(result))
    },
  })
}
