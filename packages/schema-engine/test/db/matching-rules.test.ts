import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { afterAll, describe, expect, it } from 'vitest'

import {
  defineAttribute,
  defineObjectType,
  finalizeMatchingBackfill,
  loadSchema,
  materializeMatchingRecordBatch,
  retryMatchingRules,
  setMatchingRules,
} from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for matching lifecycle tests')

const db = createDb(databaseUrl)
const organizationIds: string[] = []
const actor = {
  type: 'system' as const,
  id: 'matching_rules_test',
  onBehalfOf: 'uoa_matching_rules_test',
  requestId: 'matching_rules_test',
}
const auditMetadata = {
  app: 'deepcrm:test',
  actChain: [{ sub: 'test-subject', product: 'deepcrm:test' }],
  provenance: { runId: 'matching-rules-test', toolCallId: 'set-rules', requestId: actor.requestId },
}
const matchingIdentity = {
  onBehalfOf: { uoaUserId: actor.onBehalfOf, role: 'owner' as const },
  auditMetadata,
}

async function setup(): Promise<{ organizationId: string; teamId: string; objectTypeId: string }> {
  const tenant = await seedTenant(db)
  organizationIds.push(tenant.organizationId)
  const object = await db.$transaction(async (tx) => {
    const created = await defineObjectType(tx, tenant, actor, {
      slug: 'person', singularName: 'Person', pluralName: 'People', description: 'A person',
    })
    await defineAttribute(tx, tenant, actor, {
      objectType: 'person', slug: 'email', name: 'Email', description: 'Email address',
      type: 'email', config: { type: 'email' }, is_multi: false, is_required: false,
      is_unique: true, is_indexed: true, sensitivity: 'internal',
    })
    return created
  })
  await db.record.create({
    data: {
      organizationId: tenant.organizationId, teamId: tenant.teamId, objectTypeId: object.id,
      data: { email: 'person@example.test' }, displayName: 'Person', visibility: 'team',
      createdByType: 'system', createdById: actor.id,
    },
  })
  return { ...tenant, objectTypeId: object.id }
}

afterAll(async () => {
  for (const organizationId of organizationIds) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('matching rule lifecycle', () => {
  it('persists a retryable backfill job and terminalizes activation atomically', async () => {
    const tenant = await setup()
    const first = await db.$transaction((tx) => setMatchingRules(tx, tenant, actor, 'person', {
      rules: [{ attributes: ['email'], method: 'normalized', action: 'block' }],
    }, matchingIdentity))
    expect(first.activation.state).toBe('pending_backfill')
    if (first.activation.state !== 'pending_backfill') throw new Error('expected pending backfill')
    const pending = await db.matchingRuleGeneration.findFirstOrThrow({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, state: 'pending_backfill' },
    })
    expect(pending.backfillJobId).toBe(first.activation.taskId)
    expect(pending.backfillAttempt).toBe(0)
    if (pending.backfillJobId === null) throw new Error('initial backfill job must exist')
    await db.queueJob.update({ where: { id: pending.backfillJobId }, data: { status: 'failed' } })

    const retry = await db.$transaction((tx) => retryMatchingRules(
      tx, tenant, actor, pending.id, matchingIdentity,
    ))
    expect(retry.attempt).toBe(1)
    const retried = await db.matchingRuleGeneration.findUniqueOrThrow({ where: { id: pending.id } })
    expect(retried.backfillJobId).not.toBe(first.activation.taskId)
    if (retried.backfillJobId === null) throw new Error('retry job must exist')
    const retryJobId = retried.backfillJobId
    await db.queueJob.update({
      where: { id: retryJobId },
      data: { status: 'running', lockedBy: 'matching_worker', lockedAt: new Date() },
    })

    const final = await db.$transaction((tx) => finalizeMatchingBackfill(tx, tenant, actor, {
      generationId: retried.id, attempt: retried.backfillAttempt, jobId: retryJobId,
      workerId: 'matching_worker', processed: 1, auditMetadata,
    }))
    expect(final).toMatchObject({ terminalized: true, state: 'active', processed: 1 })
    const [active, job, audits] = await Promise.all([
      db.matchingRuleGeneration.findUniqueOrThrow({ where: { id: retried.id } }),
      db.queueJob.findUniqueOrThrow({ where: { id: retryJobId } }),
      db.auditLog.findMany({
        where: { organizationId: tenant.organizationId, teamId: tenant.teamId },
        orderBy: { createdAt: 'asc' }, select: { action: true },
      }),
    ])
    expect(active.state).toBe('active')
    expect(active.keysReadyAt).not.toBeNull()
    expect(job.status).toBe('completed')
    expect(audits.at(-1)?.action).toBe('schema.matching_rules.activate')
    const beforeNoop = await db.team.findUniqueOrThrow({ where: { id: tenant.teamId } })
    const activeNoop = await db.$transaction((tx) => setMatchingRules(tx, tenant, actor, 'person', {
      rules: [{ attributes: ['email'], method: 'normalized', action: 'block' }],
    }, matchingIdentity))
    const afterNoop = await db.team.findUniqueOrThrow({ where: { id: tenant.teamId } })
    expect(activeNoop.activation).toEqual({ state: 'active', taskId: null })
    expect(afterNoop.schemaVersion).toBe(beforeNoop.schemaVersion)
  })

  it('returns persisted collision counts and retries only when explicitly requested', async () => {
    const tenant = await setup()
    const objectType = await db.objectType.findUniqueOrThrow({ where: { id: tenant.objectTypeId } })
    const duplicate = await db.record.create({
      data: {
        organizationId: tenant.organizationId, teamId: tenant.teamId,
        objectTypeId: objectType.id, data: { email: 'PERSON@example.test' },
        displayName: 'Duplicate', visibility: 'team',
        createdByType: 'system', createdById: actor.id,
      },
    })
    const input = {
      rules: [{ attributes: ['email'], method: 'normalized' as const, action: 'block' as const }],
    }
    const pending = await db.$transaction((tx) => setMatchingRules(
      tx, tenant, actor, 'person', input, matchingIdentity,
    ))
    if (pending.activation.state !== 'pending_backfill') throw new Error('Expected pending backfill')
    const pendingTaskId = pending.activation.taskId
    const generation = await db.matchingRuleGeneration.findFirstOrThrow({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, state: 'pending_backfill' },
    })
    const records = await db.record.findMany({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId }, select: { id: true },
    })
    const schema = await loadSchema(db, tenant)
    await db.$transaction((tx) => materializeMatchingRecordBatch(
      tx, tenant, schema, generation.id, records.map((record) => record.id),
    ))
    await db.queueJob.update({
      where: { id: pendingTaskId },
      data: { status: 'running', lockedBy: 'matching_worker', lockedAt: new Date() },
    })
    const blocked = await db.$transaction((tx) => finalizeMatchingBackfill(tx, tenant, actor, {
      generationId: generation.id, attempt: 0, jobId: pendingTaskId,
      workerId: 'matching_worker', processed: records.length, auditMetadata,
    }))
    expect(blocked).toMatchObject({ terminalized: true, state: 'collision_blocked' })
    const status = await db.$transaction((tx) => setMatchingRules(
      tx, tenant, actor, 'person', input, matchingIdentity,
    ))
    expect(status.activation).toEqual({
      state: 'collision_blocked', taskId: pendingTaskId, group_count: 1, record_count: 2,
    })
    const retry = await db.$transaction((tx) => setMatchingRules(
      tx, tenant, actor, 'person', { ...input, retryBackfill: true }, matchingIdentity,
    ))
    expect(retry.activation).toMatchObject({ state: 'pending_backfill' })
    expect(retry.activation.taskId).not.toBe(pendingTaskId)
    expect(duplicate.id).toBeDefined()
  })
})
