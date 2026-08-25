import { randomUUID } from 'node:crypto'

import { createDb, writeAudit, type PolicyAction, type PolicyResourceType } from '@deepcrm/db'
import { applyTemplate, loadSchema, refreshDynamicListMembership } from '@deepcrm/schema-engine'
import {
  CrmListAdd,
  CrmListCreate,
  CrmListEntries,
  CrmListRemove,
  CrmListStatus,
  CrmListUpdate,
  CrmViewDelete,
  CrmViewRun,
  CrmViewSave,
  type ActorContext,
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
const dynamicListSlug = `dynamic_targets_${key}`
const viewSlug = `people_${key}`
const ToolResult = z.object({
  content: z.array(z.unknown()), structuredContent: z.unknown().optional(),
}).passthrough()
let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>
let organizationId: string
let teamId: string
let recordId: string
let matchingCompanyId: string
let changedCompanyId: string
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

function devContext(): ActorContext {
  return {
    tenant: { organizationId, teamId },
    app: 'dev',
    actChain: [],
    actor: { type: 'agent', id: 'agent_dev' },
    onBehalfOf: { uoaUserId: 'usr_dev', role: 'owner' },
    provenance: { runId: 'dynamic-list-test', toolCallId: 'refresh', requestId: key },
    requestId: randomUUID(),
    now: new Date('2026-08-24T12:00:00.000Z'),
  }
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
    ['record', 'view'], ['record', 'edit'], ['attribute', 'view'], ['attribute', 'edit'],
  ] as const) await allowAgent(resource, action)
  const schema = await loadSchema(db, { organizationId, teamId })
  const person = schema.objectTypesBySlug.get('person')
  const company = schema.objectTypesBySlug.get('company')
  if (person === undefined || company === undefined) throw new Error('standard template missing')
  recordId = (await db.record.create({ data: {
    organizationId, teamId, objectTypeId: person.id,
    data: { name: { given: 'MCP', family: key } }, displayName: `MCP ${key}`,
    visibility: 'team', createdOnBehalfOf: 'usr_dev', createdByType: 'system', createdById: createdBy,
  } })).id
  matchingCompanyId = (await db.record.create({ data: {
    organizationId, teamId, objectTypeId: company.id,
    data: { name: `Dynamic Match ${key}`, domains: [`dynamic-${key}.test`] },
    displayName: `Dynamic Match ${key}`, visibility: 'team', createdOnBehalfOf: 'usr_dev',
    createdByType: 'system', createdById: createdBy,
  } })).id
  changedCompanyId = (await db.record.create({ data: {
    organizationId, teamId, objectTypeId: company.id,
    data: { name: `Dynamic Change ${key}`, domains: [`old-${key}.test`] },
    displayName: `Dynamic Change ${key}`, visibility: 'team', createdOnBehalfOf: 'usr_dev',
    createdByType: 'system', createdById: createdBy,
  } })).id
})

afterAll(async () => {
  await db.list.deleteMany({ where: { organizationId, teamId, slug: { in: [listSlug, dynamicListSlug] } } })
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
  it('discovers all list/view tools and executes the list/view lifecycle', async () => {
    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name)
    for (const name of [
      'crm_list_create', 'crm_list_update', 'crm_list_status',
      'crm_list_add', 'crm_list_remove', 'crm_list_entries',
      'crm_view_save', 'crm_view_run', 'crm_view_delete',
    ]) expect(names).toContain(name)
    const createTool = listed.tools.find((tool) => tool.name === 'crm_list_create')
    expect(createTool?.description).toContain('curated')
    expect(createTool?.inputSchema).toMatchObject({ properties: {
      slug: { description: expect.any(String) }, name: { description: expect.any(String) },
      description: { description: expect.any(String) }, object_type: { description: expect.any(String) },
      kind: { description: expect.any(String) }, filter: { description: expect.any(String) },
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

  it('creates a dynamic company list, refreshes after a qualifying update, and blocks manual entries', async () => {
    const created = CrmListCreate.out.parse(structured(await client.callTool({
      name: 'crm_list_create', arguments: {
        slug: dynamicListSlug, name: 'Dynamic MCP companies', object_type: 'company',
        kind: 'dynamic', filter: { attribute: 'domains', op: 'contains', value: `dynamic-${key}.test` },
      },
    })))
    expect(created).toMatchObject({ kind: 'dynamic', refresh_state: 'refreshing', entry_count: 0 })
    expect(ToolResult.parse(await client.callTool({
      name: 'crm_list_entries', arguments: { list: dynamicListSlug },
    })).structuredContent).toMatchObject({ code: 'SCHEMA_CONFLICT' })
    await refreshDynamicListMembership(db, { organizationId, teamId }, devContext(), created.id, 1, devContext().now, writeAudit)
    expect(CrmListStatus.out.parse(structured(await client.callTool({
      name: 'crm_list_status', arguments: { list: dynamicListSlug },
    })))).toMatchObject({ status: { refresh_state: 'ready', evaluation_version: 1 } })
    expect(CrmListEntries.out.parse(structured(await client.callTool({
      name: 'crm_list_entries', arguments: { list: dynamicListSlug },
    }))).entries.map((entry) => entry.record.id)).toEqual([matchingCompanyId])

    const changed = await db.record.findUniqueOrThrow({ where: { id: changedCompanyId }, select: { version: true } })
    await client.callTool({
      name: 'crm_record_update',
      arguments: {
        id: changedCompanyId, data: { domains: [`dynamic-${key}.test`] },
        expected_version: changed.version,
      },
    })
    await refreshDynamicListMembership(db, { organizationId, teamId }, devContext(), created.id, 1, devContext().now, writeAudit)
    expect(CrmListEntries.out.parse(structured(await client.callTool({
      name: 'crm_list_entries', arguments: { list: dynamicListSlug },
    }))).entries.map((entry) => entry.record.id).sort()).toEqual([changedCompanyId, matchingCompanyId].sort())
    expect(ToolResult.parse(await client.callTool({
      name: 'crm_list_add', arguments: { list: dynamicListSlug, entries: [{ record_id: matchingCompanyId }] },
    })).structuredContent).toMatchObject({ code: 'SCHEMA_CONFLICT' })

    const updated = CrmListUpdate.out.parse(structured(await client.callTool({
      name: 'crm_list_update', arguments: {
        list: dynamicListSlug, filter: { attribute: 'domains', op: 'contains', value: `old-${key}.test` },
      },
    })))
    expect(updated).toMatchObject({ refresh_state: 'refreshing', definition: { evaluation_version: 2 } })
    await refreshDynamicListMembership(db, { organizationId, teamId }, devContext(), created.id, 2, devContext().now, writeAudit)
    expect(CrmListEntries.out.parse(structured(await client.callTool({
      name: 'crm_list_entries', arguments: { list: dynamicListSlug },
    }))).entries).toEqual([])
  })
})
