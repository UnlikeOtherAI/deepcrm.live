import { randomUUID } from 'node:crypto'

import { createDb, type PolicyAction, type PolicyResourceType } from '@deepcrm/db'
import { CrmActivityLog, CrmNoteAdd } from '@deepcrm/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP activity tests')

const db = createDb(databaseUrl)
const runKey = randomUUID()
const ToolResult = z.object({
  content: z.array(z.unknown()), structuredContent: z.unknown().optional(),
}).passthrough()
let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>
let organizationId: string
let teamId: string

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
  await db.record.deleteMany({ where: { organizationId, teamId } })
  const bindings = { create: [
    { actorType: 'agent', actorId: 'agent:dev:agent_dev' },
    { actorType: 'role', actorId: 'owner' },
  ] }
  const policies: Array<{ resourceType: PolicyResourceType; action: PolicyAction }> = [
    { resourceType: 'record', action: 'view' },
    { resourceType: 'record', action: 'create' },
    { resourceType: 'record', action: 'edit' },
    { resourceType: 'record', action: 'link' },
    { resourceType: 'attribute', action: 'view' },
    { resourceType: 'link', action: 'link' },
    { resourceType: 'schema', action: 'define' },
  ]
  for (const { resourceType, action } of policies) {
    await db.policyRule.create({ data: {
      organizationId, teamId, scope: 'team', scopeId: teamId, resourceType, action,
      effect: 'allow', priority: 100, requiresApproval: false,
      createdById: `activity-mcp-${runKey}`, bindings,
    } })
  }
  await call('crm_template_apply', { template: 'standard_crm' })
})

afterAll(async () => {
  await closeServer()
  await db.$disconnect()
})

describe('activity and note MCP tools', () => {
  it('logs idempotent activities about multiple records and advances last activity monotonically', async () => {
    const company = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(structured(
      await call('crm_record_create', {
        object_type: 'company', data: { name: 'Activity Company', domains: [`activity-${runKey}.example`] },
      }),
    )).record
    const person = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(structured(
      await call('crm_record_create', {
        object_type: 'person', data: {
          name: { full: 'Activity Person' }, emails: [`activity-${runKey}@example.com`],
        },
      }),
    )).record
    const about = [person.id, company.id]
    const occurredAt = '2026-08-24T14:00:00.000Z'
    const externalRef = `mcp-activity-${runKey}`
    const first = CrmActivityLog.out.parse(structured(await call('crm_activity_log', {
      kind: 'call', occurred_at: occurredAt, subject: 'Discovery call', about, external_ref: externalRef,
    })))
    const repeated = CrmActivityLog.out.parse(structured(await call('crm_activity_log', {
      kind: 'call', occurred_at: occurredAt, subject: 'Discovery call updated', about,
      external_ref: externalRef,
    })))
    expect(repeated.record.id).toBe(first.record.id)
    expect(repeated.record.data).toMatchObject({ subject: 'Discovery call updated' })

    await call('crm_activity_log', {
      kind: 'email', occurred_at: '2026-08-24T10:00:00.000Z', about: [person.id],
      external_ref: `mcp-older-${runKey}`,
    })
    const records = await db.record.findMany({
      where: { organizationId, teamId, id: { in: about } },
      select: { lastActivityAt: true },
    })
    expect(records).toHaveLength(2)
    expect(records.every((record) => record.lastActivityAt?.toISOString() === occurredAt)).toBe(true)

    const noteKey = `mcp-note-${runKey}`
    const note = CrmNoteAdd.out.parse(structured(await call('crm_note_add', {
      title: 'Follow-up', body: 'Send a proposal.', about, idempotency_key: noteKey,
    })))
    const noteReplay = CrmNoteAdd.out.parse(structured(await call('crm_note_add', {
      title: 'Follow-up', body: 'Send a proposal.', about, idempotency_key: noteKey,
    })))
    expect(noteReplay.record.id).toBe(note.record.id)
  })
})
