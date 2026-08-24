import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CreateTaskResultSchema, GetTaskPayloadResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import { applyTemplate, FakeEmbedder, loadSchema } from '@deepcrm/schema-engine'
import { FindDuplicatesResult } from '@deepcrm/schemas'
import { startWorker } from '@deepcrm/worker'
import { createHandlers } from '@deepcrm/worker/dist/jobs/registry.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildMcpServer } from '../../src/mcp/server.js'
import { linkContext, linkDeps, type LinkTenant } from '../db/link-fixture.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for duplicate MCP tests')
const db = createDb(databaseUrl)
const deps = linkDeps(db)
let tenant: LinkTenant
let client: Client
let closeMcp: () => Promise<void>

async function waitForJob(id: string) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const job = await db.queueJob.findUniqueOrThrow({ where: { id } })
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Duplicate scan did not become terminal')
}

beforeAll(async () => {
  const seeded = await seedTenant(db)
  tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  const ctx = linkContext(tenant, 'uoa_dedup_owner')
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
  const schema = await loadSchema(db, tenant)
  const company = schema.objectTypesBySlug.get('company')
  if (company === undefined) throw new Error('Company template is missing')
  for (const name of ['Acme Limited', 'Acme Limitedd', 'Acme Limite']) {
    await db.record.create({ data: {
      ...tenant,
      objectTypeId: company.id,
      data: { name, domains: [`${name.toLowerCase().replaceAll(' ', '-')}.test`] },
      displayName: name,
      visibility: 'team',
      createdOnBehalfOf: ctx.onBehalfOf.uoaUserId,
      createdByType: 'human',
      createdById: ctx.actor.id,
    } })
  }
  await db.record.create({ data: {
    ...tenant,
    objectTypeId: company.id,
    data: { name: 'Acme Hidden' },
    displayName: 'Acme Hidden',
    visibility: 'private',
    createdOnBehalfOf: 'uoa_other_user',
    createdByType: 'human',
    createdById: 'uoa_other_user',
  } })
  const server = buildMcpServer(ctx, deps)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'dedup-test', version: '0.0.0' })
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

describe('duplicate scan MCP Task', () => {
  it('coalesces concurrent scans and returns only visible evidence groups', async () => {
    const args = { object_type: 'company', include_semantic: false }
    const first = CreateTaskResultSchema.parse(await client.callTool({
      name: 'crm_find_duplicates', arguments: args,
    }))
    const second = CreateTaskResultSchema.parse(await client.callTool({
      name: 'crm_find_duplicates', arguments: args,
    }))
    expect(second.task.taskId).toBe(first.task.taskId)

    const controller = new AbortController()
    const worker = startWorker(
      { ...deps, writeAudit, ids: () => crypto.randomUUID() },
      createHandlers(
        async () => { throw new Error('unexpected bulk assert') },
        new FakeEmbedder(),
        deps.secretBox,
        async () => { throw new Error('unexpected export') },
        { exportDir: '.exports-test', maxExportRows: 100_000, publicUrl: 'http://127.0.0.1', retentionDays: 30 },
      ),
      controller.signal,
    )
    const job = await waitForJob(first.task.taskId)
    controller.abort()
    await worker
    expect(job.status).toBe('completed')

    const payload = await client.request({
      method: 'tasks/result', params: { taskId: first.task.taskId },
    }, GetTaskPayloadResultSchema)
    const result = FindDuplicatesResult.parse(payload.structuredContent)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]?.records.map((record) => record.display_name).sort())
      .toEqual(['Acme Limited', 'Acme Limitedd', 'Acme Limite'].sort())
    expect(result.groups[0]?.evidence).toEqual([
      expect.objectContaining({ kind: 'fuzzy', attribute: 'name', matched: true }),
    ])
  }, 20_000)
})
