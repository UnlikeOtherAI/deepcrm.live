import { createDb, seedTenant } from '@deepcrm/db'
import { cancel, enqueue } from '@deepcrm/queue'
import { afterAll, describe, expect, it } from 'vitest'
import type { JobHandler } from '../../src/index.js'
import { noop } from '../../src/jobs/noop.js'
import { startWorker } from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
const describeDb = databaseUrl === undefined ? describe.skip : describe

describeDb('worker loop', () => {
const db = createDb(databaseUrl ?? '')
const workerDeps = {
  db,
  clock: () => new Date(),
  ids: () => crypto.randomUUID(),
}
const organizationIds: string[] = []

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: organizationIds } } })
  await db.$disconnect()
})

async function createTenant() {
  const tenant = await seedTenant(db)
  organizationIds.push(tenant.organizationId)
  return tenant
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return
    await sleep(10)
  }
  throw new Error(message)
}

it('completes a noop job and stops on abort', async () => {
  const tenant = await createTenant()
  const item = await enqueue(db, {
    type: 'noop',
    payload: {},
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
  })
  const controller = new AbortController()
  const loop = startWorker(workerDeps, { noop }, controller.signal)

  await waitFor(async () => {
    const job = await db.queueJob.findUniqueOrThrow({ where: { id: item.id } })
    return job.status === 'completed'
  }, 'noop job did not complete')
  controller.abort()
  await loop
})

it('does not claim jobs with an empty handler registry', async () => {
  const tenant = await createTenant()
  const item = await enqueue(db, {
    type: 'noop',
    payload: {},
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
  })
  const controller = new AbortController()
  const loop = startWorker(workerDeps, {}, controller.signal)

  await sleep(30)
  controller.abort()
  await loop
  const job = await db.queueJob.findUniqueOrThrow({ where: { id: item.id } })
  expect(job.status).toBe('queued')
  expect(job.lockedBy).toBeNull()
})

it('does not claim a job whose type has no registered handler', async () => {
  const tenant = await createTenant()
  const item = await enqueue(db, {
    type: 'other',
    payload: {},
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
  })
  const controller = new AbortController()
  const loop = startWorker(workerDeps, { noop }, controller.signal)

  await sleep(30)
  controller.abort()
  await loop
  const job = await db.queueJob.findUniqueOrThrow({ where: { id: item.id } })
  expect(job.status).toBe('queued')
  expect(job.lockedBy).toBeNull()
})

it('claims at most four jobs concurrently', async () => {
  const tenant = await createTenant()
  const jobs = await Promise.all(Array.from({ length: 5 }, () => enqueue(db, {
    type: 'held',
    payload: {},
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
  })))
  const started = new Set<string>()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const held: JobHandler = async ({ job }) => {
    started.add(job.id)
    await gate
  }
  const controller = new AbortController()
  const loop = startWorker(workerDeps, { held }, controller.signal)

  await waitFor(() => started.size === 4, 'worker did not claim four jobs')
  expect(started).toHaveLength(4)
  expect(jobs.filter((job) => started.has(job.id))).toHaveLength(4)
  if (release === undefined) throw new Error('handler gate was not created')
  release()
  await waitFor(async () => {
    const count = await db.queueJob.count({
      where: { id: { in: jobs.map((job) => job.id) }, status: 'completed' },
    })
    return count === 5
  }, 'worker did not drain held jobs')
  controller.abort()
  await loop
})

it('requeues a failed job without completing it', async () => {
  const tenant = await createTenant()
  const item = await enqueue(db, {
    type: 'failing',
    payload: {},
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
  })
  const failing: JobHandler = async () => {
    throw new Error('expected failure')
  }
  const controller = new AbortController()
  const loop = startWorker(workerDeps, { failing }, controller.signal)

  await waitFor(async () => {
    const job = await db.queueJob.findUniqueOrThrow({ where: { id: item.id } })
    return job.status === 'queued' && job.lastError === 'expected failure'
  }, 'failed job was not requeued')
  controller.abort()
  await loop
  const job = await db.queueJob.findUniqueOrThrow({ where: { id: item.id } })
  expect(job.status).toBe('queued')
  expect(job.lockedBy).toBeNull()
})

it('does not overwrite a cancellation after the handler returns', async () => {
  const tenant = await createTenant()
  const item = await enqueue(db, {
    type: 'held',
    payload: {},
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
  })
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const held: JobHandler = async () => gate
  const controller = new AbortController()
  const loop = startWorker(workerDeps, { held }, controller.signal)

  await waitFor(async () => {
    const job = await db.queueJob.findUniqueOrThrow({ where: { id: item.id } })
    return job.status === 'running'
  }, 'held job was not claimed')
  await expect(cancel(db, item.id, tenant)).resolves.toBe(true)
  if (release === undefined) throw new Error('handler gate was not created')
  release()
  await sleep(30)
  controller.abort()
  await loop
  const job = await db.queueJob.findUniqueOrThrow({ where: { id: item.id } })
  expect(job.status).toBe('cancelled')
})

it('drains active handlers after abort without claiming more jobs', async () => {
  const tenant = await createTenant()
  const first = await enqueue(db, {
    type: 'held',
    payload: {},
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
  })
  const second = await enqueue(db, {
    type: 'held',
    payload: {},
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
  })
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Set<string>()
  const held: JobHandler = async ({ job }) => {
    started.add(job.id)
    await gate
  }
  const controller = new AbortController()
  const loop = startWorker(workerDeps, { held }, controller.signal)

  await waitFor(() => started.size === 2, 'worker did not claim active jobs')
  controller.abort()
  let finished = false
  void loop.then(() => {
    finished = true
  })
  await sleep(30)
  expect(finished).toBe(false)
  if (release === undefined) throw new Error('handler gate was not created')
  release()
  await loop
  expect(started).toEqual(new Set([first.id, second.id]))
  const complete = await db.queueJob.count({
    where: { id: { in: [first.id, second.id] }, status: 'completed' },
  })
  expect(complete).toBe(2)
})
})
