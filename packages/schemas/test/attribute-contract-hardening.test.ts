import { describe, expect, it } from 'vitest'

import { AttributeConfig } from '../src/attribute-config.js'
import { CurrencyValue, SelectOption, StatusOption } from '../src/attribute-values.js'

describe('shared attribute contracts', () => {
  it('accepts only supported ISO 4217 currency codes', () => {
    expect(CurrencyValue.safeParse({ amount: '12.34', currency: 'USD' }).success).toBe(true)
    expect(CurrencyValue.safeParse({ amount: '12.34', currency: 'ZZZ' }).success).toBe(false)
    expect(AttributeConfig.safeParse({ type: 'currency', defaultCurrency: 'ZZZ' }).success).toBe(false)
    expect(AttributeConfig.safeParse({ type: 'currency', fixedCurrency: 'GBP' }).success).toBe(true)
  })

  it('enforces the exact select and status option shapes', () => {
    expect(SelectOption.safeParse({ id: 'valid_id', label: 'Valid', color: 'blue' }).success).toBe(true)
    expect(SelectOption.safeParse({ id: 'BAD ID', label: 'Valid' }).success).toBe(false)
    expect(SelectOption.safeParse({ id: 'valid_id', label: 'Valid', color: '' }).success).toBe(false)
    expect(StatusOption.safeParse({
      id: 'new_stage', label: 'New', color: 'blue', category: 'open', position: 0,
    }).success).toBe(true)
  })

  it('describes timestamp-system configuration as virtual and read-only', () => {
    const parsed = AttributeConfig.safeParse({ type: 'timestamp_system', source: 'created_at' })
    expect(parsed.success).toBe(true)
    const option = AttributeConfig.options.find((candidate) => (
      'source' in candidate.shape && candidate.shape.type.safeParse('timestamp_system').success
    ))
    if (option === undefined || !('source' in option.shape)) throw new Error('timestamp_system option missing')
    expect(option.shape.source.description).toContain('virtual')
    expect(option.shape.source.description).toContain('read-only')
  })
})
