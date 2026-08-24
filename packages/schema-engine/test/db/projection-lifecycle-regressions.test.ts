import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { ErrorCode, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import { applyTemplate, createProjectionLinkWriter, createRecord, linkRecords, loadSchema, unlinkRecords } from '../../src/index.js'

const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(url)
const organizations: string[] = []

async function setup() {
  const tenant = await seedTenant(db); organizations.push(tenant.organizationId)
  const ctx: ActorContext = { tenant, app: 'test', actor: { type: 'system', id: 'test' }, onBehalfOf: { uoaUserId: 'uoa', role: 'owner' }, provenance: null, actChain: [], requestId: crypto.randomUUID(), now: new Date() }
  await db.$transaction((tx) => applyTemplate(tx, tenant, { type: 'system', id: 'test', onBehalfOf: null, requestId: ctx.requestId }, 'standard_crm'))
  const schema = await loadSchema(db, tenant); const links = createProjectionLinkWriter()
  const person = await db.$transaction((tx) => createRecord(tx, ctx, schema, { objectType: 'person', data: { name: { full: 'Ada' } } }, links))
  const companies = await Promise.all(['A', 'B'].map((name) => db.$transaction((tx) => createRecord(tx, ctx, schema, { objectType: 'company', data: { name } }, links))))
  return { tenant, ctx, schema, links, person: person.record, companies: companies.map((value) => value.record) }
}

function snapshot(link: { id: string; relationTypeId: string; fromRecordId: string; toRecordId: string; data: unknown; position: number | null; label: string | null }) {
  return { links: [{ id: link.id, relation_type_id: link.relationTypeId, from_record_id: link.fromRecordId, to_record_id: link.toRecordId, data: {}, position: link.position, label: link.label }], cascaded: [] }
}

async function endedFixture() {
  const value = await setup(); const [one, two] = value.companies
  if (one === undefined || two === undefined) throw new Error('fixtures')
  const made = await db.$transaction((tx) => linkRecords(tx, value.ctx, value.schema, { relationType: 'person_works_at', fromRecordId: value.person.id, toRecordId: one.id }))
  const link = await db.recordLink.findUniqueOrThrow({ where: { id: made.link.id } })
  await db.$transaction((tx) => unlinkRecords(tx, value.ctx, value.schema, 'person_works_at', value.person.id, one.id))
  return { ...value, one, two, link, state: snapshot(link) }
}

afterAll(async () => { await Promise.all(organizations.map((id) => dropTenant(db, id))); await db.$disconnect() })

describe('projection lifecycle restore conflicts', () => {
  it('maps different-target cardinality conflict to RESTORE_CONFLICT atomically', async () => {
    const value = await endedFixture()
    await db.$transaction((tx) => linkRecords(tx, value.ctx, value.schema, { relationType: 'person_works_at', fromRecordId: value.person.id, toRecordId: value.two.id }))
    const before = await db.recordLink.findMany({ where: { organizationId: value.tenant.organizationId, teamId: value.tenant.teamId }, orderBy: { id: 'asc' } })
    await expect(db.$transaction((tx) => value.links.restore(tx, value.ctx, value.schema, value.person.id, value.state))).rejects.toMatchObject({ code: ErrorCode.RESTORE_CONFLICT })
    expect(await db.recordLink.findMany({ where: { organizationId: value.tenant.organizationId, teamId: value.tenant.teamId }, orderBy: { id: 'asc' } })).toEqual(before)
  })

  it('rejects deleted and merged external endpoints without resurrecting the link', async () => {
    for (const mode of ['deletedAt', 'mergedIntoId'] as const) {
      const value = await endedFixture()
      await db.record.update({ where: { id: value.one.id }, data: mode === 'deletedAt' ? { deletedAt: new Date() } : { mergedIntoId: value.two.id } })
      const before = await db.recordLink.findUniqueOrThrow({ where: { id: value.link.id } })
      await expect(db.$transaction((tx) => value.links.restore(tx, value.ctx, value.schema, value.person.id, value.state))).rejects.toMatchObject({ code: ErrorCode.RESTORE_CONFLICT })
      expect(await db.recordLink.findUniqueOrThrow({ where: { id: value.link.id } })).toEqual(before)
    }
  })
})
