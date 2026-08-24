import { randomUUID } from 'node:crypto'

import { createDb, type PolicyResourceType } from '@deepcrm/db'
import { applyTemplate, loadSchema } from '@deepcrm/schema-engine'
import {
  CrmPipelineDefine,
  CrmPipelineStageSet,
  CrmPipelineStagesList,
  CrmPipelineSummary,
} from '@deepcrm/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP pipeline tests')
const db = createDb(databaseUrl)
const runKey = randomUUID()
const createdBy = `pipeline-mcp-${runKey}`
const pipelineSlug = `sales_${runKey.replaceAll('-', '_')}`
const ToolResult = z.object({
  content: z.array(z.unknown()), structuredContent: z.unknown().optional(),
}).passthrough()
let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>
let organizationId: string
let teamId: string
let auditIdsBefore = new Set<string>()

function structured(result: unknown): unknown {
  const parsed = ToolResult.parse(result)
  const text = z.object({ type: z.literal('text'), text: z.string() }).parse(parsed.content[0])
  const decoded: unknown = JSON.parse(text.text)
  expect(decoded).toEqual(parsed.structuredContent)
  return parsed.structuredContent
}

async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args })
}

beforeAll(async () => {
  const started = await startTestServer()
  client = started.client
  closeServer = started.close
  const team = await db.team.findUniqueOrThrow({
    where: { externalTeamId: 'team_dev' }, select: { id: true, organizationId: true },
  })
  organizationId = team.organizationId
  teamId = team.id
  auditIdsBefore = new Set((await db.auditLog.findMany({
    where: { organizationId, teamId }, select: { id: true },
  })).map((audit) => audit.id))
  await db.$transaction((tx) => applyTemplate(tx, { organizationId, teamId }, {
    type: 'system', id: 'pipeline-mcp-test', onBehalfOf: null, requestId: runKey,
  }, 'standard_crm'))
  const schema = await loadSchema(db, { organizationId, teamId })
  const deal = schema.objectTypesBySlug.get('deal')
  const amount = deal?.attributes.find((attribute) => attribute.slug === 'amount')
  if (deal === undefined || amount === undefined) throw new Error('deal pipeline schema missing')
  await db.attribute.update({
    where: { id: amount.id },
    data: { config: { defaultCurrency: 'GBP', fixedCurrency: 'GBP' } },
  })
  await db.team.update({ where: { id: teamId }, data: { schemaVersion: { increment: 1 } } })
  const rules: ReadonlyArray<Readonly<{ resourceType: PolicyResourceType; action: 'view' | 'create' | 'edit' | 'define' }>> = [
    { resourceType: 'record', action: 'view' },
    { resourceType: 'record', action: 'create' },
    { resourceType: 'record', action: 'edit' },
    { resourceType: 'attribute', action: 'view' },
    { resourceType: 'schema', action: 'view' },
    { resourceType: 'schema', action: 'define' },
  ]
  for (const rule of rules) {
    await db.policyRule.create({ data: {
      organizationId,
      teamId,
      scope: 'team',
      scopeId: teamId,
      resourceType: rule.resourceType,
      action: rule.action,
      effect: 'allow',
      priority: 100,
      requiresApproval: false,
      createdById: createdBy,
      bindings: { create: [
        { actorType: 'agent', actorId: 'agent:dev:agent_dev' },
        { actorType: 'role', actorId: 'owner' },
      ] },
    } })
  }
})

afterAll(async () => {
  await db.recordStageHistory.deleteMany({ where: { organizationId, teamId } })
  await db.record.deleteMany({ where: { organizationId, teamId, createdById: createdBy } })
  await db.pipelineStage.deleteMany({ where: { organizationId, teamId, pipeline: { slug: pipelineSlug } } })
  await db.pipeline.deleteMany({ where: { organizationId, teamId, slug: pipelineSlug } })
  await db.policyRule.deleteMany({ where: { organizationId, teamId, createdById: createdBy } })
  const newAuditIds = (await db.auditLog.findMany({
    where: { organizationId, teamId }, select: { id: true },
  })).map((audit) => audit.id).filter((id) => !auditIdsBefore.has(id))
  await db.auditLog.deleteMany({ where: { id: { in: newAuditIds } } })
  await closeServer()
  await db.$disconnect()
})

describe('pipeline MCP tool', () => {
  it('is discoverable with described fields and returns typed compact output', async () => {
    const listed = await client.listTools()
    for (const name of [
      'crm_pipeline_define',
      'crm_pipeline_update',
      'crm_pipeline_stage_set',
      'crm_pipeline_stages_list',
      'crm_pipeline_summary',
    ]) {
      const tool = listed.tools.find((candidate) => candidate.name === name)
      expect(tool?.description).toBeTypeOf('string')
      expect(tool?.inputSchema).toMatchObject({ properties: expect.any(Object) })
    }
    const summary = listed.tools.find((candidate) => candidate.name === 'crm_pipeline_summary')
    expect(summary?.description).toContain('Summarize visible live records')
    expect(summary?.inputSchema).toMatchObject({ properties: {
      object_type: { description: expect.any(String) },
      pipeline: { description: expect.any(String) },
      amount_attribute: { description: expect.any(String) },
      filter: { description: expect.any(String) },
      since: { description: expect.any(String) },
    } })

    const defined = CrmPipelineDefine.out.parse(structured(await call('crm_pipeline_define', {
      object_type: 'deal',
      slug: pipelineSlug,
      name: 'MCP Sales',
      description: 'Pipeline MCP test flow',
      is_default: true,
      stages: [
        { slug: 'lead', name: 'Lead', position: 0, category: 'open', probability: 0.1 },
        { slug: 'proposal', name: 'Proposal', position: 1, category: 'open', probability: 0.6 },
        { slug: 'won', name: 'Won', position: 2, category: 'won', probability: 1 },
      ],
    })))
    expect(defined.stages.map((stage) => stage.slug)).toEqual(['lead', 'proposal', 'won'])

    const listedStages = CrmPipelineStagesList.out.parse(structured(await call('crm_pipeline_stages_list', {
      object_type: 'deal',
      pipeline: pipelineSlug,
    })))
    expect(listedStages.stages.map((stage) => stage.slug)).toEqual(['lead', 'proposal', 'won'])

    const created = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(structured(await call(
      'crm_record_create',
      {
        object_type: 'deal',
        data: {
          name: `Pipeline ${runKey} Proposal`,
          stage: 'proposal',
          amount: { amount: '15', currency: 'GBP' },
        },
      },
    )))
    const now = Date.now()
    const firstAt = new Date(now - 2 * 86_400_000).toISOString()
    const secondAt = new Date(now - 86_400_000).toISOString()
    const lead = CrmPipelineStageSet.out.parse(structured(await call('crm_pipeline_stage_set', {
      record_id: created.record.id,
      pipeline: pipelineSlug,
      stage: 'lead',
      occurred_at: firstAt,
      reason: 'initial stage',
      idempotency_key: `pipeline-stage-lead-${runKey}`,
    })))
    expect(lead).toMatchObject({ record_id: created.record.id, pipeline: pipelineSlug, stage: 'lead', changed: true })
    const proposal = CrmPipelineStageSet.out.parse(structured(await call('crm_pipeline_stage_set', {
      record_id: created.record.id,
      pipeline: pipelineSlug,
      stage: 'proposal',
      occurred_at: secondAt,
      reason: 'qualified opportunity',
      idempotency_key: `pipeline-stage-proposal-${runKey}`,
    })))
    expect(proposal).toMatchObject({
      record_id: created.record.id, pipeline: pipelineSlug, stage: 'proposal', changed: true,
    })

    const result = CrmPipelineSummary.out.parse(structured(await call('crm_pipeline_summary', {
        object_type: 'deal',
        pipeline: pipelineSlug,
        amount_attribute: 'amount',
        filter: { system: 'display_name', op: 'starts_with', value: `Pipeline ${runKey}` },
      },
    )))
    expect(result.stages.find((stage) => stage.id === 'lead')).toMatchObject({
      count: 0, amount_sum: null, avg_days_in_stage: 1,
    })
    expect(result.stages.find((stage) => stage.id === 'proposal')).toMatchObject({
      count: 1, amount_sum: { amount: '15', currency: 'GBP' },
    })
    expect(result.conversions).toEqual([{ from: 'lead', to: 'proposal', count: 1 }])
  })
})
