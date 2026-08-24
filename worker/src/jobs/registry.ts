import type { JobHandler } from '../index.js'
import type { Embedder } from '@deepcrm/schema-engine'
import type { BulkAssertRecordPort } from '../bulk-assert-port.js'
import { BULK_ASSERT_JOB, createBulkAssertHandler } from './bulk-assert.js'
import { MATCH_KEY_BACKFILL_JOB, matchKeyBackfillHandler } from './match-key-backfill.js'
import { noop } from './noop.js'
import { createRecordReindexHandler, RECORD_REINDEX_JOB } from './record-reindex.js'

export const handlers: Record<string, JobHandler> = {
  noop,
  [MATCH_KEY_BACKFILL_JOB]: matchKeyBackfillHandler,
}

export function createHandlers(
  recordAssert: BulkAssertRecordPort,
  embedder: Embedder,
): Record<string, JobHandler> {
  return {
    ...handlers,
    [BULK_ASSERT_JOB]: createBulkAssertHandler(recordAssert),
    [RECORD_REINDEX_JOB]: createRecordReindexHandler(embedder),
  }
}
