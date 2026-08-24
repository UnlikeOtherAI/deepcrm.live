import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDb } from '@deepcrm/db'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP records tests')

const ToolResult = z.object({ content: z.array(z.unknown()), structuredContent: z.unknown().optional() }).passthrough()
const runKey = randomUUID()
let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>
let organizationId: string
let teamId: string
const db = createDb(databaseUrl)

function structured(result: unknown): Record<string, unknown> {
  const parsed = ToolResult.parse(result).structuredContent
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Expected structured object')
  const text = z.object({ type: z.literal('text'), text: z.string() }).parse(ToolResult.parse(result).content[0])
  let decoded: unknown
  try { decoded = JSON.parse(text.text) } catch { throw new Error(JSON.stringify(parsed)) }
  expect(decoded).toEqual(parsed)
  return parsed as Record<string, unknown>
}

async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args })
}

beforeAll(async () => {
  const started = await startTestServer()
  client = started.client
  closeServer = started.close
  await call('crm_template_apply', { template: 'standard_crm' })
  const team = await db.team.findUniqueOrThrow({ where: { externalTeamId: 'team_dev' }, select: { id: true, organizationId: true } })
  organizationId = team.organizationId
  teamId = team.id
  await db.record.deleteMany({ where: { organizationId: team.organizationId, teamId: team.id } })
  for (const action of ['view', 'create', 'edit', 'delete', 'restore', 'link'] as const) {
    await db.policyRule.create({ data: {
      organizationId: team.organizationId, teamId: team.id, scope: 'team', scopeId: team.id,
      resourceType: 'record', action, effect: 'allow', priority: 100, requiresApproval: false, createdById: 'records-mcp',
      bindings: { create: [{ actorType: 'agent', actorId: 'agent:dev:agent_dev' }, { actorType: 'role', actorId: 'owner' }] },
    } })
  }
  await db.policyRule.create({ data: {
    organizationId: team.organizationId, teamId: team.id, scope: 'team', scopeId: team.id,
    resourceType: 'attribute', action: 'view', effect: 'allow', priority: 100, requiresApproval: false, createdById: 'records-mcp',
    bindings: { create: [{ actorType: 'agent', actorId: 'agent:dev:agent_dev' }, { actorType: 'role', actorId: 'owner' }] },
  } })
  await db.policyRule.create({ data: {
    organizationId: team.organizationId, teamId: team.id, scope: 'team', scopeId: team.id,
    resourceType: 'link', action: 'link', effect: 'allow', priority: 100, requiresApproval: false, createdById: 'records-mcp',
    bindings: { create: [{ actorType: 'agent', actorId: 'agent:dev:agent_dev' }, { actorType: 'role', actorId: 'owner' }] },
  } })
  await db.policyRule.create({ data: {
    organizationId: team.organizationId, teamId: team.id, scope: 'team', scopeId: team.id,
    resourceType: 'schema', action: 'define', effect: 'allow', priority: 100, requiresApproval: false, createdById: 'records-mcp',
    bindings: { create: [{ actorType: 'agent', actorId: 'agent:dev:agent_dev' }, { actorType: 'role', actorId: 'owner' }] },
  } })
  const applied = await call('crm_template_apply', { template: 'standard_crm' })
  const appliedContent = ToolResult.parse(applied).structuredContent
  if (typeof appliedContent === 'object' && appliedContent !== null && !Array.isArray(appliedContent)
    && !Object.hasOwn(appliedContent, 'code')) structured(applied)
})
afterAll(async () => { await closeServer(); await db.$disconnect() })

describe('record MCP tools', () => {
  it('creates, reads, queries, histories, deletes and restores records', async () => {
    const company = structured(await call('crm_record_create', { object_type: 'company', data: { name: 'Asahi', domains: ['asahi.eu'] } }))
    const companyId = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(company).record.id
    const person = structured(await call('crm_record_create', { object_type: 'person', data: { name: { full: 'Anna Novak' }, emails: ['anna@asahi.eu'] }, links: [{ relation_type: 'person_works_at', to_record_id: companyId }] }))
    const personRecord = z.object({ record: z.object({ id: z.string().uuid(), version: z.number().int() }) }).parse(person).record
    const personId = personRecord.id
    expect(personRecord.version).toBeGreaterThan(1)
    const got = structured(await call('crm_record_get', { object_type: 'person', match_attribute: 'emails', value: 'anna@asahi.eu', include_links: true }))
    expect(z.object({ record: z.object({ id: z.string() }), links: z.record(z.array(z.unknown())) }).parse(got).record.id).toBe(personId)
    const secondCompany = structured(await call('crm_record_create', { object_type: 'company', data: { name: 'Kirin', domains: ['kirin.eu'] } }))
    const secondCompanyId = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(secondCompany).record.id
    const linkedWrite = structured(await call('crm_record_create', {
      object_type: 'person',
      data: { name: { full: 'Link Binding' }, emails: ['links@asahi.eu'] },
      links: [{ relation_type: 'person_works_at', to_record_id: companyId }],
      idempotency_key: `records-test-link-binding-${runKey}`,
    }))
    const linkedWriteId = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(linkedWrite).record.id
    const changedLinkReplay = await call('crm_record_create', {
      object_type: 'person',
      data: { name: { full: 'Link Binding' }, emails: ['links@asahi.eu'] },
      links: [{ relation_type: 'person_works_at', to_record_id: secondCompanyId }],
      idempotency_key: `records-test-link-binding-${runKey}`,
    })
    expect(ToolResult.parse(changedLinkReplay).structuredContent).toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
    const metadata = structured(await call('crm_record_update', {
      id: personId, data: {}, visible_to: [], expected_version: personRecord.version,
      idempotency_key: `records-test-metadata-${runKey}`,
    }))
    expect(z.object({ record: z.object({ visibility: z.literal('users'), version: z.number().int() }) }).parse(metadata).record.version).toBeGreaterThan(personRecord.version)
    const metadataMismatch = await call('crm_record_update', {
      id: personId, data: {}, visibility: 'team', expected_version: personRecord.version,
      idempotency_key: `records-test-metadata-${runKey}`,
    })
    expect(ToolResult.parse(metadataMismatch).structuredContent).toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
    expect(await db.recordVisibilityGrant.count({ where: { recordId: personId } })).toBe(0)
    expect(await db.recordLink.count({
      where: { organizationId, teamId, fromRecordId: linkedWriteId, activeUntil: null },
    })).toBe(1)
    const duplicate = await call('crm_record_create', { object_type: 'person', data: { name: { full: 'Other Anna' }, emails: ['anna@asahi.eu'] } })
    expect(ToolResult.parse(duplicate).structuredContent).toMatchObject({ code: 'DUPLICATE_FOUND' })
    const conflict = await call('crm_record_update', { id: personId, data: { title: 'CTO' }, expected_version: 1 })
    expect(ToolResult.parse(conflict).structuredContent).toMatchObject({ code: 'VERSION_CONFLICT' })
    const firstAssert = structured(await call('crm_record_assert', { object_type: 'person', match_attribute: 'emails', data: { name: { full: 'Anna Novak' }, emails: ['anna@asahi.eu'] }, idempotency_key: `records-test-assert-${runKey}` }))
    const replayAssert = structured(await call('crm_record_assert', { object_type: 'person', match_attribute: 'emails', data: { name: { full: 'Anna Novak' }, emails: ['anna@asahi.eu'] }, idempotency_key: `records-test-assert-${runKey}` }))
    expect(replayAssert).toEqual(firstAssert)
    const assertMismatch = await call('crm_record_assert', { object_type: 'person', match_attribute: 'emails', data: { name: { full: 'Changed Anna' }, emails: ['anna@asahi.eu'] }, idempotency_key: `records-test-assert-${runKey}` })
    expect(ToolResult.parse(assertMismatch).structuredContent).toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
    const deal = structured(await call('crm_record_create', {
      object_type: 'deal', data: { name: 'Asahi pilot', stage: 'qualified', close_date: '2026-09-01' },
    }))
    const dealId = z.object({ record: z.object({ id: z.string().uuid() }) }).parse(deal).record.id
    const deals = structured(await call('crm_records_query', {
      object_type: 'deal',
      filter: {
        and: [
          { attribute: 'stage', op: 'in', value: ['qualified', 'proposal'] },
          { not: { attribute: 'close_date', op: 'is_null' } },
        ],
      },
    }))
    expect(z.object({ records: z.array(z.object({ id: z.string() })) }).parse(deals).records.map((record) => record.id)).toContain(dealId)
    const page = structured(await call('crm_records_query', { object_type: 'company', filter: { attribute: 'domains', op: 'contains', value: 'asahi.eu' }, attributes: ['name'] }))
    expect(z.object({ records: z.array(z.object({ id: z.string() })) }).parse(page).records.map((record) => record.id)).toContain(companyId)
    const history = structured(await call('crm_record_history', { id: personId }))
    expect(z.object({ changes: z.array(z.unknown()) }).parse(history).changes.length).toBeGreaterThan(0)
    const at = structured(await call('crm_record_at', { id: personId, at: new Date().toISOString() }))
    expect(z.object({ record_at: z.object({ version_at: z.number().int() }) }).parse(at).record_at.version_at).toBeGreaterThan(0)
    expect(structured(await call('crm_record_delete', { id: personId })).deleted).toBe(true)
    expect(z.object({ record: z.object({ id: z.string() }) }).parse(structured(await call('crm_record_restore', { id: personId }))).record.id).toBe(personId)
  })
})
