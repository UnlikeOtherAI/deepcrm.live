import { createDb, dropTenant, seedTenant } from '@deepcrm/db'
import type { ActorContext, Principal } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import {
  consumeSeenRequestId,
  recordPrincipalSeen,
  TokenVersionRegressionError,
} from '../../src/services/principals.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for principal tests')

const db = createDb(databaseUrl)
const organizationIds: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')

type Tenant = { organizationId: string; teamId: string }

function ctx(tenant: Tenant): ActorContext {
  return {
    tenant,
    app: 'nessie',
    actChain: [{ sub: 'api.origin.example', product: 'origin' }],
    actor: { type: 'agent', id: 'agent_nessie' },
    onBehalfOf: { uoaUserId: 'usr_seen', role: 'admin' },
    provenance: { runId: 'run_1', toolCallId: 'call_1', requestId: 'req_1' },
    requestId: 'http_req_1',
    now,
  }
}

function principal(): Principal {
  return {
    app: 'nessie',
    uoaUserId: 'usr_seen',
    uoaOrgId: 'org_uoa',
    uoaTeamId: 'team_uoa',
    role: 'admin',
    sourceDomain: 'api.nessie.works',
    product: 'nessie',
    actChain: [{ sub: 'api.origin.example', product: 'origin' }],
    agentId: 'agent_nessie',
    tokenVersion: 7,
    provenance: { runId: 'run_1', toolCallId: 'call_1', requestId: 'req_1' },
  }
}

async function fixture(): Promise<Tenant> {
  const created = await seedTenant(db)
  organizationIds.push(created.organizationId)
  return { organizationId: created.organizationId, teamId: created.teamId }
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { organizationId: { in: organizationIds } } })
  for (const organizationId of organizationIds) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('principal liveness and replay evidence', () => {
  it('upserts last seen and schedules webhook delivery resume', async () => {
    const tenant = await fixture()
    await db.webhook.create({
      data: {
        id: crypto.randomUUID(),
        ...tenant,
        subscribingUoaUserId: 'usr_seen',
        url: 'https://hooks.example.test/events',
        events: ['record.updated'],
        secretCiphertext: 'sealed',
      },
    })
    await recordPrincipalSeen(db, ctx(tenant), principal())

    await expect(db.principalLastSeen.findUniqueOrThrow({
      where: { teamId_uoaUserId: { teamId: tenant.teamId, uoaUserId: 'usr_seen' } },
    })).resolves.toMatchObject({ lastSeenAt: now })
    await expect(db.queueJob.findFirstOrThrow({
      where: { ...tenant, type: 'change.deliver' },
    })).resolves.toMatchObject({ priority: 100 })
  })

  it('rejects token-version regression and consumes destructive request ids once', async () => {
    const tenant = await fixture()
    await recordPrincipalSeen(db, ctx(tenant), principal())
    await expect(recordPrincipalSeen(db, ctx(tenant), { ...principal(), tokenVersion: 6 }))
      .rejects.toBeInstanceOf(TokenVersionRegressionError)

    await expect(consumeSeenRequestId(db, ctx(tenant), 'crm_record_delete', 'a'.repeat(64)))
      .resolves.toBe(true)
    await expect(consumeSeenRequestId(db, ctx(tenant), 'crm_record_delete', 'a'.repeat(64)))
      .resolves.toBe(false)
    await expect(consumeSeenRequestId(db, { ...ctx(tenant), provenance: null }, 'crm_record_delete', 'a'.repeat(64)))
      .resolves.toBe(true)
  })
})
