import { Prisma, createDb, dropTenant, seedTenant, type TenantRef } from '@deepcrm/db'
import type { ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import { applyTemplate } from '../../src/templates/apply.js'
import { attributeReadAccess, canSee, rowAccess } from '../../src/records/visibility.js'
import { loadSchema, type LoadedObjectType } from '../../src/schema/load.js'

const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(url)
const organizations: string[] = []

async function fixture() {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  const ctx: ActorContext = {
    tenant, app: 'test', actor: { type: 'system', id: 'query-access' },
    onBehalfOf: { uoaUserId: 'owner', role: 'owner' }, provenance: null,
    actChain: [], requestId: crypto.randomUUID(), now: new Date(),
  }
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'query-access', onBehalfOf: null, requestId: ctx.requestId,
  }, 'standard_crm'))
  const schema = await loadSchema(db, tenant)
  const objectType = schema.objectTypesBySlug.get('company')
  if (objectType === undefined) throw new Error('company missing')
  return { tenant, ctx, schema, objectType }
}

async function addRecord(
  tenant: TenantRef,
  objectTypeId: string,
  name: string,
  visibility: 'team' | 'users' | 'private' = 'team',
  createdOnBehalfOf = 'owner',
) {
  return db.record.create({
    data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      objectTypeId,
      data: { name },
      displayName: name,
      visibility,
      createdOnBehalfOf,
      createdByType: 'system',
      createdById: 'test',
    },
  })
}

async function bindRule(input: {
  tenant: TenantRef
  scope: 'record' | 'object_type' | 'team'
  scopeId: string
  actorType: 'human' | 'role' | 'agent'
  actorId: string
  effect: 'allow' | 'deny'
  priority?: number
  requiresApproval?: boolean
}) {
  return db.policyRule.create({
    data: {
      organizationId: input.tenant.organizationId,
      teamId: input.tenant.teamId,
      scope: input.scope,
      scopeId: input.scopeId,
      resourceType: 'record',
      action: 'view',
      effect: input.effect,
      priority: input.priority ?? 0,
      requiresApproval: input.requiresApproval ?? false,
      createdById: 'test',
      bindings: { create: { actorType: input.actorType, actorId: input.actorId } },
    },
  })
}

async function visibleIds(
  tenant: TenantRef,
  ctx: ActorContext,
  objectType: LoadedObjectType,
) {
  const predicate = rowAccess(tenant, ctx, objectType)
  const sql = Prisma.sql`SELECT r.id FROM records r WHERE ${predicate} ORDER BY r.id`
  const countSql = Prisma.sql`SELECT COUNT(*)::integer AS total FROM records r WHERE ${predicate}`
  const [page, count] = await Promise.all([
    db.$queryRaw<Array<{ id: string }>>(sql),
    db.$queryRaw<Array<{ total: number }>>(countSql),
  ])
  expect(count[0]?.total).toBe(page.length)
  return page.map((row) => row.id)
}

afterAll(async () => { await Promise.all(organizations.map(dropTenant.bind(null, db))); await db.$disconnect() })

describe('query row access', () => {
  it('evaluates the shared in-memory visibility gate', () => {
    const ctx: ActorContext = {
      tenant: { organizationId: crypto.randomUUID(), teamId: crypto.randomUUID() },
      app: 'test',
      actor: { type: 'system', id: 'query-access' },
      onBehalfOf: { uoaUserId: 'owner', role: 'owner' },
      provenance: null,
      actChain: [],
      requestId: crypto.randomUUID(),
      now: new Date(),
    }
    expect(canSee(ctx, { visibility: 'team', createdOnBehalfOf: 'other', visibilityGrants: [] })).toBe(true)
    expect(canSee(ctx, { visibility: 'private', createdOnBehalfOf: 'owner', visibilityGrants: [] })).toBe(true)
    expect(canSee(ctx, { visibility: 'private', createdOnBehalfOf: 'other', visibilityGrants: [] })).toBe(false)
    expect(canSee(ctx, {
      visibility: 'users',
      createdOnBehalfOf: 'other',
      visibilityGrants: [{ uoaUserId: 'owner' }],
    })).toBe(true)
    expect(canSee(ctx, {
      visibility: 'users',
      createdOnBehalfOf: 'other',
      visibilityGrants: [{ uoaUserId: 'another-user' }],
    })).toBe(false)
  })

  it('uses identical tenant/visibility predicates for page and count', async () => {
    const value = await fixture()
    const scope = { organizationId: value.tenant.organizationId, teamId: value.tenant.teamId }
    await db.record.createMany({ data: [
      { ...scope, objectTypeId: value.objectType.id, data: { name: 'team' }, displayName: 'team', visibility: 'team', createdOnBehalfOf: 'other', createdByType: 'system', createdById: 'test' },
      { ...scope, objectTypeId: value.objectType.id, data: { name: 'private' }, displayName: 'private', visibility: 'private', createdOnBehalfOf: 'other', createdByType: 'system', createdById: 'test' },
    ] })
    const predicate = rowAccess(value.tenant, value.ctx, value.objectType)
    const sql = Prisma.sql`SELECT r.id FROM records r WHERE ${predicate}`
    const countSql = Prisma.sql`SELECT COUNT(*)::integer AS total FROM records r WHERE ${predicate}`
    const [page, count] = await Promise.all([
      db.$queryRaw<Array<{ id: string }>>(sql),
      db.$queryRaw<Array<{ total: number }>>(countSql),
    ])
    expect(page).toHaveLength(1)
    expect(count[0]?.total).toBe(1)
  })

  it('enforces private/users grants and tenant isolation before policy', async () => {
    const value = await fixture()
    const team = await addRecord(value.tenant, value.objectType.id, 'team')
    const privateRecord = await addRecord(value.tenant, value.objectType.id, 'private', 'private', 'other')
    const users = await addRecord(value.tenant, value.objectType.id, 'users', 'users', 'other')
    await db.recordVisibilityGrant.create({ data: { recordId: users.id, uoaUserId: 'owner' } })
    const other = await fixture()
    await addRecord(other.tenant, other.objectType.id, 'other-team')
    await expect(visibleIds(value.tenant, value.ctx, value.objectType)).resolves.toEqual([team.id, users.id].sort())
    expect(privateRecord.id).toBeTruthy()
  })

  it('applies record, object, and team denies as absolute', async () => {
    const recordScope = await fixture()
    const record = await addRecord(recordScope.tenant, recordScope.objectType.id, 'record')
    await bindRule({ tenant: recordScope.tenant, scope: 'record', scopeId: record.id, actorType: 'human', actorId: 'owner', effect: 'deny', priority: -10 })
    await expect(visibleIds(recordScope.tenant, recordScope.ctx, recordScope.objectType)).resolves.toEqual([])

    const objectScope = await fixture()
    await addRecord(objectScope.tenant, objectScope.objectType.id, 'object')
    await bindRule({ tenant: objectScope.tenant, scope: 'object_type', scopeId: objectScope.objectType.id, actorType: 'role', actorId: 'owner', effect: 'deny' })
    await expect(visibleIds(objectScope.tenant, objectScope.ctx, objectScope.objectType)).resolves.toEqual([])

    const teamScope = await fixture()
    await addRecord(teamScope.tenant, teamScope.objectType.id, 'team')
    await bindRule({ tenant: teamScope.tenant, scope: 'team', scopeId: teamScope.tenant.teamId, actorType: 'human', actorId: 'owner', effect: 'deny' })
    await expect(visibleIds(teamScope.tenant, teamScope.ctx, teamScope.objectType)).resolves.toEqual([])
  })

  it('uses highest priority allow, tied approval exclusion, and hard deny precedence', async () => {
    const value = await fixture()
    const record = await addRecord(value.tenant, value.objectType.id, 'priority')
    const base = { tenant: value.tenant, scope: 'record' as const, scopeId: record.id, actorType: 'human' as const, actorId: 'owner' }
    await bindRule({ ...base, effect: 'allow', priority: 1 })
    await bindRule({ ...base, effect: 'allow', priority: 2 })
    await expect(visibleIds(value.tenant, value.ctx, value.objectType)).resolves.toEqual([record.id])
    await bindRule({ ...base, effect: 'allow', priority: 2, requiresApproval: true })
    await expect(visibleIds(value.tenant, value.ctx, value.objectType)).resolves.toEqual([])
    await bindRule({ ...base, effect: 'deny', priority: -100 })
    await expect(visibleIds(value.tenant, value.ctx, value.objectType)).resolves.toEqual([])
  })

  it('requires both human and agent channels for agents', async () => {
    const value = await fixture()
    const record = await addRecord(value.tenant, value.objectType.id, 'agent')
    const agentCtx: ActorContext = {
      ...value.ctx,
      actor: { type: 'agent', id: 'worker' },
      requestId: crypto.randomUUID(),
    }
    await expect(visibleIds(value.tenant, agentCtx, value.objectType)).resolves.toEqual([])
    await bindRule({ tenant: value.tenant, scope: 'record', scopeId: record.id, actorType: 'agent', actorId: 'agent:test:worker', effect: 'allow' })
    await expect(visibleIds(value.tenant, agentCtx, value.objectType)).resolves.toEqual([])
    await bindRule({ tenant: value.tenant, scope: 'record', scopeId: record.id, actorType: 'human', actorId: 'owner', effect: 'allow' })
    await expect(visibleIds(value.tenant, agentCtx, value.objectType)).resolves.toEqual([record.id])
  })

  it('excludes a row with a record-scoped attribute-view deny from filter membership and count', async () => {
    const value = await fixture()
    const allowed = await addRecord(value.tenant, value.objectType.id, 'allowed')
    const denied = await addRecord(value.tenant, value.objectType.id, 'denied')
    const attribute = value.objectType.attributes.find((candidate) => candidate.slug === 'name')
    if (attribute === undefined) throw new Error('name attribute missing')
    await db.policyRule.create({
      data: {
        organizationId: value.tenant.organizationId,
        teamId: value.tenant.teamId,
        scope: 'record',
        scopeId: denied.id,
        resourceType: 'attribute',
        action: 'view',
        effect: 'deny',
        priority: 1,
        conditions: { sensitivity: attribute.sensitivity },
        createdById: 'test',
        bindings: { create: { actorType: 'human', actorId: 'owner' } },
      },
    })
    const predicate = Prisma.sql`${rowAccess(value.tenant, value.ctx, value.objectType)}${attributeReadAccess(
      value.tenant,
      value.ctx,
      value.objectType,
      [attribute],
    )}`
    const sql = Prisma.sql`SELECT r.id FROM records r WHERE ${predicate} ORDER BY r.id`
    const countSql = Prisma.sql`SELECT COUNT(*)::integer AS total FROM records r WHERE ${predicate}`
    const [page, count] = await Promise.all([
      db.$queryRaw<Array<{ id: string }>>(sql),
      db.$queryRaw<Array<{ total: number }>>(countSql),
    ])
    expect(page.map((row) => row.id)).toEqual([allowed.id])
    expect(count[0]?.total).toBe(1)
  }, 15_000)
})
