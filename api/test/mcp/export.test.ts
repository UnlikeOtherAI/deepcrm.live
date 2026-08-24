import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CreateTaskResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { createDb, writeAudit } from '@deepcrm/db'
import { applyTemplate, FakeEmbedder } from '@deepcrm/schema-engine'
import { ExportResult } from '@deepcrm/schemas'
import { startWorker } from '@deepcrm/worker'
import { createHandlers } from '@deepcrm/worker/dist/jobs/registry.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { queryRecordsForExport } from '../../src/services/record-query.js'
import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for export MCP tests')
const db = createDb(databaseUrl)
let exportDir: string
let started: Awaited<ReturnType<typeof startTestServer>>
let team: { id: string; organizationId: string }
const createdById = `export-test-${crypto.randomUUID()}`
const recordPrefix = `Export ${createdById} Deal `

async function waitForJob(id: string) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const job = await db.queueJob.findUniqueOrThrow({ where: { id } })
    if (job.status === 'completed' || job.status === 'failed') return job
    if (job.lastError !== null) throw new Error(job.lastError)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Export job did not become terminal')
}

beforeAll(async () => {
  exportDir = await mkdtemp(join(tmpdir(), 'deepcrm-export-test-'))
  started = await startTestServer({ exportDir })
  await started.client.listTools()
  team = await db.team.findUniqueOrThrow({
    where: { externalTeamId: 'team_dev' }, select: { id: true, organizationId: true },
  })
  const tenant = { organizationId: team.organizationId, teamId: team.id }
  await db.$transaction(async (tx) => {
    await applyTemplate(tx, tenant, {
      type: 'agent', id: 'agent:dev:agent_dev', onBehalfOf: 'usr_dev', requestId: crypto.randomUUID(),
    }, 'system')
    await applyTemplate(tx, tenant, {
      type: 'agent', id: 'agent:dev:agent_dev', onBehalfOf: 'usr_dev', requestId: crypto.randomUUID(),
    }, 'standard_crm')
  })
  for (const rule of [
    { resourceType: 'export' as const, action: 'export' as const },
    { resourceType: 'record' as const, action: 'view' as const },
    { resourceType: 'attribute' as const, action: 'view' as const },
    { resourceType: 'view' as const, action: 'view' as const },
  ]) {
    await db.policyRule.create({ data: {
      ...tenant,
      scope: 'team',
      scopeId: team.id,
      ...rule,
      effect: 'allow',
      priority: 500,
      requiresApproval: false,
      createdById,
      bindings: { create: [
        { actorType: 'agent', actorId: 'agent:dev:agent_dev' },
        { actorType: 'role', actorId: 'owner' },
      ] },
    } })
  }
})

afterAll(async () => {
  if (team !== undefined) {
    await db.record.deleteMany({ where: {
      organizationId: team.organizationId, teamId: team.id, createdById,
    } })
    await db.policyRule.deleteMany({ where: {
      organizationId: team.organizationId, teamId: team.id, createdById,
    } })
    await db.view.deleteMany({ where: {
      organizationId: team.organizationId, teamId: team.id, createdById,
    } })
    await db.queueJob.deleteMany({ where: {
      organizationId: team.organizationId, teamId: team.id, type: 'records.export',
    } })
  }
  if (started !== undefined) await started.close()
  await db.$disconnect()
  if (exportDir !== undefined) await rm(exportDir, { recursive: true, force: true })
})

describe('crm_export MCP task and signed download', () => {
  it('exports 12 deals to RFC 4180 CSV and permits one future download', async () => {
    const deal = await db.objectType.findFirstOrThrow({
      where: { organizationId: team.organizationId, teamId: team.id, slug: 'deal' },
      select: { id: true },
    })
    await db.record.createMany({
      data: Array.from({ length: 12 }, (_, index) => ({
        organizationId: team.organizationId,
        teamId: team.id,
        objectTypeId: deal.id,
        data: { name: `${recordPrefix}${index + 1}`, stage: 'lead' },
        displayName: `${recordPrefix}${index + 1}`,
        visibility: 'team' as const,
        createdOnBehalfOf: 'usr_dev',
        createdByType: 'agent' as const,
        createdById,
      })),
    })
    const view = await db.view.create({ data: {
      organizationId: team.organizationId,
      teamId: team.id,
      objectTypeId: deal.id,
      slug: `export_${crypto.randomUUID().replaceAll('-', '_')}`,
      name: 'Export acceptance deals',
      description: 'Only the twelve deals created by the export acceptance test.',
      filter: { attribute: 'name', op: 'starts_with', value: recordPrefix },
      sort: [{ system: 'created_at', direction: 'desc' }],
      attributes: ['name', 'stage'],
      createdByType: 'agent',
      createdById,
    } })
    const created = CreateTaskResultSchema.parse(await started.client.callTool({
      name: 'crm_export',
      arguments: { view: view.slug, format: 'csv', attributes: ['name', 'stage'] },
    }))
    const exportPage = async (
      ctx: Parameters<typeof queryRecordsForExport>[1],
      input: Parameters<typeof queryRecordsForExport>[2],
    ) => {
      const result = await queryRecordsForExport(started.deps, ctx, input)
      return {
        records: result.records.map((record) => ({ data: record.data })),
        nextCursor: result.next_cursor,
        ...(result.total === undefined ? {} : { total: result.total }),
      }
    }
    const controller = new AbortController()
    const worker = startWorker(
      { ...started.deps, writeAudit, ids: () => crypto.randomUUID() },
      createHandlers(
        async () => { throw new Error('unexpected bulk assert') },
        new FakeEmbedder('export-test'),
        started.deps.secretBox,
        exportPage,
        {
          exportDir,
          maxExportRows: 100_000,
          publicUrl: 'http://127.0.0.1',
          retentionDays: 30,
        },
      ),
      controller.signal,
    )
    let stored: Awaited<ReturnType<typeof waitForJob>>
    try {
      stored = await waitForJob(created.task.taskId)
    } finally {
      controller.abort()
      await worker
    }
    expect(stored.status).toBe('completed')
    const result = ExportResult.parse(stored.result)
    expect(result.rows).toBe(12)

    const download = new URL(result.url)
    download.host = started.url.host
    const response = await fetch(download)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/csv')
    const csv = await response.text()
    expect(csv.split('\r\n').filter((line) => line !== '')).toHaveLength(13)
    expect(csv.startsWith('name,stage\r\n')).toBe(true)
    expect((await fetch(download)).status).toBe(404)

    const expired = Math.floor(Date.now() / 1_000) - 1
    const signature = started.deps.secretBox.sign(
      Buffer.from(`${created.task.taskId}:${expired}`, 'utf8'),
      'export',
    )
    const expiredUrl = new URL(`/exports/${created.task.taskId}`, started.url)
    expiredUrl.searchParams.set('sig', signature)
    expiredUrl.searchParams.set('exp', String(expired))
    expect((await fetch(expiredUrl)).status).toBe(403)
  }, 30_000)
})
