import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import type { ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import {
  applyTemplate,
  createProjectionLinkWriter,
  createRecord,
  executeMerge,
  executeUnmerge,
  listLinks,
  loadSchema,
  recordAt,
  updateRecord,
} from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for merge execution tests')
const db = createDb(databaseUrl)
const organizations: string[] = []

function context(tenant: { organizationId: string; teamId: string }): ActorContext {
  return {
    tenant, app: 'merge-test', actor: { type: 'system', id: 'merge-test' },
    onBehalfOf: { uoaUserId: 'merge-owner', role: 'owner' }, provenance: null,
    actChain: [], requestId: crypto.randomUUID(), now: new Date('2026-08-24T12:00:00.000Z'),
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
    type: 'system', id: 'merge-test', onBehalfOf: null, requestId: ctx.requestId,
  }, 'standard_crm'))
  const schema = await loadSchema(db, tenant)
  const writer = createProjectionLinkWriter()
  const company = (await db.$transaction((tx) => createRecord(tx, ctx, schema, {
    objectType: 'company', data: { name: 'Analytical Engines' },
  }, writer))).record
  const survivor = (await db.$transaction((tx) => createRecord(tx, ctx, schema, {
    objectType: 'person',
    data: { name: { full: 'Ada' }, emails: ['ada@engine.test'], company: company.id },
  }, writer))).record
  const loser = (await db.$transaction((tx) => createRecord(tx, ctx, schema, {
    objectType: 'person',
    data: { name: { full: 'Augusta' }, emails: ['augusta@engine.test'], company: company.id },
  }, writer))).record
  const deal = (await db.$transaction((tx) => createRecord(tx, ctx, schema, {
    objectType: 'deal', data: { name: 'Engine', contacts: [loser.id] },
  }, writer))).record
  const personType = schema.objectTypesBySlug.get('person')
  if (personType === undefined) throw new Error('Missing person type')
  const list = await db.list.create({
    data: {
      ...scope(tenant), slug: 'founders', name: 'Founders', objectTypeId: personType.id,
      createdByType: 'system', createdById: 'merge-test',
    },
  })
  await db.listEntry.createMany({
    data: [
      { listId: list.id, recordId: survivor.id, data: { note: 'survivor' }, position: 0 },
      { listId: list.id, recordId: loser.id, data: { note: 'loser' }, position: 1 },
    ],
  })
  return { tenant, ctx, schema, survivor, loser, company, deal, list }
}

afterAll(async () => {
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('merge execution', () => {
  it('undoes a merge without losing data, links, list membership, or current match rows', async () => {
    const fixture = await setup()
    const recordIds = [fixture.survivor.id, fixture.loser.id]
    const beforeRecords = await db.record.findMany({
      where: { ...scope(fixture.tenant), id: { in: recordIds } },
      select: { id: true, data: true }, orderBy: { id: 'asc' },
    })
    const beforeLinks = await db.recordLink.findMany({
      where: {
        ...scope(fixture.tenant), activeUntil: null,
        OR: [
          { fromRecordId: { in: recordIds } },
          { toRecordId: { in: recordIds } },
        ],
      },
      select: {
        id: true, relationTypeId: true, fromRecordId: true, toRecordId: true, position: true,
      },
      orderBy: { id: 'asc' },
    })
    const beforeMatchKeys = await db.recordMatchKey.findMany({
      where: { ...scope(fixture.tenant), recordId: { in: recordIds } },
      select: { matchingRuleId: true, normalizedHash: true, recordId: true },
      orderBy: [{ recordId: 'asc' }, { matchingRuleId: 'asc' }, { normalizedHash: 'asc' }],
    })
    const beforeLookupKeys = await db.recordMatchLookupKey.findMany({
      where: { ...scope(fixture.tenant), recordId: { in: recordIds } },
      select: { matchingRuleId: true, normalizedHash: true, recordId: true },
      orderBy: [{ recordId: 'asc' }, { matchingRuleId: 'asc' }, { normalizedHash: 'asc' }],
    })
    const merged = await db.$transaction((tx) => executeMerge(tx, fixture.ctx, fixture.schema, {
      survivorId: fixture.survivor.id,
      mergedIds: [fixture.loser.id],
      reason: 'same person',
    }))
    const result = await db.$transaction((tx) => executeUnmerge(tx, {
      ...fixture.ctx, requestId: crypto.randomUUID(), now: new Date('2026-08-24T12:01:00.000Z'),
    }, fixture.schema, {
      mergeChangeId: merged.mergeChangeId,
      reason: 'merge was incorrect',
    }))
    expect(result).toMatchObject({ restored: [fixture.loser.id], conflicts: [] })
    expect(await db.record.findMany({
      where: { ...scope(fixture.tenant), id: { in: recordIds } },
      select: { id: true, data: true }, orderBy: { id: 'asc' },
    })).toEqual(beforeRecords)
    expect(await db.recordLink.findMany({
      where: {
        ...scope(fixture.tenant), activeUntil: null,
        OR: [
          { fromRecordId: { in: recordIds } },
          { toRecordId: { in: recordIds } },
        ],
      },
      select: {
        id: true, relationTypeId: true, fromRecordId: true, toRecordId: true, position: true,
      },
      orderBy: { id: 'asc' },
    })).toEqual(beforeLinks)
    expect(await db.recordMatchKey.findMany({
      where: { ...scope(fixture.tenant), recordId: { in: recordIds } },
      select: { matchingRuleId: true, normalizedHash: true, recordId: true },
      orderBy: [{ recordId: 'asc' }, { matchingRuleId: 'asc' }, { normalizedHash: 'asc' }],
    })).toEqual(beforeMatchKeys)
    expect(await db.recordMatchLookupKey.findMany({
      where: { ...scope(fixture.tenant), recordId: { in: recordIds } },
      select: { matchingRuleId: true, normalizedHash: true, recordId: true },
      orderBy: [{ recordId: 'asc' }, { matchingRuleId: 'asc' }, { normalizedHash: 'asc' }],
    })).toEqual(beforeLookupKeys)
  })

  it('moves keys, re-points both link columns, collapses duplicates, and leaves redirects', async () => {
    const fixture = await setup()
    const beforeLinks = await db.recordLink.findMany({
      where: {
        ...scope(fixture.tenant),
        OR: [{ fromRecordId: fixture.survivor.id }, { fromRecordId: fixture.loser.id }],
        activeUntil: null,
      },
      orderBy: [{ activeFrom: 'asc' }, { id: 'asc' }],
    })
    const oldestCompanyLink = beforeLinks[0]
    if (oldestCompanyLink === undefined) throw new Error('Missing company link')
    const result = await db.$transaction((tx) => executeMerge(tx, fixture.ctx, fixture.schema, {
      survivorId: fixture.survivor.id,
      mergedIds: [fixture.loser.id],
      reason: 'same person',
    }))
    expect(result.record.data).toMatchObject({
      name: { full: 'Ada' }, emails: ['ada@engine.test', 'augusta@engine.test'],
    })
    expect(result.repointedLinks).toBe(1)
    expect(result.endedLinks).toHaveLength(1)
    const loser = await db.record.findUniqueOrThrow({ where: { id: fixture.loser.id } })
    expect(loser).toMatchObject({ mergedIntoId: fixture.survivor.id, deletedAt: fixture.ctx.now })
    const activeCompanyLinks = await db.recordLink.findMany({
      where: {
        ...scope(fixture.tenant), fromRecordId: fixture.survivor.id,
        toRecordId: fixture.company.id, activeUntil: null,
      },
    })
    expect(activeCompanyLinks.map((link) => link.id)).toEqual([oldestCompanyLink.id])
    expect(await db.recordLink.count({
      where: {
        ...scope(fixture.tenant), fromRecordId: fixture.deal.id,
        toRecordId: fixture.survivor.id, activeUntil: null,
      },
    })).toBe(1)
    const keys = await db.recordUniqueKey.findMany({
      where: { ...scope(fixture.tenant), recordId: fixture.survivor.id },
      select: { normalizedValue: true }, orderBy: { normalizedValue: 'asc' },
    })
    expect(keys.map((key) => key.normalizedValue)).toEqual([
      'ada@engine.test', 'augusta@engine.test',
    ])
    const snapshot = await db.recordChange.findUniqueOrThrow({
      where: { id: result.mergeChangeId }, select: { occurredAt: true, snapshot: true },
    })
    expect(snapshot.snapshot).toMatchObject({
      survivorBefore: { name: { full: 'Ada' }, emails: ['ada@engine.test'] },
      losers: [{ id: fixture.loser.id }],
      repointedLinks: expect.any(Array),
      endedLinks: expect.any(Array),
      movedKeys: expect.any(Array),
      droppedKeys: expect.any(Array),
      movedEntries: [],
    })
    const entries = await db.$queryRaw<Array<{ recordId: string; data: unknown }>>`
      SELECT record_id AS "recordId", data FROM list_entries
      WHERE list_id = ${fixture.list.id}::uuid ORDER BY position ASC
    `
    expect(entries).toEqual([
      { recordId: fixture.survivor.id, data: { note: 'survivor' } },
      { recordId: fixture.loser.id, data: { note: 'loser' } },
    ])
    const redirectedLinks = await listLinks(db, fixture.ctx, fixture.schema, {
      recordId: fixture.loser.id,
    })
    expect(redirectedLinks.length).toBeGreaterThan(0)
    const at = await recordAt(
      db, fixture.tenant, fixture.loser.id,
      new Date(snapshot.occurredAt.getTime() + 1),
    )
    expect(at.data).toMatchObject({ emails: ['ada@engine.test', 'augusta@engine.test'] })
  })

  it('keeps projected multi-reference positions contiguous after source re-pointing', async () => {
    const fixture = await setup()
    const writer = createProjectionLinkWriter()
    const survivorDeal = (await db.$transaction((tx) => createRecord(
      tx, fixture.ctx, fixture.schema, {
        objectType: 'deal', data: { name: 'Surviving deal', contacts: [fixture.survivor.id] },
      }, writer,
    ))).record
    const merged = await db.$transaction((tx) => executeMerge(tx, fixture.ctx, fixture.schema, {
      survivorId: survivorDeal.id,
      mergedIds: [fixture.deal.id],
      reason: 'same deal',
    }))
    const other = (await db.$transaction((tx) => createRecord(tx, {
      ...fixture.ctx, requestId: crypto.randomUUID(),
    }, fixture.schema, {
      objectType: 'person',
      data: { name: { full: 'Other' }, emails: ['other@engine.test'] },
    }, writer))).record
    const updateCtx = {
      ...fixture.ctx,
      requestId: crypto.randomUUID(),
      now: new Date('2026-08-24T12:01:00.000Z'),
    }
    await db.$transaction((tx) => updateRecord(tx, updateCtx, fixture.schema, {
      recordId: survivorDeal.id,
      expectedVersion: merged.record.version,
      data: { contacts: [fixture.survivor.id, fixture.loser.id, other.id] },
    }, writer))
    expect((await db.$transaction((tx) => executeUnmerge(tx, {
      ...updateCtx, requestId: crypto.randomUUID(),
    }, fixture.schema, {
      mergeChangeId: merged.mergeChangeId,
      reason: 'deals are distinct',
    }))).conflicts).toEqual([])
    const relation = fixture.schema.resolveBackingRelation('deal', 'contacts')
    if (relation === undefined) throw new Error('Missing deal contacts relation')
    const links = await db.recordLink.findMany({
      where: {
        ...scope(fixture.tenant), relationTypeId: relation.id,
        fromRecordId: survivorDeal.id, activeUntil: null,
      },
      select: { toRecordId: true, position: true }, orderBy: { position: 'asc' },
    })
    expect(links).toEqual([
      { toRecordId: fixture.survivor.id, position: 0 },
      { toRecordId: other.id, position: 1 },
    ])
    expect(await db.recordLink.findMany({
      where: {
        ...scope(fixture.tenant), relationTypeId: relation.id,
        fromRecordId: fixture.deal.id, activeUntil: null,
      },
      select: { toRecordId: true, position: true }, orderBy: { position: 'asc' },
    })).toEqual([{ toRecordId: fixture.loser.id, position: 0 }])
  })

  it('preserves survivor changes after merge and returns unique conflicts atomically', async () => {
    const fixture = await setup()
    const writer = createProjectionLinkWriter()
    const merged = await db.$transaction((tx) => executeMerge(tx, fixture.ctx, fixture.schema, {
      survivorId: fixture.survivor.id,
      mergedIds: [fixture.loser.id],
      reason: 'same person',
    }))
    const updateCtx = {
      ...fixture.ctx,
      requestId: crypto.randomUUID(),
      now: new Date('2026-08-24T12:01:00.000Z'),
    }
    const updated = await db.$transaction((tx) => updateRecord(tx, updateCtx, fixture.schema, {
      recordId: fixture.survivor.id,
      expectedVersion: merged.record.version,
      data: { title: 'Analyst', emails: ['ada@engine.test'] },
    }, writer))
    const third = (await db.$transaction((tx) => createRecord(tx, {
      ...updateCtx, requestId: crypto.randomUUID(),
    }, fixture.schema, {
      objectType: 'person',
      data: { name: { full: 'Third' }, emails: ['augusta@engine.test'] },
    }, writer))).record
    const changesBefore = await db.recordChange.count({ where: scope(fixture.tenant) })
    const result = await db.$transaction((tx) => executeUnmerge(tx, {
      ...updateCtx, requestId: crypto.randomUUID(), now: new Date('2026-08-24T12:02:00.000Z'),
    }, fixture.schema, {
      mergeChangeId: merged.mergeChangeId,
      reason: 'merge was incorrect',
    }))
    expect(result).toEqual({
      restored: [],
      conflicts: [{ kind: 'unique_key', attribute: 'emails', heldBy: third.id }],
      sequences: [],
      touchedRecordIds: [],
    })
    expect(await db.recordChange.count({ where: scope(fixture.tenant) })).toBe(changesBefore)
    expect(await db.record.findUniqueOrThrow({ where: { id: fixture.survivor.id } })).toMatchObject({
      data: { name: { full: 'Ada' }, emails: ['ada@engine.test'], title: 'Analyst' },
      version: updated.record.version,
    })
    expect(await db.record.findUniqueOrThrow({ where: { id: fixture.loser.id } })).toMatchObject({
      mergedIntoId: fixture.survivor.id,
    })
  })
})
