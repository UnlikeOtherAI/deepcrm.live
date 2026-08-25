import { randomUUID } from 'node:crypto'

import { createDb, dropTenant, seedTenant, writeAudit, type PolicyAction, type PolicyResourceType } from '@deepcrm/db'
import { applyTemplate, loadSchema, refreshDynamicListMembership } from '@deepcrm/schema-engine'
import type { ActorContext } from '@deepcrm/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP commerce document tests')

const db = createDb(databaseUrl)
const runKey = randomUUID().replaceAll('-', '_')
const hostKey = runKey.replaceAll('_', '')
const createdBy = `commerce-docs-${runKey}`
const segmentSlug = `sku_buyers_${runKey}`
const ToolResult = z.object({
  content: z.array(z.unknown()), structuredContent: z.unknown().optional(),
}).passthrough()
const RecordResult = z.object({
  record: z.object({
    id: z.string().uuid(), version: z.number().int(), data: z.record(z.unknown()),
    redacted_attributes: z.array(z.string()).default([]),
  }).passthrough(),
})

let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>
let organizationId: string
let teamId: string
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
    tenant: { organizationId, teamId },
    app: 'dev',
    actChain: [],
    actor: { type: 'agent', id: 'agent_dev' },
    onBehalfOf: { uoaUserId: 'usr_dev', role: 'owner' },
    provenance: { runId: 'commerce-documents', toolCallId: randomUUID(), requestId: randomUUID() },
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
  for (const [resourceType, action] of [
    ['schema', 'view'], ['schema', 'define'], ['record', 'view'], ['record', 'create'],
    ['record', 'edit'], ['record', 'link'], ['link', 'link'], ['link', 'view'],
    ['list', 'create'], ['list', 'view'],
  ] as const) await allow(resourceType, action)
  await allow('attribute', 'view')
  await allow('attribute', 'edit')
})

afterAll(async () => {
  await db.policyRule.deleteMany({ where: { organizationId, teamId, createdById: createdBy } })
  if (otherOrganizationId !== undefined) await dropTenant(db, otherOrganizationId)
  await closeServer()
  await db.$disconnect()
})

describe('standard commerce document templates over MCP', () => {
  it('links commerce documents to copied line items and segments visible SKU revenue only', async () => {
    await call('crm_template_apply', { template: 'standard_crm' })
    await call('crm_template_apply', { template: 'standard_commerce' })
    const schema = structured(await call('crm_schema_get', {}))
    expect(JSON.stringify(schema)).toContain('quote')
    expect(JSON.stringify(schema)).toContain('payment')

    const company = RecordResult.parse(structured(await call('crm_record_create', {
      object_type: 'company', data: { name: `Buyer ${runKey}`, domains: [`buyer-${hostKey}.example`] },
    }))).record
    const person = RecordResult.parse(structured(await call('crm_record_create', {
      object_type: 'person', data: { name: { full: `Buyer Person ${runKey}` }, emails: [`buyer-${runKey}@example.test`] },
    }))).record
    const deal = RecordResult.parse(structured(await call('crm_record_create', {
      object_type: 'deal', data: {
        name: `Commerce deal ${runKey}`, stage: 'qualified', company: company.id, contacts: [person.id],
      },
    }))).record
    const product = RecordResult.parse(structured(await call('crm_record_create', {
      object_type: 'product',
      data: {
        name: `Commerce product ${runKey}`, sku: `sku-${runKey}`,
        current_unit_price: { amount: '10', currency: 'GBP' },
      },
    }))).record

    const quote = RecordResult.parse(structured(await call('crm_record_create', {
      object_type: 'quote',
      data: {
        name: `Quote ${runKey}`, quote_number: `Q-${runKey}`, status: 'sent',
        total_amount: { amount: '20', currency: 'GBP' }, company: company.id, person: person.id, deal: deal.id,
        external_ref: `quote-${runKey}`,
      },
    }))).record
    const subscription = RecordResult.parse(structured(await call('crm_record_create', {
      object_type: 'subscription',
      data: {
        name: `Subscription ${runKey}`, subscription_ref: `SUB-${runKey}`, status: 'active',
        start_date: '2026-08-24', billing_frequency: 'monthly',
        recurring_amount: { amount: '20', currency: 'GBP' }, support_entitlement_active: true,
        company: company.id, person: person.id, deal: deal.id, external_ref: `subscription-${runKey}`,
      },
    }))).record
    const order = RecordResult.parse(structured(await call('crm_record_create', {
      object_type: 'order',
      data: {
        name: `Order ${runKey}`, order_number: `O-${runKey}`, status: 'placed',
        total_amount: { amount: '20', currency: 'GBP' }, quote: quote.id,
        company: company.id, person: person.id, deal: deal.id, external_ref: `order-${runKey}`,
      },
    }))).record
    const invoice = RecordResult.parse(structured(await call('crm_record_assert', {
      object_type: 'invoice', match_attribute: 'invoice_number',
      data: {
        name: `Invoice ${runKey}`, invoice_number: `INV-${runKey}`, status: 'open',
        issue_date: '2026-08-24', due_date: '2026-09-24',
        total_amount: { amount: '20', currency: 'GBP' }, balance_due: { amount: '0', currency: 'GBP' },
        order: order.id, subscription: subscription.id, company: company.id, person: person.id, deal: deal.id,
        external_ref: `invoice-${runKey}`,
      },
    }))).record
    const payment = RecordResult.parse(structured(await call('crm_record_create', {
      object_type: 'payment',
      data: {
        name: `Payment ${runKey}`, payment_ref: `PAY-${runKey}`, provider: 'stripe',
        provider_payment_ref: `pi_${runKey}`, status: 'succeeded',
        amount: { amount: '20', currency: 'GBP' }, received_at: '2026-08-24T12:00:00.000Z',
        invoice: invoice.id, order: order.id, subscription: subscription.id,
        company: company.id, person: person.id, deal: deal.id, external_ref: `payment-${runKey}`,
      },
    }))).record

    const parentRefs = [
      ['quote', quote.id], ['order', order.id], ['invoice', invoice.id], ['subscription', subscription.id],
    ] as const
    const lineItemIds: string[] = []
    for (const [parentSlug, parentId] of parentRefs) {
      const line = RecordResult.parse(structured(await call('crm_record_create', {
        object_type: 'line_item',
        data: {
          name: `${parentSlug} line ${runKey}`, sku: `sku-${runKey}`, quantity: 2,
          unit_price: { amount: '10', currency: 'GBP' }, total_amount: { amount: '20', currency: 'GBP' },
          billing_frequency: parentSlug === 'subscription' ? 'monthly' : 'one_time',
          snapshot_at: '2026-08-24T12:00:00.000Z', product: product.id, [parentSlug]: parentId,
          external_ref: `${parentSlug}-line-${runKey}`,
        },
      }))).record
      lineItemIds.push(line.id)
    }
    const beforeUpdate = RecordResult.parse(structured(await call('crm_record_get', { id: quote.id }))).record
    await call('crm_record_update', {
      id: quote.id, expected_version: beforeUpdate.version,
      data: { total_amount: { amount: '99', currency: 'GBP' } },
    })
    const firstLine = RecordResult.parse(structured(await call('crm_record_get', { id: lineItemIds[0] }))).record
    expect(firstLine.data.unit_price).toEqual({ amount: '10', currency: 'GBP' })

    const rejected = await call('crm_record_create', {
      object_type: 'payment',
      data: {
        name: `Unsafe payment ${runKey}`, payment_ref: `PAY-UNSAFE-${runKey}`, provider: 'stripe',
        provider_payment_ref: `pi_unsafe_${runKey}`, status: 'pending',
        amount: { amount: '20', currency: 'GBP' }, card_number: '4242424242424242',
      },
    })
    expect(ToolResult.parse(rejected).structuredContent).toMatchObject({ code: 'UNKNOWN_ATTRIBUTE', attribute: 'card_number' })

    const otherTenant = await seedTenant(db)
    otherOrganizationId = otherTenant.organizationId
    await db.$transaction((tx) => applyTemplate(tx, otherTenant, {
      type: 'system', id: createdBy, onBehalfOf: null, requestId: runKey,
    }, 'standard_crm'))
    await db.$transaction((tx) => applyTemplate(tx, otherTenant, {
      type: 'system', id: createdBy, onBehalfOf: null, requestId: runKey,
    }, 'standard_commerce'))
    const otherSchema = await loadSchema(db, otherTenant)
    const otherLineItemType = otherSchema.objectTypesBySlug.get('line_item')
    if (otherLineItemType === undefined) throw new Error('other line item type missing')
    await db.record.create({ data: {
      organizationId: otherTenant.organizationId, teamId: otherTenant.teamId, objectTypeId: otherLineItemType.id,
      data: {
        name: `Other tenant line ${runKey}`, sku: `sku-${runKey}`, quantity: 1,
        unit_price: { amount: '10', currency: 'GBP' }, total_amount: { amount: '10', currency: 'GBP' },
        billing_frequency: 'one_time', snapshot_at: '2026-08-24T12:00:00.000Z',
      },
      displayName: `Other tenant line ${runKey}`, visibility: 'team',
      createdByType: 'system', createdById: createdBy, createdOnBehalfOf: 'usr_other',
    } })

    const segment = structured(await call('crm_list_create', {
      slug: segmentSlug, name: 'Visible SKU buyers without external leak',
      kind: 'dynamic', object_type: 'line_item',
      filter: { attribute: 'sku', op: 'eq', value: `sku-${runKey}` },
    }))
    const segmentId = z.object({ id: z.string().uuid(), definition: z.object({ evaluation_version: z.number().int() }) })
      .parse(segment)
    await refreshDynamicListMembership(db, { organizationId, teamId }, ctx(), segmentId.id, segmentId.definition.evaluation_version, ctx().now, writeAudit)
    const entries = structured(await call('crm_list_entries', { list: segmentSlug, limit: 20 }))
    const entryRecords = z.object({ entries: z.array(z.object({ record: z.object({ id: z.string().uuid() }) })) }).parse(entries).entries
    expect(entryRecords.map((entry) => entry.record.id).sort()).toEqual(lineItemIds.sort())
    expect(entryRecords).toHaveLength(4)

    const history = structured(await call('crm_record_history', { id: payment.id }))
    expect(z.object({ changes: z.array(z.unknown()) }).parse(history).changes.length).toBeGreaterThan(0)
    const auditActions = await db.auditLog.findMany({
      where: { organizationId, teamId, action: { in: ['crm_record_create', 'crm_record_update', 'crm_record_assert'] } },
      select: { action: true, outcome: true },
    })
    expect(auditActions.map((audit) => `${audit.action}:${audit.outcome}`))
      .toEqual(expect.arrayContaining(['crm_record_create:success', 'crm_record_update:success', 'crm_record_assert:success']))
  })
})
