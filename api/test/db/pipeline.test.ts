import { createDb, dropTenant, seedTenant, writeAudit, type TenantRef } from '@deepcrm/db'
import { applyTemplate, createProjectionLinkWriter, loadSchema } from '@deepcrm/schema-engine'
import { parseSecretBox, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { pipelineSummary } from '../../src/services/pipeline.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for pipeline tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')
const key = Buffer.alloc(32, 7).toString('base64')
const keyring = Buffer.from(JSON.stringify({ active: 'test-v1', keys: { 'test-v1': key } }))
  .toString('base64')
const secretBox = parseSecretBox(keyring)
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
  writeAudit,
}

function context(tenant: TenantRef): ActorContext {
  return {
    tenant,
    app: 'test',
    actor: { type: 'human', id: 'pipeline-user' },
    onBehalfOf: { uoaUserId: 'pipeline-user', role: 'member' },
    provenance: { runId: 'pipeline-run', toolCallId: 'pipeline-call', requestId: crypto.randomUUID() },
    actChain: [],
    requestId: crypto.randomUUID(),
    now,
  }
}

async function fixture(): Promise<{ tenant: TenantRef; ctx: ActorContext }> {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const ctx = context(tenant)
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'pipeline-api-test', onBehalfOf: null, requestId: ctx.requestId,
  }, 'standard_crm'))
  const schema = await loadSchema(db, tenant)
  const deal = schema.objectTypesBySlug.get('deal')
  const amount = deal?.attributes.find((attribute) => attribute.slug === 'amount')
  if (deal === undefined || amount === undefined) throw new Error('deal pipeline schema missing')
  await db.attribute.update({
    where: { id: amount.id },
    data: { config: { defaultCurrency: 'GBP', fixedCurrency: 'GBP' } },
  })
  await db.team.update({
    where: { id: tenant.teamId }, data: { schemaVersion: { increment: 1 } },
  })
  return { tenant, ctx }
}

async function createDeal(
  tenant: TenantRef,
  name: string,
  stage: string,
  amount: string,
): Promise<void> {
  const { organizationId, teamId } = tenant
  const objectType = await db.objectType.findFirstOrThrow({
    where: { organizationId, teamId, slug: 'deal' }, select: { id: true },
  })
  await db.record.create({ data: {
    organizationId,
    teamId,
    objectTypeId: objectType.id,
    data: { name, stage, amount: { amount, currency: 'GBP' } },
    displayName: name,
    visibility: 'team',
    createdOnBehalfOf: 'pipeline-user',
    createdByType: 'human',
    createdById: 'pipeline-user',
    createdAt: now,
    updatedAt: now,
  } })
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { organizationId: { in: organizations } } })
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('pipeline summary service', () => {
  it('selects the sole active status and returns compact filtered aggregates', async () => {
    const value = await fixture()
    await createDeal(value.tenant, 'Pipeline Alpha', 'proposal', '12.50')
    await createDeal(value.tenant, 'Pipeline Beta', 'won', '20')
    const result = await pipelineSummary(deps, value.ctx, {
      objectType: 'deal',
      amountAttribute: 'amount',
      filter: { system: 'display_name', op: 'starts_with', value: 'Pipeline A' },
      since: '2026-08-01T00:00:00.000Z',
    })
    expect(result.stages.map((stage) => stage.id)).toEqual([
      'lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost',
    ])
    expect(result.stages.find((stage) => stage.id === 'proposal')).toMatchObject({
      count: 1,
      amount_sum: { amount: '12.5', currency: 'GBP' },
      avg_days_in_stage: null,
    })
    expect(result.stages.find((stage) => stage.id === 'won')).toMatchObject({
      count: 0, amount_sum: null,
    })
    expect(result.conversions).toEqual([])
  })

  it('uses shared attribute errors for explicit status slugs', async () => {
    const value = await fixture()
    await expect(pipelineSummary(deps, value.ctx, {
      objectType: 'deal', statusAttribute: 'missing_stage',
    })).rejects.toMatchObject({ code: 'UNKNOWN_ATTRIBUTE' })
    const stage = await db.attribute.findFirstOrThrow({
      where: {
        organizationId: value.tenant.organizationId,
        teamId: value.tenant.teamId,
        objectType: { slug: 'deal' },
        slug: 'stage',
      },
    })
    await db.attribute.update({ where: { id: stage.id }, data: { archivedAt: now } })
    await db.team.update({
      where: { id: value.tenant.teamId }, data: { schemaVersion: { increment: 1 } },
    })
    await expect(pipelineSummary(deps, value.ctx, {
      objectType: 'deal', statusAttribute: 'stage',
    })).rejects.toMatchObject({ code: 'ATTRIBUTE_ARCHIVED' })
  })

  it('preauthorizes sensitive aggregation and audits a denial exactly once', async () => {
    const value = await fixture()
    await db.policyRule.create({ data: {
      organizationId: value.tenant.organizationId,
      teamId: value.tenant.teamId,
      scope: 'team',
      scopeId: value.tenant.teamId,
      resourceType: 'attribute',
      action: 'view',
      effect: 'deny',
      priority: 100,
      conditions: { sensitivity: 'internal' },
      createdById: 'pipeline-api-test',
      bindings: { create: { actorType: 'role', actorId: 'member' } },
    } })
    await expect(pipelineSummary(deps, value.ctx, {
      objectType: 'deal', statusAttribute: 'stage', amountAttribute: 'amount',
    })).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    const audits = await db.auditLog.findMany({
      where: {
        organizationId: value.tenant.organizationId,
        teamId: value.tenant.teamId,
        action: 'crm_pipeline_summary',
        outcome: 'denied',
      },
    })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      resourceType: 'object_type', actorType: 'human', actorId: 'pipeline-user',
    })
  })
})
