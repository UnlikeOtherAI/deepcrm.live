import { createDb, dropTenant, seedTenant, writeAudit, type TenantRef } from '@deepcrm/db'
import { applyTemplate, createProjectionLinkWriter, loadSchema } from '@deepcrm/schema-engine'
import { parseSecretBox, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import {
  addListEntries,
  createList,
  getList,
  listEntries,
  removeListEntries,
} from '../../src/services/lists.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import { deleteView, getView, listViews, runView, saveView } from '../../src/services/views.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for list tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')
const key = Buffer.alloc(32, 31).toString('base64')
const secretBox = parseSecretBox(Buffer.from(JSON.stringify({
  active: 'lists-v1', keys: { 'lists-v1': key },
})).toString('base64'))
const deps: AppDeps = {
  db, clock: () => now, ids: () => crypto.randomUUID(), version: '0.0.0', maxBulkRows: 10_000,
  orgAllowlist: null, linkWriter: createProjectionLinkWriter(), secretBox,
  historyCursor: createHistoryCursorCodec(secretBox), queryCursor: createQueryCursorCodec(secretBox),
  writeAudit,
}

type Fixture = { tenant: TenantRef; ctx: ActorContext; people: string[]; company: string }

function tenantData(tenant: TenantRef): TenantRef {
  return { organizationId: tenant.organizationId, teamId: tenant.teamId }
}

function context(tenant: TenantRef): ActorContext {
  return {
    tenant, app: 'list-test', actChain: [], actor: { type: 'human', id: 'list-user' },
    onBehalfOf: { uoaUserId: 'list-user', role: 'member' },
    provenance: { runId: 'list-run', toolCallId: 'list-call', requestId: crypto.randomUUID() },
    requestId: crypto.randomUUID(), now,
  }
}

async function fixture(): Promise<Fixture> {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const ctx = context(tenant)
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'list-fixture', onBehalfOf: null, requestId: ctx.requestId,
  }, 'standard_crm'))
  const schema = await loadSchema(db, tenant)
  const person = schema.objectTypesBySlug.get('person')
  const companyType = schema.objectTypesBySlug.get('company')
  const relation = schema.relationTypesBySlug.get('person_works_at')
  if (person === undefined || companyType === undefined || relation === undefined) throw new Error('template missing')
  const company = await db.record.create({ data: {
    ...tenantData(tenant), objectTypeId: companyType.id, data: { name: 'List Company' }, displayName: 'List Company',
    visibility: 'team', createdOnBehalfOf: 'list-user', createdByType: 'human', createdById: 'list-user',
  } })
  const people = []
  for (let index = 0; index < 4; index += 1) {
    people.push(await db.record.create({ data: {
      ...tenantData(tenant), objectTypeId: person.id,
      data: { name: { given: `List${index}`, family: 'Person' } },
      displayName: `List${index} Person`, visibility: 'team', createdOnBehalfOf: 'list-user',
      createdByType: 'human', createdById: 'list-user',
    } }))
  }
  await db.recordLink.create({ data: {
    ...tenantData(tenant), relationTypeId: relation.id, fromRecordId: people[0]!.id, toRecordId: company.id,
    data: {}, activeFrom: now, createdByType: 'system', createdById: 'list-fixture',
  } })
  return { tenant, ctx, people: people.map((record) => record.id), company: company.id }
}

async function denyRecord(target: Fixture, recordId: string): Promise<void> {
  await db.policyRule.create({ data: {
    ...tenantData(target.tenant), scope: 'record', scopeId: recordId, resourceType: 'record', action: 'view',
    effect: 'deny', priority: 100, requiresApproval: false, createdById: 'list-fixture',
    bindings: { create: { actorType: 'human', actorId: 'list-user' } },
  } })
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { organizationId: { in: organizations } } })
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('list and view services', () => {
  it('validates priority data and prefilters hidden and policy-denied entries before paging/counting', async () => {
    const target = await fixture()
    const before = (await db.team.findUniqueOrThrow({ where: { id: target.tenant.teamId } })).schemaVersion
    const created = await createList(deps, target.ctx, {
      slug: 'target_people', name: 'Target people', objectType: 'person',
      attributes: [{
        slug: 'priority', name: 'Priority', description: 'Follow-up priority.', type: 'select',
        config: { options: [{ id: 'high', label: 'High' }, { id: 'low', label: 'Low' }] },
        is_multi: false, is_required: true, is_unique: false, is_indexed: false,
        sensitivity: 'internal',
      }],
    })
    expect(created).toMatchObject({ slug: 'target_people', entry_count: 0 })
    expect((await db.team.findUniqueOrThrow({ where: { id: target.tenant.teamId } })).schemaVersion)
      .toBe(before + 1)
    expect(await addListEntries(deps, target.ctx, {
      list: 'target_people', entries: target.people.slice(0, 3).map((recordId) => ({
        recordId, data: { priority: 'high' },
      })),
    })).toEqual({ added: 3 })
    await db.record.update({
      where: { id: target.people[1]! },
      data: { visibility: 'private', createdOnBehalfOf: 'different-user' },
    })
    await denyRecord(target, target.people[2]!)
    expect((await getList(deps, target.ctx, 'target_people')).entry_count).toBe(1)
    const page = await listEntries(deps, target.ctx, { list: 'target_people', limit: 1 })
    expect(page.next_cursor).toBeNull()
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]).toMatchObject({
      entry: { data: { priority: 'high' }, position: 0 },
      record: { id: target.people[0], data: { company: target.company } },
    })
    await denyRecord(target, target.people[3]!)
    await expect(addListEntries(deps, target.ctx, {
      list: 'target_people', entries: [{ recordId: target.people[3]!, data: { priority: 'low' } }],
    })).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    expect(await removeListEntries(deps, target.ctx, 'target_people', [target.people[0]!]))
      .toEqual({ removed: 1 })
    expect((await listEntries(deps, target.ctx, { list: 'target_people' })).entries).toEqual([])
  })

  it('versions exact saved queries, runs and lists them, blocks denied target moves, then deletes', async () => {
    const target = await fixture()
    const before = (await db.team.findUniqueOrThrow({ where: { id: target.tenant.teamId } })).schemaVersion
    const input = {
      slug: 'list_people', name: 'List people', objectType: 'person',
      filter: { system: 'display_name' as const, op: 'starts_with' as const, value: 'List' },
      attributes: ['name', 'company'],
    }
    const saved = await saveView(deps, target.ctx, input)
    const savedVersion = (await db.team.findUniqueOrThrow({ where: { id: target.tenant.teamId } })).schemaVersion
    expect(savedVersion).toBe(before + 1)
    expect(await saveView(deps, target.ctx, input)).toEqual(saved)
    expect((await db.team.findUniqueOrThrow({ where: { id: target.tenant.teamId } })).schemaVersion)
      .toBe(savedVersion)
    expect(await listViews(deps, target.ctx)).toContainEqual({
      slug: 'list_people', name: 'List people', object_type: 'person',
    })
    const result = await runView(deps, target.ctx, 'list_people', undefined, 2)
    expect(result.records).toHaveLength(2)
    expect(result.records[0]?.data).toHaveProperty('name')
    expect(result.next_cursor).not.toBeNull()
    await expect(runView(deps, target.ctx, 'list_people', result.next_cursor ?? undefined, 3))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const company = (await loadSchema(db, target.tenant)).objectTypesBySlug.get('company')
    if (company === undefined) throw new Error('company missing')
    await db.policyRule.create({ data: {
      ...tenantData(target.tenant), scope: 'object_type', scopeId: company.id,
      resourceType: 'view', action: 'edit', effect: 'deny', priority: 100,
      requiresApproval: false, createdById: 'list-fixture',
      bindings: { create: { actorType: 'human', actorId: 'list-user' } },
    } })
    await expect(saveView(deps, target.ctx, { ...input, objectType: 'company', attributes: ['name'] }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' })
    expect((await getView(deps, target.ctx, 'list_people')).object_type).toBe('person')
    expect(await deleteView(deps, target.ctx, 'list_people')).toEqual({ deleted: true })
    await expect(getView(deps, target.ctx, 'list_people')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await db.team.findUniqueOrThrow({ where: { id: target.tenant.teamId } })).schemaVersion)
      .toBe(savedVersion + 1)
  })
})
