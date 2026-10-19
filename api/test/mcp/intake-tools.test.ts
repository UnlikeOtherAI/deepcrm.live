import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import { applyTemplate, createProjectionLinkWriter, FakeEmbedder } from '@deepcrm/schema-engine'
import { parseSecretBox, type ActorContext } from '@deepcrm/schemas'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { AppDeps } from '../../src/deps.js'
import { buildMcpServer } from '../../src/mcp/server.js'
import type { ToolExposure } from '../../src/mcp/tools/register.js'
import { submitIntake } from '../../src/services/intake.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { seedDefaultPolicies } from '../../src/services/policy.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import { testFileAccess } from '../file-access-fixture.js'

// The human side of intake over MCP (schema-engine §4d″–§4d‴): a Nessie agent
// acting for an admin lists and decides proposals and works a person's phones;
// a delegated crm_intake_submit is refused.

// Postgres-backed writes on a shared, loaded host take seconds each.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP intake tests')

const db = createDb(databaseUrl)
const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSJ9fQ=='
const deps: AppDeps = {
  db, clock: () => new Date(), ids: () => crypto.randomUUID(), version: '0.0.0',
  maxBulkRows: 10_000, maxExportRows: 100_000, embedder: new FakeEmbedder('api-test'), orgAllowlist: null,
  linkWriter: createProjectionLinkWriter(),
  historyCursor: createHistoryCursorCodec(parseSecretBox(keyring)),
  queryCursor: createQueryCursorCodec(parseSecretBox(keyring)),
  secretBox: parseSecretBox(keyring), fileAccess: testFileAccess, writeAudit,
}
const ToolResult = z.object({ isError: z.boolean().optional(), structuredContent: z.record(z.unknown()) })
  .passthrough()

let tenant: { organizationId: string; teamId: string }
const closers: Array<() => Promise<void>> = []

async function connect(ctx: ActorContext, exposure?: ToolExposure): Promise<Client> {
  const server = buildMcpServer(ctx, deps, exposure)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'intake-test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  closers.push(async () => {
    await client.close()
    await server.close()
  })
  return client
}

function context(actor: ActorContext['actor'], onBehalfOf: ActorContext['onBehalfOf']): ActorContext {
  return {
    tenant, app: 'nessie', actChain: [], actor, onBehalfOf,
    provenance: actor.type === 'agent' ? { runId: 'run_1', toolCallId: 'call_1', requestId: 'req_1' } : null,
    requestId: crypto.randomUUID(), now: new Date(),
  }
}

const agent = () => context({ type: 'agent', id: 'agent_clients' }, { uoaUserId: 'uoa_admin', role: 'admin' })
const subject = () => context({ type: 'system', id: 'subject:nessie' }, null)

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return ToolResult.parse(await client.callTool({ name, arguments: args }))
}

const submission = (input: Record<string, unknown>) => ({
  source: { kind: 'contact_form', id: 'form_spring', name: 'Spring newsletter form' },
  activity: { kind: 'message', occurred_at: '2026-10-19T09:00:00Z', subject: 'Contact form: Spring' },
  ...input,
})

beforeAll(async () => {
  const seeded = await seedTenant(db)
  tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  await db.$transaction(async (tx) => {
    await seedDefaultPolicies(tx, tenant)
    const actor = { type: 'system' as const, id: 'intake-test', onBehalfOf: null, requestId: 'seed' }
    await applyTemplate(tx, tenant, actor, 'system')
    await applyTemplate(tx, tenant, actor, 'standard_crm')
  }, { timeout: 60_000 })
})

afterAll(async () => {
  for (const close of closers) await close()
  await dropTenant(db, tenant.organizationId)
  await db.$disconnect()
})

describe('intake tools for people, over MCP', () => {
  it('refuses a delegated crm_intake_submit', async () => {
    const client = await connect(agent())
    const result = await call(client, 'crm_intake_submit', submission({ email: 'ada@example.com' }))
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'POLICY_DENIED' })
  })

  it('lists and approves an amendment, then works the person\'s phones', async () => {
    const created = await submitIntake(deps, subject(), submission({
      email: 'ada@example.com', phone: '+442071838750', data: { name: { full: 'Ada Lovelace' } },
    }) as Parameters<typeof submitIntake>[2])
    const id = created.record_id ?? ''
    await submitIntake(deps, subject(), submission({
      email: 'ada@example.com', phone: '+16502530000', data: { name: { full: 'Ada King' } },
    }) as Parameters<typeof submitIntake>[2])
    const client = await connect(agent())
    const listed = await call(client, 'crm_proposals_list', { status: 'pending' })
    const proposals = z.array(z.object({ id: z.string(), record: z.object({ version: z.number() }) }))
      .parse(listed.structuredContent['proposals'])
    expect(proposals).toHaveLength(1)
    const [proposal] = proposals
    const decided = await call(client, 'crm_proposal_decide', {
      id: proposal?.id, decision: 'approve', expected_version: proposal?.record.version,
    })
    expect(decided.structuredContent).toEqual({ id: proposal?.id, status: 'approved', record_id: id })

    const read = await call(client, 'crm_contact_points_get', { record_id: id })
    const phones = z.array(z.object({ slug: z.string(), values: z.array(z.object({ value: z.string(), confirmed: z.boolean() })) }))
      .parse(read.structuredContent['attributes']).find((attribute) => attribute.slug === 'phones')
    expect(phones?.values).toEqual([
      { value: '+442071838750', confirmed: false }, { value: '+16502530000', confirmed: false },
    ])
    const reached = await call(client, 'crm_contact_point_set', {
      record_id: id, attribute: 'phones', value: '+16502530000', action: 'reach', note: 'Called back',
    })
    expect(reached.isError).not.toBe(true)
    const replaced = await call(client, 'crm_contact_point_set', {
      record_id: id, attribute: 'phones', value: '+16502530000', action: 'replace_others',
    })
    expect(replaced.structuredContent).toMatchObject({
      record_id: id,
      attribute: {
        slug: 'phones',
        values: [expect.objectContaining({ value: '+16502530000', confirmed: true, reached: expect.objectContaining({ note: 'Called back' }) })],
        archived: [expect.objectContaining({ value: '+442071838750', archived: expect.objectContaining({ by: { type: 'agent', id: 'agent_clients' } }) })],
      },
    })
  })
})
