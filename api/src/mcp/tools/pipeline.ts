import {
  CrmPipelineDefine,
  CrmPipelineStageSet,
  CrmPipelineStagesList,
  CrmPipelineSummaryToolInput,
  CrmPipelineUpdate,
  Filter,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../../deps.js'
import {
  definePipeline,
  listPipelineStages,
  pipelineSummary,
  setPipelineStage,
  updatePipeline,
} from '../../services/pipeline.js'
import { defineTool } from './register.js'
import { ok } from './result.js'

export function registerPipelineTools(
  server: Parameters<typeof defineTool>[0],
  ctx: ActorContext,
  deps: AppDeps,
): void {
  defineTool(server, {
    name: 'crm_pipeline_define',
    description: 'Define a generic pipeline and ordered stages for one object type. Use before stage moves; errors on duplicate slugs or non-contiguous positions.',
    input: CrmPipelineDefine.in.shape,
    handler: async (args) => {
      const result = await definePipeline(deps, ctx, args)
      return ok(result, JSON.stringify(result))
    },
  })
  defineTool(server, {
    name: 'crm_pipeline_update',
    description: 'Rename, describe, or make a generic object pipeline the default. Use crm_pipeline_define to create stages; errors when the pipeline is absent.',
    input: CrmPipelineUpdate.in.shape,
    handler: async (args) => {
      const result = await updatePipeline(deps, ctx, args)
      return ok(result, JSON.stringify(result))
    },
  })
  defineTool(server, {
    name: 'crm_pipeline_stage_set',
    description: 'Move one visible record to an active pipeline stage. Appends immutable stage history; same-stage calls are no-ops. Errors on hidden records or stages.',
    input: CrmPipelineStageSet.in.shape,
    handler: async (args) => {
      const result = await setPipelineStage(deps, ctx, args)
      return ok(result, JSON.stringify(result))
    },
  })
  defineTool(server, {
    name: 'crm_pipeline_stages_list',
    description: 'List one pipeline and its active ordered stages. Use before crm_pipeline_stage_set or crm_pipeline_summary to inspect valid stage slugs.',
    input: CrmPipelineStagesList.in.shape,
    handler: async (args) => {
      const result = await listPipelineStages(deps, ctx, args)
      return ok(result, JSON.stringify(result))
    },
  })
  defineTool(server, {
    name: 'crm_pipeline_summary',
    description: 'Summarize visible live records from pipeline stage history with optional fixed-currency sums and conversions. Use crm_records_query for rows.',
    input: CrmPipelineSummaryToolInput.shape,
    handler: async (args) => {
      const result = await pipelineSummary(deps, ctx, {
        objectType: args.object_type,
        pipeline: args.pipeline,
        amountAttribute: args.amount_attribute,
        filter: args.filter === undefined ? undefined : Filter.parse(args.filter),
        since: args.since,
      })
      return ok(result, JSON.stringify(result))
    },
  })
}
