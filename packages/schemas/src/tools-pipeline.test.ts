import { describe, expect, it } from 'vitest'

import {
  CrmPipelineDefine,
  CrmPipelineStageSet,
  CrmPipelineStagesList,
  CrmPipelineSummary,
  CrmPipelineSummaryToolInput,
  CrmPipelineUpdate,
} from './tools-pipeline.js'

describe('pipeline summary contract', () => {
  it('describes every input and validates nullable currency output', () => {
    for (const schema of [
      CrmPipelineDefine.in,
      CrmPipelineUpdate.in,
      CrmPipelineStageSet.in,
      CrmPipelineStagesList.in,
      CrmPipelineSummary.in,
    ]) {
      for (const field of Object.values(schema.shape)) {
        expect(field.description).toBeTypeOf('string')
        expect(field.description?.length).toBeGreaterThan(0)
      }
    }
    const pipeline = CrmPipelineDefine.out.parse({
      id: crypto.randomUUID(),
      object_type: 'deal',
      slug: 'sales',
      name: 'Sales',
      description: 'Primary sales flow',
      is_default: true,
      stages: [{
        id: crypto.randomUUID(),
        slug: 'open',
        name: 'Open',
        position: 0,
        probability: null,
        category: 'open',
        archived_at: null,
      }],
      archived_at: null,
    })
    expect(CrmPipelineStagesList.out.parse({ pipeline, stages: pipeline.stages }).stages).toHaveLength(1)
    expect(CrmPipelineStageSet.out.parse({
      record_id: crypto.randomUUID(),
      pipeline: 'sales',
      stage: 'open',
      changed: true,
      interval_id: crypto.randomUUID(),
    }).changed).toBe(true)
    expect(CrmPipelineSummary.out.parse({
      stages: [{
        id: 'open', label: 'Open', category: 'open', count: 2,
        amount_sum: null, avg_days_in_stage: null,
      }],
      conversions: [{ from: 'open', to: 'won', count: 1 }],
    }).stages[0]?.amount_sum).toBeNull()
    expect(CrmPipelineSummaryToolInput.shape.filter.description).toContain('crm://help/filtering')
  })
})
