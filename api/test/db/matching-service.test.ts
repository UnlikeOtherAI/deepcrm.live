import { createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import { applyTemplate, createProjectionLinkWriter, FakeEmbedder } from '@deepcrm/schema-engine'
import { parseSecretBox, ServiceError, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import { assertRecord, createRecord } from '../../src/services/records.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for matching service tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSJ9fQ=='
type Tenant = { organizationId: string; teamId: string }

function tenantFields(tenant: Tenant): Tenant {
  return { organizationId: tenant.organizationId, teamId: tenant.teamId }
}

const deps: AppDeps = {
  db,
  clock: () => new Date('2026-08-24T12:00:00.000Z'),
  ids: () => crypto.randomUUID(),
  version: '0.0.0',
  maxBulkRows: 10_000, maxExportRows: 100_000,
  embedder: new FakeEmbedder('api-test'),
  orgAllowlist: null,
  linkWriter: createProjectionLinkWriter(),
  historyCursor: createHistoryCursorCodec(parseSecretBox(keyring)),
  queryCursor: createQueryCursorCodec(parseSecretBox(keyring)),
  secretBox: parseSecretBox(keyring),
  writeAudit,
}

function context(tenant: Tenant): ActorContext {
  return {
    tenant,
    app: 'test',
    actChain: [],
    actor: { type: 'human', id: 'uoa_matching_user' },
    onBehalfOf: { uoaUserId: 'uoa_matching_user', role: 'owner' },
    provenance: { runId: 'run_matching', toolCallId: crypto.randomUUID(), requestId: crypto.randomUUID() },
    requestId: crypto.randomUUID(),
    now: new Date('2026-08-24T12:00:00.000Z'),
  }
}

async function fixture(): Promise<Tenant> {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'matching_service_fixture', onBehalfOf: null, requestId: crypto.randomUUID(),
  }, 'standard_crm'))
  return tenant
}

async function companyObject(tenant: Tenant) {
  return db.objectType.findFirstOrThrow({
    where: { organizationId: tenant.organizationId, teamId: tenant.teamId, slug: 'company' },
  })
}

async function caught(operation: Promise<unknown>): Promise<ServiceError> {
  try {
    await operation
  } catch (error) {
    if (error instanceof ServiceError) return error
    throw error
  }
  throw new Error('Expected service operation to fail')
}

afterAll(async () => {
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('matching service security and candidates', () => {
  it('returns fuzzy candidates in score order and replays no-op assert candidates exactly', async () => {
    const tenant = await fixture()
    const ctx = context(tenant)
    const first = await createRecord(deps, ctx, {
      objectType: 'company', data: { name: 'Acme Corporation', domains: ['acme-one.com'] },
    })
    const second = await createRecord(deps, ctx, {
      objectType: 'company', data: { name: 'Acme Corporatio', domains: ['acme-two.com'] },
    })
    expect(second.duplicates?.[0]).toMatchObject({
      record: { id: first.record.id },
      rule_position: 1,
      evidence: [{ kind: 'fuzzy', attribute: 'name', matched: true, score: expect.any(Number) }],
    })
    const input = {
      objectType: 'company', matchAttribute: 'domains',
      data: { name: 'Acme Corporatio', domains: ['acme-two.com'] },
      idempotencyKey: 'matching-noop-assert',
    }
    const asserted = await assertRecord(deps, ctx, input)
    const replay = await assertRecord(deps, ctx, input)
    expect(asserted).toEqual(replay)
    expect(asserted).toMatchObject({ created: false, changed: false })
    expect(asserted.duplicates?.map((candidate) => candidate.record.id)).toContain(first.record.id)
  })

  it('redacts evidence through one policy load and omits invisible high-ranked rows before limit', async () => {
    const tenant = await fixture()
    const ctx = context(tenant)
    const company = await companyObject(tenant)
    for (let index = 0; index < 21; index += 1) {
      await db.record.create({
        data: {
          ...tenantFields(tenant), objectTypeId: company.id, data: { name: 'Hidden Exact Match' },
          displayName: 'hidden exact match', visibility: 'private',
          createdOnBehalfOf: `other_${index}`, createdByType: 'system', createdById: 'matching_fixture',
        },
      })
    }
    const visible = await db.record.create({
      data: {
        ...tenantFields(tenant), objectTypeId: company.id, data: { name: 'Hidden Exact Matcher' },
        displayName: 'hidden exact matcher', visibility: 'team',
        createdByType: 'system', createdById: 'matching_fixture',
      },
    })
    await db.policyRule.create({
      data: {
        ...tenantFields(tenant), scope: 'team', scopeId: tenant.teamId,
        resourceType: 'attribute', action: 'view',
        effect: 'deny', priority: 100, conditions: { sensitivity: 'internal' },
        createdById: 'matching_fixture',
        bindings: { create: [{ actorType: 'role', actorId: 'owner' }] },
      },
    })
    const result = await createRecord(deps, ctx, {
      objectType: 'company', data: { name: 'Hidden Exact Match' },
    })
    expect(result.duplicates?.map((candidate) => candidate.record.id)).toEqual([visible.id])
    expect(result.duplicates?.[0]?.evidence).toEqual([
      { kind: 'fuzzy', attribute: 'name', matched: true },
    ])
  })

  it('keeps an invisible block collision generic and never crosses tenants', async () => {
    const firstTenant = await fixture()
    const secondTenant = await fixture()
    const firstContext = context(firstTenant)
    const holder = await createRecord(deps, firstContext, {
      objectType: 'company', data: { name: 'Hidden Holder', domains: ['hidden-holder.com'] },
    })
    const company = await companyObject(firstTenant)
    await db.attribute.updateMany({
      where: { ...tenantFields(firstTenant), objectTypeId: company.id, slug: 'domains' },
      data: { isUnique: false },
    })
    await db.record.update({
      where: { id: holder.record.id },
      data: { visibility: 'private', createdOnBehalfOf: 'different_uoa_user' },
    })
    await db.team.update({ where: { id: firstTenant.teamId }, data: { schemaVersion: { increment: 1 } } })
    const error = await caught(createRecord(deps, firstContext, {
      objectType: 'company', data: { name: 'Other Holder', domains: ['hidden-holder.com'] },
    }))
    expect(error.code).toBe('DUPLICATE_FOUND')
    expect(error.details).not.toHaveProperty('record_id')
    expect(error.details).not.toHaveProperty('candidates')
    await expect(createRecord(deps, context(secondTenant), {
      objectType: 'company', data: { name: 'Other Tenant', domains: ['hidden-holder.com'] },
    })).resolves.toMatchObject({ created: true })
  })

  it('allows exactly one concurrent normalized block-key create', async () => {
    const tenant = await fixture()
    const company = await companyObject(tenant)
    await db.attribute.updateMany({
      where: { ...tenantFields(tenant), objectTypeId: company.id, slug: 'domains' },
      data: { isUnique: false },
    })
    await db.team.update({ where: { id: tenant.teamId }, data: { schemaVersion: { increment: 1 } } })
    const outcomes = await Promise.allSettled([
      createRecord(deps, context(tenant), {
        objectType: 'company', data: { name: 'Concurrent One', domains: ['concurrent.com'] },
      }),
      createRecord(deps, context(tenant), {
        objectType: 'company', data: { name: 'Concurrent Two', domains: ['CONCURRENT.COM'] },
      }),
    ])
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((result) => result.status === 'rejected')
    if (rejected?.status !== 'rejected') throw new Error('Expected one blocked create')
    expect(rejected.reason).toMatchObject({ code: 'DUPLICATE_FOUND' })
  })
})
