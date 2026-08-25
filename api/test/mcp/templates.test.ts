import { randomUUID } from 'node:crypto'

import { createDb, type PolicyAction, type PolicyResourceType } from '@deepcrm/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP template tests')

const db = createDb(databaseUrl)
const runKey = randomUUID().replaceAll('-', '_')
const createdBy = `templates-mcp-${runKey}`
const ToolResult = z.object({
  content: z.array(z.unknown()), structuredContent: z.unknown().optional(),
}).passthrough()
let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>
let organizationId: string
let teamId: string

function structured(result: unknown): Record<string, unknown> {
  const parsed = ToolResult.parse(result)
  const text = z.object({ type: z.literal('text'), text: z.string() }).parse(parsed.content[0])
  const decoded: unknown = JSON.parse(text.text)
  expect(decoded).toEqual(parsed.structuredContent)
  return z.record(z.unknown()).parse(parsed.structuredContent)
}

async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args })
}

async function allow(resourceType: PolicyResourceType, action: PolicyAction): Promise<void> {
  await db.policyRule.create({ data: {
    organizationId, teamId, scope: 'team', scopeId: teamId, resourceType, action,
    effect: 'allow', priority: 100, requiresApproval: false, createdById: createdBy,
    bindings: { create: [
      { actorType: 'agent', actorId: 'agent:dev:agent_dev' },
      { actorType: 'role', actorId: 'owner' },
    ] },
  } })
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
  for (const [resourceType, action] of [
    ['schema', 'view'], ['schema', 'define'], ['record', 'view'], ['record', 'create'],
    ['record', 'edit'], ['record', 'link'], ['link', 'link'], ['link', 'view'], ['attribute', 'edit'],
  ] as const) await allow(resourceType, action)
  await db.policyRule.create({ data: {
    organizationId, teamId, scope: 'team', scopeId: teamId, resourceType: 'attribute', action: 'view',
    effect: 'allow', priority: 100, requiresApproval: false, conditions: { sensitivity: 'internal' },
    createdById: createdBy,
    bindings: { create: [
      { actorType: 'agent', actorId: 'agent:dev:agent_dev' },
      { actorType: 'role', actorId: 'owner' },
    ] },
  } })
})

afterAll(async () => {
  await db.policyRule.deleteMany({ where: { organizationId, teamId, createdById: createdBy } })
  await closeServer()
  await db.$disconnect()
})

describe('standard sales and service templates over MCP', () => {
  it('applies templates twice and exercises leads, tickets, activities and redaction', async () => {
    for (const template of ['standard_crm', 'standard_sales', 'standard_service']) {
      await call('crm_template_apply', { template })
      const repeated = structured(await call('crm_template_apply', { template }))
      expect(repeated).toMatchObject({
        added: { object_types: 0, attributes: 0, relation_types: 0, pipelines: 0, matching_rules: 0 },
      })
    }

    const leadSchema = structured(await call('crm_schema_get', { object_type: 'lead' }))
    expect(leadSchema).toMatchObject({
      pipelines: [expect.objectContaining({ slug: 'lead_qualification' })],
      attributes: expect.arrayContaining([
        expect.objectContaining({ slug: 'lifecycle_stage' }),
        expect.objectContaining({ slug: 'person' }),
      ]),
    })
    const ticketSchema = structured(await call('crm_schema_get', { object_type: 'ticket' }))
    expect(ticketSchema).toMatchObject({
      pipelines: [expect.objectContaining({ slug: 'ticket_resolution' })],
      relation_types: expect.arrayContaining([
        expect.objectContaining({ slug: 'ticket_product' }),
        expect.objectContaining({ slug: 'ticket_activity' }),
      ]),
    })

    const person = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(structured(
      await call('crm_record_create', {
        object_type: 'person',
        data: { name: { full: `Template Person ${runKey}` }, emails: [`template-${runKey}@example.com`] },
      }),
    )).record
    const firstLead = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(structured(
      await call('crm_record_create', {
        object_type: 'lead',
        data: {
          name: `First pursuit ${runKey}`, lifecycle_stage: 'working', person: person.id,
          external_ref: `lead-one-${runKey}`,
        },
      }),
    )).record
    const secondLead = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(structured(
      await call('crm_record_create', {
        object_type: 'lead',
        data: {
          name: `Second pursuit ${runKey}`, lifecycle_stage: 'new', person: person.id,
          external_ref: `lead-two-${runKey}`,
        },
      }),
    )).record
    const linkedLeads = structured(await call('crm_links_list', {
      record_id: person.id, relation_type: 'lead_person', direction: 'to',
    }))
    expect(z.object({ links: z.array(z.unknown()) }).parse(linkedLeads).links).toHaveLength(2)
    expect(firstLead.id).not.toBe(secondLead.id)

    const ticket = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(structured(
      await call('crm_record_create', {
        object_type: 'ticket',
        data: {
          subject: `Service request ${runKey}`, status: 'new', priority: 'urgent',
          source_channel: 'email', person: person.id, external_ref: `ticket-${runKey}`,
        },
      }),
    )).record
    for (const [kind, occurredAt] of [
      ['call', '2026-08-24T10:00:00.000Z'],
      ['email', '2026-08-24T11:00:00.000Z'],
      ['meeting', '2026-08-24T12:00:00.000Z'],
    ] as const) {
      await call('crm_activity_log', {
        kind, occurred_at: occurredAt, subject: `${kind} about ticket`, about: [ticket.id],
        external_ref: `${kind}-${runKey}`,
      })
    }
    const restrictedActivity = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(structured(
      await call('crm_record_create', {
        object_type: 'activity',
        data: {
          kind: 'call', occurred_at: '2026-08-24T13:00:00.000Z',
          subject: 'Restricted transcript', transcript: 'sensitive transcript',
        },
      }),
    )).record
    await call('crm_link', {
      relation_type: 'activity_about', from_record_id: restrictedActivity.id, to_record_id: ticket.id,
    })

    const timeline = z.object({
      items: z.array(z.object({
        kind: z.string(),
        record: z.object({
          id: z.string().uuid(),
          data: z.record(z.unknown()),
          redacted_attributes: z.array(z.string()),
        }),
      }).passthrough()),
    }).parse(structured(await call('crm_record_timeline', {
      id: ticket.id, kinds: ['activity'], limit: 10,
    })))
    expect(timeline.items.map((item) => item.record.data.kind).sort())
      .toEqual(['call', 'call', 'email', 'meeting'])
    const restricted = timeline.items.find((item) => item.record.id === restrictedActivity.id)
    expect(restricted?.record.data).not.toHaveProperty('transcript')
    expect(restricted?.record.redacted_attributes).toContain('transcript')
  })
})
