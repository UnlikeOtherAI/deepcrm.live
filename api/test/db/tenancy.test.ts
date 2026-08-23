import { createDb } from '@deepcrm/db'
import { devPrincipal } from '@deepcrm/mcp-inbound'
import { afterAll, describe, expect, it } from 'vitest'
import type { AppDeps } from '../../src/deps.js'
import { resolveTenant } from '../../src/services/tenancy.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for tenancy tests')

const db = createDb(databaseUrl)
const createdOrganizationIds: string[] = []
const deps: AppDeps = {
  db,
  clock: () => new Date(),
  ids: () => 'id_test',
  version: '0.0.0',
}

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } })
  await db.$disconnect()
})

describe('resolveTenant', () => {
  it('keeps tenant ids stable and creates separate teams', async () => {
    const suffix = crypto.randomUUID()
    const firstPrincipal = {
      ...devPrincipal(`req_${suffix}`),
      uoaOrgId: `org_${suffix}`,
      uoaTeamId: `tm_first_${suffix}`,
    }
    const secondPrincipal = { ...firstPrincipal, uoaTeamId: `tm_second_${suffix}` }

    const first = await resolveTenant(deps, firstPrincipal)
    createdOrganizationIds.push(first.organizationId)
    const repeated = await resolveTenant(deps, firstPrincipal)
    const second = await resolveTenant(deps, secondPrincipal)

    expect(repeated).toMatchObject({
      organizationId: first.organizationId,
      teamId: first.teamId,
    })
    expect(second.organizationId).toBe(first.organizationId)
    expect(second.teamId).not.toBe(first.teamId)
  })

  it('rejects a team paired with another organisation without reparenting it', async () => {
    const suffix = crypto.randomUUID()
    const existingOrganization = await db.organization.create({
      data: { externalOrgId: `org_existing_${suffix}`, name: 'Organisation existing' },
    })
    const requestedOrganization = await db.organization.create({
      data: { externalOrgId: `org_requested_${suffix}`, name: 'Organisation requested' },
    })
    createdOrganizationIds.push(existingOrganization.id, requestedOrganization.id)
    const externalTeamId = `tm_existing_${suffix}`
    await db.team.create({
      data: {
        organizationId: existingOrganization.id,
        externalTeamId,
        name: 'Team existing',
      },
    })
    const principal = {
      ...devPrincipal(`req_mismatch_${suffix}`),
      uoaOrgId: `org_requested_${suffix}`,
      uoaTeamId: externalTeamId,
    }

    await expect(resolveTenant(deps, principal)).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
    })
    const team = await db.team.findUniqueOrThrow({ where: { externalTeamId } })
    expect(team.organizationId).toBe(existingOrganization.id)
  })
})
