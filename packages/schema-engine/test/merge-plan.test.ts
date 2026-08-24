import { ErrorCode } from '@deepcrm/schemas'
import { describe, expect, it } from 'vitest'

import {
  planMerge,
  type MergeAttribute,
  type MergeLastSetAt,
  type MergeRecord,
} from '../src/index.js'

function attribute(
  id: string,
  slug: string,
  options: { multi?: boolean; unique?: boolean } = {},
): MergeAttribute {
  return {
    id,
    slug,
    type: 'text',
    config: {},
    isMulti: options.multi ?? false,
    isUnique: options.unique ?? false,
    archivedAt: null,
  }
}

function fixture(attributes: readonly MergeAttribute[]) {
  const objectType = { id: 'person-type', attributes }
  const schema = {
    attributesByObjectTypeId: new Map([[
      objectType.id,
      new Map(attributes.map((item) => [item.slug, item])),
    ]]),
  }
  return { schema, objectType }
}

function record(id: string, data: MergeRecord['data']): MergeRecord {
  return { id, data }
}

function lastSetAt(values: Array<[string, string, string]>): MergeLastSetAt {
  const result = new Map<string, Map<string, Date>>()
  for (const [recordId, slug, timestamp] of values) {
    const fields = result.get(recordId) ?? new Map<string, Date>()
    fields.set(slug, new Date(timestamp))
    result.set(recordId, fields)
  }
  return result
}

describe('merge planner', () => {
  it('keeps survivor scalars, selects the newest loser fallback, and stably unions multi values', () => {
    const title = attribute('title-id', 'title')
    const status = attribute('status-id', 'status')
    const tags = attribute('tags-id', 'tags', { multi: true })
    const target = fixture([title, status, tags])
    const survivor = record('survivor', { title: 'CTO', tags: ['one', 'shared'] })
    const first = record('first', { title: 'Ignored', status: 'qualified', tags: ['shared', 'two'] })
    const second = record('second', { status: 'customer', tags: ['three', 'one'] })

    const result = planMerge(target.schema, target.objectType, survivor, [first, second], lastSetAt([
      ['first', 'status', '2026-08-20T00:00:00.000Z'],
      ['second', 'status', '2026-08-21T00:00:00.000Z'],
    ]))

    expect(result.data).toEqual({ title: 'CTO', status: 'customer', tags: ['one', 'shared', 'two', 'three'] })
    expect(result.fieldSources).toEqual({
      title: ['survivor'], status: ['second'], tags: ['survivor', 'first', 'second'],
    })
  })

  it('uses field choices wholesale for scalar and multi values', () => {
    const title = attribute('title-id', 'title')
    const tags = attribute('tags-id', 'tags', { multi: true })
    const target = fixture([title, tags])
    const survivor = record('survivor', { title: 'Old', tags: ['survivor'] })
    const loser = record('loser', { title: 'Chosen', tags: ['loser', 'only'] })
    const result = planMerge(
      target.schema, target.objectType, survivor, [loser], new Map(),
      { title: 'loser', tags: 'loser' },
    )
    expect(result.data).toEqual({ title: 'Chosen', tags: ['loser', 'only'] })
    expect(result.fieldSources).toEqual({ title: ['loser'], tags: ['loser'] })
  })

  it('moves only loser unique keys whose values survive the plan', () => {
    const emails = attribute('email-id', 'emails', { multi: true, unique: true })
    const code = attribute('code-id', 'code', { unique: true })
    const target = fixture([emails, code])
    const survivor = record('survivor', { emails: ['survivor@example.test'], code: 'SURVIVOR' })
    const loser = record('loser', { emails: ['loser@example.test'], code: 'LOSER' })
    const result = planMerge(target.schema, target.objectType, survivor, [loser], new Map())

    expect(result.uniqueKeyMoves).toEqual([
      expect.objectContaining({
        attributeId: 'email-id',
        attributeSlug: 'emails',
        normalizedValue: 'loser@example.test',
        fromRecordId: 'loser',
      }),
    ])
  })

  it('rejects a field choice outside the merge set', () => {
    const title = attribute('title-id', 'title')
    const target = fixture([title])
    expect(() => planMerge(
      target.schema,
      target.objectType,
      record('survivor', { title: 'Old' }),
      [record('loser', { title: 'New' })],
      new Map(),
      { title: 'outside' },
    )).toThrow(expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }))
  })
})
