import { createDb, dropTenant, seedTenant, writeAudit, type TenantRef } from '@deepcrm/db'
import { applyTemplate, createProjectionLinkWriter, FakeEmbedder } from '@deepcrm/schema-engine'
import { parseSecretBox, type ActorContext, type Filter } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { dataQualityReport } from '../../src/services/quality.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import { queryRecords } from '../../src/services/record-query.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for quality tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')
const key = Buffer.alloc(32, 12).toString('base64')
const secretBox = parseSecretBox(Buffer.from(JSON.stringify({
  active: 'test-v1', keys: { 'test-v1': key },
})).toString('base64'))
const deps: AppDeps = {
  db,
  clock: () => now,
  ids: () => crypto.randomUUID(),
  version: '0.0.0',
  maxBulkRows: 10_000,
  orgAllowlist: null,
  linkWriter: createProjectionLinkWriter(),
  historyCursor: createHistoryCursorCodec(secretBox),
  queryCursor: createQueryCursorCodec(secretBox),
  secretBox,
  embedder: new FakeEmbedder('api-test'),
  writeAudit,
}

function context(tenant: TenantRef): ActorContext {
  return {
    tenant,
    app: 'test',
    actor: { type: 'human', id: 'quality-user' },
    onBehalfOf: { uoaUserId: 'quality-user', role: 'owner' },
    provenance: { runId: 'quality-run', toolCallId: 'quality-call', requestId: crypto.randomUUID() },
    actChain: [],
    requestId: crypto.randomUUID(),
    now,
  }
}

async function addRecord(
  tenant: TenantRef,
  objectTypeId: string,
  displayName: string,
  data: Record<string, unknown>,
  lastActivityAt: Date | null = now,
): Promise<string> {
  const record = await db.record.create({ data: {
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    objectTypeId,
    data,
    displayName,
    visibility: 'team',
    createdOnBehalfOf: 'quality-user',
    createdByType: 'human',
    createdById: 'quality-user',
    createdAt: now,
    updatedAt: now,
    lastActivityAt,
  } })
  return record.id
}

async function matchingIds(
  ctx: ActorContext, objectType: string, filter: Filter,
): Promise<string[]> {
  const page = await queryRecords(deps, ctx, {
    objectType, filter, attributes: [], limit: 200,
  })
  return page.records.map((record) => record.id).sort()
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { organizationId: { in: organizations } } })
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('data quality report', () => {
  it('finds seeded dirty data and returns filters executable by crm_records_query', async () => {
    const tenant = await seedTenant(db)
    organizations.push(tenant.organizationId)
    const ctx = context(tenant)
    await db.$transaction((tx) => applyTemplate(tx, tenant, {
      type: 'system', id: 'quality-fixture', onBehalfOf: null, requestId: ctx.requestId,
    }, 'standard_crm'))
    const scope = { organizationId: tenant.organizationId, teamId: tenant.teamId }
    const [personType, companyType, dealType, dealCompany] = await Promise.all([
      db.objectType.findFirstOrThrow({ where: { ...scope, slug: 'person' } }),
      db.objectType.findFirstOrThrow({ where: { ...scope, slug: 'company' } }),
      db.objectType.findFirstOrThrow({ where: { ...scope, slug: 'deal' } }),
      db.relationType.findFirstOrThrow({ where: { ...scope, slug: 'deal_for_company' } }),
    ])
    const missingPerson = await addRecord(
      tenant, personType.id, 'Missing name', { title: 'Anonymous' }, null,
    )
    const firstCompany = await addRecord(
      tenant, companyType.id, 'Duplicate Alpha', { name: 'Duplicate Alpha', domains: ['duplicate.test'] },
    )
    const secondCompany = await addRecord(
      tenant, companyType.id, 'Duplicate Beta', { name: 'Duplicate Beta', domains: ['duplicate.test'] },
    )
    await db.record.createMany({ data: Array.from({ length: 100 }, (_, index) => ({
      ...scope,
      objectTypeId: companyType.id,
      data: { name: `Duplicate ${index}`, domains: ['duplicate.test'] },
      displayName: `Duplicate ${index}`,
      visibility: 'team' as const,
      createdOnBehalfOf: 'quality-user',
      createdByType: 'human' as const,
      createdById: 'quality-user',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })) })
    const hiddenCompany = await db.record.create({ data: {
      ...scope,
      objectTypeId: companyType.id,
      data: { name: 'Hidden duplicate', domains: ['duplicate.test'] },
      displayName: 'Hidden duplicate',
      visibility: 'private',
      createdOnBehalfOf: 'somebody-else',
      createdByType: 'human',
      createdById: 'somebody-else',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    } })
    const linkedDeal = await addRecord(
      tenant, dealType.id, 'Linked deal', { name: 'Linked deal', stage: 'qualified' },
    )
    const orphanDeal = await addRecord(
      tenant, dealType.id, 'Orphan deal', { name: 'Orphan deal', stage: 'proposal' },
    )
    await db.recordLink.create({ data: {
      ...scope,
      relationTypeId: dealCompany.id,
      fromRecordId: linkedDeal,
      toRecordId: firstCompany,
      data: {},
      createdByType: 'system',
      createdById: 'quality-fixture',
    } })

    const people = await dataQualityReport(deps, ctx, { objectType: 'person', staleDays: 30 })
    expect(people.missing_required).toMatchObject({
      count: 1,
      items: [{ record: { id: missingPerson, object_type: 'person' } }],
    })
    expect(await matchingIds(ctx, 'person', people.missing_required.query_filter))
      .toEqual([missingPerson])
    expect(people.stale.count).toBe(1)
    expect(await matchingIds(ctx, 'person', people.stale.query_filter)).toEqual([missingPerson])

    const deals = await dataQualityReport(deps, ctx, { objectType: 'deal' })
    expect(deals.orphans).toMatchObject({
      count: 1,
      items: [{ record: { id: orphanDeal, object_type: 'deal' } }],
    })
    expect(await matchingIds(ctx, 'deal', deals.orphans.query_filter)).toEqual([orphanDeal])

    const companies = await dataQualityReport(deps, ctx, { objectType: 'company' })
    expect(companies.collisions.count).toBe(102)
    expect(companies.collisions.items).toHaveLength(100)
    const collisionIds = await matchingIds(ctx, 'company', companies.collisions.query_filter)
    expect(collisionIds).toHaveLength(102)
    expect(collisionIds).toEqual(expect.arrayContaining([firstCompany, secondCompany]))
    expect(collisionIds).not.toContain(hiddenCompany.id)

    const workspace = await dataQualityReport(deps, ctx, { staleDays: 30 })
    expect(await matchingIds(ctx, 'person', workspace.missing_required.query_filter))
      .toEqual([missingPerson])
  })

  it('rejects unknown object types through the stable service error', async () => {
    const tenant = await seedTenant(db)
    organizations.push(tenant.organizationId)
    await expect(dataQualityReport(deps, context(tenant), { objectType: 'unknown' }))
      .rejects.toMatchObject({ code: 'UNKNOWN_OBJECT_TYPE' })
  })
})
