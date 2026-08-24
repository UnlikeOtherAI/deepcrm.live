import { createDb, Prisma, seedTenant, writeAudit } from '@deepcrm/db'
import { cancel, complete, enqueue, fail, progress as queueProgress } from '@deepcrm/queue'
import { BulkAssertPayload, ErrorCode, ServiceError } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { JobHandlerInput } from '../../src/index.js'
import { BULK_ASSERT_JOB, createBulkAssertHandler } from '../../src/jobs/bulk-assert.js'
import type { BulkAssertRecordPort } from '../../src/bulk-assert-port.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for bulk worker tests')
const db = createDb(databaseUrl)
const organizationIds: string[] = []
const jobIds: string[] = []

async function fixture(total: number) {
  const tenant = await seedTenant(db)
  organizationIds.push(tenant.organizationId)
  const scope = { organizationId: tenant.organizationId, teamId: tenant.teamId }
  const payload = {
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    objectType: 'person',
    matchAttribute: 'external_ref',
    rows: Array.from({ length: total }, (_, index) => ({
      data: { external_ref: `row-${index}` },
      idempotencyKey: `row-key-${index}`,
    })),
    argumentsHash: 'a'.repeat(64),
    actorContext: {
      tenant: scope,
      app: 'bulk-worker-test',
      actChain: [],
      actor: { type: 'human', id: 'uoa_bulk_worker' },
      onBehalfOf: { uoaUserId: 'uoa_bulk_worker', role: 'owner' },
      provenance: null,
      requestId: crypto.randomUUID(),
    },
  } satisfies Prisma.InputJsonObject
  BulkAssertPayload.parse(payload)
  const job = await enqueue(db, {
    type: BULK_ASSERT_JOB,
    payload,
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    maxAttempts: 3,
  })
  jobIds.push(job.id)
  return { tenant: scope, job }
}

async function handlerInput(id: string, workerId: string): Promise<JobHandlerInput> {
  const claimed = await db.queueJob.updateMany({
    where: { id, status: 'queued' },
    data: {
      status: 'running', lockedAt: new Date(), lockedBy: workerId,
      attempts: { increment: 1 },
    },
  })
  if (claimed.count !== 1) throw new Error('Expected exact bulk fixture job to be queued')
  const job = await db.queueJob.findUniqueOrThrow({ where: { id } })
  return {
    db,
    job,
    workerId,
    clock: () => new Date('2026-08-24T12:00:00.000Z'),
    writeAudit,
    progress: (value) => queueProgress(db, id, workerId, value),
    terminalize: (tx, result) => complete(tx, id, workerId, result),
  }
}

afterAll(async () => {
  await db.queueJob.deleteMany({ where: { id: { in: jobIds } } })
  for (const organizationId of organizationIds) {
    await db.organization.delete({ where: { id: organizationId } })
  }
  await db.$disconnect()
})

describe('bulk assert worker', () => {
  it('processes 250 authoritative asserts in 100-row chunks and retries infrastructure errors', async () => {
    const target = await fixture(250)
    const completedKeys = new Set<string>()
    const observedProgress: number[] = []
    let injectedRetry = false
    const recordAssert: BulkAssertRecordPort = async (_ctx, input) => {
      const calls = completedKeys.size
      if (calls === 100 && !injectedRetry) {
        injectedRetry = true
        throw new ServiceError(ErrorCode.INTERNAL, 'Temporary storage failure')
      }
      if (calls === 100 || calls === 200) {
        const job = await db.queueJob.findUniqueOrThrow({ where: { id: target.job.id } })
        if (typeof job.progress === 'object' && job.progress !== null && !Array.isArray(job.progress)) {
          const done = job.progress['done']
          if (typeof done === 'number') observedProgress.push(done)
        }
      }
      completedKeys.add(input.idempotencyKey)
      return { created: true }
    }
    const handler = createBulkAssertHandler(recordAssert)
    const first = await handlerInput(target.job.id, 'bulk-worker-first')
    await expect(handler(first)).rejects.toMatchObject({ code: ErrorCode.INTERNAL })
    expect(await fail(
      db, target.job.id, first.workerId, 'Temporary storage failure',
    )).toBe(true)
    const second = await handlerInput(target.job.id, 'bulk-worker-second')
    await expect(handler(second)).resolves.toEqual({ terminalized: true })
    const stored = await db.queueJob.findUniqueOrThrow({ where: { id: target.job.id } })

    expect({ status: stored.status, attempts: stored.attempts, injectedRetry })
      .toEqual({ status: 'completed', attempts: 2, injectedRetry: true })
    expect(stored.progress).toEqual({ done: 250, total: 250 })
    expect(stored.result).toEqual({ created: 250, updated: 0, failed: [] })
    expect(completedKeys).toHaveLength(250)
    expect(observedProgress).toEqual(expect.arrayContaining([100, 200]))
  }, 20_000)

  it('stops cooperatively when cancellation wins at a batch boundary', async () => {
    const target = await fixture(250)
    let calls = 0
    const recordAssert = async () => {
      calls += 1
      if (calls === 100) await cancel(db, target.job.id, target.tenant)
      return { created: true }
    }
    const handler = createBulkAssertHandler(recordAssert)
    const input = await handlerInput(target.job.id, 'bulk-worker-cancel')
    await expect(handler(input)).resolves.toBeUndefined()
    const stored = await db.queueJob.findUniqueOrThrow({ where: { id: target.job.id } })

    expect(stored.status).toBe('cancelled')
    expect(stored.result).toBeNull()
    expect(calls).toBe(100)
  }, 20_000)
})
