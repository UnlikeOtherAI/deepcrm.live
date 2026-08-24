import { createDb, dropTenant, Prisma, seedTenant, writeAudit } from '@deepcrm/db'
import { complete, enqueue, progress } from '@deepcrm/queue'
import { afterAll, describe, expect, it } from 'vitest'

import type { JobHandlerInput } from '../../src/index.js'
import { tenantReparentHandler, TENANT_REPARENT_JOB } from '../../src/jobs/tenant-reparent.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for tenant reparent tests')

const db = createDb(databaseUrl)
const organizationIds: string[] = []

async function input(payload: Prisma.InputJsonObject): Promise<JobHandlerInput> {
  const workerId = crypto.randomUUID()
  const jobId = await enqueue(db, {
    organizationId: String(payload['sourceOrganizationId']),
    teamId: String(payload['teamId']),
    type: TENANT_REPARENT_JOB,
    payload,
  })
  await db.queueJob.update({
    where: { id: jobId.id },
    data: { status: 'running', lockedBy: workerId, lockedAt: new Date(), attempts: 1 },
  })
  const job = await db.queueJob.findUniqueOrThrow({ where: { id: jobId.id } })
  return {
    db,
    job,
    workerId,
    clock: () => new Date('2026-08-24T12:00:00.000Z'),
    writeAudit,
    progress: (value) => progress(db, job.id, workerId, value),
    terminalize: (tx, result) => complete(tx, job.id, workerId, result),
  }
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { organizationId: { in: organizationIds } } })
  await db.queueJob.deleteMany({ where: { organizationId: { in: organizationIds } } })
  for (const organizationId of [...organizationIds].reverse()) {
    await dropTenant(db, organizationId).catch(() => undefined)
  }
  await db.$disconnect()
})

describe('tenant reparent worker', () => {
  it('rewrites tenant-scoped rows, flips the team last, and audits completion', async () => {
    const source = await seedTenant(db)
    organizationIds.push(source.organizationId)
    const target = await db.organization.create({
      data: { externalOrgId: `org_target_${crypto.randomUUID()}`, name: 'Target org' },
    })
    organizationIds.push(target.id)
    await db.objectType.create({
      data: {
        organizationId: source.organizationId,
        teamId: source.teamId,
        slug: 'case',
        singularName: 'Case',
        pluralName: 'Cases',
        description: 'Case',
        kind: 'custom',
        createdByType: 'system',
        createdById: 'tenant-reparent-test',
      },
    })
    await tenantReparentHandler(await input({
      teamId: source.teamId,
      sourceOrganizationId: source.organizationId,
      targetOrganizationId: target.id,
      externalOrgId: target.externalOrgId,
      externalTeamId: source.externalTeamId,
      requestId: 'tenant_reparent_request',
      uoaUserId: 'usr_reparent',
    }))

    await expect(db.team.findUniqueOrThrow({ where: { id: source.teamId } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.objectType.findFirstOrThrow({ where: { teamId: source.teamId, slug: 'case' } }))
      .resolves.toMatchObject({ organizationId: target.id })
    await expect(db.auditLog.findFirstOrThrow({
      where: { organizationId: target.id, teamId: source.teamId, action: 'tenant.reparent.completed' },
    })).resolves.toMatchObject({
      actorType: 'system',
      actorId: 'tenant.reparent',
      onBehalfOf: 'usr_reparent',
    })
  })
})
