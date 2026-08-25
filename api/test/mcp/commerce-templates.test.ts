import { randomUUID } from 'node:crypto'

import { createDb, type PolicyAction, type PolicyResourceType } from '@deepcrm/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP commerce template tests')

const db = createDb(databaseUrl)
const runKey = randomUUID().replaceAll('-', '_')
const createdBy = `commerce-mcp-${runKey}`
const ToolResult = z.object({
  content: z.array(z.unknown()), structuredContent: z.unknown().optional(),
}).passthrough()
const RecordResult = z.object({
  record: z.object({
    id: z.string().uuid(),
    version: z.number().int(),
    data: z.record(z.unknown()),
    redacted_attributes: z.array(z.string()).default([]),
  }).passthrough(),
})
let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>
let organizationId: string
let teamId: string

function structured(result: unknown): Record<string, unknown> {
  const parsed = ToolResult.parse(result)
  const text = z.object({ type: z.literal('text'), text: z.string() }).parse(parsed.content[0])
  const decoded: unknown = JSON.parse(text.text)
  expect(decoded).toEqual(parsed.structuredContent)
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

async function denyAttributeView(sensitivity: 'confidential' | 'restricted') {
  await db.policyRule.create({ data: {
    organizationId, teamId, scope: 'team', scopeId: teamId, resourceType: 'attribute', action: 'view',
    effect: 'deny', priority: 200, requiresApproval: false, conditions: { sensitivity },
    createdById: createdBy,
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
  for (const [resourceType, action] of [
    ['schema', 'view'], ['schema', 'define'], ['record', 'view'], ['record', 'create'],
    ['record', 'edit'], ['record', 'link'], ['link', 'link'], ['link', 'view'],
  ] as const) await allow(resourceType, action)
  await allow('attribute', 'edit', { sensitivity: 'confidential' })
  await allow('attribute', 'view', { sensitivity: 'internal' })
  await denyAttributeView('confidential')
})

afterAll(async () => {
  await db.policyRule.deleteMany({ where: { organizationId, teamId, createdById: createdBy } })
  await closeServer()
  await db.$disconnect()
})

describe('standard commerce template over MCP', () => {
  it('keeps line item snapshots distinct from catalogue product updates', async () => {
    await call('crm_template_apply', { template: 'standard_crm' })
    await call('crm_template_apply', { template: 'standard_commerce' })
    const repeated = structured(await call('crm_template_apply', { template: 'standard_commerce' }))
    expect(repeated).toMatchObject({
      added: { object_types: 0, attributes: 0, relation_types: 0, pipelines: 0, matching_rules: 0 },
    })

    const productSchema = structured(await call('crm_schema_get', { object_type: 'product' }))
    expect(productSchema).toMatchObject({
      attributes: expect.arrayContaining([
        expect.objectContaining({ slug: 'current_unit_price' }),
        expect.objectContaining({ slug: 'line_item_revenue_total', value_source: 'rollup' }),
      ]),
    })
    const lineItemSchema = structured(await call('crm_schema_get', { object_type: 'line_item' }))
    expect(lineItemSchema).toMatchObject({
      relation_types: expect.arrayContaining([
        expect.objectContaining({ slug: 'line_item_product' }),
        expect.objectContaining({ slug: 'line_item_deal' }),
      ]),
    })

    const deal = RecordResult.parse(structured(await call('crm_record_create', {
      object_type: 'deal',
      data: { name: `Commerce deal ${runKey}`, stage: 'qualified' },
    }))).record
    const productCreate = {
      object_type: 'product',
      data: {
        name: `Commerce product ${runKey}`,
        sku: `sku-${runKey}`,
        current_unit_price: { amount: '10', currency: 'GBP' },
        current_unit_cost: { amount: '4', currency: 'GBP' },
        external_ref: `product-${runKey}`,
      },
      idempotency_key: `commerce-product-${runKey}`,
    }
    const product = RecordResult.parse(structured(await call('crm_record_create', productCreate))).record
    const productReplay = RecordResult.parse(structured(await call('crm_record_create', productCreate))).record
    expect(productReplay.id).toBe(product.id)
    const duplicate = await call('crm_record_create', {
      object_type: 'product',
      data: { name: `Duplicate ${runKey}`, sku: `sku-${runKey}` },
    })
    expect(ToolResult.parse(duplicate).structuredContent).toMatchObject({ code: 'DUPLICATE_FOUND' })

    const firstLine = RecordResult.parse(structured(await call('crm_record_create', {
      object_type: 'line_item',
      data: {
        name: `Snapshot 10 ${runKey}`,
        sku: `sku-${runKey}`,
        quantity: 2,
        unit_price: { amount: '10', currency: 'GBP' },
        total_amount: { amount: '20', currency: 'GBP' },
        billing_frequency: 'one_time',
        snapshot_at: '2026-08-24T10:00:00.000Z',
        product: product.id,
        deal: deal.id,
        external_ref: `line-one-${runKey}`,
      },
    }))).record
    const productBeforeUpdate = RecordResult.parse(structured(await call('crm_record_get', { id: product.id }))).record
    const productUpdated = RecordResult.parse(structured(await call('crm_record_update', {
      id: product.id,
      data: { current_unit_price: { amount: '20', currency: 'GBP' } },
      expected_version: productBeforeUpdate.version,
    }))).record
    const secondLine = RecordResult.parse(structured(await call('crm_record_create', {
      object_type: 'line_item',
      data: {
        name: `Snapshot 20 ${runKey}`,
        sku: `sku-${runKey}`,
        quantity: 1,
        unit_price: { amount: '20', currency: 'GBP' },
        total_amount: { amount: '20', currency: 'GBP' },
        billing_frequency: 'one_time',
        snapshot_at: '2026-08-24T11:00:00.000Z',
        product: product.id,
        deal: deal.id,
        external_ref: `line-two-${runKey}`,
      },
    }))).record
    expect(productUpdated.data.current_unit_price).toEqual({ amount: '20', currency: 'GBP' })
    const firstSnapshot = RecordResult.parse(structured(await call('crm_record_get', { id: firstLine.id }))).record
    const secondSnapshot = RecordResult.parse(structured(await call('crm_record_get', { id: secondLine.id }))).record
    expect(firstSnapshot.data.unit_price).toEqual({ amount: '10', currency: 'GBP' })
    expect(secondSnapshot.data.unit_price).toEqual({ amount: '20', currency: 'GBP' })

    const linkedItems = structured(await call('crm_records_query', {
      object_type: 'line_item',
      filter: { linked_to: { relation: 'line_item_product', record_id: product.id, direction: 'from' } },
      attributes: ['name', 'sku', 'unit_price'],
    }))
    expect(z.object({ records: z.array(z.object({ id: z.string().uuid() })) }).parse(linkedItems).records)
      .toHaveLength(2)
    const productRead = RecordResult.parse(structured(await call('crm_record_get', { id: product.id }))).record
    expect(productRead.data).not.toHaveProperty('current_unit_cost')
    expect(productRead.redacted_attributes).toContain('current_unit_cost')

    const invalidDiscount = await call('crm_record_create', {
      object_type: 'line_item',
      data: {
        name: `Invalid discount ${runKey}`,
        sku: `sku-${runKey}`,
        quantity: 1,
        unit_price: { amount: '20', currency: 'GBP' },
        discount_percent: 101,
        total_amount: { amount: '20', currency: 'GBP' },
        billing_frequency: 'one_time',
        snapshot_at: '2026-08-24T12:00:00.000Z',
        product: product.id,
        deal: deal.id,
      },
    })
    expect(ToolResult.parse(invalidDiscount).structuredContent).toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})
