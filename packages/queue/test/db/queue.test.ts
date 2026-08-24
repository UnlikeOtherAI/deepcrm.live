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

it('enqueues through a transaction client with tenant payload and idempotency', async () => {
  const tenant = await seedTenant(db)
  const key = crypto.randomUUID()
  const input = {
    type: 'transaction_test', payload: { organizationId: tenant.organizationId, teamId: tenant.teamId },
    organizationId: tenant.organizationId, teamId: tenant.teamId, idempotencyKey: key,
  }
  const first = await db.$transaction((tx) => enqueue(tx, input))
  const duplicate = await db.$transaction((tx) => enqueue(tx, input))
  expect(duplicate).toEqual({ id: first.id, created: false })
  const row = await db.queueJob.findUniqueOrThrow({ where: { id: first.id } })
  expect(row).toMatchObject({ organizationId: tenant.organizationId, teamId: tenant.teamId, payload: input.payload })
  await db.organization.delete({ where: { id: tenant.organizationId } })
})

it('deduplicates concurrent transaction-client enqueues', async () => {
  const tenant = await seedTenant(db)
  const input = {
    type: 'concurrent_transaction_test',
    payload: { organizationId: tenant.organizationId, teamId: tenant.teamId },
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    idempotencyKey: crypto.randomUUID(),
  }
  const results = await Promise.all([
    db.$transaction((tx) => enqueue(tx, input)),
    db.$transaction((tx) => enqueue(tx, input)),
  ])
  expect(new Set(results.map((result) => result.id)).size).toBe(1)
  expect(results.filter((result) => result.created)).toHaveLength(1)
  expect(await db.queueJob.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(1)
  await db.organization.delete({ where: { id: tenant.organizationId } })
})

it('does not return a job owned by another tenant for a colliding key', async () => {
  const first = await seedTenant(db)
  const second = await seedTenant(db)
  const key = crypto.randomUUID()
  await enqueue(db, {
    type: 'tenant_collision_test', payload: {}, organizationId: first.organizationId, teamId: first.teamId, idempotencyKey: key,
  })
  await expect(enqueue(db, {
    type: 'tenant_collision_test', payload: {}, organizationId: second.organizationId, teamId: second.teamId, idempotencyKey: key,
  })).rejects.toThrow('Queue job idempotency key is already used by another job')
  await db.organization.delete({ where: { id: first.organizationId } })
  await db.organization.delete({ where: { id: second.organizationId } })
})

it('requeues failed work', async () => {
  const type = `system_${crypto.randomUUID()}`
  const item = await enqueue(db, { type, payload: {}, maxAttempts: 2 })
  const job = await claimNext(db, 'worker', [type])
  expect(job?.id).toBe(item.id)
  expect(await fail(db, item.id, 'worker', 'failed')).toBe(true)
  await db.queueJob.delete({ where: { id: item.id } })
})
