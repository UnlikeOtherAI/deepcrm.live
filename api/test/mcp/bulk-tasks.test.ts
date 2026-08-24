import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  CancelTaskResultSchema,
  CreateTaskResultSchema,
  GetTaskPayloadResultSchema,
  GetTaskResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import { applyTemplate, FakeEmbedder } from '@deepcrm/schema-engine'
import { BulkAssertResult } from '@deepcrm/schemas'
import { startWorker } from '@deepcrm/worker'
import { createHandlers } from '@deepcrm/worker/dist/jobs/registry.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildMcpServer } from '../../src/mcp/server.js'
import { enqueueBulkAssert } from '../../src/services/bulk-assert.js'
import { standardRecordWrite } from '../../src/services/record-write-integration.js'
import { assertRecordWithIntegration } from '../../src/services/records.js'
import { linkContext, linkDeps, type LinkTenant } from '../db/link-fixture.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for bulk MCP tests')
const db = createDb(databaseUrl)
const deps = linkDeps(db)
let tenant: LinkTenant
let ctx: ReturnType<typeof linkContext>
let client: Client
let closeMcp: () => Promise<void>

function rows(total: number) {
  return Array.from({ length: total }, (_, index) => ({
    data: {
      name: { full: `Bulk Person ${index}` },
      emails: [`bulk-${index}@example.test`],
    },
  }))
}

async function waitForJob(id: string) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const job = await db.queueJob.findUniqueOrThrow({ where: { id } })
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Bulk MCP job did not become terminal')
}

beforeAll(async () => {
  const seeded = await seedTenant(db)
  tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  ctx = linkContext(tenant, 'uoa_bulk_owner')
  const actor = {
    type: ctx.actor.type,
    id: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    requestId: ctx.requestId,
  }
  await db.$transaction(async (tx) => {
    await applyTemplate(tx, tenant, actor, 'system')
    await applyTemplate(tx, tenant, actor, 'standard_crm')
  })
  for (const action of ['view', 'create', 'edit'] as const) {
    await db.policyRule.create({ data: {
      ...tenant, scope: 'team', scopeId: tenant.teamId,
      resourceType: 'record', action, effect: 'allow', priority: 100,
      createdById: 'bulk-mcp-test',
      bindings: { create: [{ actorType: 'role', actorId: 'owner' }] },
    } })
  }
  const server = buildMcpServer(ctx, deps)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'bulk-test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  closeMcp = async () => {
    await client.close()
    await server.close()
  }
})

afterAll(async () => {
  await closeMcp()
  await db.auditLog.deleteMany({ where: { organizationId: tenant.organizationId } })
  await dropTenant(db, tenant.organizationId)
  await db.$disconnect()
})

describe('bulk assert MCP Task', () => {
  it('runs 250 authoritative writes and binds logical replays to the bulk identity', async () => {
    const inputRows = rows(250)
    const idempotencyKey = `bulk-${crypto.randomUUID()}`
    const created = CreateTaskResultSchema.parse(await client.callTool({
      name: 'crm_records_bulk_assert',
      arguments: {
        object_type: 'person', match_attribute: 'emails', rows: inputRows,
        reason: 'test import', idempotency_key: idempotencyKey,
      },
    }))
    expect(created).not.toHaveProperty('resultType')
    const replayCtx = {
      ...ctx,
      requestId: crypto.randomUUID(),
      provenance: {
        runId: 'bulk-replay', toolCallId: crypto.randomUUID(), requestId: crypto.randomUUID(),
      },
    }
    const replay = await enqueueBulkAssert(deps, replayCtx, {
      objectType: 'person', matchAttribute: 'emails', rows: inputRows,
      reason: 'test import', idempotencyKey,
    })
    expect(replay.task.taskId).toBe(created.task.taskId)
    await expect(enqueueBulkAssert(deps, replayCtx, {
      objectType: 'person', matchAttribute: 'emails', rows: rows(249),
      reason: 'test import', idempotencyKey,
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
    await expect(enqueueBulkAssert({ ...deps, maxBulkRows: 2 }, ctx, {
      objectType: 'person', matchAttribute: 'emails', rows: rows(3),
    })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', details: { limit: 2 } })

    const recordAssert = async (
      workerCtx: Parameters<typeof assertRecordWithIntegration>[1],
      input: Parameters<typeof assertRecordWithIntegration>[2],
    ) => {
      const result = await assertRecordWithIntegration(
        deps, workerCtx, input, standardRecordWrite('crm_records_bulk_assert'),
      )
      return { created: result.created }
    }
    const controller = new AbortController()
    const worker = startWorker(
      { ...deps, writeAudit, ids: () => crypto.randomUUID() },
      createHandlers(recordAssert, new FakeEmbedder('bulk-test-v1'), deps.secretBox),
      controller.signal,
    )
    const stored = await waitForJob(created.task.taskId)
    controller.abort()
    await worker
    expect(stored.status).toBe('completed')

    const task = await client.request({
      method: 'tasks/get',
      params: { taskId: created.task.taskId, _meta: { progressToken: 'bulk-progress' } },
    }, GetTaskResultSchema)
    expect(task).toMatchObject({
      taskId: created.task.taskId,
      status: 'completed',
      statusMessage: 'Processed 250 of 250 rows',
    })
    const toolResult = await client.request({
      method: 'tasks/result', params: { taskId: created.task.taskId },
    }, GetTaskPayloadResultSchema)
    expect(BulkAssertResult.parse(toolResult.structuredContent)).toEqual({
      created: 250, updated: 0, failed: [],
    })
    expect(await db.record.count({ where: { ...tenant, objectType: { slug: 'person' } } })).toBe(250)
    expect(await db.idempotencyReplay.count({
      where: { ...tenant, tool: 'crm_records_bulk_assert' },
    })).toBe(250)
    expect(await db.auditLog.count({
      where: { ...tenant, action: 'crm_records_bulk_assert', outcome: 'success' },
    })).toBe(250)
  }, 60_000)

  it('returns standard safe get/cancel results and hides foreign, system and raw failures', async () => {
    const queued = await db.queueJob.create({ data: {
      ...tenant, type: 'records.bulk_assert', payload: {},
    } })
    const cancelled = await client.request({
      method: 'tasks/cancel', params: { taskId: queued.id },
    }, CancelTaskResultSchema)
    expect(cancelled).toMatchObject({ taskId: queued.id, status: 'cancelled' })
    expect(cancelled).not.toHaveProperty('progress')
    expect(cancelled).not.toHaveProperty('result')

    const failed = await db.queueJob.create({ data: {
      ...tenant, type: 'records.bulk_assert', payload: {}, status: 'failed',
      lastError: 'database password hunter2',
    } })
    const safe = await client.request({
      method: 'tasks/get', params: { taskId: failed.id },
    }, GetTaskResultSchema)
    expect(safe.statusMessage).toBe('Task failed')
    expect(JSON.stringify(safe)).not.toContain('hunter2')

    const other = await seedTenant(db)
    try {
      const otherCtx = linkContext({ organizationId: other.organizationId, teamId: other.teamId })
      const otherServer = buildMcpServer(otherCtx, linkDeps(db))
      const [otherClientTransport, otherServerTransport] = InMemoryTransport.createLinkedPair()
      const otherClient = new Client({ name: 'other-tenant', version: '0.0.0' })
      await otherServer.connect(otherServerTransport)
      await otherClient.connect(otherClientTransport)
      await expect(otherClient.request({
        method: 'tasks/get', params: { taskId: queued.id },
      }, GetTaskResultSchema)).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
      await otherClient.close()
      await otherServer.close()
    } finally {
      await dropTenant(db, other.organizationId)
    }
    const system = await db.queueJob.create({ data: {
      type: 'records.bulk_assert', payload: {},
    } })
    try {
      await expect(client.request({
        method: 'tasks/get', params: { taskId: system.id },
      }, GetTaskResultSchema)).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    } finally {
      await db.queueJob.delete({ where: { id: system.id } })
    }
    await expect(client.request({
      method: 'tasks/update', params: {},
    }, GetTaskResultSchema)).rejects.toMatchObject({ code: -32_601 })
  })
})
