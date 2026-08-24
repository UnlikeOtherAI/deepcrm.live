import type { JobHandler } from '../index.js'
import type { Embedder } from '@deepcrm/schema-engine'
import type { BulkAssertRecordPort } from '../bulk-assert-port.js'
import { createSafeFetch, type SecretBox } from '@deepcrm/schemas'
import { BULK_ASSERT_JOB, createBulkAssertHandler } from './bulk-assert.js'
import { CHANGE_DELIVER_JOB, createChangeDeliverHandler } from './change-deliver.js'
import { MATCH_KEY_BACKFILL_JOB, matchKeyBackfillHandler } from './match-key-backfill.js'
import { noop } from './noop.js'
import { createRecordReindexHandler, RECORD_REINDEX_JOB } from './record-reindex.js'
import { createDedupScanHandler, DEDUP_SCAN_JOB } from './dedup-scan.js'

export const handlers: Record<string, JobHandler> = {
  noop,
  [MATCH_KEY_BACKFILL_JOB]: matchKeyBackfillHandler,
}

export function createHandlers(
  recordAssert: BulkAssertRecordPort,
  embedder: Embedder,
  secretBox: SecretBox,
): Record<string, JobHandler> {
  return {
    ...handlers,
    [BULK_ASSERT_JOB]: createBulkAssertHandler(recordAssert),
    [RECORD_REINDEX_JOB]: createRecordReindexHandler(embedder),
    [CHANGE_DELIVER_JOB]: createChangeDeliverHandler(secretBox, createSafeFetch()),
    [DEDUP_SCAN_JOB]: createDedupScanHandler(),
  }
}
