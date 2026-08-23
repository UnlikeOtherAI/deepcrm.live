import { describe, expect, it, afterAll } from 'vitest'

import { createDb, dropTenant, seedTenant, type Db } from '../../src/index.js'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('migration shape (DB)', () => {
  const db: Db = createDb(url ?? '')

  afterAll(async () => {
    await db.$disconnect()
  })

  it('seeds a tenant, has vector + pg_trgm extensions, and drops the tenant', async () => {
    const tenant = await seedTenant(db)

    const extensions = await db.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension
    `
    const names = extensions.map((row) => row.extname)
    expect(names).toContain('vector')
    expect(names).toContain('pg_trgm')

    await dropTenant(db, tenant.organizationId)

    const teams = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM teams WHERE organization_id = ${tenant.organizationId}::uuid
    `
    expect(teams[0]?.count).toBe(0n)
  })
})
