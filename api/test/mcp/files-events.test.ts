import { randomUUID } from 'node:crypto'

import { createDb, dropTenant, seedTenant, type PolicyAction, type PolicyResourceType } from '@deepcrm/db'
import {
  CrmEventIngest,
  CrmEventsQuery,
  CrmEventTypeDefine,
  CrmFileLink,
  CrmFileList,
  CrmFileRegister,
} from '@deepcrm/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP file/event tests')
const db = createDb(databaseUrl)
const key = randomUUID().replaceAll('-', '').slice(0, 12)
const createdBy = `files-mcp-${key}`
const eventSlug = `product_feature_used_${key}`
const objectSlug = `event_subject_${key}`
const providerKey = `mcp/${key}/contract.pdf`
const ToolResult = z.object({
  content: z.array(z.unknown()), structuredContent: z.unknown().optional(),
}).passthrough()

let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>
let serverUrl: URL
let organizationId: string
let teamId: string
let recordId: string
let objectTypeId: string
let otherTenantOrganizationId: string
let otherTenantRecordId: string

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
  serverUrl = started.url
  const team = await db.team.findUniqueOrThrow({
    where: { externalTeamId: 'team_dev' }, select: { id: true, organizationId: true },
  })
  organizationId = team.organizationId
  teamId = team.id
  for (const [resource, action] of [
    ['schema', 'view'], ['schema', 'define'], ['record', 'view'], ['attribute', 'view'],
  ] as const) await allowAgent(resource, action)
  objectTypeId = (await db.objectType.create({ data: {
    organizationId, teamId, slug: objectSlug, singularName: 'Event subject',
    pluralName: 'Event subjects', description: 'MCP event subject fixture.',
    kind: 'custom', createdByType: 'system', createdById: createdBy,
  } })).id
  recordId = (await db.record.create({ data: {
    organizationId, teamId, objectTypeId,
    data: {}, displayName: `MCP ${key}`,
    visibility: 'team', createdOnBehalfOf: 'usr_dev', createdByType: 'system', createdById: createdBy,
  } })).id

  const otherTenant = await seedTenant(db)
  otherTenantOrganizationId = otherTenant.organizationId
  const otherObjectType = await db.objectType.create({ data: {
    organizationId: otherTenant.organizationId, teamId: otherTenant.teamId,
    slug: objectSlug, singularName: 'Event subject', pluralName: 'Event subjects',
    description: 'Other tenant event subject fixture.', kind: 'custom',
    createdByType: 'system', createdById: createdBy,
  } })
  otherTenantRecordId = (await db.record.create({ data: {
    organizationId: otherTenant.organizationId, teamId: otherTenant.teamId, objectTypeId: otherObjectType.id,
    data: {}, displayName: `Other ${key}`,
    visibility: 'team', createdOnBehalfOf: 'other-user', createdByType: 'system', createdById: createdBy,
  } })).id
})

afterAll(async () => {
  await db.fileObject.deleteMany({ where: { organizationId, teamId, provider: 's3', providerKey } })
  await db.record.deleteMany({ where: { organizationId, teamId, createdById: createdBy } })
  await db.objectType.deleteMany({ where: { organizationId, teamId, slug: objectSlug } })
  await db.policyRule.deleteMany({ where: { organizationId, teamId, createdById: createdBy } })
  await dropTenant(db, otherTenantOrganizationId)
  await closeServer()
  await db.$disconnect()
})

describe('file and event MCP tools', () => {
  it('registers and links a file, ingests product feature events, and blocks another tenant subject', async () => {
    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name)
    for (const name of [
      'crm_file_register', 'crm_file_link', 'crm_file_list',
      'crm_event_type_define', 'crm_event_ingest', 'crm_events_query',
    ]) expect(names).toContain(name)
    expect(listed.tools.find((tool) => tool.name === 'crm_event_ingest')?.inputSchema)
      .toMatchObject({ properties: { event_type: { description: expect.any(String) } } })

    const eventType = CrmEventTypeDefine.out.parse(structured(await client.callTool({
      name: 'crm_event_type_define',
      arguments: {
        slug: eventSlug, name: 'Product feature used',
        property_schema: {
          type: 'object', additionalProperties: false, required: ['feature'],
          properties: { feature: { type: 'string' } },
        },
      },
    })))
    expect(eventType.event_type.slug).toBe(eventSlug)

    const file = CrmFileRegister.out.parse(structured(await client.callTool({
      name: 'crm_file_register',
      arguments: {
        provider: 's3', provider_key: providerKey, filename: 'contract.pdf',
        mime_type: 'application/pdf', size_bytes: '256', checksum_sha256: 'b'.repeat(64),
      },
    })))
    expect(file.file.provider_key).toBe(providerKey)
    const linked = CrmFileLink.out.parse(structured(await client.callTool({
      name: 'crm_file_link',
      arguments: {
        file_id: file.file.id, target_type: 'record', record_id: recordId, purpose: 'contract',
      },
    })))
    expect(linked.link.record_id).toBe(recordId)
    const files = CrmFileList.out.parse(structured(await client.callTool({
      name: 'crm_file_list', arguments: { record_id: recordId },
    })))
    expect(files.files).toHaveLength(1)
    expect(files.files[0]?.access.expires_at).toMatch(/Z$/u)
    expect(files.files[0]?.access.url).toMatch(/^http:\/\/127\.0\.0\.1\/files\/access\/.+\?token=/u)
    expect(files.files[0]?.access.url).not.toContain(providerKey)
    const accessUrl = new URL(files.files[0]?.access.url ?? '')
    accessUrl.host = serverUrl.host
    const accessResponse = await fetch(accessUrl)
    expect(accessResponse.status).toBe(200)
    await expect(accessResponse.json()).resolves.toMatchObject({
      file_id: file.file.id,
      provider: 's3',
      provider_key: providerKey,
    })
    accessUrl.searchParams.set('token', 'tampered')
    const tamperedResponse = await fetch(accessUrl)
    expect(tamperedResponse.status).toBe(403)

    const event = CrmEventIngest.out.parse(structured(await client.callTool({
      name: 'crm_event_ingest',
      arguments: {
        event_type: eventSlug, source: 'product', external_id: `feature-${key}`,
        occurred_at: '2026-08-24T12:00:00.000Z', properties: { feature: 'attachments' },
      },
    })))
    expect(event).toMatchObject({ created: true, event: { source: 'product', subject_record_id: null } })
    const queried = CrmEventsQuery.out.parse(structured(await client.callTool({
      name: 'crm_events_query',
      arguments: { event_type: eventSlug, source: 'product' },
    })))
    expect(queried.events.map((item) => item.external_id)).toEqual([`feature-${key}`])

    const blocked = structured(await client.callTool({
      name: 'crm_events_query',
      arguments: { event_type: eventSlug, subject_record_id: otherTenantRecordId },
    }))
    expect(blocked).toMatchObject({ code: 'NOT_FOUND' })
  })
})
