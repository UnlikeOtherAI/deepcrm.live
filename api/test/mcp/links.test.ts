import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDb } from '@deepcrm/db'
import { CrmLink, CrmLinksList, CrmUnlink } from '@deepcrm/schemas'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP links tests')

const ToolResult = z.object({
  content: z.array(z.unknown()),
  structuredContent: z.unknown().optional(),
}).passthrough()
const runKey = randomUUID()
const db = createDb(databaseUrl)
let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>

function structured(result: unknown): unknown {
  const parsed = ToolResult.parse(result)
  const text = z.object({ type: z.literal('text'), text: z.string() }).parse(parsed.content[0])
  let decoded: unknown
  try {
    decoded = JSON.parse(text.text)
  } catch {
    throw new Error('Expected JSON text content')
  }
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
  await call('crm_template_apply', { template: 'standard_crm' })
  const team = await db.team.findUniqueOrThrow({
    where: { externalTeamId: 'team_dev' },
    select: { id: true, organizationId: true },
  })
  await db.record.deleteMany({
    where: { organizationId: team.organizationId, teamId: team.id },
  })
  const bindings = {
    create: [
      { actorType: 'agent', actorId: 'agent:dev:agent_dev' },
      { actorType: 'role', actorId: 'owner' },
    ],
  }
  for (const action of ['view', 'create', 'link'] as const) {
    await db.policyRule.create({
      data: {
        organizationId: team.organizationId,
        teamId: team.id,
        scope: 'team',
        scopeId: team.id,
        resourceType: 'record',
        action,
        effect: 'allow',
        priority: 100,
        requiresApproval: false,
        createdById: `links-mcp-${runKey}`,
        bindings,
      },
    })
  }
  for (const [resourceType, action] of [
    ['attribute', 'view'],
    ['link', 'link'],
    ['link', 'view'],
    ['schema', 'define'],
  ] as const) {
    await db.policyRule.create({
      data: {
        organizationId: team.organizationId,
        teamId: team.id,
        scope: 'team',
        scopeId: team.id,
        resourceType,
        action,
        effect: 'allow',
        priority: 100,
        requiresApproval: false,
        createdById: `links-mcp-${runKey}`,
        bindings,
      },
    })
  }
  await call('crm_template_apply', { template: 'standard_crm' })
})

afterAll(async () => {
  await closeServer()
  await db.$disconnect()
})

describe('link MCP tools', () => {
  it('links with edge data, lists both directions, and keeps ended history', async () => {
    const company = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(structured(
      await call('crm_record_create', {
        object_type: 'company',
        data: { name: 'DeepCRM Link Test', domains: [`links-${runKey}.example`] },
      }),
    )).record
    const person = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(structured(
      await call('crm_record_create', {
        object_type: 'person',
        data: {
          name: { full: 'Link Test Person' },
          emails: [`links-${runKey}@example.com`],
        },
      }),
    )).record

    const linked = CrmLink.out.parse(structured(await call('crm_link', {
      relation_type: 'person_works_at',
      from_record_id: person.id,
      to_record_id: company.id,
      data: { role: 'Principal Engineer' },
      label: 'primary',
      reason: 'T24 MCP acceptance',
      idempotency_key: `t24-link-${runKey}`,
    })))
    expect(linked.link).toMatchObject({
      relation_type: 'person_works_at',
      from_record_id: person.id,
      to_record_id: company.id,
      data: { role: 'Principal Engineer' },
      label: 'primary',
      active_until: null,
    })
    expect(linked.ended_links).toEqual([])

    const outgoing = CrmLinksList.out.parse(structured(await call('crm_links_list', {
      record_id: person.id,
      direction: 'from',
    })))
    expect(outgoing.links).toEqual([
      expect.objectContaining({
        link: expect.objectContaining({ id: linked.link.id }),
        related: expect.objectContaining({ id: company.id, object_type: 'company' }),
      }),
    ])

    const incoming = CrmLinksList.out.parse(structured(await call('crm_links_list', {
      record_id: company.id,
      relation_type: 'person_works_at',
      direction: 'to',
    })))
    expect(incoming.links).toEqual([
      expect.objectContaining({
        link: expect.objectContaining({ id: linked.link.id }),
        related: expect.objectContaining({ id: person.id, object_type: 'person' }),
      }),
    ])

    const unlinked = CrmUnlink.out.parse(structured(await call('crm_unlink', {
      link_id: linked.link.id,
      reason: 'Employment ended',
    })))
    expect(unlinked.link_id).toBe(linked.link.id)

    const active = CrmLinksList.out.parse(structured(await call('crm_links_list', {
      record_id: person.id,
      direction: 'both',
    })))
    expect(active.links).toEqual([])

    const history = CrmLinksList.out.parse(structured(await call('crm_links_list', {
      record_id: person.id,
      direction: 'both',
      include_history: true,
    })))
    expect(history.links).toEqual([
      expect.objectContaining({
        link: expect.objectContaining({ id: linked.link.id }),
        related: expect.objectContaining({ id: company.id }),
      }),
    ])
    expect(history.links[0]?.link.active_until).not.toBeNull()
  })
})
