import { createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import { cancel } from '@deepcrm/queue'
import { afterAll, describe, expect, it } from 'vitest'

import { ActiveBootstrapPayloadSchema } from '../../src/jobs/match-key-backfill.js'
import { matchKeyBackfillHandler } from '../../src/jobs/match-key-backfill.js'
import { enqueueMatchingBootstrapCandidate } from '../../src/matching-bootstrap.js'
import type { JobHandlerInput } from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
const describeDb = databaseUrl === undefined ? describe.skip : describe
const db = createDb(databaseUrl ?? '')

type Fixture = {
  organizationId: string
  teamId: string
  objectTypeId: string
  generationId: string
}

async function fixture(records: 'none' | 'unique' | 'collision' = 'none'): Promise<Fixture> {
  const tenant = await seedTenant(db)
  const objectType = await db.objectType.create({
    data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      slug: 'contact',
      singularName: 'Contact',
      pluralName: 'Contacts',
      description: 'Bootstrap fixture',
      kind: 'custom',
      createdByType: 'system',
      createdById: 'matching_bootstrap_test',
    },
  })
  const generation = await db.matchingRuleGeneration.create({
    data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      objectTypeId: objectType.id,
      state: 'active',
      fingerprint: `legacy:${objectType.id}`,
      rules: {
        create: {
          organizationId: tenant.organizationId,
          teamId: tenant.teamId,
          objectTypeId: objectType.id,
          position: 0,
          attributeSlugs: ['email'],
          method: 'normalized',
          action: 'block',
        },
      },
    },
  })
  await db.attribute.create({
    data: {
      organizationId: tenant.organizationId, teamId: tenant.teamId, objectTypeId: objectType.id,
      slug: 'email', name: 'Email', description: 'Bootstrap email', type: 'email',
    },
  })
  if (records !== 'none') {
    const emails = records === 'collision'
      ? ['same@example.com', 'SAME@example.com']
      : ['first@example.com', 'second@example.com']
    await db.record.createMany({
      data: emails.map((email) => ({
        organizationId: tenant.organizationId, teamId: tenant.teamId, objectTypeId: objectType.id,
        data: { email }, displayName: email, visibility: 'team' as const,
        createdByType: 'system' as const, createdById: 'matching_bootstrap_test',
      })),
    })
  }
  return {
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    objectTypeId: objectType.id,
    generationId: generation.id,
  }
}

async function cleanup(target: Fixture): Promise<void> {
  await db.queueJob.deleteMany({ where: {
    organizationId: target.organizationId,
    teamId: target.teamId,
  } })
  await db.auditLog.deleteMany({ where: { organizationId: target.organizationId } })
  await dropTenant(db, target.organizationId)
}

const deps = {
  db,
  ids: () => crypto.randomUUID(),
  writeAudit,
}
const env = {
  DATABASE_URL: databaseUrl ?? '',
  DEEPCRM_BOOTSTRAP_UOA_USER_ID: 'usr_bootstrap_operator',
}

async function enqueueTarget(
  target: Fixture,
  retryBootstrap: boolean,
) {
  const candidate = {
    id: target.generationId,
    organizationId: target.organizationId,
    teamId: target.teamId,
    objectTypeId: target.objectTypeId,
  }
  const job = await enqueueMatchingBootstrapCandidate(deps, candidate, env, { retryBootstrap })
  return job === null ? [] : [job]
}

async function runJob(target: Fixture, jobId: string): Promise<void> {
  const job = await db.queueJob.update({
    where: { id: jobId },
    data: { status: 'running', lockedBy: 'bootstrap-worker', lockedAt: new Date() },
  })
  const input: JobHandlerInput = {
    db, job, workerId: 'bootstrap-worker', clock: () => new Date(), writeAudit,
    progress: async () => false,
    terminalize: async () => false,
  }
  await expect(matchKeyBackfillHandler(input)).resolves.toEqual({ terminalized: true })
  const stored = await db.queueJob.findUniqueOrThrow({ where: { id: jobId } })
  expect(stored.status).toBe('completed')
  expect(stored.organizationId).toBe(target.organizationId)
}

afterAll(async () => {
  await db.$disconnect()
})

describeDb('matching bootstrap enqueue', () => {
  it('enqueues once with full attribution and reuses queued work', async () => {
    const target = await fixture()
    try {
      const first = await enqueueTarget(target, false)
      expect(first).toHaveLength(1)
      expect(first[0]).toMatchObject({
        generationId: target.generationId,
        attempt: 0,
        created: true,
      })
      const jobId = first[0]?.jobId
      if (jobId === undefined) throw new Error('Missing bootstrap job')
      const job = await db.queueJob.findUniqueOrThrow({ where: { id: jobId } })
      const payload = ActiveBootstrapPayloadSchema.parse(job.payload)
      expect(payload).toMatchObject({
        organizationId: target.organizationId,
        teamId: target.teamId,
        objectTypeId: target.objectTypeId,
        generationId: target.generationId,
        mode: 'active_bootstrap',
        attempt: 0,
        context: {
          app: 'deepcrm:migration',
          actor: { type: 'system', id: 'deepcrm:migration:t16' },
          onBehalfOf: { uoaUserId: 'usr_bootstrap_operator', role: null },
        },
      })

      const repeated = await enqueueTarget(target, false)
      expect(repeated).toEqual([{ ...first[0], created: false }])
      const audits = await db.auditLog.findMany({
        where: { organizationId: target.organizationId, teamId: target.teamId },
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        action: 'schema.matching_rules.bootstrap_queued',
        actorType: 'system',
        actorId: 'deepcrm:migration:t16',
        onBehalfOf: 'usr_bootstrap_operator',
        metadata: {
          attempt: 0,
          retry: false,
          app: 'deepcrm:migration',
          actChain: [],
        },
      })
    } finally {
      await cleanup(target)
    }
  })

  it('requires explicit retry and creates a new terminal attempt identity', async () => {
    const target = await fixture()
    try {
      const initial = await enqueueTarget(target, false)
      const first = initial[0]
      if (first === undefined) throw new Error('Missing bootstrap job')
      await expect(cancel(db, first.jobId, target)).resolves.toBe(true)
      await expect(enqueueTarget(target, false)).rejects.toThrow('requires --retry-terminal')

      const retried = await enqueueTarget(target, true)
      expect(retried).toHaveLength(1)
      expect(retried[0]).toMatchObject({ attempt: 1, created: true })
      expect(retried[0]?.jobId).not.toBe(first.jobId)
      const generation = await db.matchingRuleGeneration.findUniqueOrThrow({
        where: { id: target.generationId },
      })
      expect(generation).toMatchObject({
        bootstrapAttempt: 1,
        bootstrapJobId: retried[0]?.jobId,
      })
      const audits = await db.auditLog.findMany({
        where: { organizationId: target.organizationId, teamId: target.teamId },
        orderBy: { createdAt: 'asc' },
      })
      expect(audits.map((audit) => audit.metadata)).toMatchObject([
        { attempt: 0, retry: false },
        { attempt: 1, retry: true },
      ])
    } finally {
      await cleanup(target)
    }
  })

  it('fails closed when a completed job has no readiness marker', async () => {
    const target = await fixture()
    try {
      const queued = await enqueueTarget(target, false)
      const job = queued[0]
      if (job === undefined) throw new Error('Missing bootstrap job')
      await db.queueJob.update({ where: { id: job.jobId }, data: { status: 'completed' } })
      await expect(enqueueTarget(target, true)).rejects.toThrow('no readiness marker')
    } finally {
      await cleanup(target)
    }
  })

  it('rebuilds canonical keys and marks a collision-free generation ready', async () => {
    const target = await fixture('unique')
    try {
      const queued = (await enqueueTarget(target, false))[0]
      if (queued === undefined) throw new Error('Missing bootstrap job')
      await runJob(target, queued.jobId)
      const [generation, job, blocks, lookups, audits] = await Promise.all([
        db.matchingRuleGeneration.findUniqueOrThrow({ where: { id: target.generationId } }),
        db.queueJob.findUniqueOrThrow({ where: { id: queued.jobId } }),
        db.recordMatchKey.count({ where: { organizationId: target.organizationId, teamId: target.teamId } }),
        db.recordMatchLookupKey.count({ where: { organizationId: target.organizationId, teamId: target.teamId } }),
        db.auditLog.findMany({
          where: { organizationId: target.organizationId, teamId: target.teamId },
          orderBy: { createdAt: 'asc' },
        }),
      ])
      expect(generation.keysReadyAt).not.toBeNull()
      expect(job.result).toEqual({ state: 'active', processed: 2 })
      expect(blocks).toBe(2)
      expect(lookups).toBe(2)
      expect(audits.map((audit) => audit.action)).toEqual([
        'schema.matching_rules.bootstrap_queued', 'schema.matching_rules.bootstrap',
      ])
    } finally {
      await cleanup(target)
    }
  })

  it('reports canonical collisions without enabling matching', async () => {
    const target = await fixture('collision')
    try {
      const queued = (await enqueueTarget(target, false))[0]
      if (queued === undefined) throw new Error('Missing bootstrap job')
      await runJob(target, queued.jobId)
      const [generation, job, blocks, audits] = await Promise.all([
        db.matchingRuleGeneration.findUniqueOrThrow({ where: { id: target.generationId } }),
        db.queueJob.findUniqueOrThrow({ where: { id: queued.jobId } }),
        db.recordMatchKey.count({ where: { organizationId: target.organizationId, teamId: target.teamId } }),
        db.auditLog.findMany({
          where: { organizationId: target.organizationId, teamId: target.teamId },
          orderBy: { createdAt: 'asc' },
        }),
      ])
      expect(generation).toMatchObject({ state: 'active', keysReadyAt: null })
      expect(job.result).toEqual({ state: 'collisions', group_count: 1, record_count: 2 })
      expect(blocks).toBe(0)
      expect(audits.map((audit) => audit.action)).toEqual([
        'schema.matching_rules.bootstrap_queued', 'schema.matching_rules.bootstrap',
      ])
    } finally {
      await cleanup(target)
    }
  })
})
