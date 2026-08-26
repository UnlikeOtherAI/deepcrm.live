import { createDb, dropTenant, seedTenant, tenantWhere, type TenantRef } from '@deepcrm/db'
import { ErrorCode, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import {
  applyTemplate,
  createRecord,
  definePipeline,
  loadSchema,
  setRecordStage,
  type LinkWriter,
  type LinkWriteResult,
} from '../../src/index.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for pipeline stage tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const noLinks: LinkWriter = {
  apply: async (): Promise<LinkWriteResult> => { throw new Error('Projection link writer must not run') },
  delete: async () => ({ changes: [], touchedRecordIds: [] }),
  restore: async () => ({ changes: [], touchedRecordIds: [] }),
}

function actor(): { type: 'system'; id: string; onBehalfOf: null; requestId: string } {
  return { type: 'system', id: 'pipeline-stage-test', onBehalfOf: null, requestId: crypto.randomUUID() }
}

function context(tenant: TenantRef, now: Date): ActorContext {
  return {
    tenant,
    app: 'pipeline-stage-test',
    actor: { type: 'system', id: 'pipeline-stage-test' },
    onBehalfOf: { uoaUserId: 'pipeline-stage-user', role: 'owner' },
    provenance: null,
    actChain: [],
    requestId: crypto.randomUUID(),
    now,
  }
}

async function fixture() {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  await db.$transaction((tx) => applyTemplate(tx, tenant, actor(), 'standard_crm'))
  const schema = await loadSchema(db, tenant)
  await db.$transaction((tx) => definePipeline(tx, tenant, actor(), schema, {
    objectType: 'deal',
    slug: 'sales_pipeline',
    name: 'Sales Pipeline',
    description: 'Pipeline stage invariant test',
    isDefault: true,
    stages: [
      { slug: 'lead', name: 'Lead', position: 0, category: 'open', probability: 0.1 },
      { slug: 'proposal', name: 'Proposal', position: 1, category: 'open', probability: 0.6 },
      { slug: 'won', name: 'Won', position: 2, category: 'won', probability: 1 },
    ],
  }))
  const reloaded = await loadSchema(db, tenant)
  const ctx = context(tenant, new Date('2026-08-24T12:00:00.000Z'))
  const created = await db.$transaction((tx) => createRecord(tx, ctx, reloaded, {
    objectType: 'deal',
    data: { name: 'Out-of-order pipeline deal', stage: 'lead' },
  }, noLinks))
  return { tenant, schema: reloaded, ctx, recordId: created.record.id }
}

afterAll(async () => {
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('pipeline stage transitions', () => {
  it('rejects out-of-order moves without creating negative intervals or side effects', async () => {
    const value = await fixture()
    const firstAt = new Date('2026-08-24T12:00:00.000Z')
    const secondAt = new Date('2026-08-25T12:00:00.000Z')
    const staleAt = new Date('2026-08-25T11:59:59.999Z')
    const first = await db.$transaction((tx) => setRecordStage(tx, value.ctx, value.schema, {
      recordId: value.recordId,
      pipeline: 'sales_pipeline',
      stage: 'lead',
      occurredAt: firstAt,
    }))
    expect(first.changed).toBe(true)
    const second = await db.$transaction((tx) => setRecordStage(tx, value.ctx, value.schema, {
      recordId: value.recordId,
      pipeline: 'sales_pipeline',
      stage: 'proposal',
      occurredAt: secondAt,
    }))
    expect(second.changed).toBe(true)
    const before = {
      record: await db.record.findUniqueOrThrow({ where: { id: value.recordId }, select: { version: true } }),
      changes: await db.recordChange.count({ where: { ...tenantWhere(value.tenant), recordId: value.recordId } }),
      audits: await db.auditLog.count({ where: { ...tenantWhere(value.tenant), resourceId: value.recordId } }),
    }

    await expect(db.$transaction((tx) => setRecordStage(tx, value.ctx, value.schema, {
      recordId: value.recordId,
      pipeline: 'sales_pipeline',
      stage: 'won',
      occurredAt: staleAt,
    }))).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED })

    const histories = await db.recordStageHistory.findMany({
      where: { ...tenantWhere(value.tenant), recordId: value.recordId },
      include: { stage: { select: { slug: true } } },
      orderBy: { startedAt: 'asc' },
    })
    expect(histories.map((row) => ({
      stage: row.stage.slug,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
    }))).toEqual([
      { stage: 'lead', startedAt: firstAt.toISOString(), endedAt: secondAt.toISOString() },
      { stage: 'proposal', startedAt: secondAt.toISOString(), endedAt: null },
    ])
    for (const history of histories) {
      if (history.endedAt !== null) expect(history.endedAt.getTime()).toBeGreaterThanOrEqual(history.startedAt.getTime())
    }
    await expect(db.record.findUniqueOrThrow({
      where: { id: value.recordId }, select: { version: true },
    })).resolves.toEqual(before.record)
    await expect(db.recordChange.count({
      where: { ...tenantWhere(value.tenant), recordId: value.recordId },
    })).resolves.toBe(before.changes)
    await expect(db.auditLog.count({
      where: { ...tenantWhere(value.tenant), resourceId: value.recordId },
    })).resolves.toBe(before.audits)
  })
})
