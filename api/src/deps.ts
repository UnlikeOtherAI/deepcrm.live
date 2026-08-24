import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@deepcrm/db'
import type { Env } from './env.js'

export type AppDeps = {
  db: Db
  clock: () => Date
  ids: () => string
  version: string
  orgAllowlist: ReadonlySet<string> | null
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
  }
}
