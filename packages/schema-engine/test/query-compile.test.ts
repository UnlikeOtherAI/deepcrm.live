import { describe, expect, it } from 'vitest'

import { Filter, Sort } from '@deepcrm/schemas'

describe('query grammar contract', () => {
  it('parses the documented nested grammar and three-key sort', () => {
    expect(Filter.parse({ and: [
      { attribute: 'stage', op: 'in', value: ['qualified', 'proposal'] },
      { system: 'owner', op: 'eq', value: { type: 'human', id: 'uoa_1' } },
      { linked_to: { relation: 'deal_for_company', record_id: '018f2e65-7a7b-7d2f-8c4d-111111111111', direction: 'from' } },
    ] })).toBeTruthy()
    expect(Sort.parse([
      { attribute: 'stage', direction: 'asc' },
      { attribute: 'close_date', direction: 'desc' },
      { system: 'display_name', direction: 'asc' },
    ])).toHaveLength(3)
  })

  it('rejects shape-level operator and owner-sort violations before SQL', () => {
    expect(Filter.safeParse({ attribute: 'stage', op: 'not_an_op', value: 'qualified' }).success).toBe(false)
    expect(Sort.safeParse([{ system: 'owner' }]).success).toBe(false)
  })
})
