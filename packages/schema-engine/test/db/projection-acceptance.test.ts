import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import type { ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import {
  applyTemplate,
  createProjectionLinkWriter,
  createRecord,
  loadSchema,
  projectLinksIntoData,
  updateRecord,
} from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(databaseUrl)
const organizations: string[] = []

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
  const links = createProjectionLinkWriter()
  const company = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
    objectType: 'company', data: { name: 'Analytical Engines' },
  }, links))
  const people = await Promise.all(['Ada', 'Grace', 'Lin'].map((full) => db.$transaction((tx) =>
    createRecord(tx, ctx, schema, { objectType: 'person', data: { name: { full } } }, links))))
  return { tenant, ctx, schema, links, company: company.record, people: people.map((item) => item.record) }
}

async function output(
  tenant: { organizationId: string; teamId: string }, schema: Awaited<ReturnType<typeof loadSchema>>,
  objectType: string, recordId: string,
) {
  const links = await db.recordLink.findMany({
    where: { ...scope(tenant), fromRecordId: recordId, activeUntil: null },
    select: { relationTypeId: true, toRecordId: true, position: true },
  })
  return projectLinksIntoData(schema, objectType, links)
}

afterAll(async () => {
  await Promise.all(organizations.map((organizationId) => dropTenant(db, organizationId)))
  await db.$disconnect()
})

describe('record_reference projection acceptance', () => {
  it('keeps an omitted scalar link, clears null, and serializes only active links', async () => {
    const { tenant, ctx, schema, links, company } = await setup()
    const person = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'person', data: { name: { full: 'Ada' }, company: company.id },
    }, links))
    expect(person.record.data).not.toHaveProperty('company')
    expect(await output(tenant, schema, 'person', person.record.id)).toEqual({ company: company.id })
    const renamed = await db.$transaction((tx) => updateRecord(tx, ctx, schema, {
      recordId: person.record.id, expectedVersion: person.record.version,
      data: { name: { full: 'Ada Lovelace' } },
    }, links))
    expect(await output(tenant, schema, 'person', person.record.id)).toEqual({ company: company.id })
    await db.$transaction((tx) => updateRecord(tx, ctx, schema, {
      recordId: person.record.id, expectedVersion: renamed.record.version, data: { company: null },
    }, links))
    expect(await output(tenant, schema, 'person', person.record.id)).toEqual({})
    await expect(db.$transaction((tx) => updateRecord(tx, ctx, schema, {
      recordId: person.record.id, data: { company: [] },
    }, links))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('deduplicates multi references stably and keeps positions contiguous through reorder, removal, and clear', async () => {
    const { tenant, ctx, schema, links, company, people } = await setup()
    const [ada, grace, lin] = people
    if (ada === undefined || grace === undefined || lin === undefined) throw new Error('Missing people')
    const deal = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'deal', data: { name: 'Deal', company: company.id, contacts: [ada.id, ada.id, grace.id] },
    }, links))
    expect(await output(tenant, schema, 'deal', deal.record.id)).toMatchObject({ contacts: [ada.id, grace.id] })
    let current = deal.record
    current = (await db.$transaction((tx) => updateRecord(tx, ctx, schema, {
      recordId: current.id, expectedVersion: current.version, data: { contacts: [grace.id, ada.id, lin.id] },
    }, links))).record
    expect(await output(tenant, schema, 'deal', current.id)).toMatchObject({ contacts: [grace.id, ada.id, lin.id] })
    current = (await db.$transaction((tx) => updateRecord(tx, ctx, schema, {
      recordId: current.id, expectedVersion: current.version, data: { contacts: [grace.id, lin.id] },
    }, links))).record
    const contacts = schema.resolveBackingRelation('deal', 'contacts')
    if (contacts === undefined) throw new Error('Missing contacts backing relation')
    const active = await db.recordLink.findMany({
      where: { ...scope(tenant), relationTypeId: contacts.id, fromRecordId: current.id, activeUntil: null },
      select: { toRecordId: true, position: true }, orderBy: { position: 'asc' },
    })
    expect(active).toEqual([{ toRecordId: grace.id, position: 0 }, { toRecordId: lin.id, position: 1 }])
    await db.$transaction((tx) => updateRecord(tx, ctx, schema, {
      recordId: current.id, expectedVersion: current.version, data: { contacts: [] },
    }, links))
    expect(await output(tenant, schema, 'deal', current.id)).toEqual({ company: company.id })
  })

  it('retains a surviving edge payload and uses an empty payload only for a newly projected link', async () => {
    const { tenant, ctx, schema, links, company, people } = await setup()
    const [ada, grace, lin] = people
    if (ada === undefined || grace === undefined || lin === undefined) throw new Error('Missing people')
    const deal = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'deal', data: { name: 'Deal', company: company.id, contacts: [ada.id, grace.id] },
    }, links))
    const contacts = schema.resolveBackingRelation('deal', 'contacts')
    if (contacts === undefined) throw new Error('Missing contacts backing relation')
    const kept = await db.recordLink.findFirstOrThrow({
      where: { ...scope(tenant), relationTypeId: contacts.id, fromRecordId: deal.record.id, toRecordId: ada.id, activeUntil: null }, select: { id: true },
    })
    await db.recordLink.update({ where: { id: kept.id }, data: { data: { source: 'operator' } } })
    await db.$transaction((tx) => updateRecord(tx, ctx, schema, {
      recordId: deal.record.id, expectedVersion: deal.record.version, data: { contacts: [ada.id, lin.id] },
    }, links))
    expect(await db.recordLink.findMany({
      where: { ...scope(tenant), relationTypeId: contacts.id, fromRecordId: deal.record.id, activeUntil: null },
      select: { toRecordId: true, data: true }, orderBy: { toRecordId: 'asc' },
    })).toEqual([
      { toRecordId: ada.id, data: { source: 'operator' } }, { toRecordId: lin.id, data: {} },
    ].sort((left, right) => left.toRecordId.localeCompare(right.toRecordId)))
  })

  it('serializes competing projection writes into one complete contiguous target set', async () => {
    const { tenant, ctx, schema, links, company, people } = await setup()
    const [ada, grace, lin] = people
    if (ada === undefined || grace === undefined || lin === undefined) throw new Error('Missing people')
    const deal = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'deal', data: { name: 'Deal', company: company.id },
    }, links))
    await expect(Promise.all([
      db.$transaction((tx) => updateRecord(tx, { ...ctx, requestId: crypto.randomUUID() }, schema, {
        recordId: deal.record.id, data: { contacts: [ada.id, grace.id] },
      }, links)),
      db.$transaction((tx) => updateRecord(tx, { ...ctx, requestId: crypto.randomUUID() }, schema, {
        recordId: deal.record.id, data: { contacts: [grace.id, lin.id] },
      }, links)),
    ])).resolves.toHaveLength(2)
    const contacts = schema.resolveBackingRelation('deal', 'contacts')
    if (contacts === undefined) throw new Error('Missing contacts backing relation')
    const active = await db.recordLink.findMany({
      where: { ...scope(tenant), relationTypeId: contacts.id, fromRecordId: deal.record.id, activeUntil: null },
      select: { toRecordId: true, position: true }, orderBy: { position: 'asc' },
    })
    expect(active.map((link) => link.position)).toEqual([0, 1])
    expect([
      [ada.id, grace.id], [grace.id, lin.id],
    ]).toContainEqual(active.map((link) => link.toRecordId))
  })
})
