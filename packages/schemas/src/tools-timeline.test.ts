import { describe, expect, it } from 'vitest'

import { CrmRecordTimeline } from './tools-timeline.js'

describe('record timeline tool contract', () => {
  it('describes every input and applies pagination defaults', () => {
    for (const field of Object.values(CrmRecordTimeline.in.shape)) {
      expect(field.description).toBeTypeOf('string')
      expect(field.description?.length).toBeGreaterThan(0)
    }
    expect(CrmRecordTimeline.in.parse({ id: crypto.randomUUID() })).toMatchObject({
      hops: 0,
      limit: 50,
    })
  })

  it('rejects invalid hops and unknown arguments', () => {
    const id = crypto.randomUUID()
    expect(CrmRecordTimeline.in.safeParse({ id, hops: 2 }).success).toBe(false)
    expect(CrmRecordTimeline.in.safeParse({ id, unexpected: true }).success).toBe(false)
  })
})
