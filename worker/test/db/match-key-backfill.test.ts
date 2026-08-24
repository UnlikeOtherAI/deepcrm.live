import { createDb, dropTenant, seedTenant, writeAudit, type QueueJob } from '@deepcrm/db'
import { enqueue } from '@deepcrm/queue'
import { afterAll, describe, expect, it } from 'vitest'

import type { JobHandlerInput } from '../../src/index.js'
import {
  MATCH_KEY_BACKFILL_JOB,
  matchKeyBackfillHandler,
  replacementBackfillKey,
  type ReplacementBackfillPayload,
} from '../../src/jobs/match-key-backfill.js'

const databaseUrl = process.env.DATABASE_URL
const describeDb = databaseUrl === undefined ? describe.skip : describe
const db = createDb(databaseUrl ?? '')

afterAll(async () => {
  await db.$disconnect()
})

type Fixture = {
  organizationId: string
  teamId: string
  objectTypeId: string
  generationId: string
  ruleId: string
}

async function fixture(colliding = true): Promise<Fixture> {
  const tenant = await seedTenant(db)
  const objectType = await db.objectType.create({
    data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      slug: 'contact',
      singularName: 'Contact',
      pluralName: 'Contacts',
      description: 'Backfill handler fixture',
      kind: 'custom',
      createdByType: 'system',
      createdById: 'match_key_backfill_test',
    },
  })
  await db.attribute.create({
    data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      objectTypeId: objectType.id,
      slug: 'email',
      name: 'Email',
      description: '',
      type: 'email',
    },
  })
  const emails = colliding
    ? ['same@example.com', 'same@example.com', 'other@example.com']
    : ['first@example.com', 'second@example.com', 'third@example.com']
  await db.record.createMany({
    data: emails.map((email) => ({
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      objectTypeId: objectType.id,
      data: { email },
      displayName: email,
      createdByType: 'system' as const,
      createdById: 'match_key_backfill_test',
    })),
  })
  const generation = await db.matchingRuleGeneration.create({
    data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      objectTypeId: objectType.id,
      state: 'pending_backfill',
      fingerprint: `replacement:${objectType.id}`,
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
    include: { rules: true },
  })
  const rule = generation.rules[0]
  if (rule === undefined) throw new Error('fixture rule missing')
  expect(rule.generationId).toBe(generation.id)
  return {
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    objectTypeId: objectType.id,
    generationId: generation.id,
    ruleId: rule.id,
  }
}

function replacementPayload(fixture: Fixture, generationId: string): ReplacementBackfillPayload {
  return {
    organizationId: fixture.organizationId,
    teamId: fixture.teamId,
    objectTypeId: fixture.objectTypeId,
    generationId,
    attempt: 0,
    actor: { type: 'human', id: 'usr_backfill_operator' },
    onBehalfOf: { uoaUserId: 'usr_backfill_operator', role: 'admin' },
    requestId: 'req_backfill_1',
    provenance: { runId: 'run_backfill_1', toolCallId: 'call_backfill_1', requestId: 'req_backfill_1' },
    auditMetadata: {
      app: 'deepcrm:mcp',
      actChain: [{ sub: 'usr_backfill_operator', product: 'mcp' }],
      provenance: { runId: 'run_backfill_1', toolCallId: 'call_backfill_1', requestId: 'req_backfill_1' },
    },
  }
}

async function claimTenantJob(tenant: { organizationId: string; teamId: string }, workerId: string): Promise<QueueJob> {
  for (let tries = 0; tries < 40; tries += 1) {
    const claimed = await db.$queryRaw<Array<{ id: string }>>`
      UPDATE queue_jobs SET status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
      WHERE id = (
        SELECT id FROM queue_jobs
        WHERE ((status = 'queued' AND visible_at <= now()) OR (status = 'running' AND locked_at < now() - interval '10 minutes'))
          AND type = ${MATCH_KEY_BACKFILL_JOB}
          AND organization_id = ${tenant.organizationId}::uuid
          AND team_id = ${tenant.teamId}::uuid
        ORDER BY priority DESC, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id
    `
    const id = claimed[0]?.id
    if (id === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      continue
    }
    const job = await db.queueJob.findUnique({ where: { id } })
    if (job !== null) return job
  }
  throw new Error('tenant job was not claimable')
}

async function claimHandlerInput(jobId: string, tenant: { organizationId: string; teamId: string }): Promise<JobHandlerInput> {
  const job = await claimTenantJob(tenant, 'backfill-worker')
  expect(job.id).toBe(jobId)
  return {
    db,
    job,
    workerId: 'backfill-worker',
    clock: () => new Date(),
    writeAudit,
    progress: async () => false,
    terminalize: async () => false,
  }
}

async function cleanup(fixture: Fixture): Promise<void> {
  await db.queueJob.deleteMany({ where: {
    organizationId: fixture.organizationId,
    teamId: fixture.teamId,
  } })
  await db.auditLog.deleteMany({ where: { organizationId: fixture.organizationId } })
  await dropTenant(db, fixture.organizationId)
}

describeDb('match-key-backfill handler', () => {

  it('blocks on lookup collisions with count-only results and terminalizes inside the audit transaction', async () => {
    const seeded = await fixture()
    const generationId = seeded.generationId
    try {
      const queued = await enqueue(db, {
        organizationId: seeded.organizationId,
        teamId: seeded.teamId,
        type: MATCH_KEY_BACKFILL_JOB,
        payload: replacementPayload(seeded, generationId),
        idempotencyKey: `match-key-backfill:${seeded.teamId}:${seeded.objectTypeId}:${generationId}:0`,
      })
      const bound = await db.matchingRuleGeneration.update({
        where: { id: generationId },
        data: { backfillAttempt: 0, backfillJobId: queued.id },
        select: { id: true },
      })
      expect(bound.id).toBe(generationId)
      const input = await claimHandlerInput(queued.id, seeded)
      const outcome = await matchKeyBackfillHandler(input)
      expect(outcome).toEqual({ terminalized: true })

      const job = await db.queueJob.findUniqueOrThrow({ where: { id: queued.id } })
      expect(job.status).toBe('completed')
      expect(job.result).toEqual({ state: 'collisions', group_count: 1, record_count: 2 })
      expect(JSON.stringify(job.result)).not.toContain('same@example.com')

      const generation = await db.matchingRuleGeneration.findUniqueOrThrow({ where: { id: generationId } })
      expect(generation).toMatchObject({
        state: 'collision_blocked',
        processedRecords: 3,
        collisionGroups: 1,
        collisionRecords: 2,
        keysReadyAt: null,
      })
      const blocks = await db.recordMatchKey.count({
        where: { organizationId: seeded.organizationId, teamId: seeded.teamId },
      })
      expect(blocks).toBe(0)
      const lookups = await db.recordMatchLookupKey.count({
        where: {
          organizationId: seeded.organizationId,
          teamId: seeded.teamId,
          matchingRuleId: seeded.ruleId,
        },
      })
      expect(lookups).toBe(3)

      const audits = await db.auditLog.findMany({
        where: { organizationId: seeded.organizationId, teamId: seeded.teamId },
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        action: 'schema.matching_rules.backfill_blocked',
        actorType: 'human',
        actorId: 'usr_backfill_operator',
        onBehalfOf: 'usr_backfill_operator',
        outcome: 'success',
        metadata: {
          app: 'deepcrm:mcp',
          actChain: [{ sub: 'usr_backfill_operator', product: 'mcp' }],
          provenance: { runId: 'run_backfill_1', toolCallId: 'call_backfill_1', requestId: 'req_backfill_1' },
        },
      })


    } finally {
      await cleanup(seeded)
    }
  })

  it('stale claimed attempt mutates nothing and never completes the newer job', async () => {
    const seeded = await fixture()
    const firstGenerationId = seeded.generationId
    try {
      const first = await enqueue(db, {
        organizationId: seeded.organizationId,
        teamId: seeded.teamId,
        type: MATCH_KEY_BACKFILL_JOB,
        payload: replacementPayload(seeded, firstGenerationId),
        idempotencyKey: `match-key-backfill:${seeded.teamId}:${seeded.objectTypeId}:${firstGenerationId}:0`,
      })
      await db.matchingRuleGeneration.update({
        where: { id: firstGenerationId },
        data: { backfillAttempt: 0, backfillJobId: first.id },
        select: { id: true },
      })
      const claimed = await claimTenantJob(seeded, 'stale-worker')
      expect(claimed.id).toBe(first.id)

      // A newer attempt supersedes the claimed lease.
      const replacement = await db.matchingRuleGeneration.update({
        where: { id: firstGenerationId },
        data: { backfillAttempt: 1, backfillJobId: null, processedRecords: 0 },
        select: { id: true },
      })
      const outcome = await matchKeyBackfillHandler({
        db,
        job: { ...claimed, payload: { ...replacementPayload(seeded, replacement.id), attempt: 0 } },
        workerId: 'stale-worker',
        clock: () => new Date(),
        writeAudit,
        progress: async () => false,
        terminalize: async () => false,
      })
      expect(outcome).toBeUndefined()
      const generation = await db.matchingRuleGeneration.findUniqueOrThrow({
        where: { id: firstGenerationId },
      })
      expect(generation).toMatchObject({
        state: 'pending_backfill',
        backfillAttempt: 1,
        processedRecords: 0,
        collisionGroups: 0,
      })
      const [audits, lookups, staleJob] = await Promise.all([
        db.auditLog.count({ where: { organizationId: seeded.organizationId, teamId: seeded.teamId } }),
        db.recordMatchLookupKey.count({
          where: { organizationId: seeded.organizationId, teamId: seeded.teamId },
        }),
        db.queueJob.findUniqueOrThrow({ where: { id: first.id } }),
      ])
      expect(audits).toBe(0)
      expect(lookups).toBe(0)
      expect(staleJob).toMatchObject({ status: 'running', progress: null, result: null })
    } finally {
      await cleanup(seeded)
    }
  })

  it('activates a collision-free replacement and creates authoritative block rows', async () => {
    const seeded = await fixture(false)
    try {
      const payload = replacementPayload(seeded, seeded.generationId)
      const queued = await enqueue(db, {
        organizationId: seeded.organizationId,
        teamId: seeded.teamId,
        type: MATCH_KEY_BACKFILL_JOB,
        payload,
        idempotencyKey: replacementBackfillKey(payload),
      })
      await db.matchingRuleGeneration.update({
        where: { id: seeded.generationId },
        data: { backfillAttempt: 0, backfillJobId: queued.id },
      })
      await matchKeyBackfillHandler(await claimHandlerInput(queued.id, seeded))
      const [generation, job, blocks, audit] = await Promise.all([
        db.matchingRuleGeneration.findUniqueOrThrow({ where: { id: seeded.generationId } }),
        db.queueJob.findUniqueOrThrow({ where: { id: queued.id } }),
        db.recordMatchKey.count({
          where: { organizationId: seeded.organizationId, teamId: seeded.teamId },
        }),
        db.auditLog.findFirstOrThrow({
          where: { organizationId: seeded.organizationId, teamId: seeded.teamId },
        }),
      ])
      expect(generation).toMatchObject({ state: 'active', processedRecords: 3 })
      expect(generation.keysReadyAt).not.toBeNull()
      expect(job).toMatchObject({ status: 'completed', result: { state: 'active', processed: 3 } })
      expect(blocks).toBe(3)
      expect(audit.action).toBe('schema.matching_rules.activate')
    } finally {
      await cleanup(seeded)
    }
  })
})
