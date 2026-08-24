import { randomUUID } from 'node:crypto'

import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { applyTemplate } from '@deepcrm/schema-engine'
import { afterAll, describe, expect, it } from 'vitest'

import { addNote, logActivity, type LogActivityInput } from '../../src/services/activity.js'
import { linkContext, linkDeps } from './link-fixture.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for activity service tests')

const db = createDb(databaseUrl)
const organizationIds: string[] = []

afterAll(async () => {
  for (const organizationId of organizationIds) {
    await db.auditLog.deleteMany({ where: { organizationId } })
    await dropTenant(db, organizationId)
  }
  await db.$disconnect()
})

describe('activity and note service', () => {
  it('asserts external activities and advances about records monotonically without a field change', async () => {
    const tenant = await seedTenant(db)
    organizationIds.push(tenant.organizationId)
    const ctx = linkContext(tenant)
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
    const objects = await db.objectType.findMany({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId, slug: { in: ['person', 'company'] } },
      select: { id: true, slug: true },
    })
    const objectIds = new Map(objects.map((object) => [object.slug, object.id]))
    const personTypeId = objectIds.get('person')
    const companyTypeId = objectIds.get('company')
    if (personTypeId === undefined || companyTypeId === undefined) throw new Error('Standard CRM schema is missing')
    const tenantIds = { organizationId: tenant.organizationId, teamId: tenant.teamId }
    const [person, company] = await Promise.all([
      db.record.create({ data: {
        ...tenantIds, objectTypeId: personTypeId, data: {}, displayName: 'Activity Person',
        createdByType: 'system', createdById: 'activity-test', visibility: 'team',
      } }),
      db.record.create({ data: {
        ...tenantIds, objectTypeId: companyTypeId, data: {}, displayName: 'Activity Company',
        createdByType: 'system', createdById: 'activity-test', visibility: 'team',
      } }),
    ])
    const about = [person.id, company.id]
    const noteKey = `note-${randomUUID()}`
    const note = await addNote(linkDeps(db), ctx, {
      title: 'Follow-up', body: 'Send the proposal.', about, idempotencyKey: noteKey,
    })
    const noteReplay = await addNote(linkDeps(db), ctx, {
      title: 'Follow-up', body: 'Send the proposal.', about, idempotencyKey: noteKey,
    })
    expect(noteReplay.record.id).toBe(note.record.id)
    expect(note.record.visibility).toBe('team')
    expect(await db.recordLink.count({
      where: {
        ...tenantIds, fromRecordId: note.record.id, activeUntil: null,
        relationType: { slug: 'note_about' },
      },
    })).toBe(2)
    const afterNote = await db.record.findMany({
      where: { ...tenantIds, id: { in: about } }, select: { lastActivityAt: true },
    })
    expect(afterNote.every((record) => record.lastActivityAt?.getTime() === ctx.now.getTime())).toBe(true)

    const externalRef = `activity-${randomUUID()}`
    const occurredAt = '2026-08-24T14:00:00.000Z'
    const first = await logActivity(linkDeps(db), ctx, {
      kind: 'call', occurredAt, subject: 'Discovery call', about, externalRef,
    })
    const repeated = await logActivity(linkDeps(db), ctx, {
      kind: 'call', occurredAt, subject: 'Discovery call updated', about, externalRef,
    })
    expect(repeated.record.id).toBe(first.record.id)
    expect(repeated.record.data).toMatchObject({ subject: 'Discovery call updated' })
    expect(await db.recordLink.count({
      where: { ...tenantIds, fromRecordId: first.record.id, activeUntil: null },
    })).toBe(2)

    await logActivity(linkDeps(db), ctx, {
      kind: 'email', occurredAt: '2026-08-24T10:00:00.000Z', about: [person.id],
      externalRef: `activity-${randomUUID()}`,
    })
    const refreshed = await db.record.findMany({
      where: { ...tenantIds, id: { in: about } },
      select: { id: true, lastActivityAt: true },
      orderBy: { id: 'asc' },
    })
    expect(refreshed).toHaveLength(2)
    expect(refreshed.every((record) => record.lastActivityAt?.toISOString() === occurredAt)).toBe(true)
    expect(await db.recordChange.count({
      where: { ...tenantIds, recordId: { in: about }, attributeSlug: 'last_activity_at' },
    })).toBe(0)
    const activityKey = `activity-idempotency-${randomUUID()}`
    const idempotentInput: LogActivityInput = {
      kind: 'message', occurredAt, about: [person.id], idempotencyKey: activityKey,
    }
    const idempotent = await logActivity(linkDeps(db), ctx, idempotentInput)
    const activityReplay = await logActivity(linkDeps(db), ctx, idempotentInput)
    expect(activityReplay.record.id).toBe(idempotent.record.id)

    const replays = await db.idempotencyReplay.findMany({
      where: { ...tenantIds }, select: { key: true, tool: true }, orderBy: { tool: 'asc' },
    })
    expect(replays).toEqual([
      { key: activityKey, tool: 'crm_activity_log' },
      { key: noteKey, tool: 'crm_note_add' },
    ])
    const actions = await db.auditLog.findMany({
      where: { organizationId: tenant.organizationId, teamId: tenant.teamId },
      select: { action: true },
    })
    expect(actions.filter(({ action }) => action === 'crm_activity_log')).toHaveLength(4)
    expect(actions.filter(({ action }) => action === 'crm_note_add')).toHaveLength(1)

    await db.record.update({ where: { id: company.id }, data: { visibility: 'private' } })
    const rowCounts = () => Promise.all([
      db.record.count({ where: { ...tenantIds } }),
      db.recordLink.count({ where: { ...tenantIds } }),
      db.recordChange.count({ where: { ...tenantIds } }),
      db.idempotencyReplay.count({ where: { ...tenantIds } }),
      db.auditLog.count({ where: { organizationId: tenant.organizationId, teamId: tenant.teamId } }),
    ])
    const beforeHidden = await rowCounts()
    await expect(addNote(linkDeps(db), ctx, {
      body: 'Must not be persisted.', about: [company.id], idempotencyKey: `hidden-${randomUUID()}`,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await rowCounts()).toEqual(beforeHidden)
  })
})
