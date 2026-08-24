import { createDb, dropTenant, seedTenant, type TenantRef } from '@deepcrm/db'
import { type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import { queryRecords } from '../../src/query/run.js'
import { loadSchema } from '../../src/schema/load.js'
import { applyTemplate } from '../../src/templates/apply.js'

const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(url)
const organizations: string[] = []

function dataObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('record data must be an object')
  }
  return { ...value }
}

function context(tenant: TenantRef): ActorContext {
  return {
    tenant,
    app: 'test',
    actor: { type: 'system', id: 'query-acceptance' },
    onBehalfOf: { uoaUserId: 'query-owner', role: 'owner' },
    provenance: null,
    actChain: [],
    requestId: crypto.randomUUID(),
    now: new Date('2026-08-24T12:00:00.000Z'),
  }
}

async function fixture() {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const ctx = context(tenant)
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'query-acceptance', onBehalfOf: null, requestId: ctx.requestId,
  }, 'standard_crm'))
  const initial = await loadSchema(db, tenant)
  const deal = initial.objectTypesBySlug.get('deal')
  const person = initial.objectTypesBySlug.get('person')
  if (deal === undefined || person === undefined) throw new Error('template object missing')
  await db.record.createMany({ data: Array.from({ length: 30 }, (_, index) => ({
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    objectTypeId: deal.id,
    data: {
      name: `Deal ${String(index).padStart(2, '0')}`,
      stage: index % 2 === 0 ? 'qualified' : 'proposal',
    },
    displayName: `Deal ${String(index).padStart(2, '0')}`,
    visibility: 'team' as const,
    createdOnBehalfOf: 'query-owner',
    createdByType: 'system' as const,
    createdById: 'query-acceptance',
  })) })
  const rows = await db.record.findMany({
    where: { organizationId: tenant.organizationId, teamId: tenant.teamId, objectTypeId: deal.id },
    orderBy: { displayName: 'asc' },
  })
  const position = Math.max(...deal.attributes.map((attribute) => attribute.position)) + 1
  await db.attribute.createMany({ data: [
    { organizationId: tenant.organizationId, teamId: tenant.teamId, objectTypeId: deal.id, slug: 'fixed_amount', name: 'Fixed amount', description: '', type: 'currency', config: { defaultCurrency: 'GBP', fixedCurrency: 'GBP' }, position },
    { organizationId: tenant.organizationId, teamId: tenant.teamId, objectTypeId: deal.id, slug: 'score', name: 'Score', description: '', type: 'number', config: { precision: 0 }, position: position + 1 },
    { organizationId: tenant.organizationId, teamId: tenant.teamId, objectTypeId: deal.id, slug: 'review_date', name: 'Review date', description: '', type: 'date', config: {}, position: position + 2 },
    { organizationId: tenant.organizationId, teamId: tenant.teamId, objectTypeId: deal.id, slug: 'reviewed_at', name: 'Reviewed at', description: '', type: 'datetime', config: {}, position: position + 3 },
    { organizationId: tenant.organizationId, teamId: tenant.teamId, objectTypeId: deal.id, slug: 'assignee', name: 'Assignee', description: '', type: 'actor_reference', config: { allow: ['human', 'agent'] }, position: position + 4 },
    { organizationId: tenant.organizationId, teamId: tenant.teamId, objectTypeId: deal.id, slug: 'observed_at', name: 'Observed at', description: '', type: 'timestamp_system', config: { source: 'last_activity_at' }, position: position + 5 },
  ] })
  await db.team.update({ where: { id: tenant.teamId }, data: { schemaVersion: { increment: 1 } } })
  const schema = await loadSchema(db, tenant)
  const loadedDeal = schema.objectTypesBySlug.get('deal')
  const loadedPerson = schema.objectTypesBySlug.get('person')
  if (loadedDeal === undefined || loadedPerson === undefined) throw new Error('loaded object missing')
  return { tenant, ctx, schema, deal: loadedDeal, person: loadedPerson, rows }
}

afterAll(async () => {
  await Promise.all(organizations.map((organizationId) => dropTenant(db, organizationId)))
  await db.$disconnect()
})

describe('query run acceptance', () => {
  it('hydrates a multi record-reference projection in active position order', async () => {
    const value = await fixture()
    const source = value.rows[0]
    if (source === undefined) throw new Error('source missing')
    const first = await db.record.create({ data: {
      organizationId: value.tenant.organizationId, teamId: value.tenant.teamId, objectTypeId: value.person.id,
      data: { name: { full: 'First Contact' } }, displayName: 'First Contact',
      createdByType: 'system', createdById: 'query-acceptance',
    } })
    const second = await db.record.create({ data: {
      organizationId: value.tenant.organizationId, teamId: value.tenant.teamId, objectTypeId: value.person.id,
      data: { name: { full: 'Second Contact' } }, displayName: 'Second Contact',
      createdByType: 'system', createdById: 'query-acceptance',
    } })
    const relation = value.schema.relationTypesBySlug.get('deal_contacts')
    if (relation === undefined) throw new Error('contacts relation missing')
    await db.recordLink.createMany({ data: [
      { organizationId: value.tenant.organizationId, teamId: value.tenant.teamId, relationTypeId: relation.id, fromRecordId: source.id, toRecordId: first.id, position: 1, data: {}, createdByType: 'system', createdById: 'query-acceptance' },
      { organizationId: value.tenant.organizationId, teamId: value.tenant.teamId, relationTypeId: relation.id, fromRecordId: source.id, toRecordId: second.id, position: 0, data: {}, createdByType: 'system', createdById: 'query-acceptance' },
    ] })
    const page = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      filter: { attribute: 'contacts', op: 'contains', value: first.id },
    })
    expect(page.records).toHaveLength(1)
    expect(page.records[0]?.data.contacts).toEqual([second.id, first.id])
  })

  it('filters a fixed currency amount with stage membership and canonical structured equality', async () => {
    const value = await fixture()
    await Promise.all(value.rows.map((row, index) => db.record.update({
      where: { id: row.id },
      data: { data: { ...dataObject(row.data), fixed_amount: { amount: String(10_000 + index * 100), currency: 'GBP' } } },
    })))
    const filtered = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      includeTotal: true,
      filter: { and: [
        { attribute: 'stage', op: 'in', value: ['qualified'] },
        { attribute: 'fixed_amount', op: 'gte', value: { amount: '11000', currency: 'GBP' } },
      ] },
    })
    expect(filtered.records).toHaveLength(10)
    expect(filtered.total).toBe(10)
    const canonical = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      filter: { attribute: 'fixed_amount', op: 'eq', value: { currency: 'GBP', amount: '11000.00' } },
    })
    expect(canonical.records).toHaveLength(1)
    const actor = { id: 'uoa-structured', type: 'human' }
    const row = value.rows[0]
    if (row === undefined) throw new Error('row missing')
    await db.record.update({ where: { id: row.id }, data: { data: { ...dataObject(row.data), assignee: actor } } })
    const object = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      filter: { attribute: 'assignee', op: 'eq', value: { type: 'human', id: 'uoa-structured' } },
    })
    expect(object.records.map((record) => record.id)).toEqual([row.id])
  })

  it('uses typed scalar equality and in for number, date, datetime, and virtual timestamp nulls', async () => {
    const value = await fixture()
    const first = value.rows[0]
    const second = value.rows[1]
    if (first === undefined || second === undefined) throw new Error('rows missing')
    await db.record.update({ where: { id: first.id }, data: {
      data: { ...dataObject(first.data), score: '7', review_date: '2026-04-01', reviewed_at: '2026-04-01T11:00:00.000Z' },
      lastActivityAt: new Date('2026-04-01T12:00:00.000Z'),
    } })
    await db.record.update({ where: { id: second.id }, data: {
      data: { ...dataObject(second.data), score: '11', review_date: '2026-04-02', reviewed_at: '2026-04-02T11:00:00.000Z' },
    } })
    for (const [attribute, operand] of [
      ['score', 7], ['review_date', '2026-04-01'], ['reviewed_at', '2026-04-01T12:00:00+01:00'],
    ] as const) {
      const equality = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
        filter: { attribute, op: 'eq', value: operand },
      })
      expect(equality.records.map((record) => record.id)).toEqual([first.id])
    }
    for (const [attribute, values] of [
      ['score', [7, 11]], ['review_date', ['2026-04-01', '2026-04-02']], ['reviewed_at', ['2026-04-01T11:00:00Z', '2026-04-02T11:00:00Z']],
    ] as const) {
      const membership = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
        filter: { attribute, op: 'in', value: values },
      })
      expect(new Set(membership.records.map((record) => record.id))).toEqual(new Set([first.id, second.id]))
    }
    const timestampNulls = await queryRecords(db, value.tenant, value.ctx, value.schema, value.deal, {
      includeTotal: true,
      filter: { attribute: 'observed_at', op: 'is_null' },
    })
    expect(timestampNulls.records).toHaveLength(29)
    expect(timestampNulls.total).toBe(29)
    expect(timestampNulls.records.every((record) => !Object.hasOwn(record.data, 'observed_at'))).toBe(true)
  })
})
