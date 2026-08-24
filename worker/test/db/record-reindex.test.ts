import {
  createDb,
  dropTenant,
  seedTenant,
  writeAudit,
  type Prisma,
} from '@deepcrm/db'
import { complete, enqueue, progress } from '@deepcrm/queue'
import {
  applyTemplate,
  buildSearchContent,
  FakeEmbedder,
  loadSchema,
  type Embedder,
} from '@deepcrm/schema-engine'
import { afterAll, describe, expect, it } from 'vitest'

import type { JobHandlerInput } from '../../src/index.js'
import {
  createRecordReindexHandler,
  createRecordReindexNeighboursHandler,
  RECORD_REINDEX_JOB,
  RECORD_REINDEX_NEIGHBOURS_JOB,
} from '../../src/jobs/record-reindex.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for record reindex tests')
const db = createDb(databaseUrl)
const organizationIds: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')

type Tenant = { organizationId: string; teamId: string }
type SearchRow = {
  recordId: string
  content: string
  dimensions: number | null
  embeddingModel: string | null
}

async function fixture() {
  const seeded = await seedTenant(db)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  organizationIds.push(tenant.organizationId)
  const actor = { type: 'system' as const, id: 'reindex-fixture', onBehalfOf: null, requestId: crypto.randomUUID() }
  await db.$transaction(async (tx) => {
    await applyTemplate(tx, tenant, actor, 'system')
    await applyTemplate(tx, tenant, actor, 'standard_crm')
  })
  const schema = await loadSchema(db, tenant)
  const personType = schema.objectTypesBySlug.get('person')
  const companyType = schema.objectTypesBySlug.get('company')
  const relation = schema.relationTypesBySlug.get('person_works_at')
  if (personType === undefined || companyType === undefined || relation === undefined) {
    throw new Error('standard CRM fixture is missing')
  }
  const company = await db.record.create({ data: {
    ...tenant, objectTypeId: companyType.id, data: { name: 'Analytical Engines' },
    displayName: 'Analytical Engines', visibility: 'team', createdOnBehalfOf: 'reindex-user',
    createdByType: 'system', createdById: 'reindex-fixture',
  } })
  const person = await db.record.create({ data: {
    ...tenant, objectTypeId: personType.id,
    data: {
      name: { full: 'Ada Lovelace' }, emails: ['ada@example.test'],
      phones: ['+442079460000'], title: 'Mathematician',
    },
    displayName: 'Ada Lovelace', visibility: 'team', createdOnBehalfOf: 'reindex-user',
    createdByType: 'system', createdById: 'reindex-fixture',
  } })
  await db.recordLink.create({ data: {
    ...tenant, relationTypeId: relation.id, fromRecordId: person.id, toRecordId: company.id,
    data: {}, activeFrom: now, createdByType: 'system', createdById: 'reindex-fixture',
  } })
  return { tenant, schema, person, company }
}

async function input(tenant: Tenant, recordId: string, workerId: string): Promise<JobHandlerInput> {
  const job = await enqueue(db, {
    organizationId: tenant.organizationId, teamId: tenant.teamId,
    type: RECORD_REINDEX_JOB,
    payload: { ...tenant, recordId },
    idempotencyKey: `reindex-test:${recordId}:${workerId}`,
  })
  const claimed = await db.queueJob.updateMany({
    where: { id: job.id, status: 'queued' },
    data: { status: 'running', lockedBy: workerId, lockedAt: now, attempts: { increment: 1 } },
  })
  if (claimed.count !== 1) throw new Error('reindex fixture job was not claimed')
  const running = await db.queueJob.findUniqueOrThrow({ where: { id: job.id } })
  return {
    db, job: running, workerId, clock: () => now, writeAudit,
    progress: (value: Prisma.InputJsonValue) => progress(db, running.id, workerId, value),
    terminalize: (tx, result) => complete(tx, running.id, workerId, result),
  }
}

async function searchRows(tenant: Tenant, ids: readonly string[]): Promise<SearchRow[]> {
  return db.$queryRaw<SearchRow[]>`
    SELECT record_id AS "recordId", content, vector_dims(embedding)::int AS dimensions,
      embedding_model AS "embeddingModel"
    FROM record_search
    WHERE organization_id = ${tenant.organizationId}::uuid
      AND team_id = ${tenant.teamId}::uuid
      AND record_id = ANY(${[...ids]}::uuid[])
    ORDER BY record_id
  `
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { organizationId: { in: organizationIds } } })
  for (const organizationId of organizationIds) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('record reindex worker', () => {
  it('indexes both linked endpoints with safe content and 1024-wide deterministic embeddings', async () => {
    const target = await fixture()
    const handler = createRecordReindexHandler(new FakeEmbedder('fake-reindex-v1'))
    await handler(await input(target.tenant, target.person.id, 'person-worker'))
    await handler(await input(target.tenant, target.company.id, 'company-worker'))
    const rows = await searchRows(target.tenant, [target.person.id, target.company.id])
    const person = rows.find((row) => row.recordId === target.person.id)
    const company = rows.find((row) => row.recordId === target.company.id)
    expect(person).toMatchObject({ dimensions: 1024, embeddingModel: 'fake-reindex-v1' })
    expect(person?.content).toContain('Ada Lovelace')
    expect(person?.content).toContain('ada@example.test')
    expect(person?.content).toContain('mathematician')
    expect(person?.content).toContain('Analytical Engines')
    expect(person?.content).not.toContain('+442079460000')
    expect(company).toMatchObject({ dimensions: 1024, embeddingModel: 'fake-reindex-v1' })
    expect(company?.content).toContain('Ada Lovelace')

    const activity = target.schema.objectTypesBySlug.get('activity')
    const activityAbout = target.schema.relationTypesBySlug.get('activity_about')
    if (activity === undefined || activityAbout === undefined) throw new Error('system activity fixture is missing')
    const long = buildSearchContent(target.schema, {
      objectTypeId: activity.id,
      displayName: 'Unicode budget',
      data: {
        kind: 'note', occurred_at: '2026-08-24T12:00:00.000Z',
        subject: 'Unicode budget', body: `**${'é'.repeat(10_000)}**`,
      },
    }, Array.from({ length: 500 }, (_, index) => ({
      relationTypeId: activityAbout.id,
      direction: 'forward',
      relatedDisplayName: `Related record ${index} ${'界'.repeat(10)}`,
    })))
    expect(Buffer.byteLength(long, 'utf8')).toBeLessThanOrEqual(8 * 1024)
    expect(long).not.toContain('\uFFFD')
  })

  it('keeps keyword content on embedding failure and removes search for a deleted record', async () => {
    const target = await fixture()
    const failing: Embedder = {
      model: 'failing-v1',
      embed: async () => { throw new Error('ledger unavailable') },
    }
    await expect(createRecordReindexHandler(failing)(
      await input(target.tenant, target.person.id, 'failing-worker'),
    )).rejects.toThrow('ledger unavailable')
    expect(await searchRows(target.tenant, [target.person.id])).toEqual([
      expect.objectContaining({ recordId: target.person.id, dimensions: null, embeddingModel: null }),
    ])
    await db.record.update({ where: { id: target.person.id }, data: { deletedAt: now } })
    await createRecordReindexHandler(new FakeEmbedder())(
      await input(target.tenant, target.person.id, 'delete-worker'),
    )
    expect(await searchRows(target.tenant, [target.person.id])).toEqual([])
  })

  it('rejects a queue payload whose tenant differs from the claimed job', async () => {
    const target = await fixture()
    const second = await seedTenant(db)
    organizationIds.push(second.organizationId)
    const item = await input(target.tenant, target.person.id, 'mismatch-worker')
    const mismatched = {
      ...item,
      job: { ...item.job, payload: {
        organizationId: second.organizationId, teamId: second.teamId, recordId: target.person.id,
      } },
    }
    await expect(createRecordReindexHandler(new FakeEmbedder())(mismatched))
      .rejects.toThrow('record.reindex tenant payload mismatch')
  })

  it('fans neighbour reindex jobs out to exact record.reindex tasks', async () => {
    const target = await fixture()
    const sourceId = crypto.randomUUID()
    const neighbourJob = await enqueue(db, {
      organizationId: target.tenant.organizationId,
      teamId: target.tenant.teamId,
      type: RECORD_REINDEX_NEIGHBOURS_JOB,
      payload: {
        ...target.tenant,
        recordId: sourceId,
        neighbourRecordIds: [target.company.id, target.company.id, target.person.id],
      },
      idempotencyKey: `reindex-neighbours-test:${sourceId}`,
    })
    const running = await db.queueJob.update({
      where: { id: neighbourJob.id },
      data: { status: 'running', lockedBy: 'neighbour-worker', lockedAt: now, attempts: { increment: 1 } },
    })
    await createRecordReindexNeighboursHandler()({
      db,
      job: running,
      workerId: 'neighbour-worker',
      clock: () => now,
      writeAudit,
      progress: (value: Prisma.InputJsonValue) => progress(db, running.id, 'neighbour-worker', value),
      terminalize: (tx, result) => complete(tx, running.id, 'neighbour-worker', result),
    })
    const jobs = await db.queueJob.findMany({
      where: {
        organizationId: target.tenant.organizationId,
        teamId: target.tenant.teamId,
        type: RECORD_REINDEX_JOB,
        idempotencyKey: { contains: `:neighbour:${running.id}` },
      },
    })
    const payloads = jobs.map((job) => job.payload)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    expect(jobs).toHaveLength(2)
    expect(payloads).toEqual([
      { ...target.tenant, recordId: target.company.id },
      { ...target.tenant, recordId: target.person.id },
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
  })
})
