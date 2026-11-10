import { dropTenant } from '@deepcrm/db'
import { afterAll, describe, expect, it } from 'vitest'

import { getRecord } from '../../src/services/record-read.js'
import { queryRecords } from '../../src/services/record-query.js'
import { createRecord, deleteRecord, restoreRecord } from '../../src/services/records.js'
import { context, db, deps, fixture, now, organizations, person, unavailable, viewRule } from './deleted-records-fixture.js'

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { organizationId: { in: organizations } } })
  for (const id of organizations) await dropTenant(db, id)
  await db.$disconnect()
})

describe('recoverable deleted record reads', () => {
  it('defaults to active, reads deleted UUIDs only on opt-in, and preserves restore conflicts', async () => {
    const tenant = await fixture()
    const ctx = context(tenant)
    const id = await person(tenant, 'Recover me', { deleted: true, email: 'recover@example.test' })
    await expect(getRecord(deps, ctx, { id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await queryRecords(deps, ctx, { objectType: 'person' })).records).toEqual([])
    const deleted = await getRecord(deps, ctx, { id, includeDeleted: true, includeLinks: true })
    expect(deleted).toMatchObject({ record: { id, deleted_at: now.toISOString() }, links: {} })
    expect((await queryRecords(deps, ctx, {
      objectType: 'person', recordState: 'deleted', includeTotal: true,
    }))).toMatchObject({ records: [{ id, deleted_at: now.toISOString() }], total: 1 })
    await expect(getRecord(deps, ctx, {
      objectType: 'person', matchAttribute: 'emails', value: 'recover@example.test', includeDeleted: true,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const holder = await person(tenant, 'Unique holder', { email: 'recover@example.test' })
    await expect(restoreRecord(deps, ctx, { recordId: id })).rejects.toMatchObject({ code: 'RESTORE_CONFLICT' })
    expect((await queryRecords(deps, ctx, { objectType: 'person', recordState: 'deleted' })).records)
      .toEqual([expect.objectContaining({ id })])
    const restoredHolder = await getRecord(deps, ctx, { id: holder, includeDeleted: true })
    expect(restoredHolder.record.deleted_at).toBeNull()
    const cleanId = await person(tenant, 'Restore clean', { deleted: true })
    await restoreRecord(deps, ctx, { recordId: cleanId })
    expect((await getRecord(deps, ctx, { id: cleanId })).record.deleted_at).toBeNull()
    expect((await queryRecords(deps, ctx, { objectType: 'person', recordState: 'deleted' })).records
      .some((record) => record.id === cleanId)).toBe(false)
  })

  it('enforces private visibility even for owner/admin, current policy, grants, redaction and tenant boundaries', async () => {
    const tenant = await fixture()
    const ctx = context(tenant)
    const visibleId = await person(tenant, 'Visible deleted', { deleted: true })
    const privateId = await person(tenant, 'Private deleted', { deleted: true, private: true })
    const grantedId = await person(tenant, 'Granted deleted', { deleted: true, visibleTo: [ctx.actor.id] })
    const deniedId = await person(tenant, 'Denied deleted', { deleted: true })
    const approvalId = await person(tenant, 'Approval deleted', { deleted: true })
    await viewRule(tenant, 'record', deniedId)
    await viewRule(tenant, 'record', approvalId, true)
    const type = await db.objectType.findFirstOrThrow({ where: { ...tenant, slug: 'person' } })
    await db.attribute.updateMany({ where: { ...tenant, objectTypeId: type.id, slug: 'title' },
      data: { sensitivity: 'restricted' } })
    await db.team.update({ where: { id: tenant.teamId }, data: { schemaVersion: { increment: 1 } } })
    await viewRule(tenant, 'attribute', visibleId)
    await expect(getRecord(deps, ctx, { id: privateId, includeDeleted: true }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(getRecord(deps, { ...ctx, onBehalfOf: { uoaUserId: ctx.actor.id, role: 'admin' } }, {
      id: privateId, includeDeleted: true,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(getRecord(deps, ctx, { id: deniedId, includeDeleted: true }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' })
    await expect(getRecord(deps, ctx, { id: approvalId, includeDeleted: true }))
      .rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    const read = await getRecord(deps, ctx, { id: visibleId, includeDeleted: true })
    expect(read.record.data).not.toHaveProperty('title')
    expect(read.record.redacted_attributes).toContain('title')
    const page = await queryRecords(deps, ctx, { objectType: 'person', recordState: 'deleted', includeTotal: true })
    expect(page.total).toBe(2)
    expect(new Set(page.records.map((record) => record.id))).toEqual(new Set([visibleId, grantedId]))
    expect(page.records.find((record) => record.id === visibleId)?.redacted_attributes).toEqual(['title'])
    expect((await queryRecords(deps, ctx, {
      objectType: 'person', recordState: 'deleted', filter: { attribute: 'title', op: 'eq', value: 'Sensitive title' },
    })).records.map((record) => record.id)).toEqual([grantedId])
    for (const other of [await fixture(), await fixture(tenant.organizationId)]) {
      await expect(getRecord(deps, context(other), { id: visibleId, includeDeleted: true }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect((await queryRecords(deps, context(other), { objectType: 'person', recordState: 'deleted' })).records)
        .toEqual([])
    }
  })

  it('filters, sorts, projects and paginates deleted records; rejects state/filter/scope/limit cursor reuse', async () => {
    const tenant = await fixture()
    const ctx = context(tenant)
    const ids = []
    for (const name of ['C deleted', 'A deleted', 'B deleted']) ids.push(await person(tenant, name, { deleted: true }))
    const activeId = await person(tenant, 'Active')
    const { erasedId, mergedId } = await unavailable(tenant, activeId)
    const input = {
      objectType: 'person', recordState: 'deleted' as const, limit: 1, includeTotal: true,
      sort: [{ system: 'display_name' as const, direction: 'asc' as const }], attributes: ['name'],
      filter: { system: 'display_name' as const, op: 'contains' as const, value: 'deleted' },
    }
    const first = await queryRecords(deps, ctx, input)
    expect(first.records.map((record) => record.id)).toEqual([ids[1]])
    expect(first.records[0]?.data).not.toHaveProperty('title')
    expect(first.total).toBe(3)
    expect(first.next_cursor).toEqual(expect.any(String))
    const cursor = first.next_cursor ?? ''
    const second = await queryRecords(deps, ctx, { ...input, cursor })
    expect(second.records.map((record) => record.id)).toEqual([ids[2]])
    const third = await queryRecords(deps, ctx, { ...input, cursor: second.next_cursor ?? '' })
    expect(third.records.map((record) => record.id)).toEqual([ids[0]])
    expect(third.next_cursor).toBeNull()
    for (const change of [{ recordState: 'active' as const }, { limit: 2 },
      { filter: { system: 'display_name' as const, op: 'eq' as const, value: 'A deleted' } }]) {
      await expect(queryRecords(deps, ctx, { ...input, ...change, cursor }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { detail: 'cursor_mismatch' } })
    }
    await expect(queryRecords(deps, context(await fixture()), { ...input, cursor }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(queryRecords(deps, ctx, { ...input, limit: 201 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const all = await queryRecords(deps, ctx, { objectType: 'person', recordState: 'deleted' })
    expect(new Set(all.records.map((record) => record.id))).toEqual(new Set(ids))
    await expect(getRecord(deps, ctx, { id: erasedId, includeDeleted: true })).rejects.toMatchObject({ code: 'ERASED' })
    expect((await getRecord(deps, ctx, { id: mergedId, includeDeleted: true })).record)
      .toMatchObject({ id: activeId, redirected_from: mergedId, deleted_at: null })
  })

  it('keeps agent grants and record approval gates on deleted reads', async () => {
    const tenant = await fixture()
    const ctx = context(tenant)
    const id = await person(tenant, 'Agent deleted', { deleted: true })
    const agent = { ...ctx, actor: { type: 'agent' as const, id: 'recovery_agent' } }
    await expect(getRecord(deps, agent, { id, includeDeleted: true }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' })
    await expect(queryRecords(deps, agent, { objectType: 'person', recordState: 'deleted' }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' })
    await db.policyRule.create({ data: {
      ...tenant, scope: 'team', scopeId: tenant.teamId, resourceType: 'record', action: 'view',
      effect: 'allow', priority: 100, createdById: 'deleted-reads-fixture',
      bindings: { create: [{ actorType: 'agent', actorId: 'agent:test:recovery_agent' }] },
    } })
    expect((await getRecord(deps, agent, { id, includeDeleted: true })).record.id).toBe(id)
    expect((await queryRecords(deps, agent, { objectType: 'person', recordState: 'deleted' })).records)
      .toEqual([expect.objectContaining({ id })])
    await viewRule(tenant, 'record', tenant.teamId, true, 'team')
    await expect(queryRecords(deps, ctx, { objectType: 'person', recordState: 'deleted' }))
      .rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
  })

  it('does not reactivate ended links on recovery reads; restore recovers them', async () => {
    const tenant = await fixture()
    const ctx = context(tenant)
    const company = await createRecord(deps, ctx, { objectType: 'company', data: { name: 'Employer' } })
    const { record } = await createRecord(deps, ctx, {
      objectType: 'person', data: { name: { full: 'Linked person' } },
      links: [{ relationType: 'person_works_at', toRecordId: company.record.id }],
    })
    await deleteRecord(deps, ctx, { recordId: record.id })
    expect((await getRecord(deps, ctx, { id: record.id, includeDeleted: true, includeLinks: true })).links).toEqual({})
    await restoreRecord(deps, ctx, { recordId: record.id })
    expect((await getRecord(deps, ctx, { id: record.id, includeLinks: true })).links?.['person_works_at'])
      .toEqual([expect.objectContaining({ related: expect.objectContaining({ id: company.record.id }) })])
  })
})
