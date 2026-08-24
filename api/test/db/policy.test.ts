import {
  createDb, dropTenant, policyDefaults, seedTenant,
  type PolicyAction, type PolicyEffect, type PolicyResourceType, type PolicyScope, type Prisma,
} from '@deepcrm/db'
import type { ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'
import { checkPolicy, seedDefaultPolicies } from '../../src/services/policy.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for policy tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
type Tenant = { organizationId: string; teamId: string }

function context(
  tenant: Tenant,
  options: { app?: string; agentId?: string; role?: 'owner' | 'admin' | 'member' | null; userId?: string } = {},
): ActorContext {
  const userId = options.userId ?? 'uoa_1'
  const actor: ActorContext['actor'] = options.agentId === undefined
    ? { type: 'human', id: userId }
    : { type: 'agent', id: options.agentId }
  return {
    tenant, app: options.app ?? 'test', actChain: [], actor,
    onBehalfOf: { uoaUserId: userId, role: options.role === undefined ? 'member' : options.role },
    provenance: null, requestId: crypto.randomUUID(), now: new Date(),
  }
}

async function tenant(): Promise<Tenant> {
  const seeded = await seedTenant(db)
  organizations.push(seeded.organizationId)
  return seeded
}

async function addRule(target: Tenant, input: {
  resourceType?: PolicyResourceType; action?: PolicyAction; effect?: PolicyEffect; priority?: number
  requiresApproval?: boolean; scope?: PolicyScope; scopeId?: string; conditions?: Prisma.InputJsonValue
  bindings: Array<{ actorType: string; actorId: string }>
}): Promise<void> {
  await db.policyRule.create({ data: {
    organizationId: target.organizationId, teamId: target.teamId,
    scope: input.scope ?? 'team', scopeId: input.scopeId ?? target.teamId,
    resourceType: input.resourceType ?? 'record', action: input.action ?? 'view',
    effect: input.effect ?? 'allow', priority: input.priority ?? 0,
    requiresApproval: input.requiresApproval ?? false, conditions: input.conditions,
    createdById: 'test', bindings: { create: input.bindings },
  } })
}

const teamScope = (target: Tenant) => [{ scope: 'team' as const, id: target.teamId }]

afterAll(async () => {
  await Promise.all(organizations.map((organizationId) => dropTenant(db, organizationId)))
  await db.$disconnect()
})

describe('policy truth table', () => {
  it('matches direct-human and role bindings', async () => {
    const target = await tenant()
    await addRule(target, { bindings: [{ actorType: 'human', actorId: 'uoa_1' }] })
    await expect(checkPolicy(db, context(target, { role: null }), {
      resourceType: 'record', action: 'view', scopes: teamScope(target),
    })).resolves.toEqual({ allowed: true, requiresApproval: false })
    await addRule(target, { action: 'edit', bindings: [{ actorType: 'role', actorId: 'member' }] })
    await expect(checkPolicy(db, context(target), {
      resourceType: 'record', action: 'edit', scopes: teamScope(target),
    })).resolves.toEqual({ allowed: true, requiresApproval: false })
  })

  it('requires the exact app-agent grant as well as the human grant', async () => {
    const target = await tenant()
    await addRule(target, { bindings: [{ actorType: 'role', actorId: 'member' }] })
    const agent = context(target, { app: 'alpha', agentId: 'agent_1' })
    await expect(checkPolicy(db, agent, {
      resourceType: 'record', action: 'view', scopes: teamScope(target),
    })).resolves.toEqual({ allowed: false, requiresApproval: false })
    await addRule(target, { bindings: [{ actorType: 'agent', actorId: 'agent:alpha:agent_1' }] })
    await expect(checkPolicy(db, agent, {
      resourceType: 'record', action: 'view', scopes: teamScope(target),
    })).resolves.toEqual({ allowed: true, requiresApproval: false })
    await expect(checkPolicy(db, context(target, { app: 'beta', agentId: 'agent_1' }), {
      resourceType: 'record', action: 'view', scopes: teamScope(target),
    })).resolves.toEqual({ allowed: false, requiresApproval: false })
  })

  it('denies an agent when either side denies', async () => {
    const first = await tenant()
    await addRule(first, { effect: 'deny', bindings: [{ actorType: 'role', actorId: 'member' }] })
    await addRule(first, { bindings: [{ actorType: 'agent', actorId: 'agent:test:agent_1' }] })
    await expect(checkPolicy(db, context(first, { agentId: 'agent_1' }), {
      resourceType: 'record', action: 'view', scopes: teamScope(first),
    })).resolves.toEqual({ allowed: false, requiresApproval: false })
    const second = await tenant()
    await addRule(second, { bindings: [{ actorType: 'role', actorId: 'member' }] })
    await addRule(second, {
      effect: 'deny', bindings: [{ actorType: 'agent', actorId: 'agent:test:agent_1' }],
    })
    await expect(checkPolicy(db, context(second, { agentId: 'agent_1' }), {
      resourceType: 'record', action: 'view', scopes: teamScope(second),
    })).resolves.toEqual({ allowed: false, requiresApproval: false })
  })

  it('gives hard deny precedence over approval and otherwise surfaces approval', async () => {
    const hard = await tenant()
    const binding = [{ actorType: 'role', actorId: 'member' }]
    await addRule(hard, { action: 'delete', effect: 'deny', requiresApproval: true, bindings: binding })
    await addRule(hard, { action: 'delete', effect: 'deny', bindings: binding })
    await expect(checkPolicy(db, context(hard), {
      resourceType: 'record', action: 'delete', scopes: teamScope(hard),
    })).resolves.toEqual({ allowed: false, requiresApproval: false })
    const approval = await tenant()
    await addRule(approval, {
      action: 'delete', effect: 'deny', requiresApproval: true, bindings: binding,
    })
    await expect(checkPolicy(db, context(approval), {
      resourceType: 'record', action: 'delete', scopes: teamScope(approval),
    })).resolves.toEqual({ allowed: false, requiresApproval: true })
  })

  it('gives an agent-channel hard deny precedence over a human-channel approval denial', async () => {
    const target = await tenant()
    await addRule(target, {
      action: 'delete',
      effect: 'deny',
      requiresApproval: true,
      bindings: [{ actorType: 'role', actorId: 'member' }],
    })
    await addRule(target, {
      action: 'delete',
      effect: 'deny',
      bindings: [{ actorType: 'agent', actorId: 'agent:test:agent_1' }],
    })

    await expect(checkPolicy(db, context(target, { agentId: 'agent_1' }), {
      resourceType: 'record', action: 'delete', scopes: teamScope(target),
    })).resolves.toEqual({ allowed: false, requiresApproval: false })
  })

  it('uses highest-priority allows and approval on a top-priority tie', async () => {
    const target = await tenant()
    const binding = [{ actorType: 'role', actorId: 'member' }]
    await addRule(target, { priority: 5, requiresApproval: true, bindings: binding })
    await addRule(target, { priority: 10, bindings: binding })
    await expect(checkPolicy(db, context(target), {
      resourceType: 'record', action: 'view', scopes: teamScope(target),
    })).resolves.toEqual({ allowed: true, requiresApproval: false })
    await addRule(target, { priority: 10, requiresApproval: true, bindings: binding })
    await expect(checkPolicy(db, context(target), {
      resourceType: 'record', action: 'view', scopes: teamScope(target),
    })).resolves.toEqual({ allowed: true, requiresApproval: true })
  })

  it('matches sensitivity exactly and unconditional rules always', async () => {
    const target = await tenant()
    const binding = [{ actorType: 'role', actorId: 'member' }]
    await addRule(target, { effect: 'deny', conditions: { sensitivity: 'restricted' }, bindings: binding })
    await expect(checkPolicy(db, context(target), {
      resourceType: 'record', action: 'view', scopes: teamScope(target), sensitivity: 'restricted',
    })).resolves.toEqual({ allowed: false, requiresApproval: false })
    await expect(checkPolicy(db, context(target), {
      resourceType: 'record', action: 'view', scopes: teamScope(target), sensitivity: 'confidential',
    })).resolves.toEqual({ allowed: true, requiresApproval: false })
    await addRule(target, { action: 'edit', bindings: binding })
    await expect(checkPolicy(db, context(target), {
      resourceType: 'record', action: 'edit', scopes: teamScope(target), sensitivity: 'restricted',
    })).resolves.toEqual({ allowed: true, requiresApproval: false })
  })

  it('uses documented defaults including erase and unlink-as-link', async () => {
    const target = await tenant()
    for (const action of ['view', 'create', 'edit', 'link'] as const) {
      await expect(checkPolicy(db, context(target), {
        resourceType: 'record', action, scopes: teamScope(target),
      })).resolves.toEqual({ allowed: true, requiresApproval: false })
    }
    await expect(checkPolicy(db, context(target), {
      resourceType: 'record', action: 'erase', scopes: teamScope(target),
    })).resolves.toEqual({ allowed: false, requiresApproval: false })
  })

  it('requires both scope type and id', async () => {
    const target = await tenant()
    await addRule(target, {
      resourceType: 'schema', action: 'define', scope: 'object_type', scopeId: 'same-id',
      bindings: [{ actorType: 'role', actorId: 'member' }],
    })
    await expect(checkPolicy(db, context(target), {
      resourceType: 'schema', action: 'define', scopes: [{ scope: 'team', id: 'same-id' }],
    })).resolves.toEqual({ allowed: false, requiresApproval: false })
    await expect(checkPolicy(db, context(target), {
      resourceType: 'schema', action: 'define', scopes: [{ scope: 'object_type', id: 'same-id' }],
    })).resolves.toEqual({ allowed: true, requiresApproval: false })
  })

  it('keeps tenants isolated', async () => {
    const first = await tenant()
    const second = await tenant()
    await addRule(first, {
      resourceType: 'schema', action: 'define', scopeId: second.teamId,
      bindings: [{ actorType: 'role', actorId: 'member' }],
    })
    await expect(checkPolicy(db, context(second), {
      resourceType: 'schema', action: 'define', scopes: teamScope(second),
    })).resolves.toEqual({ allowed: false, requiresApproval: false })
  })
})

function normalizedPolicySource() {
  return policyDefaults.rules.map((rule) => ({
    resourceType: rule.resource_type, action: rule.action, effect: rule.effect,
    priority: rule.priority,
    requiresApproval: 'requires_approval' in rule && rule.requires_approval === true,
    conditions: 'conditions' in rule ? rule.conditions : null,
    bindings: rule.bindings.map(([actorType, actorId]) => `${actorType}:${actorId}`).sort(),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

async function normalizedSeededPolicies(target: Tenant) {
  const rules = await db.policyRule.findMany({
    where: { organizationId: target.organizationId, teamId: target.teamId }, include: { bindings: true },
  })
  return rules.map((rule) => ({
    resourceType: rule.resourceType, action: rule.action, effect: rule.effect,
    priority: rule.priority, requiresApproval: rule.requiresApproval, conditions: rule.conditions,
    bindings: rule.bindings.map((binding) => `${binding.actorType}:${binding.actorId}`).sort(),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

describe('policy default seeding', () => {
  it('seeds the authoritative source exactly and is idempotent', async () => {
    const target = await tenant()
    await db.$transaction((tx) => seedDefaultPolicies(tx, target))
    expect(await normalizedSeededPolicies(target)).toEqual(normalizedPolicySource())
    await db.$transaction((tx) => seedDefaultPolicies(tx, target))
    expect(await normalizedSeededPolicies(target)).toEqual(normalizedPolicySource())
  })

  it('rejects a partially drifted seed', async () => {
    const target = await tenant()
    await db.$transaction((tx) => seedDefaultPolicies(tx, target))
    const first = await db.policyRule.findFirstOrThrow({
      where: { organizationId: target.organizationId, teamId: target.teamId },
    })
    await db.policyRule.delete({ where: { id: first.id } })
    await expect(db.$transaction((tx) => seedDefaultPolicies(tx, target))).rejects.toMatchObject({
      code: 'SCHEMA_CONFLICT',
    })
  })

  it('rejects same-count drift in rule fields, bindings, and conditions', async () => {
    const ruleTarget = await tenant()
    await db.$transaction((tx) => seedDefaultPolicies(tx, ruleTarget))
    const changedRule = await db.policyRule.findFirstOrThrow({
      where: { organizationId: ruleTarget.organizationId, teamId: ruleTarget.teamId },
    })
    await db.policyRule.update({
      where: { id: changedRule.id },
      data: { priority: changedRule.priority + 1 },
    })
    await expect(db.$transaction((tx) => seedDefaultPolicies(tx, ruleTarget))).rejects.toMatchObject({
      code: 'SCHEMA_CONFLICT',
    })

    const bindingTarget = await tenant()
    await db.$transaction((tx) => seedDefaultPolicies(tx, bindingTarget))
    const ruleWithBinding = await db.policyRule.findFirstOrThrow({
      where: { organizationId: bindingTarget.organizationId, teamId: bindingTarget.teamId },
      include: { bindings: true },
    })
    const changedBinding = ruleWithBinding.bindings[0]
    if (changedBinding === undefined) throw new Error('seeded rule must have a binding')
    await db.policyBinding.update({
      where: { id: changedBinding.id },
      data: { actorId: `${changedBinding.actorId}_drift` },
    })
    await expect(db.$transaction((tx) => seedDefaultPolicies(tx, bindingTarget))).rejects.toMatchObject({
      code: 'SCHEMA_CONFLICT',
    })

    const conditionsTarget = await tenant()
    await db.$transaction((tx) => seedDefaultPolicies(tx, conditionsTarget))
    const conditionRules = await db.policyRule.findMany({
      where: { organizationId: conditionsTarget.organizationId, teamId: conditionsTarget.teamId },
    })
    const changedConditions = conditionRules.find((rule) => rule.conditions !== null)
    if (changedConditions === undefined) throw new Error('seeded rules must include conditions')
    await db.policyRule.update({
      where: { id: changedConditions.id },
      data: { conditions: { sensitivity: 'public' } },
    })
    await expect(db.$transaction((tx) => seedDefaultPolicies(tx, conditionsTarget)))
      .rejects.toMatchObject({ code: 'SCHEMA_CONFLICT' })
  })

  it('serializes concurrent seeds into one exact set', async () => {
    const target = await tenant()
    await Promise.all([
      db.$transaction((tx) => seedDefaultPolicies(tx, target)),
      db.$transaction((tx) => seedDefaultPolicies(tx, target)),
    ])
    expect(await normalizedSeededPolicies(target)).toEqual(normalizedPolicySource())
  })
})
