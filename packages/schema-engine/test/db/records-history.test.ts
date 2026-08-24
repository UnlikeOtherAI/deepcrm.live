import { createDb, dropTenant, seedTenant, tenantWhere } from '@deepcrm/db'
import { ErrorCode, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import {
  applyTemplate,
  createProjectionLinkWriter,
  createRecord,
  deleteRecord,
  linkRecords,
  loadSchema,
  recordAt,
  recordHistory,
  restoreRecord,
  updateRecord,
  writeChanges,
  type LinkWriter,
  type LinkWriteResult,
} from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for record history tests')
const db = createDb(databaseUrl)
const organizations: string[] = []

const noLinks: LinkWriter = {
  apply: async (): Promise<LinkWriteResult> => { throw new Error('Unexpected reference write') },
  delete: async () => ({ changes: [], touchedRecordIds: [] }),
  restore: async () => ({ changes: [], touchedRecordIds: [] }),
}

function context(tenant: { organizationId: string; teamId: string }, now = new Date()): ActorContext {
  return {
    tenant, app: 'test', actor: { type: 'system', id: 'history-test' },
    onBehalfOf: { uoaUserId: 'uoa_history', role: 'owner' }, provenance: null,
    actChain: [], requestId: crypto.randomUUID(), now,
  }
}

async function setup() {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const ctx = context(tenant)
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'history-test', onBehalfOf: null, requestId: ctx.requestId,
  }, 'standard_crm'))
  return { tenant, ctx, schema: await loadSchema(db, tenant) }
}

async function moveChanges(
  tenant: { organizationId: string; teamId: string },
  recordId: string,
  resultingVersion: number,
  occurredAt: Date,
): Promise<void> {
  await db.recordChange.updateMany({
    where: { ...tenantWhere(tenant), recordId, resultingVersion },
    data: { occurredAt },
  })
}

afterAll(async () => {
  await Promise.all(organizations.map((organizationId) => dropTenant(db, organizationId)))
  await db.$disconnect()
})

describe('record history engine', () => {
  it('replays stored set/unset changes at an instant and pages exact descending keysets', async () => {
    const { tenant, ctx, schema } = await setup()
    const created = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'person', data: { name: { full: 'Ada Lovelace' }, title: 'Analyst' },
    }, noLinks))
    const first = await db.$transaction((tx) => updateRecord(tx, context(tenant), schema, {
      recordId: created.record.id, data: { title: 'Engineer' }, expectedVersion: 1,
    }, noLinks))
    await db.$transaction((tx) => updateRecord(tx, context(tenant), schema, {
      recordId: created.record.id, data: { title: 'Architect' }, expectedVersion: first.record.version,
    }, noLinks))
    const t0 = new Date('2026-01-01T00:00:00.000Z')
    const t1 = new Date('2026-01-02T00:00:00.000Z')
    const t2 = new Date('2026-01-03T00:00:00.000Z')
    await moveChanges(tenant, created.record.id, 1, t0)
    await moveChanges(tenant, created.record.id, 2, t1)
    await moveChanges(tenant, created.record.id, 3, t2)

    const middle = await db.$transaction((tx) => recordAt(
      tx, tenant, created.record.id, new Date('2026-01-02T12:00:00.000Z'),
    ))
    expect(middle).toMatchObject({
      data: { name: { full: 'Ada Lovelace' }, title: 'Engineer' },
      version_at: 2,
      as_of: '2026-01-02T12:00:00.000Z',
      links: {},
    })
    expect(middle).not.toHaveProperty('snapshot')

    const firstPage = await db.$transaction((tx) => recordHistory(tx, tenant, {
      recordId: created.record.id, limit: 2,
    }))
    expect(firstPage.changes).toHaveLength(2)
    expect(firstPage.next).not.toBeNull()
    expect(firstPage.changes.map((change) => change.resulting_version)).toEqual([3, 2])
    expect(firstPage.changes.every((change) => !Object.hasOwn(change, 'snapshot'))).toBe(true)
    const secondPage = await db.$transaction((tx) => recordHistory(tx, tenant, {
      recordId: created.record.id, limit: 2, after: firstPage.next ?? undefined,
    }))
    expect(new Set([...firstPage.changes, ...secondPage.changes].map((change) => change.id)).size).toBe(4)
    expect(secondPage.next).not.toBeNull()
    const finalPage = await db.$transaction((tx) => recordHistory(tx, tenant, {
      recordId: created.record.id, limit: 200, after: secondPage.next ?? undefined,
    }))
    expect(finalPage.next).toBeNull()

    const onlyTitle = await db.$transaction((tx) => recordHistory(tx, tenant, {
      recordId: created.record.id, attributes: ['title'], limit: 20,
    }))
    expect(onlyTitle.changes.map((change) => change.attribute)).toEqual(['title', 'title', 'title'])
  })

  it('returns NOT_FOUND before create and throughout a deleted interval, then resumes on restore', async () => {
    const { tenant, ctx, schema } = await setup()
    const created = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'company', data: { name: 'Analytical Engines' },
    }, noLinks))
    const deleted = await db.$transaction((tx) => deleteRecord(
      tx, context(tenant), schema, created.record.id, 1, noLinks,
    ))
    await db.$transaction((tx) => restoreRecord(
      tx, context(tenant), schema, created.record.id, deleted.record.version, noLinks,
    ))
    await moveChanges(tenant, created.record.id, 1, new Date('2026-02-01T00:00:00.000Z'))
    await moveChanges(tenant, created.record.id, 2, new Date('2026-02-02T00:00:00.000Z'))
    await moveChanges(tenant, created.record.id, 3, new Date('2026-02-03T00:00:00.000Z'))

    await expect(db.$transaction((tx) => recordAt(
      tx, tenant, created.record.id, new Date('2026-01-31T23:59:59.000Z'),
    ))).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND })
    await expect(db.$transaction((tx) => recordAt(
      tx, tenant, created.record.id, new Date('2026-02-02T12:00:00.000Z'),
    ))).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND })
    await expect(db.$transaction((tx) => recordAt(
      tx, { organizationId: crypto.randomUUID(), teamId: tenant.teamId },
      created.record.id, new Date('2026-02-04T00:00:00.000Z'),
    ))).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND })
    expect(await db.$transaction((tx) => recordAt(
      tx, tenant, created.record.id, new Date('2026-02-04T00:00:00.000Z'),
    ))).toMatchObject({ data: { name: 'Analytical Engines' }, version_at: 3 })
    const history = await db.$transaction((tx) => recordHistory(tx, tenant, {
      recordId: created.record.id, limit: 200,
    }))
    const deletion = history.changes.find((change) => change.kind === 'delete')
    expect(deletion).toBeDefined()
    expect(deletion).not.toHaveProperty('snapshot')
  })

  it('uses historical link events for multi-reference order and current redaction for values and links', async () => {
    const { tenant, ctx, schema } = await setup()
    const people = await Promise.all(['Ada', 'Grace'].map((name) => db.$transaction((tx) => createRecord(
      tx, context(tenant), schema, { objectType: 'person', data: { name: { full: name } } }, noLinks,
    ))))
    const [ada, grace] = people
    if (ada === undefined || grace === undefined) throw new Error('Missing people')
    const writer = createProjectionLinkWriter()
    const deal = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
      objectType: 'deal', data: { name: 'Engine', contacts: [ada.record.id, grace.record.id] },
    }, writer))
    const links = await db.recordLink.findMany({
      where: { ...tenantWhere(tenant), fromRecordId: deal.record.id }, orderBy: { position: 'asc' },
    })
    const [first, second] = links
    if (first === undefined || second === undefined) throw new Error('Missing projected links')
    await db.recordLink.update({ where: { id: first.id }, data: { position: -1 } })
    await db.recordLink.update({ where: { id: second.id }, data: { position: 0 } })
    await db.recordLink.update({ where: { id: first.id }, data: { position: 1 } })

    const asOf = new Date(Date.now() + 60_000)
    const historical = await db.$transaction((tx) => recordAt(tx, tenant, deal.record.id, asOf))
    expect(historical.links['contacts']?.map((link) => link.to_record_id)).toEqual([
      ada.record.id, grace.record.id,
    ])
    const redacted = await db.$transaction((tx) => recordAt(
      tx, tenant, deal.record.id, asOf, { visibleAttributeSlugs: new Set(['name']) },
    ))
    expect(redacted.links).toEqual({})

    const history = await db.$transaction((tx) => recordHistory(tx, tenant, {
      recordId: deal.record.id, visibleAttributeSlugs: new Set(['name']), limit: 200,
    }))
    const linkChange = history.changes.find((change) => change.kind === 'link')
    expect(linkChange).not.toHaveProperty('new_value')
    const hiddenName = history.changes.find((change) => change.attribute === 'stage')
    expect(hiddenName).not.toHaveProperty('old_value')
    expect(hiddenName).not.toHaveProperty('new_value')
    expect(history.changes.every((change) => !Object.hasOwn(change, 'snapshot'))).toBe(true)

    const company = await db.$transaction((tx) => createRecord(tx, context(tenant), schema, {
      objectType: 'company', data: { name: 'Engines Limited' },
    }, noLinks))
    await db.$transaction(async (tx) => {
      const link = await linkRecords(tx, context(tenant), schema, {
        relationType: 'person_works_at',
        fromRecordId: ada.record.id,
        toRecordId: company.record.id,
        data: { role: 'Classified role' },
      })
      await writeChanges(tx, context(tenant), link.changes)
    })
    const edgeVisibility = {
      visibleLinkDataSlugsByRelationType: new Map([
        ['person_works_at', new Set<string>()],
      ]),
    }
    const edgeAt = await db.$transaction((tx) => recordAt(
      tx, tenant, ada.record.id, new Date(Date.now() + 60_000), edgeVisibility,
    ))
    expect(edgeAt.links['company']?.[0]?.data).toEqual({})
    const edgeHistory = await db.$transaction((tx) => recordHistory(tx, tenant, {
      recordId: ada.record.id,
      limit: 200,
      ...edgeVisibility,
    }))
    const directLink = edgeHistory.changes.find((change) => (
      change.kind === 'link' && change.relation_type === 'person_works_at'
    ))
    expect(directLink?.new_value).toMatchObject({ data: {} })
    expect(JSON.stringify({ edgeAt, edgeHistory })).not.toContain('Classified role')
    const hiddenEndpoint = {
      ...edgeVisibility,
      visibleLinkedRecordIds: new Set<string>(),
    }
    expect(await db.$transaction((tx) => recordAt(
      tx, tenant, ada.record.id, new Date(Date.now() + 60_000), hiddenEndpoint,
    ))).toMatchObject({ links: {} })
    const hiddenHistory = await db.$transaction((tx) => recordHistory(tx, tenant, {
      recordId: ada.record.id,
      limit: 200,
      ...hiddenEndpoint,
    }))
    const hiddenChange = hiddenHistory.changes.find((change) => (
      change.kind === 'link' && change.relation_type === 'person_works_at'
    ))
    expect(hiddenChange).not.toHaveProperty('old_value')
    expect(hiddenChange).not.toHaveProperty('new_value')
  })
})
