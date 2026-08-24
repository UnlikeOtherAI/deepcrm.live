import { describe, expect, it } from 'vitest'

import {
  CrmRecordsCount,
  CrmRecordsCountToolInput,
  CrmRecordsGetMany,
} from './tools-records.js'

describe('record collection tool contracts', () => {
  it('pins recursive and discovery-safe count filters', () => {
    const input = {
      object_type: 'deal',
      filter: { attribute: 'stage', op: 'eq', value: 'proposal' },
    }
    expect(CrmRecordsCount.in.parse(input)).toEqual(input)
    expect(CrmRecordsCountToolInput.parse(input)).toEqual(input)
  })

  it('caps bulk record reads at 100 ids', () => {
    const id = '00000000-0000-4000-8000-000000000001'
    expect(CrmRecordsGetMany.in.parse({ ids: [id] }).ids).toEqual([id])
    expect(CrmRecordsGetMany.in.safeParse({ ids: Array.from({ length: 101 }, () => id) }).success)
      .toBe(false)
  })
})
