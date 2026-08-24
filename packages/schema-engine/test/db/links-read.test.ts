import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { ErrorCode, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import {
  applyTemplate,
  createRecord,
  linkRecords,
  listLinks,
  loadSchema,
  unlinkRecords,
  type LinkWriter,
  type LinkWriteResult,
} from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(databaseUrl)
const organizations: string[] = []
const noLinks: LinkWriter = {
  apply: async (): Promise<LinkWriteResult> => { throw new Error('Unexpected projection link write') },
  delete: async () => ({ changes: [], touchedRecordIds: [] }),
  restore: async () => ({ changes: [], touchedRecordIds: [] }),
}

function context(tenant: { organizationId: string; teamId: string }): ActorContext {
  return {
    tenant, app: 'test', actor: { type: 'system', id: 'test' },
    onBehalfOf: { uoaUserId: 'uoa_test', role: 'owner' }, provenance: null,
    actChain: [], requestId: crypto.randomUUID(), now: new Date(),
  }
}

async function setup() {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const ctx = context(tenant)
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'test', onBehalfOf: null, requestId: ctx.requestId,
  }, 'standard_crm'))
  const schema = await loadSchema(db, tenant)
  const person = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
    objectType: 'person', data: { name: { full: 'Ada' } },
  }, noLinks))
  const companies = await Promise.all(['One', 'Two'].map((name) => db.$transaction((tx) =>
    createRecord(tx, ctx, schema, { objectType: 'company', data: { name } }, noLinks))))
  return { tenant, ctx, schema, person: person.record, companies: companies.map((item) => item.record) }
}

afterAll(async () => {
  await Promise.all(organizations.map((organizationId) => dropTenant(db, organizationId)))
  await db.$disconnect()
})

describe('listLinks', () => {
  it('lists active/history links deterministically by direction, relation, and related endpoint', async () => {
    const { ctx, schema, person, companies } = await setup()
    const [one, two] = companies
    if (one === undefined || two === undefined) throw new Error('Missing companies')
    const first = await db.$transaction((tx) => linkRecords(tx, ctx, schema, {
      relationType: 'person_works_at', fromRecordId: person.id, toRecordId: one.id, label: 'first',
    }))
    const second = await db.$transaction((tx) => linkRecords(tx, ctx, schema, {
      relationType: 'person_works_at', fromRecordId: person.id, toRecordId: two.id, label: 'second',
    }))
    await db.recordLink.update({ where: { id: first.link.id }, data: { activeFrom: new Date(0) } })
    await db.recordLink.update({ where: { id: second.link.id }, data: { activeFrom: new Date(1000) } })
    const active = await db.$transaction((tx) => listLinks(tx, ctx, schema, {
      recordId: person.id, relationType: 'person_works_at', direction: 'from',
    }))
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ relatedRecordId: two.id, link: { label: 'second', activeUntil: null } })
    const incoming = await db.$transaction((tx) => listLinks(tx, ctx, schema, {
      recordId: two.id, direction: 'to',
    }))
    expect(incoming).toHaveLength(1)
    expect(incoming[0]?.relatedRecordId).toBe(person.id)
    const history = await db.$transaction((tx) => listLinks(tx, ctx, schema, {
      recordId: person.id, direction: 'both', includeHistory: true,
    }))
    expect(history).toHaveLength(2)
    expect(history.map((item) => item.link.id)).toEqual([second.link.id, first.link.id])
    await db.$transaction((tx) => unlinkRecords(tx, ctx, schema, 'person_works_at', person.id, two.id))
    expect(await db.$transaction((tx) => listLinks(tx, ctx, schema, { recordId: person.id }))).toEqual([])
  })

  it('rejects cross-tenant and deleted anchors while redirecting a merged anchor', async () => {
    const target = await setup()
    const foreign = await setup()
    await expect(db.$transaction((tx) => listLinks(tx, target.ctx, target.schema, {
      recordId: foreign.person.id,
    }))).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND })
    await db.record.update({ where: { id: target.person.id }, data: { deletedAt: new Date() } })
    await expect(db.$transaction((tx) => listLinks(tx, target.ctx, target.schema, {
      recordId: target.person.id,
    }))).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND })
    const merged = await setup()
    const company = merged.companies[0]
    if (company === undefined) throw new Error('Missing company')
    await db.record.update({ where: { id: merged.person.id }, data: { mergedIntoId: company.id } })
    await expect(db.$transaction((tx) => listLinks(tx, merged.ctx, merged.schema, {
      recordId: merged.person.id,
    }))).resolves.toEqual([])
  })
})
