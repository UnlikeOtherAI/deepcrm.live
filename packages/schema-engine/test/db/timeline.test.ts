import {
  createDb,
  dropTenant,
  seedTenant,
  type TenantRef,
} from '@deepcrm/db'
import { ErrorCode, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import {
  applyTemplate,
  loadSchema,
  recordChangesByIds,
  timeline,
  type LoadedObjectType,
  type LoadedRelationType,
  type LoadedSchema,
  type TimelineSystemKind,
} from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for timeline tests')
const db = createDb(databaseUrl)
const organizations: string[] = []

type Fixture = Readonly<{
  tenant: TenantRef
  ctx: ActorContext
  schema: LoadedSchema
}>

type RecordOptions = Readonly<{
  data?: Record<string, string>
  visibility?: 'team' | 'users' | 'private'
  createdOnBehalfOf?: string
  createdAt?: Date
}>

function context(tenant: TenantRef): ActorContext {
  return {
    tenant,
    app: 'test',
    actor: { type: 'system', id: 'timeline-test' },
    onBehalfOf: { uoaUserId: 'timeline-owner', role: 'owner' },
    provenance: null,
    actChain: [],
    requestId: crypto.randomUUID(),
    now: new Date('2026-08-24T12:00:00.000Z'),
  }
}

async function fixture(): Promise<Fixture> {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const ctx = context(tenant)
  const actor: Parameters<typeof applyTemplate>[2] = {
    type: 'system',
    id: 'timeline-test',
    onBehalfOf: null,
    requestId: ctx.requestId,
  }
  await db.$transaction(async (tx) => {
    await applyTemplate(tx, tenant, actor, 'system')
    await applyTemplate(tx, tenant, actor, 'standard_crm')
  })
  return { tenant, ctx, schema: await loadSchema(db, tenant) }
}

function objectType(schema: LoadedSchema, slug: string): LoadedObjectType {
  const value = schema.objectTypesBySlug.get(slug)
  if (value === undefined) throw new Error(`Missing object type ${slug}`)
  return value
}

function relation(schema: LoadedSchema, slug: string): LoadedRelationType {
  const value = schema.relationTypesBySlug.get(slug)
  if (value === undefined) throw new Error(`Missing relation ${slug}`)
  return value
}

async function addRecord(
  value: Fixture,
  objectSlug: string,
  displayName: string,
  options: RecordOptions = {},
) {
  return db.record.create({ data: {
    organizationId: value.tenant.organizationId,
    teamId: value.tenant.teamId,
    objectTypeId: objectType(value.schema, objectSlug).id,
    data: options.data ?? {},
    displayName,
    visibility: options.visibility ?? 'team',
    createdOnBehalfOf: options.createdOnBehalfOf ?? 'timeline-owner',
    createdByType: 'system',
    createdById: 'timeline-test',
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
  } })
}

async function addLink(
  value: Fixture,
  relationSlug: string,
  fromRecordId: string,
  toRecordId: string,
) {
  return db.recordLink.create({ data: {
    organizationId: value.tenant.organizationId,
    teamId: value.tenant.teamId,
    relationTypeId: relation(value.schema, relationSlug).id,
    fromRecordId,
    toRecordId,
    data: {},
    createdByType: 'system',
    createdById: 'timeline-test',
  } })
}

async function addSystemItem(
  value: Fixture,
  kind: TimelineSystemKind,
  about: readonly string[],
  occurredAt: Date,
  options: Pick<RecordOptions, 'visibility' | 'createdOnBehalfOf'> = {},
) {
  let data: Record<string, string>
  switch (kind) {
    case 'activity': data = { kind: 'call', occurred_at: occurredAt.toISOString() }; break
    case 'note': data = { body: `${kind} body` }; break
    case 'task': data = { title: `${kind} title`, status: 'open' }; break
  }
  const record = await addRecord(value, kind, `${kind}-${crypto.randomUUID()}`, {
    ...options, data, createdAt: occurredAt,
  })
  await Promise.all(about.map((target) => addLink(value, `${kind}_about`, record.id, target)))
  return record
}

async function addChange(
  value: Fixture,
  recordId: string,
  occurredAt: Date,
  seq: bigint,
  attributeSlug = 'name',
) {
  return db.recordChange.create({ data: {
    organizationId: value.tenant.organizationId,
    teamId: value.tenant.teamId,
    recordId,
    kind: 'set',
    attributeSlug,
    oldValue: `old-${seq}`,
    newValue: `new-${seq}`,
    actorType: 'system',
    actorId: 'timeline-test',
    requestId: crypto.randomUUID(),
    resultingVersion: Number(seq),
    seq,
    occurredAt,
  } })
}

async function denyRecord(value: Fixture, recordId: string): Promise<void> {
  await db.policyRule.create({ data: {
    organizationId: value.tenant.organizationId,
    teamId: value.tenant.teamId,
    scope: 'record',
    scopeId: recordId,
    resourceType: 'record',
    action: 'view',
    effect: 'deny',
    priority: 100,
    requiresApproval: false,
    createdById: 'timeline-test',
    bindings: { create: { actorType: 'human', actorId: 'timeline-owner' } },
  } })
}

afterAll(async () => {
  await Promise.all(organizations.map((organizationId) => dropTenant(db, organizationId)))
  await db.$disconnect()
})

describe('timeline engine', () => {
  it('expands one active hop in both directions and applies relation, kind, and since filters', async () => {
    const value = await fixture()
    const company = await addRecord(value, 'company', 'Timeline Company')
    const person = await addRecord(value, 'person', 'Timeline Person')
    await addLink(value, 'person_works_at', person.id, company.id)
    const endedPerson = await addRecord(value, 'person', 'Ended Person')
    const endedLink = await addLink(value, 'person_works_at', endedPerson.id, company.id)
    await db.recordLink.update({ where: { id: endedLink.id }, data: { activeUntil: value.ctx.now } })
    const taskAt = new Date('2026-08-24T09:00:00.000Z')
    const noteAt = new Date('2026-08-24T10:00:00.000Z')
    const activityAt = new Date('2026-08-24T11:00:00.000Z')
    const changeAt = new Date('2026-08-24T12:00:00.000Z')
    const activity = await addSystemItem(value, 'activity', [person.id], activityAt)
    await addSystemItem(value, 'activity', [endedPerson.id], activityAt)
    await addSystemItem(value, 'note', [company.id], noteAt)
    await addSystemItem(value, 'task', [company.id], taskAt)
    await addChange(value, company.id, changeAt, 1n)

    const direct = await timeline(db, value.tenant, value.ctx, value.schema, company.id, { hops: 0 })
    expect(direct.items.map((item) => item.kind)).toEqual(['change', 'note', 'task'])

    const expanded = await timeline(db, value.tenant, value.ctx, value.schema, company.id, {
      hops: 1, relationTypes: ['person_works_at'], kinds: ['activity'],
    })
    expect(expanded.items).toEqual([{
      kind: 'activity', recordId: activity.id, aboutRecordIds: [person.id],
      occurredAt: activityAt.toISOString(),
    }])

    const forward = await timeline(db, value.tenant, value.ctx, value.schema, person.id, {
      hops: 1, relationTypes: ['person_works_at'], kinds: ['note'],
    })
    expect(forward.items.map((item) => item.kind)).toEqual(['note'])

    const unrelated = await timeline(db, value.tenant, value.ctx, value.schema, company.id, {
      hops: 1, relationTypes: ['deal_for_company'], kinds: ['activity'],
    })
    expect(unrelated.items).toEqual([])

    const since = await timeline(db, value.tenant, value.ctx, value.schema, company.id, {
      hops: 1, since: noteAt,
    })
    expect(since.items.map((item) => item.kind)).toEqual(['change', 'activity', 'note'])
  })

  it('filters hidden and denied neighbors, system items, and about summaries before limiting', async () => {
    const value = await fixture()
    const company = await addRecord(value, 'company', 'Secure Company')
    const hiddenNeighbor = await addRecord(value, 'person', 'Hidden Neighbor', {
      visibility: 'private', createdOnBehalfOf: 'someone-else',
    })
    const deniedNeighbor = await addRecord(value, 'person', 'Denied Neighbor')
    const hiddenAbout = await addRecord(value, 'person', 'Hidden About', {
      visibility: 'private', createdOnBehalfOf: 'someone-else',
    })
    await addLink(value, 'person_works_at', hiddenNeighbor.id, company.id)
    await addLink(value, 'person_works_at', deniedNeighbor.id, company.id)
    await denyRecord(value, deniedNeighbor.id)
    await addSystemItem(value, 'activity', [hiddenNeighbor.id], new Date('2026-08-24T13:00:00.000Z'))
    await addSystemItem(value, 'activity', [deniedNeighbor.id], new Date('2026-08-24T12:00:00.000Z'))
    const hiddenItem = await addSystemItem(value, 'activity', [company.id], new Date('2026-08-24T11:00:00.000Z'), {
      visibility: 'private', createdOnBehalfOf: 'someone-else',
    })
    const deniedItem = await addSystemItem(value, 'activity', [company.id], new Date('2026-08-24T10:00:00.000Z'))
    await denyRecord(value, deniedItem.id)
    const visibleItem = await addSystemItem(
      value, 'activity', [company.id, hiddenAbout.id], new Date('2026-08-24T09:00:00.000Z'),
    )

    const page = await timeline(db, value.tenant, value.ctx, value.schema, company.id, {
      hops: 1, kinds: ['activity'], limit: 1,
    })
    expect(page).toEqual({
      items: [{
        kind: 'activity', recordId: visibleItem.id, aboutRecordIds: [company.id],
        occurredAt: '2026-08-24T09:00:00.000Z',
      }],
      next: null,
    })
    expect(hiddenItem.id).not.toBe(visibleItem.id)
  })

  it('uses stable mixed-kind tie ordering and exact keyset pagination', async () => {
    const value = await fixture()
    const company = await addRecord(value, 'company', 'Paged Company')
    const tie = new Date('2026-08-24T15:00:00.000Z')
    const tiedActivities = await Promise.all([
      addSystemItem(value, 'activity', [company.id], tie),
      addSystemItem(value, 'activity', [company.id], tie),
      addSystemItem(value, 'note', [company.id], tie),
      addSystemItem(value, 'task', [company.id], tie),
    ])
    await addChange(value, company.id, tie, 1n)

    const first = await timeline(db, value.tenant, value.ctx, value.schema, company.id, { limit: 2 })
    expect(first.items.map((item) => item.kind)).toEqual(['activity', 'activity'])
    expect(first.items.map((item) => item.kind === 'change' ? item.changeId : item.recordId))
      .toEqual(tiedActivities.slice(0, 2).map((item) => item.id).sort().reverse())
    expect(first.next).not.toBeNull()
    const second = await timeline(db, value.tenant, value.ctx, value.schema, company.id, {
      limit: 2, after: first.next ?? undefined,
    })
    expect(second.items.map((item) => item.kind)).toEqual(['change', 'note'])
    expect(second.next).not.toBeNull()
    const third = await timeline(db, value.tenant, value.ctx, value.schema, company.id, {
      limit: 2, after: second.next ?? undefined,
    })
    expect(third.items.map((item) => item.kind)).toEqual(['task'])
    expect(third.next).toBeNull()
    const ids = [...first.items, ...second.items, ...third.items].map((item) => (
      item.kind === 'change' ? item.changeId : item.recordId
    ))
    expect(new Set(ids).size).toBe(5)
  })

  it('excludes deleted, merged, erased, and cross-tenant records and batches redacted changes', async () => {
    const value = await fixture()
    const company = await addRecord(value, 'company', 'Lifecycle Company')
    const timestamp = new Date('2026-08-24T16:00:00.000Z')
    const deleted = await addSystemItem(value, 'activity', [company.id], timestamp)
    const merged = await addSystemItem(value, 'activity', [company.id], timestamp)
    const erased = await addSystemItem(value, 'activity', [company.id], timestamp)
    await db.record.update({ where: { id: deleted.id }, data: { deletedAt: timestamp } })
    await db.record.update({ where: { id: merged.id }, data: { mergedIntoId: company.id } })
    await db.record.update({ where: { id: erased.id }, data: { erasedAt: timestamp } })
    expect((await timeline(db, value.tenant, value.ctx, value.schema, company.id, {
      kinds: ['activity'],
    })).items).toEqual([])

    const first = await addChange(value, company.id, timestamp, 1n)
    const second = await addChange(value, company.id, new Date(timestamp.getTime() + 1), 2n)
    const changes = await recordChangesByIds(db, value.tenant, {
      recordId: company.id,
      ids: [second.id, first.id],
      visibleAttributeSlugs: new Set(),
    })
    expect(changes.map((change) => change.id)).toEqual([second.id, first.id])
    expect(changes.every((change) => (
      !Object.hasOwn(change, 'old_value') && !Object.hasOwn(change, 'new_value')
    ))).toBe(true)

    const other = await fixture()
    await expect(timeline(db, other.tenant, other.ctx, other.schema, company.id, {}))
      .rejects.toMatchObject({ code: ErrorCode.NOT_FOUND })
    const mergedAnchor = await addRecord(value, 'company', 'Merged Anchor')
    await db.record.update({ where: { id: mergedAnchor.id }, data: { mergedIntoId: company.id } })
    await expect(timeline(db, value.tenant, value.ctx, value.schema, mergedAnchor.id, {}))
      .rejects.toMatchObject({ code: ErrorCode.NOT_FOUND })
    await db.record.update({ where: { id: company.id }, data: { deletedAt: timestamp } })
    await expect(timeline(db, value.tenant, value.ctx, value.schema, company.id, {}))
      .rejects.toMatchObject({ code: ErrorCode.NOT_FOUND })
  })
})
