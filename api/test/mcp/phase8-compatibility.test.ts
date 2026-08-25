import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { createDb, dropTenant, seedTenant, writeAudit, type PolicyAction, type PolicyResourceType } from '@deepcrm/db'
import { applyTemplate, loadSchema, refreshDerivedFromSources, refreshDynamicListMembership } from '@deepcrm/schema-engine'
import type { ActorContext } from '@deepcrm/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for Phase 8 compatibility tests')

const Fixture = z.object({
  version: z.literal(1),
  templates: z.array(z.string()),
  records: z.record(z.record(z.unknown())),
  dynamic_segment: z.object({
    slug: z.string(), object_type: z.string(), filter: z.record(z.unknown()),
  }),
})
const fixture = Fixture.parse(JSON.parse(readFileSync(
  new URL('../../../docs/spec/fixtures/phase8-compatibility.v1.json', import.meta.url),
  'utf8',
)))
const TaskFixture = z.object({
  title: z.string(),
  due_at: z.string().optional(),
  priority: z.string(),
})
const db = createDb(databaseUrl)
const runKey = randomUUID().replaceAll('-', '_')
const hostKey = runKey.replaceAll('_', '')
const createdBy = `phase8-compat-${runKey}`
const ToolResult = z.object({ content: z.array(z.unknown()), structuredContent: z.unknown().optional() }).passthrough()
const RecordResult = z.object({
  record: z.object({ id: z.string().uuid(), version: z.number().int(), data: z.record(z.unknown()) }).passthrough(),
})

let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>
let organizationId = ''
let teamId = ''
let otherOrganizationId: string | undefined

function structured(result: unknown): Record<string, unknown> {
  const parsed = ToolResult.parse(result)
  const text = z.object({ type: z.literal('text'), text: z.string() }).parse(parsed.content[0])
  if (text.text.startsWith('{')) expect(JSON.parse(text.text)).toEqual(parsed.structuredContent)
  return z.record(z.unknown()).parse(parsed.structuredContent)
}

async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args })
}

function rec(result: unknown) {
  return RecordResult.parse(structured(result)).record
}

async function allow(resourceType: PolicyResourceType, action: PolicyAction, conditions?: Record<string, unknown>) {
  await db.policyRule.create({ data: {
    organizationId, teamId, scope: 'team', scopeId: teamId, resourceType, action,
    effect: 'allow', priority: 100, requiresApproval: false, conditions, createdById: createdBy,
    bindings: { create: [
      { actorType: 'agent', actorId: 'agent:dev:agent_dev' },
      { actorType: 'role', actorId: 'owner' },
    ] },
  } })
}

function ctx(): ActorContext {
  return {
    tenant: { organizationId, teamId }, app: 'dev', actChain: [],
    actor: { type: 'agent', id: 'agent_dev' },
    onBehalfOf: { uoaUserId: 'usr_dev', role: 'owner' },
    provenance: { runId: 'phase8-compatibility', toolCallId: randomUUID(), requestId: randomUUID() },
    requestId: randomUUID(), now: new Date('2026-08-24T12:00:00.000Z'),
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
  for (const [resourceType, action] of [
    ['schema', 'view'], ['schema', 'define'], ['record', 'view'], ['record', 'create'],
    ['record', 'edit'], ['record', 'link'], ['link', 'link'], ['link', 'view'],
    ['list', 'create'], ['list', 'view'], ['attribute', 'view'], ['attribute', 'edit'],
  ] as const) await allow(resourceType, action)
})

afterAll(async () => {
  await db.policyRule.deleteMany({ where: { organizationId, teamId, createdById: createdBy } })
  if (otherOrganizationId !== undefined) await dropTenant(db, otherOrganizationId)
  await closeServer()
  await db.$disconnect()
})

describe('Phase 8 compatibility fixture', () => {
  it('discovers, imports and round-trips the local fixture through MCP', async () => {
    const tools = await client.listTools()
    const toolNames = tools.tools.map((tool) => tool.name)
    expect(toolNames).toEqual(expect.arrayContaining([
      'crm_template_apply', 'crm_record_create', 'crm_record_assert', 'crm_activity_log',
      'crm_note_add', 'crm_task_create', 'crm_pipeline_stage_set', 'crm_list_create',
    ]))
    expect(JSON.stringify(tools)).not.toContain('NOT_YET')
    const resources = await client.listResources()
    expect(resources.resources.map((resource) => resource.uri)).toEqual(expect.arrayContaining([
      'crm://schema', 'crm://templates', 'crm://help/filtering', 'crm://help/limits',
    ]))
    const limits = JSON.stringify(await client.readResource({ uri: 'crm://help/limits' }))
    expect(limits).toContain('product_vs_line_item')
    expect(limits).toContain('pipeline_vs_lifecycle')

    for (const template of fixture.templates) await call('crm_template_apply', { template })
    const templates = JSON.stringify(await client.readResource({ uri: 'crm://templates' }))
    for (const template of fixture.templates) expect(templates).toContain(template)
    const schema = structured(await call('crm_schema_get', {}))
    for (const slug of ['person', 'company', 'deal', 'ticket', 'lead', 'product', 'line_item', 'quote', 'subscription', 'invoice', 'payment', 'order']) {
      expect(JSON.stringify(schema)).toContain(slug)
    }
    const lineItemSchema = structured(await call('crm_schema_get', { object_type: 'line_item' }))
    expect(lineItemSchema).toMatchObject({
      attributes: expect.arrayContaining([
        expect.objectContaining({ slug: 'unit_price', description: expect.stringContaining('Snapshot') }),
        expect.objectContaining({ slug: 'product', type: 'record_reference' }),
      ]),
    })

    const company = rec(await call('crm_record_create', {
      object_type: 'company', data: { ...fixture.records.company, domains: [`fixture-${hostKey}.example`] },
    }))
    const person = rec(await call('crm_record_create', {
      object_type: 'person',
      data: { ...fixture.records.person, emails: [`fixture-${runKey}@example.test`], company: company.id },
    }))
    const deal = rec(await call('crm_record_create', {
      object_type: 'deal',
      data: { ...fixture.records.deal, company: company.id, contacts: [person.id] },
    }))
    const lead = rec(await call('crm_record_create', {
      object_type: 'lead',
      data: { ...fixture.records.lead, person: person.id, company: company.id, deal: deal.id, external_ref: `lead-${runKey}` },
    }))
    const ticket = rec(await call('crm_record_create', {
      object_type: 'ticket',
      data: { ...fixture.records.ticket, person: person.id, company: company.id, deal: deal.id, external_ref: `ticket-${runKey}` },
    }))
    const product = rec(await call('crm_record_create', {
      object_type: 'product',
      data: { ...fixture.records.product, sku: `FIXTURE-SKU-${runKey}`, external_ref: `product-${runKey}` },
    }))
    const quote = rec(await call('crm_record_create', {
      object_type: 'quote',
      data: { ...fixture.records.quote, quote_number: `FIX-Q-${runKey}`, company: company.id, person: person.id, deal: deal.id, external_ref: `quote-${runKey}` },
    }))
    const subscription = rec(await call('crm_record_create', {
      object_type: 'subscription',
      data: { ...fixture.records.subscription, subscription_ref: `FIX-SUB-${runKey}`, company: company.id, person: person.id, deal: deal.id, external_ref: `subscription-${runKey}` },
    }))
    const order = rec(await call('crm_record_create', {
      object_type: 'order',
      data: { ...fixture.records.order, order_number: `FIX-O-${runKey}`, quote: quote.id, company: company.id, person: person.id, deal: deal.id, external_ref: `order-${runKey}` },
    }))
    const invoice = rec(await call('crm_record_assert', {
      object_type: 'invoice', match_attribute: 'invoice_number',
      data: { ...fixture.records.invoice, invoice_number: `FIX-INV-${runKey}`, order: order.id, subscription: subscription.id, company: company.id, person: person.id, deal: deal.id, external_ref: `invoice-${runKey}` },
    }))
    const payment = rec(await call('crm_record_create', {
      object_type: 'payment',
      data: { ...fixture.records.payment, payment_ref: `FIX-PAY-${runKey}`, provider_payment_ref: `FIX-PROVIDER-PAY-${runKey}`, invoice: invoice.id, order: order.id, subscription: subscription.id, company: company.id, person: person.id, deal: deal.id, external_ref: `payment-${runKey}` },
    }))
    const lineItem = rec(await call('crm_record_create', {
      object_type: 'line_item',
      data: { ...fixture.records.line_item, sku: `FIXTURE-SKU-${runKey}`, product: product.id, quote: quote.id, order: order.id, invoice: invoice.id, subscription: subscription.id, external_ref: `line-${runKey}` },
    }))

    await call('crm_activity_log', { ...fixture.records.email_activity, about: [company.id, deal.id], external_ref: `email-${runKey}` })
    await call('crm_activity_log', { ...fixture.records.call_activity, about: [company.id], external_ref: `call-${runKey}` })
    await call('crm_activity_log', { ...fixture.records.meeting_activity, about: [deal.id, ticket.id], external_ref: `meeting-${runKey}` })
    const note = rec(await call('crm_note_add', { ...fixture.records.note, about: [company.id], idempotency_key: `note-${runKey}` }))
    const taskCreate = TaskFixture.parse(fixture.records.task)
    const task = rec(await call('crm_task_create', {
      ...taskCreate,
      about: [deal.id],
      assignee: { type: 'agent', id: 'agent_dev' },
      idempotency_key: `task-${runKey}`,
    }))
    const stageSet = structured(await call('crm_pipeline_stage_set', {
      record_id: lead.id,
      pipeline: 'lead_qualification',
      stage: 'contacted',
      reason: 'fixture contacted',
      idempotency_key: `lead-contacted-${runKey}`,
    }))
    expect(stageSet).toMatchObject({
      record_id: lead.id, pipeline: 'lead_qualification', stage: 'contacted', changed: true,
    })
    const quoteBefore = rec(await call('crm_record_get', { id: quote.id }))
    await call('crm_record_update', {
      id: quote.id, expected_version: quoteBefore.version,
      data: { total_amount: { amount: '200', currency: 'GBP' } },
    })
    const stableLine = rec(await call('crm_record_get', { id: lineItem.id }))
    expect(stableLine.data.unit_price).toEqual({ amount: '100', currency: 'GBP' })

    await refreshDerivedFromSources(db, { organizationId, teamId }, [lineItem.id], ctx().now)
    const refreshedQuote = rec(await call('crm_record_get', { id: quote.id }))
    expect(refreshedQuote.data.line_item_count).toBe('1')
    const segment = structured(await call('crm_list_create', {
      slug: `${fixture.dynamic_segment.slug}_${runKey}`,
      name: 'Fixture visible line items',
      kind: 'dynamic',
      object_type: fixture.dynamic_segment.object_type,
      filter: { attribute: 'sku', op: 'eq', value: `FIXTURE-SKU-${runKey}` },
    }))
    const segmentId = z.object({ id: z.string().uuid(), definition: z.object({ evaluation_version: z.number().int() }) }).parse(segment)
    await refreshDynamicListMembership(db, { organizationId, teamId }, ctx(), segmentId.id, segmentId.definition.evaluation_version, ctx().now, writeAudit)
    const entries = structured(await call('crm_list_entries', { list: `${fixture.dynamic_segment.slug}_${runKey}` }))
    expect(z.object({ entries: z.array(z.object({ record: z.object({ id: z.string().uuid() }) })) }).parse(entries).entries)
      .toHaveLength(1)

    const timeline = structured(await call('crm_record_timeline', { id: company.id, kinds: ['activity', 'note'], limit: 10 }))
    expect(JSON.stringify(timeline)).toContain(note.id)
    const history = structured(await call('crm_record_history', { id: payment.id }))
    expect(z.object({ changes: z.array(z.unknown()) }).parse(history).changes.length).toBeGreaterThan(0)
    const links = structured(await call('crm_links_list', { record_id: order.id, relation_type: 'order_quote' }))
    expect(JSON.stringify(links)).toContain(quote.id)
    const listedTasks = structured(await call('crm_tasks_list', { status: 'open', about: deal.id }))
    expect(JSON.stringify(listedTasks)).toContain(task.id)

    const invalid = structured(await call('crm_record_create', {
      object_type: 'payment',
      data: { ...fixture.records.payment, payment_ref: `BAD-${runKey}`, provider_payment_ref: `BAD-PROVIDER-${runKey}`, card_number: '4242424242424242' },
    }))
    expect(invalid).toMatchObject({ code: 'UNKNOWN_ATTRIBUTE', attribute: 'card_number' })
    const currentSchema = await loadSchema(db, { organizationId, teamId })
    const lineItemType = currentSchema.objectTypesBySlug.get('line_item')
    if (lineItemType === undefined) throw new Error('line item schema missing')
    const hidden = await db.record.create({ data: {
      organizationId, teamId, objectTypeId: lineItemType.id,
      data: { ...fixture.records.line_item, sku: `FIXTURE-SKU-${runKey}`, external_ref: `private-line-${runKey}` },
      displayName: `Private line ${runKey}`, visibility: 'private',
      createdByType: 'system', createdById: createdBy, createdOnBehalfOf: 'usr_other',
    } })
    const hiddenQuery = structured(await call('crm_records_query', {
      object_type: 'line_item', filter: { attribute: 'sku', op: 'eq', value: `FIXTURE-SKU-${runKey}` },
    }))
    expect(JSON.stringify(hiddenQuery)).not.toContain(hidden.id)

    const otherTenant = await seedTenant(db)
    otherOrganizationId = otherTenant.organizationId
    await db.$transaction((tx) => applyTemplate(tx, otherTenant, { type: 'system', id: createdBy, onBehalfOf: null, requestId: runKey }, 'standard_crm'))
    const otherSchema = await loadSchema(db, otherTenant)
    const otherCompanyType = otherSchema.objectTypesBySlug.get('company')
    if (otherCompanyType === undefined) throw new Error('other company missing')
    const other = await db.record.create({ data: {
      organizationId: otherTenant.organizationId, teamId: otherTenant.teamId, objectTypeId: otherCompanyType.id,
      data: { name: `Foreign ${runKey}` }, displayName: `Foreign ${runKey}`,
      visibility: 'team', createdByType: 'system', createdById: createdBy, createdOnBehalfOf: 'usr_other',
    } })
    const foreignRead = structured(await call('crm_record_get', { id: other.id }))
    expect(foreignRead).toMatchObject({ code: 'NOT_FOUND' })
  })
})
