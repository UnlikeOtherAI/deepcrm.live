import { randomUUID } from 'node:crypto'
import { createDb } from '@deepcrm/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP value hint tests')

const db = createDb(databaseUrl)
const ruleOwner = 'value-hints-mcp'
const runKey = randomUUID()
const ToolResult = z.object({
  content: z.array(z.unknown()),
  structuredContent: z.record(z.unknown()),
  isError: z.boolean().optional(),
}).passthrough()
const ObjectDetail = z.object({
  attributes: z.array(z.object({ slug: z.string(), example: z.unknown().optional() }).passthrough()),
}).passthrough()

let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>
let tenant: { organizationId: string; teamId: string }

async function call(name: string, args: Record<string, unknown>) {
  return ToolResult.parse(await client.callTool({ name, arguments: args }))
}

beforeAll(async () => {
  const started = await startTestServer()
  client = started.client
  closeServer = started.close
  const team = await db.team.findUniqueOrThrow({
    where: { externalTeamId: 'team_dev' }, select: { id: true, organizationId: true },
  })
  tenant = { organizationId: team.organizationId, teamId: team.id }
  const grants = [
    ['schema', 'view'], ['schema', 'define'], ['record', 'view'], ['record', 'create'], ['attribute', 'view'],
  ] as const
  for (const [resourceType, action] of grants) {
    await db.policyRule.create({ data: {
      organizationId: team.organizationId, teamId: team.id, scope: 'team', scopeId: team.id,
      resourceType, action, effect: 'allow', priority: 100, requiresApproval: false, createdById: ruleOwner,
      bindings: { create: [
        { actorType: 'agent', actorId: 'agent:dev:agent_dev' }, { actorType: 'role', actorId: 'owner' },
      ] },
    } })
  }
  const applied = await call('crm_template_apply', { template: 'standard_crm' })
  expect(applied.isError ?? false).toBe(false)
})

afterAll(async () => {
  await db.policyRule.deleteMany({ where: { ...tenant, createdById: ruleOwner } })
  await closeServer()
  await db.$disconnect()
})

describe('value shape hints', () => {
  it('shows one example per attribute in the object detail and keeps crm://schema compact', async () => {
    const person = ObjectDetail.parse((await call('crm_schema_get', { object_type: 'person' })).structuredContent)
    const examples = new Map(person.attributes.map((attribute) => [attribute.slug, attribute.example]))
    expect(examples.get('name')).toEqual({ full: 'Ada Lovelace' })
    expect(examples.get('emails')).toEqual(['ada@example.com'])
    expect(examples.get('lifecycle_stage')).toBe('prospect')
    expect(examples.get('company')).toMatch(/^[0-9a-f-]{36}$/u)
    const snapshot = (await call('crm_schema_get', {})).structuredContent
    expect(JSON.stringify(snapshot)).not.toContain('"example"')
  })

  it('names the type and an accepted value when crm_record_create refuses a value', async () => {
    const refused = await call('crm_record_create', {
      object_type: 'person', data: { name: `Nessie agent check ${runKey}` },
    })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'Record data validation failed',
      next: 'fix_input',
      issues: [{
        path: '/name', message: 'Invalid attribute value', type: 'personal_name', expected: { full: 'Ada Lovelace' },
      }],
    })
    const created = await call('crm_record_create', {
      object_type: 'person', data: { name: { full: `Nessie agent check ${runKey}` } },
    })
    expect(created.isError ?? false).toBe(false)
    expect(created.structuredContent).toMatchObject({
      record: { object_type: 'person', data: { name: { full: `Nessie agent check ${runKey}` } } },
    })
  })
})
