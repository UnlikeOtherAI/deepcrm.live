import { createDb, seedTenant } from '@deepcrm/db'
import { afterAll, expect, it } from 'vitest'
import { claimNext, complete, enqueue, fail } from '../../src/index.js'

const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(url)
afterAll(async () => { await db.$disconnect() })

it('enqueues, claims, completes, and deduplicates', async () => {
  const tenant = await seedTenant(db)
  const input = { type: 'test', payload: { value: 1 }, organizationId: tenant.organizationId, teamId: tenant.teamId, idempotencyKey: crypto.randomUUID() }
  const first = await enqueue(db, input)
  const duplicate = await enqueue(db, input)
  expect(duplicate).toEqual({ id: first.id, created: false })
  const job = await claimNext(db, 'worker', ['test'])
  expect(job?.id).toBe(first.id)
  expect(await complete(db, first.id, 'worker', null)).toBe(true)
  await db.organization.delete({ where: { id: tenant.organizationId } })
})

it('requeues failed work', async () => {
  const type = `system_${crypto.randomUUID()}`
  const item = await enqueue(db, { type, payload: {}, maxAttempts: 2 })
  const job = await claimNext(db, 'worker', [type])
  expect(job?.id).toBe(item.id)
  expect(await fail(db, item.id, 'worker', 'failed')).toBe(true)
  await db.queueJob.delete({ where: { id: item.id } })
})
