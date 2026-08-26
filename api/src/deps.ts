import { randomUUID } from 'node:crypto'
import { createDb, writeAudit, type Db } from '@deepcrm/db'
import {
  createProjectionLinkWriter,
  FakeEmbedder,
  LedgerEmbedder,
  type Embedder,
  type LinkWriter,
} from '@deepcrm/schema-engine'
import { parseSecretBox, type SecretBox } from '@deepcrm/schemas'
import type { Env } from './env.js'
import { createFileAccessService, type FileAccessService } from './services/file-access.js'
import { createHistoryCursorCodec, type HistoryCursorCodec } from './services/history-cursor.js'
import { createQueryCursorCodec, type QueryCursorCodec } from './services/query-cursor.js'

export type AppDeps = {
  db: Db
  clock: () => Date
  ids: () => string
  version: string
  maxBulkRows: number
  maxExportRows: number
  orgAllowlist: ReadonlySet<string> | null
  linkWriter: LinkWriter
  historyCursor: HistoryCursorCodec
  queryCursor: QueryCursorCodec
  secretBox: SecretBox
  embedder: Embedder
  fileAccess: FileAccessService
  writeAudit: typeof writeAudit
}

export type WorkerDeps = AppDeps

export type JobHandler = (payload: unknown) => Promise<void>

function parseOrgAllowlist(value: string | undefined): ReadonlySet<string> | null {
  if (value === undefined) return null
  return new Set(value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''))
}

export function createAppDeps(env: Env): AppDeps {
  const secretBox = parseSecretBox(env.DEEPCRM_SECRET_KEYRING_B64)
  secretBox.assertKey('export')
  return {
    db: createDb(env.DATABASE_URL),
    clock: () => new Date(),
    ids: () => randomUUID(),
    version: '0.0.0',
    maxBulkRows: env.DEEPCRM_MAX_BULK_ROWS,
    maxExportRows: env.DEEPCRM_MAX_EXPORT_ROWS,
    orgAllowlist: parseOrgAllowlist(env.DEEPCRM_ORG_ALLOWLIST),
    linkWriter: createProjectionLinkWriter(),
    historyCursor: createHistoryCursorCodec(secretBox),
    queryCursor: createQueryCursorCodec(secretBox),
    secretBox,
    embedder: env.LEDGER_PROXY_TOKEN === undefined
      ? new FakeEmbedder(env.DEEPCRM_EMBEDDING_MODEL)
      : new LedgerEmbedder({
          publicUrl: requiredLedgerUrl(env),
          token: env.LEDGER_PROXY_TOKEN,
          model: env.DEEPCRM_EMBEDDING_MODEL,
        }),
    fileAccess: createFileAccessService(env.DEEPCRM_FILE_ACCESS_PUBLIC_URL, secretBox),
    writeAudit,
  }
}

function requiredLedgerUrl(env: Env): string {
  if (env.LEDGER_PUBLIC_URL === undefined) {
    throw new Error('LEDGER_PUBLIC_URL is required when LEDGER_PROXY_TOKEN is set')
  }
  return env.LEDGER_PUBLIC_URL
}
