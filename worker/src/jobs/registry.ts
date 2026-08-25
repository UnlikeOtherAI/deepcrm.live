import type { JobHandler } from '../index.js'
import type { Embedder } from '@deepcrm/schema-engine'
import type { BulkAssertRecordPort } from '../bulk-assert-port.js'
import type { ExportPagePort } from '../export-page-port.js'
import { createSafeFetch, type SecretBox } from '@deepcrm/schemas'
import { BULK_ASSERT_JOB, createBulkAssertHandler } from './bulk-assert.js'
import { BULK_EXPORT_JOB, createBulkExportHandler, type BulkExportConfig } from './bulk-export.js'
import { CHANGE_DELIVER_JOB, createChangeDeliverHandler } from './change-deliver.js'
import { MATCH_KEY_BACKFILL_JOB, matchKeyBackfillHandler } from './match-key-backfill.js'
import { KEY_RECOMPUTE_JOB, keyRecomputeHandler } from './key-recompute.js'
import { noop } from './noop.js'
import {
  createRecordReindexHandler,
  createRecordReindexNeighboursHandler,
  RECORD_REINDEX_JOB,
  RECORD_REINDEX_NEIGHBOURS_JOB,
} from './record-reindex.js'
import { createDedupScanHandler, DEDUP_SCAN_JOB } from './dedup-scan.js'
import { derivedRefreshHandler, DERIVED_REFRESH_JOB } from './derived-refresh.js'
import { listRefreshHandler, LIST_REFRESH_JOB } from './list-refresh.js'
import { createRetentionHandler, RETENTION_JOB, type RetentionConfig } from './retention.js'
import { tenantReparentHandler, TENANT_REPARENT_JOB } from './tenant-reparent.js'

export type WorkerJobConfig = BulkExportConfig & RetentionConfig & {
  webhookPrincipalStaleDays?: number
}

export const handlers: Record<string, JobHandler> = {
  noop,
  [MATCH_KEY_BACKFILL_JOB]: matchKeyBackfillHandler,
  [KEY_RECOMPUTE_JOB]: keyRecomputeHandler,
}

export function createHandlers(
  recordAssert: BulkAssertRecordPort,
  embedder: Embedder,
  secretBox: SecretBox,
  exportPage: ExportPagePort,
  config: WorkerJobConfig,
): Record<string, JobHandler> {
  return {
    ...handlers,
    [BULK_ASSERT_JOB]: createBulkAssertHandler(recordAssert),
    [RECORD_REINDEX_JOB]: createRecordReindexHandler(embedder),
    [RECORD_REINDEX_NEIGHBOURS_JOB]: createRecordReindexNeighboursHandler(),
    [DERIVED_REFRESH_JOB]: derivedRefreshHandler,
    [LIST_REFRESH_JOB]: listRefreshHandler,
    [CHANGE_DELIVER_JOB]: createChangeDeliverHandler(
      secretBox,
      createSafeFetch(),
      config.webhookPrincipalStaleDays ?? 30,
    ),
    [DEDUP_SCAN_JOB]: createDedupScanHandler(),
    [BULK_EXPORT_JOB]: createBulkExportHandler(exportPage, secretBox, config),
    [RETENTION_JOB]: createRetentionHandler(config),
    [TENANT_REPARENT_JOB]: tenantReparentHandler,
  }
}
