import { randomUUID } from 'node:crypto'
import { createDb, writeAudit, type Db } from '@deepcrm/db'
import { createProjectionLinkWriter, type LinkWriter } from '@deepcrm/schema-engine'
import { parseSecretBox } from '@deepcrm/schemas'
import type { Env } from './env.js'
import { createQueryCursorCodec, type QueryCursorCodec } from './services/query-cursor.js'

export type AppDeps = {
  db: Db
  clock: () => Date
  ids: () => string
  version: string
  orgAllowlist: ReadonlySet<string> | null
  linkWriter: LinkWriter
  queryCursor: QueryCursorCodec
  writeAudit: typeof writeAudit
}

export type WorkerDeps = AppDeps

export type JobHandler = (payload: unknown) => Promise<void>

function parseOrgAllowlist(value: string | undefined): ReadonlySet<string> | null {
  if (value === undefined) return null
  return new Set(value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''))
}

export function createAppDeps(env: Env): AppDeps {
  return {
    db: createDb(env.DATABASE_URL),
    clock: () => new Date(),
    ids: () => randomUUID(),
    version: '0.0.0',
    orgAllowlist: parseOrgAllowlist(env.DEEPCRM_ORG_ALLOWLIST),
    linkWriter: createProjectionLinkWriter(),
    queryCursor: createQueryCursorCodec(parseSecretBox(env.DEEPCRM_SECRET_KEYRING_B64)),
    writeAudit,
  }
}
