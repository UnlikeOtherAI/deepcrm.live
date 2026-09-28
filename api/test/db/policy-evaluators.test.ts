import { Prisma, createDb, dropTenant, seedTenant, type TenantRef } from '@deepcrm/db'
import {
  applyTemplate,
  attributeReadAccess,
  loadSchema,
  rowAccess,
  type LoadedAttribute,
  type LoadedObjectType,
} from '@deepcrm/schema-engine'
import type { ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import { checkPolicy, seedDefaultPolicies, type PolicyScopeRef } from '../../src/services/policy.js'

// The TypeScript evaluator (api/src/services/policy.ts) and the SQL row and
// attribute gate (schema-engine records/visibility.ts) decide record.view and
// attribute.view independently. Over one fixture matrix they must agree row for
// row: readable exactly when the TS decision is allowed without approval.

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for policy evaluator tests')
const db = createDb(databaseUrl)
const organizations: string[] = []

const SENSITIVITIES = ['public', 'internal', 'confidential', 'restricted'] as const
const ROLES = ['owner', 'admin', 'member', null] as const
const USERS = ['plain_user', 'gated_user'] as const
const ACTORS = [
  { label: 'human' },
  { label: 'nessie agent', app: 'nessie', agentId: 'agent_plain' },
  { label: 'nessie agent with an exact deny', app: 'nessie', agentId: 'agent_denied' },
  { label: 'nessie agent with an exact approval deny', app: 'nessie', agentId: 'agent_gated' },
  { label: 'deepsignal agent', app: 'deepsignal', agentId: 'agent_plain' },
] as const

type Fixture = {
  tenant: TenantRef
  objectType: LoadedObjectType
  attributes: Map<LoadedAttribute['sensitivity'], LoadedAttribute>
  recordId: string
}

async function addRule(tenant: TenantRef, input: {
  resourceType: 'record' | 'attribute'
  effect: 'allow' | 'deny'
  priority?: number
  requiresApproval?: boolean
  binding: { actorType: string; actorId: string }
}): Promise<void> {
  await db.policyRule.create({ data: {
    organizationId: tenant.organizationId, teamId: tenant.teamId,
    scope: 'team', scopeId: tenant.teamId,
    resourceType: input.resourceType, action: 'view',
    effect: input.effect, priority: input.priority ?? 0,
    requiresApproval: input.requiresApproval ?? false,
    createdById: 'policy-evaluators-test', bindings: { create: input.binding },
  } })
}

async function fixture(): Promise<Fixture> {
  const seeded = await seedTenant(db)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  organizations.push(tenant.organizationId)
  await db.$transaction((tx) => seedDefaultPolicies(tx, tenant))
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'policy-evaluators', onBehalfOf: null, requestId: crypto.randomUUID(),
  }, 'standard_crm'))
  const company = await db.objectType.findFirstOrThrow({ where: { ...tenant, slug: 'company' } })
  for (const sensitivity of SENSITIVITIES) {
    await db.attribute.create({ data: {
      ...tenant, objectTypeId: company.id, slug: `probe_${sensitivity}`, name: `Probe ${sensitivity}`,
      description: 'Policy evaluator probe.', type: 'text', sensitivity,
    } })
  }
  for (const resourceType of ['record', 'attribute'] as const) {
    await addRule(tenant, {
      resourceType, effect: 'deny', binding: { actorType: 'agent', actorId: 'agent:nessie:agent_denied' },
    })
    await addRule(tenant, {
      resourceType, effect: 'deny', requiresApproval: true,
      binding: { actorType: 'agent', actorId: 'agent:nessie:agent_gated' },
    })
    await addRule(tenant, {
      resourceType, effect: 'allow', priority: 5, requiresApproval: true,
      binding: { actorType: 'human', actorId: 'gated_user' },
    })
  }
  // The schema cache is keyed by schema_version; the raw attribute inserts must move it.
  await db.team.update({ where: { id: tenant.teamId }, data: { schemaVersion: { increment: 1 } } })
  const schema = await loadSchema(db, tenant)
  const objectType = schema.objectTypesBySlug.get('company')
  if (objectType === undefined) throw new Error('company missing')
  const attributes = new Map(objectType.attributes
    .filter((attribute) => attribute.slug.startsWith('probe_'))
    .map((attribute) => [attribute.sensitivity, attribute] as const))
  const record = await db.record.create({ data: {
    ...tenant, objectTypeId: objectType.id, data: { name: 'Evaluator Ltd' }, displayName: 'Evaluator Ltd',
    visibility: 'team', createdOnBehalfOf: 'someone_else', createdByType: 'system', createdById: 'test',
  } })
  return { tenant, objectType, attributes, recordId: record.id }
}

function context(
  tenant: TenantRef, actor: typeof ACTORS[number], role: typeof ROLES[number], userId: string,
): ActorContext {
  return {
    tenant,
    app: 'app' in actor ? actor.app : 'test',
    actChain: [],
    actor: 'agentId' in actor ? { type: 'agent', id: actor.agentId } : { type: 'human', id: userId },
    onBehalfOf: { uoaUserId: userId, role },
    provenance: null,
    requestId: crypto.randomUUID(),
    now: new Date(),
  }
}

async function tsReadable(
  ctx: ActorContext, target: Fixture, resourceType: 'record' | 'attribute',
  sensitivity?: LoadedAttribute['sensitivity'],
): Promise<boolean> {
  const scopes: PolicyScopeRef[] = [
    { scope: 'record', id: target.recordId },
    { scope: 'object_type', id: target.objectType.id },
    { scope: 'team', id: target.tenant.teamId },
  ]
  const decision = await checkPolicy(db, ctx, { resourceType, action: 'view', scopes, sensitivity })
  return decision.allowed && !decision.requiresApproval
}

async function sqlRowReadable(ctx: ActorContext, target: Fixture): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT r.id FROM records r
    WHERE ${rowAccess(target.tenant, ctx, target.objectType)} AND r.id = ${target.recordId}::uuid`)
  return rows.length === 1
}

async function sqlAttributeReadable(ctx: ActorContext, target: Fixture, attribute: LoadedAttribute): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT r.id FROM records r
    WHERE r.id = ${target.recordId}::uuid${attributeReadAccess(target.tenant, ctx, target.objectType, [attribute])}`)
  return rows.length === 1
}

afterAll(async () => {
  await Promise.all(organizations.map((organizationId) => dropTenant(db, organizationId)))
  await db.$disconnect()
})

describe('TS and SQL policy evaluators', () => {
  it('agree on record.view and attribute.view over role × binding × sensitivity', async () => {
    const target = await fixture()
    const decisions = new Map<string, boolean>()
    for (const actor of ACTORS) {
      for (const role of ROLES) {
        for (const user of USERS) {
          const ctx = context(target.tenant, actor, role, user)
          const cell = `${actor.label} / ${role ?? 'no role'} / ${user}`
          const record = await tsReadable(ctx, target, 'record')
          expect(await sqlRowReadable(ctx, target), `${cell} / record.view`).toBe(record)
          decisions.set(`${cell} / record`, record)
          for (const sensitivity of SENSITIVITIES) {
            const attribute = target.attributes.get(sensitivity)
            if (attribute === undefined) throw new Error(`probe_${sensitivity} missing`)
            const readable = await tsReadable(ctx, target, 'attribute', sensitivity)
            expect(await sqlAttributeReadable(ctx, target, attribute), `${cell} / attribute.view ${sensitivity}`)
              .toBe(readable)
            decisions.set(`${cell} / ${sensitivity}`, readable)
          }
        }
      }
    }

    // Anchors, so agreement cannot hide two evaluators that both refuse everything.
    expect(decisions.get('nessie agent / member / plain_user / record')).toBe(true)
    expect(decisions.get('nessie agent / no role / plain_user / record')).toBe(true)
    expect(decisions.get('nessie agent / member / plain_user / internal')).toBe(true)
    expect(decisions.get('nessie agent / member / plain_user / restricted')).toBe(false)
    expect(decisions.get('nessie agent / admin / plain_user / restricted')).toBe(true)
    expect(decisions.get('nessie agent / owner / gated_user / record')).toBe(false)
    expect(decisions.get('nessie agent with an exact deny / owner / plain_user / record')).toBe(false)
    expect(decisions.get('nessie agent with an exact approval deny / owner / plain_user / record')).toBe(false)
    expect(decisions.get('deepsignal agent / owner / plain_user / record')).toBe(false)
    expect(decisions.get('human / no role / plain_user / record')).toBe(true)
    expect(decisions.get('human / member / plain_user / restricted')).toBe(false)
  })
})
