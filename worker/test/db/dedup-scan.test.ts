import { createDb, dropTenant, Prisma, seedTenant, writeAudit } from '@deepcrm/db'
import { complete, enqueue, progress } from '@deepcrm/queue'
import { defineAttribute, defineObjectType } from '@deepcrm/schema-engine'
import { FindDuplicatesPayload, FindDuplicatesResult } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { JobHandlerInput } from '../../src/index.js'
import { createDedupScanHandler, DEDUP_SCAN_JOB } from '../../src/jobs/dedup-scan.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for dedup scan tests')
const db = createDb(databaseUrl)
const organizationIds: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')
const actor = {
  type: 'system' as const,
  id: 'dedup-fixture',
  onBehalfOf: 'uoa_dedup_fixture',
  requestId: 'dedup-fixture',
}

async function fixture() {
  const seeded = await seedTenant(db)
  organizationIds.push(seeded.organizationId)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  const objectType = await db.$transaction(async (tx) => {
    const object = await defineObjectType(tx, tenant, actor, {
      slug: 'person', singularName: 'Person', pluralName: 'People', description: 'A person',
    })
    await defineAttribute(tx, tenant, actor, {
      objectType: 'person', slug: 'name', name: 'Name', description: 'Full name',
      type: 'text', config: { type: 'text' }, is_multi: false, is_required: true,
      is_unique: false, is_indexed: true, sensitivity: 'internal',
    })
    return object
  })
  const generation = await db.matchingRuleGeneration.create({ data: {
    ...tenant, objectTypeId: objectType.id, state: 'active', fingerprint: crypto.randomUUID(),
    keysReadyAt: now,
  } })
  const [normalized, fuzzy] = await db.$transaction([
    db.matchingRule.create({ data: {
      ...tenant, objectTypeId: objectType.id, generationId: generation.id, position: 0,
      attributeSlugs: ['name'], method: 'normalized', action: 'warn',
    } }),
    db.matchingRule.create({ data: {
      ...tenant, objectTypeId: objectType.id, generationId: generation.id, position: 1,
      attributeSlugs: ['name'], method: 'fuzzy', threshold: 0.5, action: 'warn',
    } }),
  ])
  await db.team.update({ where: { id: tenant.teamId }, data: { schemaVersion: { increment: 1 } } })
  const records = await Promise.all([
    ['Ada Lovelace', 'Ada Lovelace'],
    ['Ada Love lace', 'Ada Love lace'],
    ['Ada Lovelacee', 'Ada Lovelacee'],
  ].map(([name, displayName]) => db.record.create({ data: {
    ...tenant, objectTypeId: objectType.id, data: { name }, displayName: displayName ?? name,
    visibility: 'team', createdOnBehalfOf: 'uoa_dedup_fixture',
    createdByType: 'system', createdById: actor.id,
  } })))
  await db.recordMatchLookupKey.createMany({ data: records.map((record) => ({
    ...tenant, matchingRuleId: normalized.id, normalizedHash: 'shared-name-hash', recordId: record.id,
  })) })
  expect(fuzzy.id).toBeDefined()
  return { tenant, objectType, records }
}

async function handlerInput(target: Awaited<ReturnType<typeof fixture>>): Promise<JobHandlerInput> {
  const payload = {
    ...target.tenant,
    objectType: 'person',
    includeSemantic: false,
    embeddingModel: 'fake-v1',
    requestedAt: now.toISOString(),
    actorContext: {
      tenant: target.tenant,
      app: 'dedup-test',
      actChain: [],
      actor: { type: 'human', id: 'uoa_dedup_fixture' },
      onBehalfOf: { uoaUserId: 'uoa_dedup_fixture', role: 'owner' },
      provenance: null,
      requestId: crypto.randomUUID(),
    },
  } satisfies Prisma.InputJsonObject
  FindDuplicatesPayload.parse(payload)
  const job = await enqueue(db, {
    ...target.tenant,
    type: DEDUP_SCAN_JOB,
    payload,
  })
  await db.queueJob.update({ where: { id: job.id }, data: {
    status: 'running', lockedBy: 'dedup-worker', lockedAt: now, attempts: { increment: 1 },
  } })
  const running = await db.queueJob.findUniqueOrThrow({ where: { id: job.id } })
  return {
    db,
    job: running,
    workerId: 'dedup-worker',
    clock: () => now,
    writeAudit,
    progress: (value) => progress(db, running.id, 'dedup-worker', value),
    terminalize: (tx, result) => complete(tx, running.id, 'dedup-worker', result),
  }
}

afterAll(async () => {
  for (const organizationId of organizationIds) {
    await db.auditLog.deleteMany({ where: { organizationId } })
    await dropTenant(db, organizationId)
  }
  await db.$disconnect()
})

describe('dedup scan worker', () => {
  it('groups three near-identical people with active normalized and fuzzy evidence', async () => {
    const target = await fixture()
    const input = await handlerInput(target)
    await expect(createDedupScanHandler()(input)).resolves.toEqual({ terminalized: true })
    const stored = await db.queueJob.findUniqueOrThrow({ where: { id: input.job.id } })
    const result = FindDuplicatesResult.parse(stored.result)

    expect(stored.status).toBe('completed')
    expect(stored.progress).toEqual({ done: 3, total: 3 })
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]?.records.map((record) => record.id).sort())
      .toEqual(target.records.map((record) => record.id).sort())
    expect(result.groups[0]?.evidence.map((item) => item.kind))
      .toEqual(expect.arrayContaining(['normalized', 'fuzzy']))
  })
})
