import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@deepcrm/db'
import type { Env } from './env.js'

export type AppDeps = {
  db: Db
  clock: () => Date
  ids: () => string
  version: string
}

export type WorkerDeps = AppDeps

export type JobHandler = (payload: unknown) => Promise<void>

export function createAppDeps(env: Env): AppDeps {
  return {
    db: createDb(env.DATABASE_URL),
    clock: () => new Date(),
    ids: () => randomUUID(),
    version: '0.0.0',
  }
}
