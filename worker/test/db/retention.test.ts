import { access, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startWorker } from '../../src/index.js'
import { createRetentionHandler, RETENTION_JOB } from '../../src/jobs/retention.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for retention tests')
const db = createDb(databaseUrl)
const now = new Date('2026-08-24T20:00:00.000Z')
let exportDir: string
let organizationId: string
let teamId: string

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function waitForJob(id: string) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const job = await db.queueJob.findUniqueOrThrow({ where: { id } })
    if (job.status === 'completed' || job.status === 'failed') return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Retention job did not become terminal')
}

beforeAll(async () => {
  exportDir = await mkdtemp(join(tmpdir(), 'deepcrm-retention-test-'))
  const tenant = await seedTenant(db)
  organizationId = tenant.organizationId
  teamId = tenant.teamId
})

afterAll(async () => {
  await db.queueJob.deleteMany({ where: { type: RETENTION_JOB } })
  await dropTenant(db, organizationId)
  await db.$disconnect()
  await rm(exportDir, { recursive: true, force: true })
})

describe('daily retention', () => {
  it('prunes expired files, deleted records, and replay rows, then schedules tomorrow', async () => {
    const objectType = await db.objectType.create({ data: {
      organizationId,
      teamId,
      slug: 'retention_record',
      singularName: 'Retention record',
      pluralName: 'Retention records',
      description: 'Retention test object.',
      kind: 'custom',
      createdByType: 'system',
      createdById: 'retention-test',
    } })
    const oldRecord = await db.record.create({ data: {
      organizationId,
      teamId,
      objectTypeId: objectType.id,
      displayName: 'Expired record',
      deletedAt: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1_000),
      createdByType: 'system',
      createdById: 'retention-test',
    } })
    const replay = await db.idempotencyReplay.create({ data: {
      organizationId,
      teamId,
      principalUserId: 'retention-user',
      key: crypto.randomUUID(),
      tool: 'retention-test',
      argumentsHash: 'a'.repeat(64),
      result: {},
      createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1_000),
    } })
    const oldFile = join(exportDir, `${crypto.randomUUID()}.csv`)
    const freshFile = join(exportDir, `${crypto.randomUUID()}.jsonl`)
    await writeFile(oldFile, 'old')
    await writeFile(freshFile, 'fresh')
    await utimes(oldFile, new Date(now.getTime() - 61 * 60 * 1_000), new Date(now.getTime() - 61 * 60 * 1_000))

    const job = await db.queueJob.create({ data: {
      type: RETENTION_JOB,
      payload: { scheduledFor: now.toISOString() },
    } })
    const controller = new AbortController()
    const worker = startWorker(
      { db, clock: () => now, ids: () => crypto.randomUUID(), writeAudit },
      { [RETENTION_JOB]: createRetentionHandler({ exportDir, retentionDays: 30 }) },
      controller.signal,
    )
    const completed = await waitForJob(job.id)
    controller.abort()
    await worker

    expect(completed.status).toBe('completed')
    expect(await exists(oldFile)).toBe(false)
    expect(await exists(freshFile)).toBe(true)
    expect(await db.record.findFirst({ where: { id: oldRecord.id, organizationId, teamId } })).toBeNull()
    expect(await db.idempotencyReplay.findFirst({
      where: { id: replay.id, organizationId, teamId },
    })).toBeNull()
    const next = await db.queueJob.findUnique({
      where: { idempotencyKey: 'retention:2026-08-25' },
    })
    expect(next).toMatchObject({ type: RETENTION_JOB, status: 'queued' })
    expect(next?.visibleAt.toISOString()).toBe('2026-08-25T20:00:00.000Z')
  })
})
