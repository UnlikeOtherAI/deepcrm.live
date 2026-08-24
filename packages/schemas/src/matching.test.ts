import { describe, expect, it } from 'vitest'

import { MatchingRule } from './matching.js'

describe('MatchingRule', () => {
  it('accepts the bounded public rule contract', () => {
    expect(MatchingRule.parse({
      attributes: ['email'], method: 'normalized', action: 'block',
    })).toMatchObject({ action: 'block' })
  })

  it('rejects removed allow actions and low fuzzy thresholds', () => {
    expect(MatchingRule.safeParse({
      attributes: ['name'], method: 'fuzzy', action: 'allow', threshold: 0.3,
    }).success).toBe(false)
  })
})
