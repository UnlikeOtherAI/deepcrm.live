import { complete, enqueue, progress } from '@deepcrm/queue'
import { createDb, dropTenant, seedTenant, writeAudit, type Prisma } from '@deepcrm/db'
import {
  createRecord,
  defineAttribute,
  defineDerivedAttribute,
  defineObjectType,
  loadSchema,
  type LinkWriter,
  type LinkWriteResult,
} from '@deepcrm/schema-engine'
import { type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { JobHandlerInput } from '../../src/index.js'
import { DERIVED_REFRESH_JOB, derivedRefreshHandler } from '../../src/jobs/derived-refresh.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for derived refresh worker tests')
const db = createDb(databaseUrl)
const organizations: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')
const noLinks: LinkWriter = {
  apply: async (): Promise<LinkWriteResult> => { throw new Error('Projection link writer must not run') },
  delete: async () => ({ changes: [], touchedRecordIds: [] }),
  restore: async () => ({ changes: [], touchedRecordIds: [] }),
}

function actor() {
  return { type: 'system' as const, id: 'derived-worker-test', onBehalfOf: null, requestId: crypto.randomUUID() }
}

function context(tenant: { organizationId: string; teamId: string }): ActorContext {
  return {
    tenant,
    app: 'test',
    actChain: [],
    actor: { type: 'system', id: 'derived-worker-test' },
    onBehalfOf: { uoaUserId: 'derived-worker-user', role: 'owner' },
    provenance: null,
    requestId: crypto.randomUUID(),
    now,
  }
}

async function input(tenant: { organizationId: string; teamId: string }, recordId: string): Promise<JobHandlerInput> {
  const queued = await enqueue(db, {
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    type: DERIVED_REFRESH_JOB,
    payload: { organizationId: tenant.organizationId, teamId: tenant.teamId, sourceRecordIds: [recordId] },
    idempotencyKey: `derived-worker:${recordId}`,
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
    terminalize: (tx, result) => complete(tx, job.id, workerId, result),
  }
}

async function fixture() {
  const tenant = await seedTenant(db)
  organizations.push(tenant.organizationId)
  await db.$transaction(async (tx) => {
    await defineObjectType(tx, tenant, actor(), {
      slug: 'deal', singularName: 'Deal', pluralName: 'Deals', description: 'Deals',
    })
    await defineAttribute(tx, tenant, actor(), {
      objectType: 'deal', slug: 'amount', name: 'Amount', description: 'Amount',
      type: 'number', config: { type: 'number', min: 0 },
      is_multi: false, is_required: false, is_unique: false, is_indexed: true, sensitivity: 'internal',
    })
    await defineDerivedAttribute(tx, tenant, actor(), {
      objectType: 'deal', slug: 'score', name: 'Score', description: 'Score',
      type: 'number', config: { type: 'number', min: 0 },
      isRequired: false, isIndexed: true, sensitivity: 'internal',
      valueSource: 'formula',
      derivationConfig: {
        expression: {
          kind: 'binary', op: 'add',
          left: { kind: 'attribute', attribute: 'amount' },
          right: { kind: 'literal', value: 10 },
        },
      },
    })
  })
  const ctx = context(tenant)
  const schema = await loadSchema(db, tenant)
  const created = await db.$transaction((tx) => createRecord(tx, ctx, schema, {
    objectType: 'deal', data: { amount: 15 },
  }, noLinks))
  return { tenant, recordId: created.record.id }
}

afterAll(async () => {
  for (const organizationId of organizations) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('derived refresh worker', () => {
  it('materializes changed records and schedules reindexing', async () => {
    const target = await fixture()
    await derivedRefreshHandler(await input(target.tenant, target.recordId))
    const record = await db.record.findUniqueOrThrow({ where: { id: target.recordId } })
    expect(record.data).toMatchObject({ score: '25' })
    const reindex = await db.queueJob.findFirst({
      where: { organizationId: target.tenant.organizationId, teamId: target.tenant.teamId, type: 'record.reindex' },
    })
    expect(reindex?.payload).toMatchObject({ recordId: target.recordId })
  })
})
