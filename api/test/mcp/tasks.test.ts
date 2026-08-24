import { randomUUID } from 'node:crypto'

import { createDb, type PolicyAction, type PolicyResourceType } from '@deepcrm/db'
import { CrmTaskCreate, CrmTasksList, CrmTaskUpdate } from '@deepcrm/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP task tests')

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
      createdById: `tasks-mcp-${runKey}`, bindings,
    } })
  }
  await call('crm_template_apply', { template: 'standard_crm' })
})

afterAll(async () => {
  await closeServer()
  await db.$disconnect()
})

describe('task MCP tools', () => {
  it('creates an assigned task, lists it and clears nullable fields while completing it', async () => {
    const company = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(structured(
      await call('crm_record_create', {
        object_type: 'company',
        data: { name: 'Task Company', domains: [`tasks-${runKey}.example`] },
      }),
    )).record
    const created = CrmTaskCreate.out.parse(structured(await call('crm_task_create', {
      title: 'Send proposal',
      body: 'Prepare the final proposal.',
      due_at: '2026-08-24T18:00:00.000Z',
      assignee: { type: 'agent', id: 'agent_dev' },
      about: [company.id],
      reason: 'Customer follow-up',
      idempotency_key: `task-create-${runKey}`,
    })))
    expect(created.record.data).toMatchObject({
      title: 'Send proposal', status: 'open', priority: 'normal',
      assignee: { type: 'agent', id: 'agent_dev' },
    })
    expect(await db.recordLink.count({
      where: {
        organizationId, teamId, fromRecordId: created.record.id, activeUntil: null,
        relationType: { slug: 'task_about' },
      },
    })).toBe(1)

    const listed = CrmTasksList.out.parse(structured(await call('crm_tasks_list', {
      status: 'open',
      assignee: { type: 'agent', id: 'agent_dev' },
      about: company.id,
    })))
    expect(listed.records.map((record) => record.id)).toEqual([created.record.id])

    const updated = CrmTaskUpdate.out.parse(structured(await call('crm_task_update', {
      id: created.record.id,
      status: 'done',
      assignee: null,
      due_at: null,
      body: null,
      expected_version: created.record.version,
      reason: 'Work completed',
      idempotency_key: `task-update-${runKey}`,
    })))
    expect(updated.record.data).toMatchObject({ status: 'done', priority: 'normal' })
    expect(updated.record.data).not.toHaveProperty('assignee')
    expect(updated.record.data).not.toHaveProperty('due_at')
    expect(updated.record.data).not.toHaveProperty('body')
    const done = CrmTasksList.out.parse(structured(await call('crm_tasks_list', {
      status: 'done', about: company.id,
    })))
    expect(done.records.map((record) => record.id)).toEqual([created.record.id])
  })
})
