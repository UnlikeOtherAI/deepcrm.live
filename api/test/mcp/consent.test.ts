import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createDb, dropTenant, seedTenant, writeAudit } from '@deepcrm/db'
import { applyTemplate, createProjectionLinkWriter, FakeEmbedder } from '@deepcrm/schema-engine'
import { CrmConsentGet, CrmConsentSet, parseSecretBox, type ActorContext } from '@deepcrm/schemas'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { AppDeps } from '../../src/deps.js'
import { buildMcpServer } from '../../src/mcp/server.js'
import type { ToolExposure } from '../../src/mcp/tools/register.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { seedDefaultPolicies } from '../../src/services/policy.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import { testFileAccess } from '../file-access-fixture.js'

// The two consent tools over MCP, as a Nessie agent, a person and a
// subject-attested call (whose server runs only the one tool it attests).

// Postgres-backed writes on a shared, loaded host take seconds each.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP consent tests')

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
  const client = new Client({ name: 'consent-test', version: '0.0.0' })
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

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return ToolResult.parse(await client.callTool({ name, arguments: args }))
}

beforeAll(async () => {
  const seeded = await seedTenant(db)
  tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  await db.$transaction(async (tx) => {
    await seedDefaultPolicies(tx, tenant)
    await applyTemplate(tx, tenant, { type: 'system', id: 'consent-mcp-test', onBehalfOf: null, requestId: 'seed' },
      'standard_crm')
  })
})

afterAll(async () => {
  for (const close of closers) await close()
  await db.auditLog.deleteMany({ where: { organizationId: tenant.organizationId } })
  await dropTenant(db, tenant.organizationId)
  await db.$disconnect()
})

describe('consent MCP tools', () => {
  it('refuses an agent confirmed consent and lets it record a decline', async () => {
    const agent = await connect(context({ type: 'agent', id: 'agent_newsletter' }, {
      uoaUserId: 'uoa_member', role: 'member',
    }))
    const refused = await call(agent, 'crm_consent_set', {
      email: 'agent@example.com', state: 'confirmed', source: 'manual', create: { data: { name: { full: 'A' } } },
    })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({ code: 'POLICY_DENIED', next: 'fatal' })

    const declined = CrmConsentSet.out.parse((await call(agent, 'crm_consent_set', {
      email: 'agent@example.com', state: 'declined', source: 'manual', create: { data: { name: { full: 'A' } } },
    })).structuredContent)
    expect(declined).toMatchObject({ created: true, state: 'declined', suppressed: true })
    expect(CrmConsentGet.out.parse((await call(agent, 'crm_consent_get', { email: 'AGENT@example.com' }))
      .structuredContent)).toMatchObject({ record_id: declined.record_id, state: 'declined', source: 'manual' })
  })

  it('needs a reason before a person records confirmed', async () => {
    const person = await connect(context({ type: 'human', id: 'uoa_member' }, {
      uoaUserId: 'uoa_member', role: 'member',
    }))
    const args = { email: 'person@example.com', state: 'confirmed', source: 'manual', create: { data: {
      name: { full: 'P' },
    } } }
    const refused = await call(person, 'crm_consent_set', args)
    expect(refused.structuredContent).toMatchObject({ code: 'VALIDATION_FAILED', next: 'fix_input' })
    const recorded = await call(person, 'crm_consent_set', { ...args, reason: 'Signed paper form at the fair' })
    expect(CrmConsentSet.out.parse(recorded.structuredContent)).toMatchObject({ created: true, state: 'confirmed' })
  })

  it('serves a subject-attested call its one tool and refuses every other', async () => {
    const subject = await connect(
      context({ type: 'system', id: 'subject:nessie' }, null),
      { kind: 'only', tool: 'crm_consent_set' },
    )
    expect((await subject.listTools()).tools.map((tool) => tool.name)).toEqual(['crm_consent_set'])
    const written = await call(subject, 'crm_consent_set', {
      email: 'subject@example.com', state: 'not_confirmed', source: 'signup_form',
      create: { data: { name: { full: 'S' } } },
    })
    expect(CrmConsentSet.out.parse(written.structuredContent)).toMatchObject({ created: true })
    for (const [name, args] of [
      ['crm_consent_get', { email: 'subject@example.com' }],
      ['crm_record_get', { id: crypto.randomUUID() }],
      ['crm_suppression_remove', { kind: 'email', value: 'subject@example.com', reason: 'x' }],
    ] as const) {
      const refused = await call(subject, name, args)
      expect(refused.structuredContent, name).toMatchObject({ code: 'POLICY_DENIED' })
    }
  })
})
