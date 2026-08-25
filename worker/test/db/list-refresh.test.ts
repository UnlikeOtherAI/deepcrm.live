import { enqueue, progress } from '@deepcrm/queue'
import { createDb, dropTenant, seedTenant, writeAudit, type Prisma, type TenantRef } from '@deepcrm/db'
import { applyTemplate, loadSchema } from '@deepcrm/schema-engine'
import { type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { JobHandlerInput } from '../../src/index.js'
import { listRefreshHandler, LIST_REFRESH_JOB } from '../../src/jobs/list-refresh.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for list refresh worker tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')

function tenantData(tenant: TenantRef): TenantRef {
  return { organizationId: tenant.organizationId, teamId: tenant.teamId }
}

function actorContext(tenant: TenantRef): ActorContext {
  return {
    tenant,
    app: 'test',
    actChain: [],
    actor: { type: 'system', id: 'list-refresh-test' },
    onBehalfOf: { uoaUserId: 'list-refresh-user', role: 'owner' },
    provenance: null,
    requestId: crypto.randomUUID(),
    now,
  }
}

async function input(tenant: TenantRef, listId: string, evaluationVersion: number): Promise<JobHandlerInput> {
  const ctx = actorContext(tenant)
  const queued = await enqueue(db, {
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    type: LIST_REFRESH_JOB,
    payload: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      listId,
      evaluationVersion,
      actorContext: {
        app: ctx.app,
        actChain: ctx.actChain,
        actor: ctx.actor,
        onBehalfOf: ctx.onBehalfOf,
        provenance: ctx.provenance,
        requestId: ctx.requestId,
      },
    },
    idempotencyKey: `list-refresh-worker:${listId}:${evaluationVersion}`,
  })
  const workerId = crypto.randomUUID()
  await db.queueJob.update({
    where: { id: queued.id },
    data: { status: 'running', lockedBy: workerId, lockedAt: now, attempts: { increment: 1 } },
  })
  const job = await db.queueJob.findUniqueOrThrow({ where: { id: queued.id } })
  return {
    db,
    job,
    workerId,
    clock: () => now,
    writeAudit,
    progress: (value: Prisma.InputJsonValue) => progress(db, job.id, workerId, value),
    terminalize: async () => false,
  }
}

async function fixture() {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  await db.$transaction((tx) => applyTemplate(tx, tenant, {
    type: 'system', id: 'list-refresh-test', onBehalfOf: null, requestId: crypto.randomUUID(),
  }, 'standard_crm'))
  const schema = await loadSchema(db, tenant)
  const company = schema.objectTypesBySlug.get('company')
  if (company === undefined) throw new Error('company template missing')
  const visible = await db.record.create({ data: {
    ...tenantData(tenant), objectTypeId: company.id, data: { name: 'Acme One' }, displayName: 'Acme One',
    visibility: 'team', createdOnBehalfOf: 'list-refresh-user', createdByType: 'system', createdById: 'list-refresh-test',
  } })
  await db.record.create({ data: {
    ...tenantData(tenant), objectTypeId: company.id, data: { name: 'Acme Hidden' }, displayName: 'Acme Hidden',
    visibility: 'private', createdOnBehalfOf: 'different-user', createdByType: 'system', createdById: 'list-refresh-test',
  } })
  await db.record.create({ data: {
    ...tenantData(tenant), objectTypeId: company.id, data: { name: 'Beta Two' }, displayName: 'Beta Two',
    visibility: 'team', createdOnBehalfOf: 'list-refresh-user', createdByType: 'system', createdById: 'list-refresh-test',
  } })
  const list = await db.list.create({ data: {
    ...tenantData(tenant), kind: 'dynamic', slug: 'acme_companies', name: 'Acme companies',
    description: 'Companies named Acme.', objectTypeId: company.id,
    definition: { filter: { system: 'display_name', op: 'starts_with', value: 'Acme' } },
    evaluationVersion: 1, refreshState: 'refreshing', createdByType: 'system', createdById: 'list-refresh-test',
  } })
  return { tenant, listId: list.id, visibleId: visible.id }
}

afterAll(async () => {
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('dynamic list refresh worker', () => {
  it('materializes the evaluation-version cache with only visible matching records', async () => {
    const target = await fixture()
    await listRefreshHandler(await input(target.tenant, target.listId, 1))
    const list = await db.list.findUniqueOrThrow({ where: { id: target.listId } })
    expect(list).toMatchObject({ refreshState: 'ready', refreshErrorCode: null })
    expect(list.lastEvaluatedAt?.toISOString()).toBe(now.toISOString())
    const entries = await db.$queryRaw<Array<{ recordId: string }>>`
      SELECT le.record_id AS "recordId" FROM list_entries le JOIN lists l ON l.id = le.list_id
      WHERE l.id = ${target.listId}::uuid
        AND l.organization_id = ${target.tenant.organizationId}::uuid
        AND l.team_id = ${target.tenant.teamId}::uuid
      ORDER BY le.position ASC
    `
    expect(entries.map((entry) => entry.recordId)).toEqual([target.visibleId])
    const job = await db.queueJob.findFirstOrThrow({
      where: { organizationId: target.tenant.organizationId, teamId: target.tenant.teamId, type: LIST_REFRESH_JOB },
    })
    expect(job.result).toMatchObject({ listId: target.listId, evaluationVersion: 1, members: 1 })
  })
})
