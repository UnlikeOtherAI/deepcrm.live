import { randomUUID } from 'node:crypto'

import { createDb, type PolicyResourceType } from '@deepcrm/db'
import { applyTemplate, loadSchema } from '@deepcrm/schema-engine'
import { CrmPipelineSummary } from '@deepcrm/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP pipeline tests')
const db = createDb(databaseUrl)
const runKey = randomUUID()
const createdBy = `pipeline-mcp-${runKey}`
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
  const resourceTypes: PolicyResourceType[] = ['record', 'attribute']
  for (const resourceType of resourceTypes) {
    await db.policyRule.create({ data: {
      organizationId,
      teamId,
      scope: 'team',
      scopeId: teamId,
      resourceType,
      action: 'view',
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
  await db.record.createMany({ data: [
    {
      organizationId, teamId, objectTypeId: deal.id,
      data: { name: `Pipeline ${runKey} Proposal`, stage: 'proposal', amount: { amount: '15', currency: 'GBP' } },
      displayName: `Pipeline ${runKey} Proposal`, visibility: 'team',
      createdOnBehalfOf: 'user_dev', createdByType: 'system', createdById: createdBy,
    },
    {
      organizationId, teamId, objectTypeId: deal.id,
      data: { name: `Pipeline ${runKey} Won`, stage: 'won', amount: { amount: '25', currency: 'GBP' } },
      displayName: `Pipeline ${runKey} Won`, visibility: 'team',
      createdOnBehalfOf: 'user_dev', createdByType: 'system', createdById: createdBy,
    },
  ] })
})

afterAll(async () => {
  await db.record.deleteMany({ where: { organizationId, teamId, createdById: createdBy } })
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
    const tool = listed.tools.find((candidate) => candidate.name === 'crm_pipeline_summary')
    expect(tool?.description).toContain('Summarize visible live records')
    expect(tool?.inputSchema).toMatchObject({ properties: {
      object_type: { description: expect.any(String) },
      status_attribute: { description: expect.any(String) },
      amount_attribute: { description: expect.any(String) },
      filter: { description: expect.any(String) },
      since: { description: expect.any(String) },
    } })
    const result = CrmPipelineSummary.out.parse(structured(await client.callTool({
      name: 'crm_pipeline_summary',
      arguments: {
        object_type: 'deal',
        amount_attribute: 'amount',
        filter: { system: 'display_name', op: 'starts_with', value: `Pipeline ${runKey}` },
      },
    })))
    expect(result.stages.find((stage) => stage.id === 'proposal')).toMatchObject({
      count: 1, amount_sum: { amount: '15', currency: 'GBP' },
    })
    expect(result.stages.find((stage) => stage.id === 'won')).toMatchObject({
      count: 1, amount_sum: { amount: '25', currency: 'GBP' },
    })
    expect(result.conversions).toEqual([])
  })
})
