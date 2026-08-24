import type { JobHandler } from '../index.js'
import type { BulkAssertRecordPort } from '../bulk-assert-port.js'
import { BULK_ASSERT_JOB, createBulkAssertHandler } from './bulk-assert.js'
import { MATCH_KEY_BACKFILL_JOB, matchKeyBackfillHandler } from './match-key-backfill.js'
import { noop } from './noop.js'

export const handlers: Record<string, JobHandler> = {
  noop,
  [MATCH_KEY_BACKFILL_JOB]: matchKeyBackfillHandler,
}

export function createHandlers(recordAssert: BulkAssertRecordPort): Record<string, JobHandler> {
  return { ...handlers, [BULK_ASSERT_JOB]: createBulkAssertHandler(recordAssert) }
}
