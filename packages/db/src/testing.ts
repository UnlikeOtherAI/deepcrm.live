import { randomUUID } from 'node:crypto'

import type { Db } from './client.js'

export type SeededTenant = {
  organizationId: string
  teamId: string
  externalOrgId: string
  externalTeamId: string
}

export async function seedTenant(db: Db): Promise<SeededTenant> {
  const externalOrgId = `org_${randomUUID()}`
  const externalTeamId = `tm_${randomUUID()}`
  const organization = await db.organization.create({
    data: { externalOrgId, name: `Organisation ${externalOrgId.slice(4, 12)}` },
  })
  const team = await db.team.create({
    data: {
      organizationId: organization.id,
      externalTeamId,
      name: `Team ${externalTeamId.slice(3, 11)}`,
    },
  })
  return { organizationId: organization.id, teamId: team.id, externalOrgId, externalTeamId }
}

export async function dropTenant(db: Db, organizationId: string): Promise<void> {
  await db.organization.delete({ where: { id: organizationId } })
}
