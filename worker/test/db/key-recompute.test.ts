import {
  createDb,
  dropTenant,
  seedTenant,
  writeAudit,
  type Prisma,
} from '@deepcrm/db'
import { complete, enqueue, progress } from '@deepcrm/queue'
import { keyHash, matchingTupleHash } from '@deepcrm/schema-engine'
import { afterAll, describe, expect, it } from 'vitest'

import type { JobHandlerInput } from '../../src/index.js'
import { keyRecomputeHandler, KEY_RECOMPUTE_JOB } from '../../src/jobs/key-recompute.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for key recompute tests')
const db = createDb(databaseUrl)
const organizationIds: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')

type Tenant = { organizationId: string; teamId: string }

async function runningInput(
  tenant: Tenant,
  payload: { objectTypeId: string; attributeId: string },
): Promise<JobHandlerInput> {
  const job = await enqueue(db, {
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    type: KEY_RECOMPUTE_JOB,
    payload: { ...tenant, ...payload },
    idempotencyKey: `key-recompute-test:${payload.attributeId}`,
  })
  const running = await db.queueJob.update({
    where: { id: job.id },
    data: { status: 'running', lockedBy: 'key-worker', lockedAt: now, attempts: { increment: 1 } },
  })
  return {
    db,
    job: running,
    workerId: 'key-worker',
    clock: () => now,
    writeAudit,
    progress: (value: Prisma.InputJsonValue) => progress(db, running.id, 'key-worker', value),
    terminalize: (tx, result) => complete(tx, running.id, 'key-worker', result),
  }
}

async function fixture() {
  const seeded = await seedTenant(db)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  organizationIds.push(tenant.organizationId)
  const objectType = await db.objectType.create({
    data: {
      ...tenant,
      slug: 'person',
      singularName: 'Person',
      pluralName: 'People',
      description: 'People',
      kind: 'custom',
      createdByType: 'system',
      createdById: 'key-fixture',
    },
  })
  const email = await db.attribute.create({
    data: {
      ...tenant,
      objectTypeId: objectType.id,
      slug: 'email',
      name: 'Email',
      description: 'Email address',
      type: 'email',
      config: {},
      isUnique: true,
      isIndexed: true,
      sensitivity: 'internal',
      position: 0,
    },
  })
  const generation = await db.matchingRuleGeneration.create({
    data: {
      ...tenant,
      objectTypeId: objectType.id,
      state: 'active',
      fingerprint: 'key-recompute-generation',
      keysReadyAt: now,
    },
  })
  const rule = await db.matchingRule.create({
    data: {
      ...tenant,
      objectTypeId: objectType.id,
      generationId: generation.id,
      position: 0,
      attributeSlugs: ['email'],
      method: 'normalized',
      action: 'block',
    },
  })
  const record = await db.record.create({
    data: {
      ...tenant,
      objectTypeId: objectType.id,
      data: { email: ' Ada@Example.Test ' },
      displayName: 'Ada',
      visibility: 'team',
      createdOnBehalfOf: 'key-user',
      createdByType: 'system',
      createdById: 'key-fixture',
    },
  })
  await db.recordUniqueKey.create({
    data: {
      ...tenant,
      attributeId: email.id,
      recordId: record.id,
      normalizedHash: keyHash('stale'),
      normalizedValue: 'stale',
    },
  })
  await db.recordMatchKey.create({
    data: {
      ...tenant,
      matchingRuleId: rule.id,
      normalizedHash: keyHash('stale-match'),
      recordId: record.id,
    },
  })
  await db.recordMatchLookupKey.create({
    data: {
      ...tenant,
      matchingRuleId: rule.id,
      normalizedHash: keyHash('stale-lookup'),
      recordId: record.id,
    },
  })
  return { tenant, objectType, email, rule }
}

afterAll(async () => {
  for (const organizationId of organizationIds) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('schema key recompute worker', () => {
  it('rewrites unique, block, and lookup keys with current normalizers', async () => {
    const target = await fixture()
    await keyRecomputeHandler(await runningInput(target.tenant, {
      objectTypeId: target.objectType.id,
      attributeId: target.email.id,
    }))
    const unique = await db.recordUniqueKey.findMany({
      where: { ...target.tenant, attributeId: target.email.id },
    })
    const block = await db.recordMatchKey.findMany({
      where: { ...target.tenant, matchingRuleId: target.rule.id },
    })
    const lookup = await db.recordMatchLookupKey.findMany({
      where: { ...target.tenant, matchingRuleId: target.rule.id },
    })
    const matchHash = matchingTupleHash(['ada@example.test'])
    expect(unique).toMatchObject([{ normalizedValue: 'ada@example.test', normalizedHash: keyHash('ada@example.test') }])
    expect(block).toMatchObject([{ normalizedHash: matchHash }])
    expect(lookup).toMatchObject([{ normalizedHash: matchHash }])
  })
})
