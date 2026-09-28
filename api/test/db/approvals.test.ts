import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createDb, dropTenant, seedTenant, type TenantRef } from '@deepcrm/db'
import { ErrorCode, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { buildMcpServer } from '../../src/mcp/server.js'
import { requireApproval, roleSatisfies } from '../../src/services/approvals.js'
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
type ApprovalChallengeResult = { args: Record<string, unknown>; requestState: string }

function context(tenant: TenantRef, role: 'member' | 'admin' | 'owner', user: string): ActorContext {
  const base = linkContext(tenant, user)
  return { ...base, onBehalfOf: { uoaUserId: user, role } }
}

/** A Nessie agent acting for `user`: the context an `X-Nessie-Context` agent claim produces. */
function nessieAgentContext(
  tenant: TenantRef, role: 'member' | 'admin' | 'owner', user: string, agentId: string,
): ActorContext {
  return { ...context(tenant, role, user), app: 'nessie', actor: { type: 'agent', id: agentId } }
}

async function clientFor(ctx: ActorContext): Promise<Client> {
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

async function challenge(target: Fixture, requester?: ActorContext) {
  const member = await clientFor(requester ?? context(target.tenant, 'member', crypto.randomUUID()))
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

async function webhookDeleteChallenge(tenant: TenantRef): Promise<ApprovalChallengeResult> {
  const webhook = await db.webhook.create({
    data: {
      ...tenant,
      subscribingUoaUserId: 'webhook_delete_requester',
      url: `https://1.1.1.1/delete-${crypto.randomUUID()}`,
      events: ['record.updated'],
      secretCiphertext: 'sealed',
      active: true,
    },
  })
  const owner = await clientFor(context(tenant, 'owner', 'webhook_delete_requester'))
  const args = { id: webhook.id }
  const result = ToolResult.parse(await owner.callTool({ name: 'crm_webhook_delete', arguments: args }))
  expect(result).toMatchObject({
    resultType: 'input_required',
    inputRequests: { approval: { method: 'elicitation/create' } },
  })
  expect(result.requestState).toEqual(expect.any(String))
  return { args, requestState: result.requestState ?? '' }
}

function mergeApproval(initial: ApprovalChallengeResult) {
  return {
    method: 'tools/call' as const,
    params: {
      name: 'crm_merge_records',
      arguments: initial.args,
      inputResponses: { approval: { action: 'accept' as const, content: { approved: true } } },
      requestState: initial.requestState,
    },
  }
}

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const organizationId of organizationIds) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('approval MRTR', () => {
  it('requires owner approval for erasure and suppression removal challenges', async () => {
    const seeded = await seedTenant(db)
    const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
    organizationIds.push(tenant.organizationId)
    const requester = context(tenant, 'member', 'approval_owner_requester')

    await requireApproval(deps, requester, {
      tool: 'crm_record_erase',
      resourceType: 'record',
      resourceId: crypto.randomUUID(),
      args: { id: crypto.randomUUID(), reason: 'gdpr_request', suppress: true },
    })
    await requireApproval(deps, requester, {
      tool: 'crm_suppression_remove',
      resourceType: 'suppression',
      args: {
        kind: 'email',
        value: 'remove@example.com',
        channel: 'all',
        reason: 'operator confirmed',
      },
    })

    const rows = await db.approvalRequest.findMany({
      where: { ...tenant },
      orderBy: { createdAt: 'asc' },
      select: { action: true, requiredRole: true },
    })
    expect(rows).toEqual([
      { action: 'crm_record_erase', requiredRole: 'owner' },
      { action: 'crm_suppression_remove', requiredRole: 'owner' },
    ])
  })

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

  it('lets a different owner consume a webhook delete approval exactly once', async () => {
    const seeded = await seedTenant(db)
    const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
    organizationIds.push(tenant.organizationId)
    await db.$transaction((tx) => seedDefaultPolicies(tx, tenant))
    const initial = await webhookDeleteChallenge(tenant)
    const owner = await clientFor(context(tenant, 'owner', 'webhook_delete_approver'))
    const request = {
      method: 'tools/call' as const,
      params: {
        name: 'crm_webhook_delete',
        arguments: initial.args,
        inputResponses: { approval: { action: 'accept' as const, content: { approved: true } } },
        requestState: initial.requestState,
      },
    }

    const deleted = ToolResult.parse(await owner.request(request, ToolResult))
    expect(deleted.isError).not.toBe(true)
    expect(deleted.structuredContent).toEqual({ deleted: true })
    await expect(db.approvalRequest.findFirstOrThrow({
      where: { ...tenant, action: 'crm_webhook_delete' },
    })).resolves.toMatchObject({ status: 'consumed', requiredRole: 'owner' })
    expect(await db.webhook.count({ where: tenant })).toBe(0)

    const replay = ToolResult.parse(await owner.request(request, ToolResult))
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

  it('lets an owner satisfy an admin requirement and never an admin an owner requirement', () => {
    expect(roleSatisfies('admin', 'admin')).toBe(true)
    expect(roleSatisfies('admin', 'owner')).toBe(true)
    expect(roleSatisfies('owner', 'owner')).toBe(true)
    expect(roleSatisfies('owner', 'admin')).toBe(false)
    for (const lesser of ['member', null] as const) {
      expect(roleSatisfies('admin', lesser)).toBe(false)
      expect(roleSatisfies('owner', lesser)).toBe(false)
    }
  })

  it('lets a different owner consume an admin-required member merge approval', async () => {
    const target = await fixture()
    const initial = await challenge(target)
    const owner = await clientFor(context(target.tenant, 'owner', crypto.randomUUID()))
    const merged = ToolResult.parse(await owner.request(mergeApproval(initial), ToolResult))
    expect(merged.isError).not.toBe(true)
    expect(merged.structuredContent).toMatchObject({ record: { id: target.survivorId } })
    await expect(db.approvalRequest.findFirstOrThrow({
      where: { ...target.tenant, action: 'crm_merge_records' },
    })).resolves.toMatchObject({ status: 'consumed', requiredRole: 'admin' })
  })

  it('refuses an admin for an owner-required approval and the requester for their own', async () => {
    const seeded = await seedTenant(db)
    const tenant = { organizationId: seeded.organizationId, teamId: seeded.teamId }
    organizationIds.push(tenant.organizationId)
    await db.$transaction((tx) => seedDefaultPolicies(tx, tenant))
    const initial = await webhookDeleteChallenge(tenant)
    const admin = await clientFor(context(tenant, 'admin', 'webhook_delete_admin'))
    const refused = ToolResult.parse(await admin.request({
      method: 'tools/call',
      params: {
        name: 'crm_webhook_delete',
        arguments: initial.args,
        inputResponses: { approval: { action: 'accept', content: { approved: true } } },
        requestState: initial.requestState,
      },
    }, ToolResult))
    expect(refused).toMatchObject({
      isError: true,
      structuredContent: { code: ErrorCode.APPROVAL_REQUIRED, detail: 'approval_not_pending' },
    })

    const target = await fixture()
    const requesterId = crypto.randomUUID()
    const own = await challenge(target, context(target.tenant, 'member', requesterId))
    const promoted = await clientFor(context(target.tenant, 'owner', requesterId))
    const selfApproved = ToolResult.parse(await promoted.request(mergeApproval(own), ToolResult))
    expect(selfApproved).toMatchObject({
      isError: true,
      structuredContent: { code: ErrorCode.APPROVAL_REQUIRED, detail: 'approver_must_differ' },
    })
    await expect(db.approvalRequest.count({
      where: { ...tenant, status: 'pending' },
    })).resolves.toBe(1)
    await expect(db.approvalRequest.count({
      where: { ...target.tenant, status: 'pending' },
    })).resolves.toBe(1)
  })

  it('takes the approving admin through a nessie agent context and keeps the agent as the actor', async () => {
    const target = await fixture()
    const requester = nessieAgentContext(target.tenant, 'member', crypto.randomUUID(), 'nessie_agent_requester')
    const initial = await challenge(target, requester)
    const approverId = crypto.randomUUID()
    const approver = await clientFor(
      nessieAgentContext(target.tenant, 'admin', approverId, 'nessie_agent_approver'),
    )
    const merged = ToolResult.parse(await approver.request(mergeApproval(initial), ToolResult))
    expect(merged.isError).not.toBe(true)
    const mergeChangeId = z.object({ merge_change_id: z.string() }).parse(merged.structuredContent).merge_change_id
    await expect(db.approvalRequest.findFirstOrThrow({
      where: { ...target.tenant, action: 'crm_merge_records' },
    })).resolves.toMatchObject({
      status: 'consumed', requiredRole: 'admin', requesterType: 'agent',
      requesterId: 'nessie_agent_requester', resolverUoaUserId: approverId,
    })
    await expect(db.recordChange.findFirstOrThrow({
      where: { ...target.tenant, id: mergeChangeId },
    })).resolves.toMatchObject({
      actorType: 'agent', actorId: 'nessie_agent_approver', onBehalfOf: approverId,
    })
  })
})
