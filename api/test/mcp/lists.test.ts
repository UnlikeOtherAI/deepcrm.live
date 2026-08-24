import { randomUUID } from 'node:crypto'

import { createDb, type PolicyAction, type PolicyResourceType } from '@deepcrm/db'
import { applyTemplate, loadSchema } from '@deepcrm/schema-engine'
import {
  CrmListAdd,
  CrmListCreate,
  CrmListEntries,
  CrmListRemove,
  CrmViewDelete,
  CrmViewRun,
  CrmViewSave,
} from '@deepcrm/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP list tests')
const db = createDb(databaseUrl)
const key = randomUUID().replaceAll('-', '').slice(0, 12)
const createdBy = `lists-mcp-${key}`
const listSlug = `targets_${key}`
const viewSlug = `people_${key}`
const ToolResult = z.object({
  content: z.array(z.unknown()), structuredContent: z.unknown().optional(),
}).passthrough()
let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>
let organizationId: string
let teamId: string
let recordId: string
let auditIdsBefore = new Set<string>()

function structured(result: unknown): unknown {
  const parsed = ToolResult.parse(result)
  const text = z.object({ type: z.literal('text'), text: z.string() }).parse(parsed.content[0])
  if (text.text.startsWith('{')) expect(JSON.parse(text.text)).toEqual(parsed.structuredContent)
  return parsed.structuredContent
}

async function allowAgent(resourceType: PolicyResourceType, action: PolicyAction): Promise<void> {
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
  auditIdsBefore = new Set((await db.auditLog.findMany({
    where: { organizationId, teamId }, select: { id: true },
  })).map((audit) => audit.id))
  await db.$transaction((tx) => applyTemplate(tx, { organizationId, teamId }, {
    type: 'system', id: createdBy, onBehalfOf: null, requestId: key,
  }, 'standard_crm'))
  for (const [resource, action] of [
    ['list', 'create'], ['list', 'edit'], ['list', 'view'],
    ['view', 'create'], ['view', 'edit'], ['view', 'view'],
    ['record', 'view'], ['attribute', 'view'], ['attribute', 'edit'],
  ] as const) await allowAgent(resource, action)
  const person = (await loadSchema(db, { organizationId, teamId })).objectTypesBySlug.get('person')
  if (person === undefined) throw new Error('person template missing')
  recordId = (await db.record.create({ data: {
    organizationId, teamId, objectTypeId: person.id,
    data: { name: { given: 'MCP', family: key } }, displayName: `MCP ${key}`,
    visibility: 'team', createdOnBehalfOf: 'usr_dev', createdByType: 'system', createdById: createdBy,
  } })).id
})

afterAll(async () => {
  await db.list.deleteMany({ where: { organizationId, teamId, slug: listSlug } })
  await db.view.deleteMany({ where: { organizationId, teamId, slug: viewSlug } })
  await db.record.deleteMany({ where: { organizationId, teamId, createdById: createdBy } })
  await db.policyRule.deleteMany({ where: { organizationId, teamId, createdById: createdBy } })
  const newAuditIds = (await db.auditLog.findMany({
    where: { organizationId, teamId }, select: { id: true },
  })).map((audit) => audit.id).filter((id) => !auditIdsBefore.has(id))
  await db.auditLog.deleteMany({ where: { id: { in: newAuditIds } } })
  await closeServer()
  await db.$disconnect()
})

describe('list and view MCP tools', () => {
  it('discovers all seven tools and executes the list/view lifecycle', async () => {
    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name)
    for (const name of [
      'crm_list_create', 'crm_list_add', 'crm_list_remove', 'crm_list_entries',
      'crm_view_save', 'crm_view_run', 'crm_view_delete',
    ]) expect(names).toContain(name)
    const createTool = listed.tools.find((tool) => tool.name === 'crm_list_create')
    expect(createTool?.description).toContain('curated')
    expect(createTool?.inputSchema).toMatchObject({ properties: {
      slug: { description: expect.any(String) }, name: { description: expect.any(String) },
      description: { description: expect.any(String) }, object_type: { description: expect.any(String) },
      attributes: { description: expect.any(String) },
    } })
    const created = CrmListCreate.out.parse(structured(await client.callTool({
      name: 'crm_list_create', arguments: {
        slug: listSlug, name: 'MCP targets', object_type: 'person',
        attributes: [{
          slug: 'priority', name: 'Priority', description: 'MCP follow-up priority.', type: 'select',
          config: { options: [{ id: 'high', label: 'High' }] }, is_required: true,
        }],
      },
    })))
    expect(created).toMatchObject({ slug: listSlug, entry_count: 0 })
    const addedResult = structured(await client.callTool({
      name: 'crm_list_add', arguments: {
        list: listSlug, entries: [{ record_id: recordId, data: { priority: 'high' } }],
      },
    }))
    if (typeof addedResult !== 'object' || addedResult === null || !Object.hasOwn(addedResult, 'added')) {
      throw new Error(JSON.stringify(addedResult))
    }
    expect(CrmListAdd.out.parse(addedResult)).toEqual({ added: 1 })
    const entries = CrmListEntries.out.parse(structured(await client.callTool({
      name: 'crm_list_entries', arguments: { list: listSlug },
    })))
    expect(entries.entries).toHaveLength(1)
    expect(entries.entries[0]).toMatchObject({
      entry: { data: { priority: 'high' } }, record: { id: recordId },
    })
    const saved = CrmViewSave.out.parse(structured(await client.callTool({
      name: 'crm_view_save', arguments: {
        slug: viewSlug, name: 'MCP people', object_type: 'person',
        filter: { system: 'display_name', op: 'eq', value: `MCP ${key}` }, attributes: ['name'],
      },
    })))
    expect(saved.slug).toBe(viewSlug)
    const ran = CrmViewRun.out.parse(structured(await client.callTool({
      name: 'crm_view_run', arguments: { view: viewSlug },
    })))
    expect(ran.records.map((record) => record.id)).toContain(recordId)
    expect(CrmListRemove.out.parse(structured(await client.callTool({
      name: 'crm_list_remove', arguments: { list: listSlug, record_ids: [recordId] },
    })))).toEqual({ removed: 1 })
    expect(CrmViewDelete.out.parse(structured(await client.callTool({
      name: 'crm_view_delete', arguments: { view: viewSlug },
    })))).toEqual({ deleted: true })
  })
})
