import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { ErrorCode, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import {
  applyTemplate,
  createRecord,
  linkRecords,
  loadSchema,
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

function scope(tenant: { organizationId: string; teamId: string }) {
  return { organizationId: tenant.organizationId, teamId: tenant.teamId }
}

async function setup() {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const ctx = context(tenant)
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'test', onBehalfOf: null, requestId: ctx.requestId,
  }, 'standard_crm'))
  const schema = await loadSchema(db, tenant)
  const people = await Promise.all(['Ada', 'Grace'].map((full) => db.$transaction((tx) =>
    createRecord(tx, ctx, schema, { objectType: 'person', data: { name: { full } } }, noLinks))))
  const companies = await Promise.all(['One', 'Two', 'Three'].map((name) => db.$transaction((tx) =>
    createRecord(tx, ctx, schema, { objectType: 'company', data: { name } }, noLinks))))
  return { tenant, ctx, schema, people: people.map((item) => item.record), companies: companies.map((item) => item.record) }
}

afterAll(async () => {
  await Promise.all(organizations.map((organizationId) => dropTenant(db, organizationId)))
  await db.$disconnect()
})

describe('direct link acceptance', () => {
  it('rejects wrong-type, deleted, and merged endpoints without creating a link', async () => {
    const { tenant, ctx, schema, people, companies } = await setup()
    const [ada, grace] = people
    const [one, two, three] = companies
    if (ada === undefined || grace === undefined || one === undefined || two === undefined || three === undefined)
      throw new Error('Missing fixtures')
    await expect(db.$transaction((tx) => linkRecords(tx, ctx, schema, {
      relationType: 'person_works_at', fromRecordId: ada.id, toRecordId: grace.id,
    }))).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED })
    await db.record.update({ where: { id: one.id }, data: { deletedAt: new Date() } })
    await expect(db.$transaction((tx) => linkRecords(tx, ctx, schema, {
      relationType: 'person_works_at', fromRecordId: ada.id, toRecordId: one.id,
    }))).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND })
    await db.record.update({ where: { id: two.id }, data: { mergedIntoId: three.id } })
    await expect(db.$transaction((tx) => linkRecords(tx, ctx, schema, {
      relationType: 'person_works_at', fromRecordId: ada.id, toRecordId: two.id,
    }))).rejects.toMatchObject({ code: ErrorCode.MERGED, details: { redirect_to: three.id } })
    expect(await db.recordLink.count({ where: { ...scope(tenant), activeUntil: null } })).toBe(0)
  })

  it('serializes competing many-to-one direct links to one active outgoing link', async () => {
    const { tenant, ctx, schema, people, companies } = await setup()
    const person = people[0]
    const [one, two] = companies
    if (person === undefined || one === undefined || two === undefined) throw new Error('Missing fixtures')
    await expect(Promise.all([
      db.$transaction((tx) => linkRecords(tx, { ...ctx, requestId: crypto.randomUUID() }, schema, {
        relationType: 'person_works_at', fromRecordId: person.id, toRecordId: one.id,
      })),
      db.$transaction((tx) => linkRecords(tx, { ...ctx, requestId: crypto.randomUUID() }, schema, {
        relationType: 'person_works_at', fromRecordId: person.id, toRecordId: two.id,
      })),
    ])).resolves.toHaveLength(2)
    const active = await db.recordLink.findMany({
      where: { ...scope(tenant), relationType: { slug: 'person_works_at' }, fromRecordId: person.id, activeUntil: null },
      select: { toRecordId: true },
    })
    expect(active).toHaveLength(1)
    expect([one.id, two.id]).toContain(active[0]?.toRecordId)
  })
})
