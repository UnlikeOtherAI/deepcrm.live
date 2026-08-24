import { describe, expect, it } from 'vitest'

import { Filter, FilterOp, Sort, SystemField } from './filter.js'

describe('query filter contract', () => {
  it('parses recursive logical and typed leaf shapes', () => {
    expect(Filter.parse({
      and: [
        { attribute: 'stage', op: 'in', value: ['qualified', 'proposal'] },
        { not: { system: 'last_activity_at', op: 'is_null' } },
        { linked_to: { relation: 'deal_for_company', record_id: '018f2e65-7a7b-7d2f-8c4d-111111111111' } },
        { text: 'packaging' },
      ],
    })).toEqual({
      and: [
        { attribute: 'stage', op: 'in', value: ['qualified', 'proposal'] },
        { not: { system: 'last_activity_at', op: 'is_null' } },
        { linked_to: {
          relation: 'deal_for_company',
          record_id: '018f2e65-7a7b-7d2f-8c4d-111111111111',
          direction: 'from',
        } },
        { text: 'packaging' },
      ],
    })
  })

  it('rejects invalid or ambiguous structures', () => {
    expect(Filter.safeParse({ and: [] }).success).toBe(false)
    expect(Filter.safeParse({ attribute: 'stage', op: 'eq', extra: true }).success).toBe(false)
    expect(Filter.safeParse({ linked_to: { relation: 'works_at', record_id: 'not-a-uuid' } }).success).toBe(false)
    expect(Filter.safeParse({ text: '' }).success).toBe(false)
  })

  it('exposes the complete operator and system-field sets', () => {
    expect(FilterOp.options).toEqual([
      'eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null', 'contains',
      'starts_with', 'gt', 'gte', 'lt', 'lte', 'between',
    ])
    expect(SystemField.options).toEqual([
      'created_at', 'updated_at', 'last_activity_at', 'display_name', 'owner',
    ])
  })
})

describe('query sort contract', () => {
  it('defaults direction and allows at most three exclusive keys', () => {
    expect(Sort.parse([{ attribute: 'amount' }, { system: 'created_at', direction: 'desc' }])).toEqual([
      { attribute: 'amount', direction: 'asc' },
      { system: 'created_at', direction: 'desc' },
    ])
    expect(Sort.safeParse([
      { attribute: 'a' }, { attribute: 'b' }, { attribute: 'c' }, { attribute: 'd' },
    ]).success).toBe(false)
  })

  it('rejects owner sorting, mixed keys, and unknown fields', () => {
    expect(Sort.safeParse([{ system: 'owner' }]).success).toBe(false)
    expect(Sort.safeParse([{ attribute: 'amount', system: 'created_at' }]).success).toBe(false)
    expect(Sort.safeParse([{ attribute: 'amount', nulls: 'first' }]).success).toBe(false)
  })
})
