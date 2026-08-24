import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createDb, dropTenant, seedTenant, type TenantRef } from '@deepcrm/db'
import { ErrorCode } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { buildMcpServer } from '../../src/mcp/server.js'
import { seedDefaultPolicies } from '../../src/services/policy.js'
import { createRecord } from '../../src/services/records.js'
import { linkContext, linkDeps } from './link-fixture.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for approval tests')

const db = createDb(databaseUrl)
const deps = linkDeps(db)
const organizationIds: string[] = []
const clients: Client[] = []
const servers: McpServer[] = []

const ToolResult = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.unknown()).optional(),
  resultType: z.string().optional(),
  requestState: z.string().optional(),
  inputRequests: z.record(z.unknown()).optional(),
  content: z.array(z.unknown()),
}).passthrough()

type Fixture = { tenant: TenantRef; survivorId: string; loserId: string }

function context(tenant: TenantRef, role: 'member' | 'admin', user: string) {
  const base = linkContext(tenant, user)
  return { ...base, onBehalfOf: { uoaUserId: user, role } }
}

async function clientFor(ctx: ReturnType<typeof context>): Promise<Client> {
  const server = buildMcpServer(ctx, deps)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: `approval-${ctx.onBehalfOf.role}`, version: '0.0.0' })
  servers.push(server)
  clients.push(client)
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

async function fixture(): Promise<Fixture> {
  const seeded = await seedTenant(db)
  const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
  organizationIds.push(tenant.organizationId)
  await db.$transaction((tx) => seedDefaultPolicies(tx, tenant))
  const objectType = await db.objectType.create({ data: {
    ...tenant,
    slug: 'person',
    singularName: 'Person',
    pluralName: 'People',
    description: 'Approval test people.',
    kind: 'custom',
    createdByType: 'system',
    createdById: 'approval-test',
  } })
  await db.attribute.create({ data: {
    ...tenant,
    objectTypeId: objectType.id,
    slug: 'name',
    name: 'Name',
    description: 'Person name.',
    type: 'text',
    isRequired: true,
    isIndexed: true,
  } })
  const admin = context(tenant, 'admin', 'approval_fixture_admin')
  const survivor = await createRecord(deps, admin, {
    objectType: 'person', data: { name: 'Anna Novak' },
  })
  const loser = await createRecord(deps, admin, {
    objectType: 'person', data: { name: 'Anna Novak duplicate' },
  })
  return { tenant, survivorId: survivor.record.id, loserId: loser.record.id }
}

async function challenge(target: Fixture) {
  const member = await clientFor(context(target.tenant, 'member', crypto.randomUUID()))
  const args = {
    survivor_id: target.survivorId,
    merged_ids: [target.loserId],
    reason: 'same person',
  }
  const result = ToolResult.parse(await member.callTool({ name: 'crm_merge_records', arguments: args }))
  expect(result).toMatchObject({
    resultType: 'input_required',
    inputRequests: { approval: { method: 'elicitation/create' } },
  })
  expect(result.requestState).toEqual(expect.any(String))
  return { args, requestState: result.requestState ?? '' }
}

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const organizationId of organizationIds) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('approval MRTR', () => {
  it('lets a different admin consume a member merge approval exactly once', async () => {
    const target = await fixture()
    const initial = await challenge(target)
    const admin = await clientFor(context(target.tenant, 'admin', crypto.randomUUID()))
    const request = {
      method: 'tools/call' as const,
      params: {
        name: 'crm_merge_records',
        arguments: initial.args,
        inputResponses: { approval: { action: 'accept' as const, content: { approved: true } } },
        requestState: initial.requestState,
      },
    }
    const merged = ToolResult.parse(await admin.request(request, ToolResult))
    expect(merged.isError).not.toBe(true)
    expect(merged.structuredContent).toMatchObject({
      record: { id: target.survivorId },
      merge_change_id: expect.any(String),
    })
    await expect(db.approvalRequest.findFirstOrThrow({
      where: { ...target.tenant, action: 'crm_merge_records' },
    })).resolves.toMatchObject({ status: 'consumed', requiredRole: 'admin' })

    const replay = ToolResult.parse(await admin.request(request, ToolResult))
    expect(replay).toMatchObject({
      isError: true,
      structuredContent: { code: ErrorCode.APPROVAL_REQUIRED },
    })
  })

  it('rejects changed arguments and expired approval rows', async () => {
    const changedTarget = await fixture()
    const changed = await challenge(changedTarget)
    const changedAdmin = await clientFor(context(changedTarget.tenant, 'admin', crypto.randomUUID()))
    const changedResult = ToolResult.parse(await changedAdmin.request({
      method: 'tools/call',
      params: {
        name: 'crm_merge_records',
        arguments: { ...changed.args, reason: 'different reason' },
        inputResponses: { approval: { action: 'accept', content: { approved: true } } },
        requestState: changed.requestState,
      },
    }, ToolResult))
    expect(changedResult).toMatchObject({
      isError: true,
      structuredContent: { code: ErrorCode.APPROVAL_REQUIRED },
    })

    const expiredTarget = await fixture()
    const expired = await challenge(expiredTarget)
    await db.approvalRequest.updateMany({
      where: { ...expiredTarget.tenant, action: 'crm_merge_records', status: 'pending' },
      data: { expiresAt: new Date('2026-08-23T00:00:00.000Z') },
    })
    const expiredAdmin = await clientFor(context(expiredTarget.tenant, 'admin', crypto.randomUUID()))
    const expiredResult = ToolResult.parse(await expiredAdmin.request({
      method: 'tools/call',
      params: {
        name: 'crm_merge_records',
        arguments: expired.args,
        inputResponses: { approval: { action: 'accept', content: { approved: true } } },
        requestState: expired.requestState,
      },
    }, ToolResult))
    expect(expiredResult).toMatchObject({
      isError: true,
      structuredContent: { code: ErrorCode.APPROVAL_REQUIRED },
    })
  })
})
