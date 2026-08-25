import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for filtering resource tests')

let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>

beforeAll(async () => {
  const started = await startTestServer()
  client = started.client
  closeServer = started.close
})

afterAll(async () => {
  await closeServer()
})

const readResult = z.object({
  ttlMs: z.literal(300_000),
  cacheScope: z.literal('private'),
  contents: z.array(z.object({ uri: z.literal('crm://help/filtering'), text: z.string() })),
}).passthrough()

describe('filtering help resource', () => {
  it('lists and reads static filter guidance with cache metadata', async () => {
    const listed = await client.listResources()
    expect(listed.resources.map((resource) => resource.uri)).toContain('crm://help/filtering')

    const result = readResult.parse(await client.request({
      method: 'resources/read', params: { uri: 'crm://help/filtering' },
    }, readResult))
    const content = result.contents[0]
    if (content === undefined) throw new Error('Expected filtering resource content')
    const help = z.object({
      caps: z.object({ max_depth: z.literal(8), max_nodes: z.literal(100), max_json_bytes: z.literal(16_384) }),
      operators_by_type: z.array(z.object({ types: z.array(z.string()), ops: z.array(z.string()) }).passthrough()),
      examples: z.array(z.object({ name: z.string(), filter: z.unknown() })).length(5),
    }).parse(JSON.parse(content.text))
    expect(help.operators_by_type.some((row) => row.types.includes('record_reference (multi)'))).toBe(true)
    const operators = new Map(help.operators_by_type.map((row) => [row.types.join('|'), row.ops]))
    expect(operators.get('system:owner')).toEqual([
      'eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null',
    ])
    expect(operators.get('system:display_name')).toEqual([
      'eq', 'neq', 'in', 'not_in', 'contains', 'starts_with', 'is_null', 'is_not_null',
    ])
    expect(operators.get('system:created_at|system:updated_at|system:last_activity_at')).toEqual([
      'eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'is_not_null',
    ])
    expect(operators.get('actor_reference (multi)')).toEqual(['contains'])
    expect(operators.get('record_reference (multi)')).toEqual(['contains'])
    expect(help.examples.map((example) => example.name)).toEqual([
      'qualified_or_proposal_deals_over_amount',
      'owned_or_enterprise_tag',
      'company_linked_deals_with_recent_activity_filter',
      'visible_line_items_for_sku',
      'data_quality_orphans',
    ])
  })
})
