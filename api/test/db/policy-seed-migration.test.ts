import {
  createDb, policyDefaults, Prisma, seedTenant,
  type Db, type PolicyAction, type PolicyEffect, type PolicyResourceType, type TenantRef,
} from '@deepcrm/db'
import type { ActorContext } from '@deepcrm/schemas'
import { describe, expect, it } from 'vitest'

import { checkPolicy, seedDefaultPolicies } from '../../src/services/policy.js'
import { deployAfter, deployBefore, migrationTestTimeout, runMigration, withDatabase } from './migration-fixture.js'

// The operator migrations that bring teams provisioned from an older
// policy-defaults.json up to the current one: each team ends with exactly the
// rows a fresh seed writes, so seedDefaultPolicies reports no drift, and its
// policy_version moves once per migration that gave it rows, however often
// the migration runs.
//   20260929120000_nessie_agent_policy_bindings — the agent:nessie:* allows.
//   20261019150100_contact_point_policy_rules — contact_point.edit for every role and for agent:nessie:*.

const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is required for the policy seed migration test')
const NESSIE_MIGRATION = '20260929120000_nessie_agent_policy_bindings'
const CONTACT_POINT_MIGRATION = '20261019150100_contact_point_policy_rules'
const NESSIE_WILDCARD = 'agent:nessie:*'

type DefaultRule = (typeof policyDefaults.rules)[number]

const isNessie = (rule: DefaultRule) => rule.bindings.some(
  ([actorType, actorId]) => actorType === 'agent' && actorId === NESSIE_WILDCARD,
)
const isContactPoint = (rule: DefaultRule) => rule.resource_type === 'contact_point'
const nessieRules = policyDefaults.rules.filter(isNessie)
const contactPointRules = policyDefaults.rules.filter(isContactPoint)

/** A team provisioned from an older JSON: the current seed without the rules later migrations add. */
async function legacyTeam(db: Db, rules: readonly DefaultRule[]): Promise<TenantRef> {
  const seeded = await seedTenant(db)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  for (const rule of rules) {
    await db.policyRule.create({ data: {
      ...tenant, scope: 'team', scopeId: tenant.teamId,
      resourceType: rule.resource_type as PolicyResourceType,
      action: rule.action as PolicyAction,
      effect: rule.effect as PolicyEffect,
      priority: rule.priority,
      requiresApproval: 'requires_approval' in rule && rule.requires_approval === true,
      conditions: 'conditions' in rule ? rule.conditions : Prisma.DbNull,
      createdById: 'system',
      bindings: { create: rule.bindings.map(([actorType, actorId]) => {
        if (actorType === undefined || actorId === undefined) throw new Error('policy-defaults.json binding is malformed')
        return { actorType, actorId }
      }) },
    } })
  }
  await db.team.update({ where: { id: tenant.teamId }, data: { policyVersion: 1 } })
  return tenant
}

async function teamState(db: Db, tenant: TenantRef) {
  const [rules, nessie, contactPoint, team] = await Promise.all([
    db.policyRule.count({ where: tenant }),
    db.policyRule.count({ where: {
      ...tenant, bindings: { some: { actorType: 'agent', actorId: NESSIE_WILDCARD } },
    } }),
    // As text: before 20261019150000 the enum has no contact_point value to compare with.
    db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM policy_rules
      WHERE organization_id = ${tenant.organizationId}::uuid AND team_id = ${tenant.teamId}::uuid
        AND resource_type::text = 'contact_point'
    `,
    db.team.findUniqueOrThrow({ where: { id: tenant.teamId }, select: { policyVersion: true } }),
  ])
  return { rules, nessie, contactPoint: Number(contactPoint[0]?.count), policyVersion: team.policyVersion }
}

function nessieAgent(tenant: TenantRef, role: 'member' | 'admin'): ActorContext {
  return {
    tenant, app: 'nessie', actChain: [], actor: { type: 'agent', id: 'agent_clients' },
    onBehalfOf: { uoaUserId: 'uoa_member', role }, provenance: null, requestId: crypto.randomUUID(), now: new Date(),
  }
}

const contactPointEdit = (tenant: TenantRef) => ({
  resourceType: 'contact_point' as const, action: 'edit' as const, sensitivity: 'confidential' as const,
  scopes: [{ scope: 'team' as const, id: tenant.teamId }],
})

describe('policy seed migrations', () => {
  it('seeds the nessie wildcard into existing seeded teams without drift and re-runs as a no-op', async () => {
    expect(nessieRules).toHaveLength(27)
    expect(nessieRules.filter((rule) => !isContactPoint(rule))).toHaveLength(26)
    await withDatabase(url, async (database) => {
      await deployBefore(database, NESSIE_MIGRATION)
      const db = createDb(database)
      try {
        const before = policyDefaults.rules.filter((rule) => !isNessie(rule) && !isContactPoint(rule))
        const first = await legacyTeam(db, before)
        const second = await legacyTeam(db, before)
        const unseededTeam = await seedTenant(db)
        const unseeded = { organizationId: unseededTeam.organizationId, teamId: unseededTeam.teamId }
        expect(await teamState(db, first)).toEqual({ rules: before.length, nessie: 0, contactPoint: 0, policyVersion: 1 })

        const afterNessie = { rules: before.length + 26, nessie: 26, contactPoint: 0, policyVersion: 2 }
        await runMigration(database, NESSIE_MIGRATION)
        for (const team of [first, second]) expect(await teamState(db, team)).toEqual(afterNessie)
        expect(await teamState(db, unseeded)).toEqual({ rules: 0, nessie: 0, contactPoint: 0, policyVersion: 0 })
        await runMigration(database, NESSIE_MIGRATION)
        for (const team of [first, second]) expect(await teamState(db, team)).toEqual(afterNessie)
        const bindings = await db.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*)::bigint AS count FROM policy_bindings b
          JOIN policy_rules r ON r.id = b.policy_rule_id
          WHERE r.organization_id = ${first.organizationId}::uuid AND r.team_id = ${first.teamId}::uuid
            AND b.actor_type = 'agent' AND b.actor_id = ${NESSIE_WILDCARD}
        `
        expect(bindings[0]?.count).toBe(26n)

        // The later migrations bring the same teams to today's defaults.
        await deployAfter(database, NESSIE_MIGRATION)
        for (const team of [first, second]) {
          expect(await teamState(db, team)).toEqual({
            rules: policyDefaults.rules.length, nessie: 27, contactPoint: 2, policyVersion: 3,
          })
          await expect(db.$transaction((tx) => seedDefaultPolicies(tx, team))).resolves.toEqual({ seeded: false })
        }
        expect(await teamState(db, unseeded)).toEqual({ rules: 0, nessie: 0, contactPoint: 0, policyVersion: 0 })
      } finally {
        await db.$disconnect()
      }
    })
  }, migrationTestTimeout)

  it('grants contact_point.edit to every role and the nessie wildcard on existing seeded teams', async () => {
    expect(contactPointRules.map((rule) => [rule.effect, rule.bindings.map(([type, id]) => `${type}:${id}`).sort()]))
      .toEqual([['allow', ['role:admin', 'role:member', 'role:owner']], ['allow', [`agent:${NESSIE_WILDCARD}`]]])
    await withDatabase(url, async (database) => {
      await deployBefore(database, CONTACT_POINT_MIGRATION)
      const db = createDb(database)
      try {
        const before = policyDefaults.rules.filter((rule) => !isContactPoint(rule))
        const legacy = await legacyTeam(db, before)
        const currentTeam = await seedTenant(db)
        const current = { organizationId: currentTeam.organizationId, teamId: currentTeam.teamId }
        await db.$transaction((tx) => seedDefaultPolicies(tx, current))
        const unseededTeam = await seedTenant(db)
        const unseeded = { organizationId: unseededTeam.organizationId, teamId: unseededTeam.teamId }
        // Before: the human side falls back to allow for edit, but the agent side never falls back.
        await expect(checkPolicy(db, nessieAgent(legacy, 'member'), contactPointEdit(legacy)))
          .resolves.toEqual({ allowed: false, requiresApproval: false })

        await runMigration(database, CONTACT_POINT_MIGRATION)
        const migrated = { rules: policyDefaults.rules.length, nessie: 27, contactPoint: 2, policyVersion: 2 }
        expect(await teamState(db, legacy)).toEqual(migrated)
        await expect(db.$transaction((tx) => seedDefaultPolicies(tx, legacy))).resolves.toEqual({ seeded: false })
        expect(await teamState(db, current)).toEqual({ ...migrated, policyVersion: 0 })
        expect(await teamState(db, unseeded)).toEqual({ rules: 0, nessie: 0, contactPoint: 0, policyVersion: 0 })
        for (const role of ['member', 'admin'] as const) {
          await expect(checkPolicy(db, nessieAgent(legacy, role), contactPointEdit(legacy)))
            .resolves.toEqual({ allowed: true, requiresApproval: false })
        }
        // Nothing else moved: a member still may not edit a confidential attribute.
        await expect(checkPolicy(db, nessieAgent(legacy, 'member'), {
          ...contactPointEdit(legacy), resourceType: 'attribute',
        })).resolves.toEqual({ allowed: false, requiresApproval: false })

        await runMigration(database, CONTACT_POINT_MIGRATION)
        expect(await teamState(db, legacy)).toEqual(migrated)
        expect(await teamState(db, current)).toEqual({ ...migrated, policyVersion: 0 })
      } finally {
        await db.$disconnect()
      }
    })
  }, migrationTestTimeout)
})
