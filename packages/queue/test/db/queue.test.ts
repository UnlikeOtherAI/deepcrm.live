import { createDb, seedTenant } from '@deepcrm/db'
import { afterAll, expect, it } from 'vitest'
import {
  cancel, claimNext, complete, enqueue, fail, QueueIdempotencyMismatchError,
} from '../../src/index.js'

const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(url)
afterAll(async () => { await db.$disconnect() })

function argumentsMatch(expected: string) {
  return (payload: unknown): boolean => (
    typeof payload === 'object'
    && payload !== null
    && !Array.isArray(payload)
    && 'argumentsHash' in payload
    && payload.argumentsHash === expected
  )
}

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

it('completes and cancels through transaction clients', async () => {
  const tenant = await seedTenant(db)
  const completed = await enqueue(db, {
    type: 'transaction_complete', payload: {},
    organizationId: tenant.organizationId, teamId: tenant.teamId,
  })
  const claimed = await claimNext(db, 'worker', ['transaction_complete'])
  expect(claimed?.id).toBe(completed.id)
  await expect(db.$transaction((tx) => (
    complete(tx, completed.id, 'worker', { terminal: true })
  ))).resolves.toBe(true)

  const cancelled = await enqueue(db, {
    type: 'transaction_cancel', payload: {},
    organizationId: tenant.organizationId, teamId: tenant.teamId,
  })
  await expect(db.$transaction((tx) => cancel(tx, cancelled.id, tenant))).resolves.toBe(true)
  const rows = await db.queueJob.findMany({
    where: { id: { in: [completed.id, cancelled.id] } },
  })
  expect(rows.find((row) => row.id === completed.id)).toMatchObject({
    status: 'completed', result: { terminal: true },
  })
  expect(rows.find((row) => row.id === cancelled.id)).toMatchObject({
    status: 'cancelled', result: null,
  })
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

it('rejects changed payload under the same idempotency key', async () => {
  const tenant = await seedTenant(db)
  const key = crypto.randomUUID()
  const scope = {
    type: 'payload_collision_test', organizationId: tenant.organizationId,
    teamId: tenant.teamId, idempotencyKey: key,
  }
  await enqueue(db, { ...scope, payload: { value: 1 } })
  await expect(enqueue(db, { ...scope, payload: { value: 2 } }))
    .rejects.toBeInstanceOf(QueueIdempotencyMismatchError)
  await db.organization.delete({ where: { id: tenant.organizationId } })
})

it('deduplicates concurrent logical replays while preserving original request payload', async () => {
  const tenant = await seedTenant(db)
  const key = crypto.randomUUID()
  const hash = 'a'.repeat(64)
  const scope = {
    type: 'logical_replay_test', organizationId: tenant.organizationId,
    teamId: tenant.teamId, idempotencyKey: key, matchesExistingPayload: argumentsMatch(hash),
  }
  const results = await Promise.all([
    enqueue(db, { ...scope, payload: { argumentsHash: hash, requestId: 'request_one' } }),
    enqueue(db, { ...scope, payload: { argumentsHash: hash, requestId: 'request_two' } }),
  ])
  expect(new Set(results.map((result) => result.id)).size).toBe(1)
  expect(results.filter((result) => result.created)).toHaveLength(1)
  const firstResult = results[0]
  if (firstResult === undefined) throw new Error('Expected a queue result')
  const stored = await db.queueJob.findUniqueOrThrow({ where: { id: firstResult.id } })
  expect(stored.payload).toEqual(expect.objectContaining({ argumentsHash: hash }))
  await expect(enqueue(db, {
    ...scope,
    matchesExistingPayload: argumentsMatch('b'.repeat(64)),
    payload: { argumentsHash: 'b'.repeat(64), requestId: 'request_three' },
  })).rejects.toBeInstanceOf(QueueIdempotencyMismatchError)
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
