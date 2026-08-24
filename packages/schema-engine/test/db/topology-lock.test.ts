import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import { ErrorCode, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import {
  applyTemplate,
  createProjectionLinkWriter,
  createRecord,
  defineRelationType,
  deleteRecord,
  linkRecords,
  loadSchema,
  lockLinkTopology,
  updateRecord,
} from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(databaseUrl)
const organizations: string[] = []

type Deferred = { promise: Promise<void>; release(): void }

function deferred(): Deferred {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return {
    promise,
    release() {
      if (resolve === undefined) throw new Error('Deferred is already released')
      resolve()
      resolve = undefined
    },
  }
}

function context(tenant: { organizationId: string; teamId: string }): ActorContext {
  return {
    tenant,
    app: 'test',
    actor: { type: 'system', id: 'topology-test' },
    onBehalfOf: { uoaUserId: 'uoa-topology', role: 'owner' },
    provenance: null,
    actChain: [],
    requestId: crypto.randomUUID(),
    now: new Date(),
  }
}

async function settles<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Topology operation timed out')), 5_000)
  })
  try {
    return await Promise.race([operation, timer])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function setup() {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const ctx = context(tenant)
  await db.$transaction((tx) => applyTemplate(
    tx,
    tenant,
    { type: 'system', id: 'topology-test', onBehalfOf: null, requestId: ctx.requestId },
    'standard_crm',
  ))
  return { tenant, ctx, schema: await loadSchema(db, tenant), links: createProjectionLinkWriter() }
}

async function company(
  ctx: ActorContext,
  schema: Awaited<ReturnType<typeof loadSchema>>,
  links: ReturnType<typeof createProjectionLinkWriter>,
  name: string,
) {
  return db.$transaction((tx) => createRecord(
    tx,
    ctx,
    schema,
    { objectType: 'company', data: { name } },
    links,
  ))
}

async function cascadeSchema(
  tenant: { organizationId: string; teamId: string },
  ctx: ActorContext,
) {
  await db.$transaction((tx) => defineRelationType(
    tx,
    tenant,
    { type: ctx.actor.type, id: ctx.actor.id, onBehalfOf: null, requestId: ctx.requestId },
    {
      slug: 'topology_cascade',
      fromObjectType: null,
      toObjectType: null,
      forwardName: 'depends on',
      inverseName: 'needed by',
      cardinality: 'many_to_many',
      onDelete: 'cascade',
    },
  ))
  await db.team.update({ where: { id: tenant.teamId }, data: { schemaVersion: { increment: 1 } } })
  return loadSchema(db, tenant)
}

afterAll(async () => {
  await Promise.all(organizations.map((organizationId) => dropTenant(db, organizationId)))
  await db.$disconnect()
})

describe('team link-topology lock', () => {
  it('serializes a projection record write and direct link on one source without deadlock', async () => {
    const { tenant, ctx, schema, links } = await setup()
    const [one, two] = await Promise.all([
      company(ctx, schema, links, 'one'),
      company(ctx, schema, links, 'two'),
    ])
    const person = await db.$transaction((tx) => createRecord(
      tx,
      ctx,
      schema,
      { objectType: 'person', data: { name: { full: 'Ada' } } },
      links,
    ))
    await settles(Promise.all([
      db.$transaction((tx) => updateRecord(
        tx,
        ctx,
        schema,
        { recordId: person.record.id, data: { company: one.record.id } },
        links,
      )),
      db.$transaction((tx) => linkRecords(tx, ctx, schema, {
        relationType: 'person_works_at', fromRecordId: person.record.id, toRecordId: two.record.id,
      })),
    ]))
    expect(await db.recordLink.count({ where: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      fromRecordId: person.record.id,
      activeUntil: null,
    } })).toBe(1)
  })

  it('serializes a candidate link before deletion, so its cascade is complete', async () => {
    const { tenant, ctx, links } = await setup()
    const schema = await cascadeSchema(tenant, ctx)
    const root = await company(ctx, schema, links, 'root')
    const dependent = await company(ctx, schema, links, 'dependent')
    const locked = deferred()
    const release = deferred()
    const linking = db.$transaction(async (tx) => {
      await lockLinkTopology(tx, tenant.teamId)
      locked.release()
      await release.promise
      return linkRecords(tx, ctx, schema, {
        relationType: 'topology_cascade',
        fromRecordId: dependent.record.id,
        toRecordId: root.record.id,
      })
    })
    await locked.promise
    const deleting = db.$transaction((tx) => deleteRecord(
      tx, ctx, schema, root.record.id, undefined, links,
    ))
    release.release()
    await settles(Promise.all([linking, deleting]))
    expect(await db.record.findUniqueOrThrow({
      where: { id: dependent.record.id }, select: { deletedAt: true },
    })).toMatchObject({ deletedAt: expect.any(Date) })
    expect(await db.recordLink.count({ where: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      fromRecordId: dependent.record.id,
      toRecordId: root.record.id,
      activeUntil: null,
    } })).toBe(0)
  })

  it('settles overlapping cascade deletions without deadlock', async () => {
    const { tenant, ctx, links } = await setup()
    const schema = await cascadeSchema(tenant, ctx)
    const [left, right, shared] = await Promise.all([
      company(ctx, schema, links, 'left'),
      company(ctx, schema, links, 'right'),
      company(ctx, schema, links, 'shared'),
    ])
    await Promise.all([
      db.$transaction((tx) => linkRecords(tx, ctx, schema, {
        relationType: 'topology_cascade', fromRecordId: shared.record.id, toRecordId: left.record.id,
      })),
      db.$transaction((tx) => linkRecords(tx, ctx, schema, {
        relationType: 'topology_cascade', fromRecordId: shared.record.id, toRecordId: right.record.id,
      })),
    ])
    const outcome = await settles(Promise.allSettled([
      db.$transaction((tx) => deleteRecord(tx, ctx, schema, left.record.id, undefined, links)),
      db.$transaction((tx) => deleteRecord(tx, ctx, schema, right.record.id, undefined, links)),
    ]))
    expect(outcome).toHaveLength(2)
    expect(outcome.every((item) => item.status === 'fulfilled')).toBe(true)
  })

  it('does not block another team behind a held topology lock', async () => {
    const first = await setup()
    const second = await setup()
    const locked = deferred()
    const release = deferred()
    const holder = db.$transaction(async (tx) => {
      await lockLinkTopology(tx, first.tenant.teamId)
      locked.release()
      await release.promise
    })
    await locked.promise
    await settles(company(second.ctx, second.schema, second.links, 'independent'))
    release.release()
    await holder
  })

  it('rejects an active M:N projection-position restore conflict atomically', async () => {
    const { tenant, ctx, schema, links } = await setup()
    await Promise.all([
      company(ctx, schema, links, 'one'),
      company(ctx, schema, links, 'two'),
    ])
    const deal = await db.$transaction((tx) => createRecord(
      tx,
      ctx,
      schema,
      { objectType: 'deal', data: { name: 'Opportunity', contacts: [] } },
      links,
    ))
    const people = await Promise.all(['Ada', 'Bea'].map((full) => db.$transaction((tx) => createRecord(
      tx,
      ctx,
      schema,
      { objectType: 'person', data: { name: { full } } },
      links,
    ))))
    const [first, second] = people
    if (first === undefined || second === undefined) throw new Error('Fixture records are missing')
    const relation = schema.relationTypesBySlug.get('deal_contacts')
    if (relation === undefined) throw new Error('deal_contacts is missing')
    const ended = await db.recordLink.create({ data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      relationTypeId: relation.id,
      fromRecordId: deal.record.id,
      toRecordId: first.record.id,
      data: {},
      position: 0,
      activeUntil: new Date(),
      createdByType: ctx.actor.type,
      createdById: ctx.actor.id,
    } })
    await db.recordLink.create({ data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      relationTypeId: relation.id,
      fromRecordId: deal.record.id,
      toRecordId: second.record.id,
      data: {},
      position: 0,
      createdByType: ctx.actor.type,
      createdById: ctx.actor.id,
    } })
    const before = await db.recordLink.findMany({ where: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      id: { in: [ended.id] },
    } })
    await expect(db.$transaction((tx) => links.restore(tx, ctx, schema, deal.record.id, {
      links: [{
        id: ended.id,
        relation_type_id: relation.id,
        from_record_id: deal.record.id,
        to_record_id: first.record.id,
        data: {},
        position: 0,
        label: null,
      }],
      cascaded: [],
    }))).rejects.toMatchObject({ code: ErrorCode.RESTORE_CONFLICT })
    expect(await db.recordLink.findMany({ where: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      id: { in: [ended.id] },
    } })).toEqual(before)
  })
})
