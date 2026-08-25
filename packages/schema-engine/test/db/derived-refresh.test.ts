import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { ErrorCode, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import {
  createRecord,
  defineAttribute,
  defineDerivedAttribute,
  defineObjectType,
  defineRelationType,
  linkRecords,
  loadSchema,
  refreshDerivedFromSources,
  updateRecord,
  type LinkWriter,
  type LinkWriteResult,
} from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for derived refresh tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const noLinks: LinkWriter = {
  apply: async (): Promise<LinkWriteResult> => { throw new Error('Projection link writer must not run') },
  delete: async () => ({ changes: [], touchedRecordIds: [] }),
  restore: async () => ({ changes: [], touchedRecordIds: [] }),
}
const actor = () => ({ type: 'system' as const, id: 'derived-test', onBehalfOf: null, requestId: crypto.randomUUID() })

function context(tenant: { organizationId: string; teamId: string }): ActorContext {
  return {
    tenant,
    app: 'test',
    actChain: [],
    actor: { type: 'system', id: 'derived-test' },
    onBehalfOf: { uoaUserId: 'derived-user', role: 'owner' },
    provenance: null,
    requestId: crypto.randomUUID(),
    now: new Date('2026-08-24T12:00:00.000Z'),
  }
}

async function fixture() {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  await db.$transaction(async (tx) => {
    await defineObjectType(tx, tenant, actor(), {
      slug: 'company', singularName: 'Company', pluralName: 'Companies', description: 'Companies',
    })
    await defineObjectType(tx, tenant, actor(), {
      slug: 'deal', singularName: 'Deal', pluralName: 'Deals', description: 'Deals',
    })
    await defineAttribute(tx, tenant, actor(), {
      objectType: 'company', slug: 'name', name: 'Name', description: 'Company name',
      type: 'text', config: { type: 'text', maxLength: 200 },
      is_multi: false, is_required: false, is_unique: false, is_indexed: true, sensitivity: 'internal',
    })
    await defineAttribute(tx, tenant, actor(), {
      objectType: 'deal', slug: 'name', name: 'Name', description: 'Deal name',
      type: 'text', config: { type: 'text', maxLength: 200 },
      is_multi: false, is_required: false, is_unique: false, is_indexed: true, sensitivity: 'internal',
    })
    await defineAttribute(tx, tenant, actor(), {
      objectType: 'deal', slug: 'amount', name: 'Amount', description: 'Deal amount',
      type: 'number', config: { type: 'number', min: 0 },
      is_multi: false, is_required: false, is_unique: false, is_indexed: true, sensitivity: 'internal',
    })
    await defineRelationType(tx, tenant, actor(), {
      slug: 'company_deals',
      fromObjectType: 'company',
      toObjectType: 'deal',
      forwardName: 'has deals',
      inverseName: 'belongs to company',
      cardinality: 'one_to_many',
    })
  })
  let schema = await loadSchema(db, tenant)
  const ctx = context(tenant)
  const company = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
    objectType: 'company', data: { name: 'Acme' },
  }, noLinks))
  const deal = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
    objectType: 'deal', data: { name: 'Expansion', amount: 100 },
  }, noLinks))
  await db.$transaction((tx) => linkRecords(tx, ctx, schema, {
    relationType: 'company_deals', fromRecordId: company.record.id, toRecordId: deal.record.id,
  }))
  await db.$transaction(async (tx) => {
    await defineDerivedAttribute(tx, tenant, actor(), {
      objectType: 'company', slug: 'total_open_pipeline', name: 'Total open pipeline',
      description: 'Sum of active related deal amount values',
      type: 'number', config: { type: 'number', min: 0 },
      isRequired: false, isIndexed: true, sensitivity: 'internal',
      valueSource: 'rollup',
      derivationConfig: {
        relation_type: 'company_deals',
        direction: 'outgoing',
        operation: 'sum',
        source_attribute: 'amount',
      },
    })
    await defineDerivedAttribute(tx, tenant, actor(), {
      objectType: 'deal', slug: 'double_amount', name: 'Double amount',
      description: 'Formula result used by agents',
      type: 'number', config: { type: 'number', min: 0 },
      isRequired: false, isIndexed: true, sensitivity: 'internal',
      valueSource: 'formula',
      derivationConfig: {
        expression: {
          kind: 'binary', op: 'multiply',
          left: { kind: 'attribute', attribute: 'amount' },
          right: { kind: 'literal', value: 2 },
        },
      },
    })
  })
  schema = await loadSchema(db, tenant)
  return { tenant, ctx, schema, companyId: company.record.id, dealId: deal.record.id }
}

afterAll(async () => {
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('derived attribute refresh', () => {
  it('rejects direct writes and refreshes formula and related rollup values', async () => {
    const target = await fixture()
    await expect(db.$transaction((tx) => updateRecord(tx, target.ctx, target.schema, {
      recordId: target.companyId,
      data: { total_open_pipeline: 123 },
    }, noLinks))).rejects.toMatchObject({ code: ErrorCode.ATTRIBUTE_READ_ONLY })

    const first = await refreshDerivedFromSources(db, target.tenant, [target.companyId, target.dealId], target.ctx.now)
    expect(first.changedRecords).toEqual([target.companyId, target.dealId].sort())
    let company = await db.record.findUniqueOrThrow({ where: { id: target.companyId } })
    let deal = await db.record.findUniqueOrThrow({ where: { id: target.dealId } })
    expect(company.data).toMatchObject({ total_open_pipeline: '100' })
    expect(deal.data).toMatchObject({ double_amount: '200' })

    await db.$transaction((tx) => updateRecord(tx, target.ctx, target.schema, {
      recordId: target.dealId,
      data: { amount: 250 },
      expectedVersion: deal.version,
    }, noLinks))
    const second = await refreshDerivedFromSources(db, target.tenant, [target.dealId], target.ctx.now)
    expect(second.changedRecords).toEqual([target.companyId, target.dealId].sort())
    company = await db.record.findUniqueOrThrow({ where: { id: target.companyId } })
    deal = await db.record.findUniqueOrThrow({ where: { id: target.dealId } })
    expect(company.data).toMatchObject({ total_open_pipeline: '250' })
    expect(deal.data).toMatchObject({ double_amount: '500' })
    expect(await db.attributeDerivation.count({
      where: { organizationId: target.tenant.organizationId, teamId: target.tenant.teamId, refreshState: 'ready' },
    })).toBe(2)
  })

  it('does not silently sum mixed-currency rollups', async () => {
    const target = await fixture()
    await db.$transaction(async (tx) => {
      await defineAttribute(tx, target.tenant, actor(), {
        objectType: 'deal', slug: 'currency_amount', name: 'Currency amount',
        description: 'Currency amount for mixed-currency rollup testing.',
        type: 'currency', config: { type: 'currency' },
        is_multi: false, is_required: false, is_unique: false, is_indexed: false, sensitivity: 'internal',
      })
      await defineDerivedAttribute(tx, target.tenant, actor(), {
        objectType: 'company', slug: 'currency_total', name: 'Currency total',
        description: 'Sum of active related deal currency amounts only when currencies match.',
        type: 'currency', config: { type: 'currency' },
        isRequired: false, isIndexed: false, sensitivity: 'internal',
        valueSource: 'rollup',
        derivationConfig: {
          relation_type: 'company_deals',
          direction: 'outgoing',
          operation: 'sum',
          source_attribute: 'currency_amount',
        },
      })
    })
    const schema = await loadSchema(db, target.tenant)
    const deal = await db.record.findUniqueOrThrow({ where: { id: target.dealId } })
    await db.$transaction((tx) => updateRecord(tx, target.ctx, schema, {
      recordId: target.dealId,
      data: { currency_amount: { amount: '100', currency: 'GBP' } },
      expectedVersion: deal.version,
    }, noLinks))
    const secondDeal = await db.$transaction((tx) => createRecord(tx, target.ctx, schema, {
      objectType: 'deal',
      data: {
        name: 'Expansion USD',
        amount: 50,
        currency_amount: { amount: '50', currency: 'USD' },
      },
    }, noLinks))
    await db.$transaction((tx) => linkRecords(tx, target.ctx, schema, {
      relationType: 'company_deals',
      fromRecordId: target.companyId,
      toRecordId: secondDeal.record.id,
    }))
    await refreshDerivedFromSources(db, target.tenant, [target.dealId, secondDeal.record.id], target.ctx.now)
    const company = await db.record.findUniqueOrThrow({ where: { id: target.companyId } })
    expect(company.data).not.toHaveProperty('currency_total')
    expect(await db.attributeDerivation.findFirstOrThrow({
      where: { organizationId: target.tenant.organizationId, teamId: target.tenant.teamId, attribute: { slug: 'currency_total' } },
    })).toMatchObject({ refreshState: 'ready' })
  })
})
