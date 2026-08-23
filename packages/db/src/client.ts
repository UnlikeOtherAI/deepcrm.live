import { PrismaClient } from '@prisma/client'

import { withTenantGuard } from './tenant-guard.js'

export function createDb(url: string) {
  return withTenantGuard(new PrismaClient({ datasources: { db: { url } } }))
}

export type Db = ReturnType<typeof createDb>
