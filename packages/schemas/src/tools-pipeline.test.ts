import { describe, expect, it } from 'vitest'

import { CrmPipelineSummary, CrmPipelineSummaryToolInput } from './tools-pipeline.js'

describe('pipeline summary contract', () => {
  it('describes every input and validates nullable currency output', () => {
    for (const field of Object.values(CrmPipelineSummary.in.shape)) {
      expect(field.description).toBeTypeOf('string')
      expect(field.description?.length).toBeGreaterThan(0)
    }
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
