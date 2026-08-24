import {
  Prisma,
  createDb,
  dropTenant,
  seedTenant,
  type TenantRef,
} from '@deepcrm/db'
import type { ActorContext, Filter } from '@deepcrm/schemas'
import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  applyTemplate,
  compileRecordSet,
  loadSchema,
  pipelineSummary,
  type LoadedObjectType,
  type LoadedSchema,
} from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for pipeline tests')
const db = createDb(databaseUrl)
const organizations: string[] = []

type Fixture = Readonly<{
  tenant: TenantRef
  ctx: ActorContext
  schema: LoadedSchema
  deal: LoadedObjectType
}>

function context(tenant: TenantRef): ActorContext {
  return {
    tenant,
    app: 'test',
    actor: { type: 'human', id: 'pipeline-owner' },
    onBehalfOf: { uoaUserId: 'pipeline-owner', role: 'owner' },
    provenance: null,
    actChain: [],
    requestId: crypto.randomUUID(),
    now: new Date('2026-08-24T12:00:00.000Z'),
  }
}

async function fixture(fixedAmount = true): Promise<Fixture> {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const ctx = context(tenant)
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'pipeline-test', onBehalfOf: null, requestId: ctx.requestId,
  }, 'standard_crm'))
  const initial = await loadSchema(db, tenant)
  const initialDeal = initial.objectTypesBySlug.get('deal')
  const amount = initialDeal?.attributes.find((attribute) => attribute.slug === 'amount')
  if (initialDeal === undefined || amount === undefined) throw new Error('deal amount missing')
  if (fixedAmount) {
    await db.attribute.update({
      where: { id: amount.id },
      data: { config: { defaultCurrency: 'GBP', fixedCurrency: 'GBP' } },
    })
    await db.team.update({ where: { id: tenant.teamId }, data: { schemaVersion: { increment: 1 } } })
  }
  const schema = await loadSchema(db, tenant)
  const deal = schema.objectTypesBySlug.get('deal')
  if (deal === undefined) throw new Error('deal missing')
  return { tenant, ctx, schema, deal }
}

async function addDeal(
  value: Fixture,
  name: string,
  stage: string,
  amount: string,
  options: Readonly<{
    visibility?: 'team' | 'private'
    createdOnBehalfOf?: string
    deletedAt?: Date
    mergedIntoId?: string
    erasedAt?: Date
  }> = {},
) {
  return db.record.create({ data: {
    organizationId: value.tenant.organizationId,
    teamId: value.tenant.teamId,
    objectTypeId: value.deal.id,
    data: { name, stage, amount: { amount, currency: 'GBP' } },
    displayName: name,
    visibility: options.visibility ?? 'team',
    createdOnBehalfOf: options.createdOnBehalfOf ?? 'pipeline-owner',
    createdByType: 'system',
    createdById: 'pipeline-test',
    ...(options.deletedAt === undefined ? {} : { deletedAt: options.deletedAt }),
    ...(options.mergedIntoId === undefined ? {} : { mergedIntoId: options.mergedIntoId }),
    ...(options.erasedAt === undefined ? {} : { erasedAt: options.erasedAt }),
  } })
}

async function addStatusChange(
  value: Fixture,
  recordId: string,
  sequence: number,
  occurredAt: string,
  oldValue: string | null,
  newValue: string | null,
): Promise<void> {
  await db.recordChange.create({ data: {
    organizationId: value.tenant.organizationId,
    teamId: value.tenant.teamId,
    recordId,
    kind: newValue === null ? 'unset' : 'set',
    attributeSlug: 'stage',
    oldValue: oldValue === null ? Prisma.JsonNull : oldValue,
    newValue: newValue === null ? Prisma.JsonNull : newValue,
    actorType: 'system',
    actorId: 'pipeline-test',
    requestId: `pipeline-change-${sequence}`,
    resultingVersion: sequence,
    seq: BigInt(sequence),
    occurredAt: new Date(occurredAt),
  } })
}

async function denyRecord(value: Fixture, recordId: string): Promise<void> {
  await db.policyRule.create({ data: {
    organizationId: value.tenant.organizationId,
    teamId: value.tenant.teamId,
    scope: 'record',
    scopeId: recordId,
    resourceType: 'record',
    action: 'view',
    effect: 'deny',
    priority: 1,
    createdById: 'pipeline-test',
    bindings: { create: { actorType: 'human', actorId: 'pipeline-owner' } },
  } })
}

async function denyAttributes(value: Fixture, recordId: string): Promise<void> {
  await db.policyRule.create({ data: {
    organizationId: value.tenant.organizationId,
    teamId: value.tenant.teamId,
    scope: 'record',
    scopeId: recordId,
    resourceType: 'attribute',
    action: 'view',
    effect: 'deny',
    priority: 1,
    conditions: { sensitivity: 'internal' },
    createdById: 'pipeline-test',
    bindings: { create: { actorType: 'human', actorId: 'pipeline-owner' } },
  } })
}

afterAll(async () => {
  await Promise.all(organizations.map((organizationId) => dropTenant(db, organizationId)))
  await db.$disconnect()
})

describe('pipeline summary', () => {
  it('aggregates the filtered visible live set with exact history, amounts, and since', async () => {
    const value = await fixture()
    const proposal = await addDeal(value, 'Visible Proposal', 'proposal', '10')
    const won = await addDeal(value, 'Visible Won', 'won', '20')
    await addDeal(value, 'Excluded Qualified', 'qualified', '5')
    await addDeal(value, 'Visible Private', 'proposal', '100', {
      visibility: 'private', createdOnBehalfOf: 'other-user',
    })
    const recordDenied = await addDeal(value, 'Visible Record Denied', 'proposal', '200')
    await denyRecord(value, recordDenied.id)
    const attributeDenied = await addDeal(value, 'Visible Attribute Denied', 'won', '300')
    await denyAttributes(value, attributeDenied.id)
    await addDeal(value, 'Visible Deleted', 'proposal', '400', { deletedAt: value.ctx.now })
    await addDeal(value, 'Visible Merged', 'proposal', '500', { mergedIntoId: proposal.id })
    await addDeal(value, 'Visible Erased', 'won', '600', { erasedAt: value.ctx.now })

    await addStatusChange(value, proposal.id, 1, '2026-08-01T00:00:00.000Z', null, 'lead')
    await addStatusChange(value, proposal.id, 2, '2026-08-03T00:00:00.000Z', 'lead', 'qualified')
    await addStatusChange(value, proposal.id, 3, '2026-08-06T00:00:00.000Z', 'qualified', 'proposal')
    await addStatusChange(value, won.id, 4, '2026-08-01T00:00:00.000Z', null, 'lead')
    await addStatusChange(value, won.id, 5, '2026-08-05T00:00:00.000Z', 'lead', 'proposal')
    await addStatusChange(value, won.id, 6, '2026-08-07T00:00:00.000Z', 'proposal', 'won')

    const filter: Filter = { system: 'display_name', op: 'starts_with', value: 'Visible' }
    const traced = db.$extends({})
    const executeRaw = traced.$queryRaw.bind(traced)
    const raw = vi.spyOn(traced, '$queryRaw').mockImplementation((query, ...values) => (
      Reflect.apply(executeRaw, traced, [query, ...values])
    ))
    const result = await pipelineSummary(
      traced,
      value.tenant,
      value.ctx,
      value.schema,
      value.deal,
      {
        statusAttribute: 'stage', amountAttribute: 'amount', filter,
        since: new Date('2026-08-05T00:00:00.000Z'),
      },
    )
    expect(raw).toHaveBeenCalledTimes(1)
    raw.mockRestore()
    const byId = new Map(result.stages.map((stage) => [stage.id, stage]))
    expect(result.stages.map((stage) => stage.id)).toEqual([
      'lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost',
    ])
    expect(byId.get('proposal')).toMatchObject({
      count: 1,
      amountSum: { amount: '10', currency: 'GBP' },
      averageDaysInStage: 2,
    })
    expect(byId.get('won')).toMatchObject({
      count: 1, amountSum: { amount: '20', currency: 'GBP' }, averageDaysInStage: null,
    })
    expect(byId.get('lead')?.averageDaysInStage).toBe(3)
    expect(byId.get('qualified')?.averageDaysInStage).toBe(3)
    expect(byId.get('negotiation')).toMatchObject({ count: 0, amountSum: null })
    expect(result.conversions).toEqual([
      { from: 'lead', to: 'proposal', count: 1 },
      { from: 'qualified', to: 'proposal', count: 1 },
      { from: 'proposal', to: 'won', count: 1 },
    ])

    const statusAttribute = value.deal.attributes.find((item) => item.slug === 'stage')
    const amountAttribute = value.deal.attributes.find((item) => item.slug === 'amount')
    if (statusAttribute === undefined || amountAttribute === undefined) {
      throw new Error('pipeline attributes missing')
    }
    const recordSet = compileRecordSet(value.tenant, value.ctx, value.schema, value.deal, {
      filter, attributes: [statusAttribute, amountAttribute],
    })
    const total = await db.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      SELECT count(*)::integer AS total
      FROM records r
      WHERE ${recordSet} AND r.erased_at IS NULL`)
    expect(result.stages.reduce((count, stage) => count + stage.count, 0)).toBe(total[0]?.total)
  }, 20_000)

  it('rejects tenant, status, amount, and stored schema mismatches before aggregation', async () => {
    const value = await fixture(false)
    const other = await fixture()
    const position = Math.max(...value.deal.attributes.map((item) => item.position)) + 1
    const options = [
      { id: 'open_stage', label: 'Open', category: 'open', position: 0 },
      { id: 'won_stage', label: 'Won', category: 'won', position: 1 },
    ]
    await db.attribute.createMany({ data: [
      {
        organizationId: value.tenant.organizationId,
        teamId: value.tenant.teamId,
        objectTypeId: value.deal.id,
        slug: 'old_stage', name: 'Old stage', description: '', type: 'status',
        config: { options }, position, archivedAt: value.ctx.now,
      },
      {
        organizationId: value.tenant.organizationId,
        teamId: value.tenant.teamId,
        objectTypeId: value.deal.id,
        slug: 'multi_stage', name: 'Multi stage', description: '', type: 'status',
        config: { options }, isMulti: true, position: position + 1,
      },
      {
        organizationId: value.tenant.organizationId,
        teamId: value.tenant.teamId,
        objectTypeId: value.deal.id,
        slug: 'multi_amount', name: 'Multi amount', description: '', type: 'currency',
        config: { defaultCurrency: 'GBP', fixedCurrency: 'GBP' },
        isMulti: true, position: position + 2,
      },
    ] })
    await db.team.update({
      where: { id: value.tenant.teamId },
      data: { schemaVersion: { increment: 1 } },
    })
    const schema = await loadSchema(db, value.tenant)
    const deal = schema.objectTypesBySlug.get('deal')
    if (deal === undefined) throw new Error('reloaded deal missing')
    await expect(pipelineSummary(db, value.tenant, other.ctx, value.schema, value.deal, {
      statusAttribute: 'stage',
    })).rejects.toMatchObject({ code: 'TENANT_MISMATCH' })
    await expect(pipelineSummary(db, value.tenant, value.ctx, schema, deal, {
      statusAttribute: 'name',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(pipelineSummary(db, value.tenant, value.ctx, schema, deal, {
      statusAttribute: 'stage', amountAttribute: 'amount',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(pipelineSummary(db, value.tenant, value.ctx, schema, deal, {
      statusAttribute: 'stage', since: new Date('invalid'),
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(pipelineSummary(db, value.tenant, value.ctx, schema, deal, {
      statusAttribute: 'old_stage',
    })).rejects.toMatchObject({ code: 'ATTRIBUTE_ARCHIVED' })
    await expect(pipelineSummary(db, value.tenant, value.ctx, schema, deal, {
      statusAttribute: 'multi_stage',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(pipelineSummary(db, value.tenant, value.ctx, schema, deal, {
      statusAttribute: 'stage', amountAttribute: 'name',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(pipelineSummary(db, value.tenant, value.ctx, schema, deal, {
      statusAttribute: 'stage', amountAttribute: 'multi_amount',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})
