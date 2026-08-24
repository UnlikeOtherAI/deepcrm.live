import type { JobHandler } from '../index.js'
import { MATCH_KEY_BACKFILL_JOB, matchKeyBackfillHandler } from './match-key-backfill.js'
import { noop } from './noop.js'

export const handlers: Record<string, JobHandler> = {
  noop,
  [MATCH_KEY_BACKFILL_JOB]: matchKeyBackfillHandler,
}
