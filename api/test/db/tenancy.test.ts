import { createDb, writeAudit } from '@deepcrm/db'
import { devPrincipal } from '@deepcrm/mcp-inbound'
import { createProjectionLinkWriter } from '@deepcrm/schema-engine'
import { parseSecretBox, type Principal } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import { resolveTenant, type TenantResolution } from '../../src/services/tenancy.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for tenancy tests')

const db = createDb(databaseUrl)
const createdOrganizationIds: string[] = []
const createdTenants: TenantResolution[] = []
const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSJ9fQ=='

function makeDeps(orgAllowlist: ReadonlySet<string> | null = null): AppDeps {
  return {
    db,
    clock: () => new Date(),
    ids: () => crypto.randomUUID(),
    version: '0.0.0',
    orgAllowlist,
    linkWriter: createProjectionLinkWriter(),
    historyCursor: createHistoryCursorCodec(parseSecretBox(keyring)),
    queryCursor: createQueryCursorCodec(parseSecretBox(keyring)),
    writeAudit,
  }
}

function makePrincipal(suffix: string): Principal {
  return {
    ...devPrincipal(`principal_${suffix}`),
    uoaOrgId: `org_${suffix}`,
    uoaTeamId: `tm_${suffix}`,
  }
}

function trackOrganization(id: string): void {
  if (!createdOrganizationIds.includes(id)) createdOrganizationIds.push(id)
}

function trackTenant(tenant: TenantResolution): void {
  trackOrganization(tenant.organizationId)
  createdTenants.push(tenant)
}

async function expectProvisioned(
  tenant: TenantResolution,
  principal: Principal,
  requestId: string,
): Promise<void> {
  const where = { organizationId: tenant.organizationId, teamId: tenant.teamId }
  const rules = await db.policyRule.findMany({ where, include: { bindings: true } })
  const [objects, attributes, relations, audits, team] = await Promise.all([
    db.objectType.count({ where }),
    db.attribute.count({ where }),
    db.relationType.count({ where }),
    db.auditLog.findMany({ where, orderBy: { createdAt: 'asc' } }),
    db.team.findFirstOrThrow({ where: { id: tenant.teamId, organizationId: tenant.organizationId } }),
  ])

  expect({ objects, attributes, relations }).toEqual({ objects: 3, attributes: 15, relations: 3 })
  expect(rules).toHaveLength(31)
  expect(rules.reduce((count, rule) => count + rule.bindings.length, 0)).toBe(62)
  expect(team).toMatchObject({ schemaVersion: 1, policyVersion: 1 })
  expect(audits).toHaveLength(1)
  expect(audits[0]).toMatchObject({
    actorType: 'system',
    actorId: 'provisioning',
    onBehalfOf: principal.uoaUserId,
    action: 'tenant.provisioned',
    resourceType: 'team',
    resourceId: tenant.teamId,
    requestId,
  })
  expect(await db.relationType.count({ where: { ...where, isSystem: true } })).toBe(3)
}

afterAll(async () => {
  for (const tenant of createdTenants) {
    const where = { organizationId: tenant.organizationId, teamId: tenant.teamId }
    await db.auditLog.deleteMany({ where })
    await db.policyRule.deleteMany({ where })
    await db.relationType.deleteMany({ where })
    await db.objectType.deleteMany({ where })
  }
  if (createdOrganizationIds.length > 0) {
    await db.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } })
  }
  await db.$disconnect()
})

describe('resolveTenant provisioning', () => {
  it('provisions exact defaults once and a repeated resolution has zero delta', async () => {
    const suffix = crypto.randomUUID()
    const principal = makePrincipal(suffix)
    const requestId = `req_${suffix}`
    const first = await resolveTenant(makeDeps(), principal, requestId)
    trackTenant(first)

    expect(first).toMatchObject({ schemaVersion: 1, policyVersion: 1 })
    await expectProvisioned(first, principal, requestId)

    const repeated = await resolveTenant(makeDeps(), principal, `repeat_${suffix}`)
    expect(repeated).toEqual(first)
    await expectProvisioned(first, principal, requestId)
  })

  it('serializes concurrent first contact into one provisioning outcome', async () => {
    const suffix = crypto.randomUUID()
    const principal = makePrincipal(suffix)
    const requestIds: [string, string] = [
      `concurrent_a_${suffix}`,
      `concurrent_b_${suffix}`,
    ]
    const [first, second] = await Promise.all([
      resolveTenant(makeDeps(), principal, requestIds[0]),
      resolveTenant(makeDeps(), principal, requestIds[1]),
    ])
    trackTenant(first)

    expect(second).toEqual(first)
    const audit = await db.auditLog.findFirstOrThrow({
      where: { organizationId: first.organizationId, teamId: first.teamId },
    })
    expect(requestIds).toContain(audit.requestId)
    await expectProvisioned(first, principal, audit.requestId)
    expect(await db.organization.count({ where: { externalOrgId: principal.uoaOrgId } })).toBe(1)
    expect(await db.team.count({ where: { externalTeamId: principal.uoaTeamId } })).toBe(1)
  })

  it('creates separate provisioned teams for one UOA organisation', async () => {
    const suffix = crypto.randomUUID()
    const firstPrincipal = makePrincipal(`first_${suffix}`)
    const secondPrincipal = { ...firstPrincipal, uoaTeamId: `tm_second_${suffix}` }
    const first = await resolveTenant(makeDeps(), firstPrincipal, `first_${suffix}`)
    trackTenant(first)
    const second = await resolveTenant(makeDeps(), secondPrincipal, `second_${suffix}`)
    trackTenant(second)

    expect(second.organizationId).toBe(first.organizationId)
    expect(second.teamId).not.toBe(first.teamId)
    expect(second).toMatchObject({ schemaVersion: 1, policyVersion: 1 })
  })

  it('rejects a disallowed organisation before writing any tenant state', async () => {
    const suffix = crypto.randomUUID()
    const principal = makePrincipal(`denied_${suffix}`)
    const requestId = `denied_${suffix}`

    await expect(
      resolveTenant(makeDeps(new Set([`org_allowed_${suffix}`])), principal, requestId),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    expect(await db.organization.findUnique({ where: { externalOrgId: principal.uoaOrgId } })).toBeNull()
    expect(await db.team.findUnique({ where: { externalTeamId: principal.uoaTeamId } })).toBeNull()
    expect(await db.auditLog.count({ where: { requestId } })).toBe(0)
  })

  it('rolls back the provisional organisation on a pairing mismatch', async () => {
    const suffix = crypto.randomUUID()
    const existingOrganization = await db.organization.create({
      data: { externalOrgId: `org_existing_${suffix}`, name: 'Organisation existing' },
    })
    trackOrganization(existingOrganization.id)
    const externalTeamId = `tm_existing_${suffix}`
    const existingTeam = await db.team.create({
      data: { organizationId: existingOrganization.id, externalTeamId, name: 'Team existing' },
    })
    const requestedExternalOrgId = `org_requested_${suffix}`
    const principal = {
      ...makePrincipal(`mismatch_${suffix}`),
      uoaOrgId: requestedExternalOrgId,
      uoaTeamId: externalTeamId,
    }
    const requestId = `mismatch_${suffix}`

    await expect(resolveTenant(makeDeps(), principal, requestId)).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
    })
    expect(await db.organization.findUnique({ where: { externalOrgId: requestedExternalOrgId } })).toBeNull()
    expect(await db.team.findUniqueOrThrow({ where: { externalTeamId } })).toEqual(existingTeam)
    expect(await db.auditLog.count({ where: { requestId } })).toBe(0)
  })
})
