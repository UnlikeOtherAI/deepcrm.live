import { describe, expect, it } from 'vitest'

import {
  BulkAssertPayload,
  CrmRecordsBulkAssert,
  McpTask,
} from './tools-bulk.js'

const task = {
  taskId: crypto.randomUUID(),
  status: 'working',
  ttl: 604_800_000,
  createdAt: '2026-08-24T12:00:00.000Z',
  lastUpdatedAt: '2026-08-24T12:00:00.000Z',
  pollInterval: 1_000,
}

describe('bulk assert and task contracts', () => {
  it('describes every tool input and uses the SDK task wire casing', () => {
    for (const field of Object.values(CrmRecordsBulkAssert.in.shape)) {
      expect(field.description).toBeTypeOf('string')
      expect(field.description?.length).toBeGreaterThan(0)
    }
    expect(CrmRecordsBulkAssert.out.parse({ task })).toEqual({ task })
    expect(McpTask.safeParse({ ...task, task_id: task.taskId }).success).toBe(false)
  })

  it('bounds rows and strictly validates the worker payload', () => {
    const base = {
      object_type: 'person',
      match_attribute: 'email',
      rows: [{ data: { email: 'a@example.test' } }],
    }
    expect(CrmRecordsBulkAssert.in.safeParse(base).success).toBe(true)
    expect(CrmRecordsBulkAssert.in.safeParse({ ...base, rows: [] }).success).toBe(false)
    expect(BulkAssertPayload.safeParse({ extra: true }).success).toBe(false)
  })
})
