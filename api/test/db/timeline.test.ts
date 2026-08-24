import { randomUUID } from 'node:crypto'

import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { applyTemplate } from '@deepcrm/schema-engine'
import { afterAll, describe, expect, it } from 'vitest'

import { addNote, logActivity } from '../../src/services/activity.js'
import { createTask } from '../../src/services/tasks.js'
import { recordTimeline } from '../../src/services/timeline.js'
import { linkContext, linkDeps } from './link-fixture.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for timeline service tests')

const db = createDb(databaseUrl)
const organizationIds: string[] = []

async function fixture() {
  const seeded = await seedTenant(db)
  organizationIds.push(seeded.organizationId)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  const ctx = linkContext(tenant, 'timeline_user')
  const actor = {
    type: ctx.actor.type,
    id: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    requestId: ctx.requestId,
  }
  await db.$transaction(async (tx) => {
    await applyTemplate(tx, tenant, actor, 'system')
    await applyTemplate(tx, tenant, actor, 'standard_crm')
  })
  const types = await db.objectType.findMany({
    where: { ...tenant, slug: { in: ['person', 'company'] } },
    select: { id: true, slug: true },
  })
  const typeIds = new Map(types.map((item) => [item.slug, item.id]))
  const personTypeId = typeIds.get('person')
  const companyTypeId = typeIds.get('company')
  if (personTypeId === undefined || companyTypeId === undefined) {
    throw new Error('Standard CRM schema is missing')
  }
  const [person, company] = await Promise.all([
    db.record.create({ data: {
      ...tenant, objectTypeId: personTypeId, data: { name: { full: 'Timeline Person' } },
      displayName: 'Timeline Person', createdByType: 'system', createdById: 'timeline-test',
      createdOnBehalfOf: 'timeline_user', visibility: 'team',
    } }),
    db.record.create({ data: {
      ...tenant, objectTypeId: companyTypeId, data: { name: 'Timeline Company' },
      displayName: 'Timeline Company', createdByType: 'system', createdById: 'timeline-test',
      createdOnBehalfOf: 'timeline_user', visibility: 'team',
    } }),
  ])
  const relation = await db.relationType.findFirstOrThrow({
    where: { ...tenant, slug: 'person_works_at' }, select: { id: true },
  })
  await db.recordLink.create({ data: {
    ...tenant, relationTypeId: relation.id, fromRecordId: person.id, toRecordId: company.id,
    data: {}, createdByType: 'system', createdById: 'timeline-test',
  } })
  return { tenant, ctx, person, company }
}

async function denyRecord(
  tenant: { organizationId: string; teamId: string },
  recordId: string,
): Promise<void> {
  await db.policyRule.create({ data: {
    ...tenant, scope: 'record', scopeId: recordId, resourceType: 'record', action: 'view',
    effect: 'deny', priority: 100, requiresApproval: false, createdById: 'timeline-test',
    bindings: { create: { actorType: 'human', actorId: 'timeline_user' } },
  } })
}

function tamper(cursor: string): string {
  const middle = Math.floor(cursor.length / 2)
  const character = cursor[middle]
  if (character === undefined) throw new Error('Cursor is empty')
  return `${cursor.slice(0, middle)}${character === 'a' ? 'b' : 'a'}${cursor.slice(middle + 1)}`
}

afterAll(async () => {
  for (const organizationId of organizationIds) {
    await db.auditLog.deleteMany({ where: { organizationId } })
    await dropTenant(db, organizationId)
  }
  await db.$disconnect()
})

describe('record timeline service', () => {
  it('presents redacted hop-one items and applies relation, kind, and since filters', async () => {
    const value = await fixture()
    const deps = linkDeps(db)
    await db.attribute.updateMany({
      where: { ...value.tenant, OR: [
        { objectType: { slug: 'activity' }, slug: 'body' },
        { objectType: { slug: 'company' }, slug: 'name' },
      ] },
      data: { sensitivity: 'restricted' },
    })
    await db.policyRule.create({ data: {
      ...value.tenant, scope: 'team', scopeId: value.tenant.teamId,
      resourceType: 'attribute', action: 'view', effect: 'deny', priority: 100,
      requiresApproval: false, conditions: { sensitivity: 'restricted' },
      createdById: 'timeline-test',
      bindings: { create: { actorType: 'human', actorId: 'timeline_user' } },
    } })
    const activity = await logActivity(deps, value.ctx, {
      kind: 'call', occurredAt: '2026-08-24T11:00:00.000Z', subject: 'Discovery',
      body: 'restricted transcript', about: [value.person.id],
      externalRef: `timeline-${randomUUID()}`,
    })
    const note = await addNote(deps, value.ctx, {
      title: 'Direct note', body: 'Visible note', about: [value.company.id],
    })
    const feed = await db.team.update({
      where: { id: value.tenant.teamId },
      data: { feedSeq: { increment: 1 } },
      select: { feedSeq: true },
    })
    const change = await db.recordChange.create({ data: {
      ...value.tenant, recordId: value.company.id, kind: 'set', attributeSlug: 'name',
      oldValue: 'Old Company', newValue: 'Timeline Company', actorType: 'human',
      actorId: 'timeline_user', onBehalfOf: 'timeline_user', requestId: randomUUID(),
      resultingVersion: 1, seq: feed.feedSeq,
      occurredAt: new Date('2026-08-24T10:00:00.000Z'),
    } })

    const expanded = await recordTimeline(deps, value.ctx, {
      id: value.company.id, hops: 1, relationTypes: ['person_works_at'],
      kinds: ['activity'],
    })
    expect(expanded.items).toEqual([expect.objectContaining({
      kind: 'activity', occurred_at: '2026-08-24T11:00:00.000Z',
      record: expect.objectContaining({
        id: activity.record.id, data: expect.not.objectContaining({ body: expect.anything() }),
        redacted_attributes: ['body'],
      }),
      about: [{
        id: value.person.id, object_type: 'person', display_name: 'Timeline Person',
      }],
    })])
    expect((await recordTimeline(deps, value.ctx, {
      id: value.company.id, hops: 1, relationTypes: ['deal_for_company'], kinds: ['activity'],
    })).items).toEqual([])
    const changes = await recordTimeline(deps, value.ctx, {
      id: value.company.id, kinds: ['change'],
    })
    const changeItem = changes.items.find((item) => (
      item.kind === 'change' && item.change.id === change.id
    ))
    if (changeItem?.kind !== 'change') throw new Error('Expected timeline change')
    expect(changeItem.change.id).toBe(change.id)
    expect(changeItem.change).not.toHaveProperty('old_value')
    expect(changeItem.change).not.toHaveProperty('new_value')
    const directSince = await recordTimeline(deps, value.ctx, {
      id: value.company.id, kinds: ['note'], since: value.ctx.now.toISOString(),
    })
    expect(directSince.items).toEqual([expect.objectContaining({
      kind: 'note', record: expect.objectContaining({ id: note.record.id }),
    })])
  })

  it('walks stable cursors, canonicalizes array order, and rejects mismatches before DB access', async () => {
    const value = await fixture()
    const deps = linkDeps(db)
    await Promise.all([
      addNote(deps, value.ctx, { body: 'Cursor note', about: [value.company.id] }),
      createTask(deps, value.ctx, { title: 'Cursor task', about: [value.company.id] }),
    ])
    const first = await recordTimeline(deps, value.ctx, {
      id: value.company.id, hops: 1,
      relationTypes: ['person_works_at', 'deal_for_company'],
      kinds: ['task', 'note'], limit: 1,
    })
    expect(first.items).toHaveLength(1)
    expect(first.next_cursor).not.toBeNull()
    if (first.next_cursor === null) throw new Error('Expected timeline cursor')
    const second = await recordTimeline(deps, value.ctx, {
      id: value.company.id, hops: 1,
      relationTypes: ['deal_for_company', 'person_works_at'],
      kinds: ['note', 'task'], limit: 1, cursor: first.next_cursor,
    })
    expect(second.items).toHaveLength(1)
    expect(second.items[0]?.kind).not.toBe(first.items[0]?.kind)

    const offlineDb = createDb(databaseUrl)
    await offlineDb.$disconnect()
    await expect(recordTimeline(linkDeps(offlineDb), value.ctx, {
      id: value.company.id, hops: 1,
      relationTypes: ['person_works_at', 'deal_for_company'],
      kinds: ['task', 'note'], limit: 2, cursor: first.next_cursor,
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED', details: { detail: 'cursor_mismatch' },
    })
    await expect(recordTimeline(linkDeps(offlineDb), value.ctx, {
      id: value.company.id, hops: 1,
      relationTypes: ['person_works_at', 'deal_for_company'],
      kinds: ['task', 'note'], limit: 1, cursor: tamper(first.next_cursor),
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED', details: { detail: 'cursor_mismatch' },
    })
  })

  it('does not leak hidden anchors and audits a denied visible anchor exactly once', async () => {
    const value = await fixture()
    const deps = linkDeps(db)
    await db.record.update({
      where: { id: value.person.id },
      data: { visibility: 'private', createdOnBehalfOf: 'someone_else' },
    })
    await expect(recordTimeline(deps, value.ctx, { id: value.person.id }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await db.auditLog.count({
      where: { ...value.tenant, action: 'crm_record_timeline' },
    })).toBe(0)
    await denyRecord(value.tenant, value.company.id)
    await expect(recordTimeline(deps, value.ctx, { id: value.company.id }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' })
    expect(await db.auditLog.count({
      where: { ...value.tenant, action: 'crm_record_timeline', outcome: 'denied' },
    })).toBe(1)
  })
})
