import { Prisma, createDb, dropTenant, seedTenant, type TenantRef } from '@deepcrm/db'
import type { ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import { applyTemplate } from '../../src/templates/apply.js'
import { attributeReadAccess, rowAccess } from '../../src/records/visibility.js'
import { loadSchema } from '../../src/schema/load.js'

// The SQL gate decides an agent from its exact binding or its app's wildcard,
// with the human channel falling back as a human's does (api policy.ts
// evaluatePolicy; the two are compared row for row in api/test/db/policy-evaluators.test.ts).

const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(url)
const organizations: string[] = []

async function fixture() {
  const seeded = await seedTenant(db)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  organizations.push(tenant.organizationId)
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'visibility-policy', onBehalfOf: null, requestId: crypto.randomUUID(),
  }, 'standard_crm'))
  const company = (await loadSchema(db, tenant)).objectTypesBySlug.get('company')
  if (company === undefined) throw new Error('company missing')
  await db.attribute.create({ data: {
    ...tenant, objectTypeId: company.id, slug: 'probe_restricted', name: 'Probe restricted',
    description: 'Restricted probe.', type: 'text', sensitivity: 'restricted',
  } })
  const objectType = (await loadSchema(db, tenant)).objectTypesBySlug.get('company')
  if (objectType === undefined) throw new Error('company missing')
  const restricted = objectType.attributes.find((attribute) => attribute.slug === 'probe_restricted')
  if (restricted === undefined) throw new Error('probe_restricted missing')
  const record = await db.record.create({ data: {
    ...tenant, objectTypeId: objectType.id, data: { name: 'Wildcard Ltd' }, displayName: 'Wildcard Ltd',
    visibility: 'team', createdOnBehalfOf: 'someone_else', createdByType: 'system', createdById: 'test',
  } })
  return { tenant, objectType, restricted, recordId: record.id }
}

async function bind(tenant: TenantRef, input: {
  resourceType?: 'record' | 'attribute'
  effect?: 'allow' | 'deny'
  sensitivity?: 'restricted'
  actorType: 'role' | 'agent'
  actorId: string
}) {
  await db.policyRule.create({ data: {
    organizationId: tenant.organizationId, teamId: tenant.teamId, scope: 'team', scopeId: tenant.teamId,
    resourceType: input.resourceType ?? 'record', action: 'view', effect: input.effect ?? 'allow', priority: 0,
    conditions: input.sensitivity === undefined ? undefined : { sensitivity: input.sensitivity },
    createdById: 'test', bindings: { create: { actorType: input.actorType, actorId: input.actorId } },
  } })
}

function agent(tenant: TenantRef, app: string, agentId: string, role: 'member' | 'admin' = 'member'): ActorContext {
  return {
    tenant, app, actChain: [], actor: { type: 'agent', id: agentId },
    onBehalfOf: { uoaUserId: 'person', role }, provenance: null,
    requestId: crypto.randomUUID(), now: new Date(),
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

async function rowVisible(target: Fixture, ctx: ActorContext): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT r.id FROM records r
    WHERE ${rowAccess(target.tenant, ctx, target.objectType)} AND r.id = ${target.recordId}::uuid`)
  return rows.length === 1
}

async function restrictedVisible(target: Fixture, ctx: ActorContext): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT r.id FROM records r
    WHERE r.id = ${target.recordId}::uuid${attributeReadAccess(target.tenant, ctx, target.objectType, [target.restricted])}`)
  return rows.length === 1
}

afterAll(async () => {
  await Promise.all(organizations.map((organizationId) => dropTenant(db, organizationId)))
  await db.$disconnect()
})

describe('SQL policy gate for agents', () => {
  it('admits an agent under its app wildcard and refuses one without any agent binding', async () => {
    const target = await fixture()
    expect(await rowVisible(target, agent(target.tenant, 'nessie', 'agent_1'))).toBe(false)
    await bind(target.tenant, { actorType: 'agent', actorId: 'agent:nessie:*' })
    expect(await rowVisible(target, agent(target.tenant, 'nessie', 'agent_1'))).toBe(true)
    expect(await rowVisible(target, agent(target.tenant, 'nessie', 'agent_2'))).toBe(true)
    expect(await rowVisible(target, agent(target.tenant, 'deepsignal', 'agent_1'))).toBe(false)
  })

  it('lets an exact per-agent deny beat the wildcard', async () => {
    const target = await fixture()
    await bind(target.tenant, { actorType: 'agent', actorId: 'agent:nessie:*' })
    await bind(target.tenant, { effect: 'deny', actorType: 'agent', actorId: 'agent:nessie:agent_denied' })
    expect(await rowVisible(target, agent(target.tenant, 'nessie', 'agent_denied'))).toBe(false)
    expect(await rowVisible(target, agent(target.tenant, 'nessie', 'agent_other'))).toBe(true)
  })

  it('keeps the human channel deciding an agent attribute read', async () => {
    const target = await fixture()
    await bind(target.tenant, { resourceType: 'attribute', actorType: 'agent', actorId: 'agent:nessie:*' })
    expect(await restrictedVisible(target, agent(target.tenant, 'nessie', 'agent_1'))).toBe(true)
    await bind(target.tenant, {
      resourceType: 'attribute', effect: 'deny', sensitivity: 'restricted', actorType: 'role', actorId: 'member',
    })
    await bind(target.tenant, {
      resourceType: 'attribute', sensitivity: 'restricted', actorType: 'role', actorId: 'admin',
    })
    expect(await restrictedVisible(target, agent(target.tenant, 'nessie', 'agent_1'))).toBe(false)
    expect(await restrictedVisible(target, agent(target.tenant, 'nessie', 'agent_1', 'admin'))).toBe(true)
  })
})
