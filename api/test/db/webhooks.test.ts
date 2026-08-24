import {
  createDb,
  dropTenant,
  seedTenant,
  writeAudit,
} from '@deepcrm/db'
import { createProjectionLinkWriter, FakeEmbedder } from '@deepcrm/schema-engine'
import { parseSecretBox, type ActorContext } from '@deepcrm/schemas'
import { afterAll, describe, expect, it } from 'vitest'

import type { AppDeps } from '../../src/deps.js'
import { createHistoryCursorCodec } from '../../src/services/history-cursor.js'
import { createQueryCursorCodec } from '../../src/services/query-cursor.js'
import { deleteWebhook, listWebhooks, setWebhook } from '../../src/services/webhooks.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for webhook tests')
const db = createDb(databaseUrl)
const organizationIds: string[] = []
const secretBox = parseSecretBox(Buffer.from(JSON.stringify({
  active: 'webhook-v1',
  keys: { 'webhook-v1': Buffer.alloc(32, 34).toString('base64') },
}), 'utf8').toString('base64'))
const now = new Date('2026-08-24T12:00:00.000Z')
const deps: AppDeps = {
  db,
  clock: () => now,
  ids: () => crypto.randomUUID(),
  version: '0.0.0',
  maxBulkRows: 10_000, maxExportRows: 100_000,
  orgAllowlist: null,
  linkWriter: createProjectionLinkWriter(),
  historyCursor: createHistoryCursorCodec(secretBox),
  queryCursor: createQueryCursorCodec(secretBox),
  secretBox,
  embedder: new FakeEmbedder('api-test'),
  writeAudit,
}

type Tenant = { organizationId: string; teamId: string }

function context(tenant: Tenant): ActorContext {
  return {
    tenant,
    app: 'webhook-test',
    actChain: [],
    actor: { type: 'human', id: 'webhook_owner' },
    onBehalfOf: { uoaUserId: 'webhook_owner', role: 'owner' },
    provenance: null,
    requestId: crypto.randomUUID(),
    now,
  }
}

async function fixture(): Promise<Tenant> {
  const tenant = await seedTenant(db)
  organizationIds.push(tenant.organizationId)
  await db.policyRule.create({
    data: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      scope: 'team',
      scopeId: tenant.teamId,
      resourceType: 'webhook',
      action: 'admin',
      effect: 'allow',
      priority: 100,
      requiresApproval: false,
      createdById: 'webhook-test',
      bindings: { create: { actorType: 'human', actorId: 'webhook_owner' } },
    },
  })
  return { organizationId: tenant.organizationId, teamId: tenant.teamId }
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { organizationId: { in: organizationIds } } })
  for (const organizationId of organizationIds) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('webhook service', () => {
  it('starts new registrations at the current sequence and returns secrets only once or on rotation', async () => {
    const tenant = await fixture()
    await db.team.update({ where: { id: tenant.teamId }, data: { feedSeq: 17n } })
    const ctx = context(tenant)
    const created = await setWebhook(deps, ctx, {
      url: 'https://1.1.1.1/events', events: ['record.updated'], active: true, rotateSecret: false,
    })
    expect(created.secret).toMatch(/^[a-f0-9]{64}$/u)
    const stored = await db.webhook.findFirstOrThrow({
      where: { id: created.webhook.id, ...tenant },
    })
    expect(stored.lastDeliveredSeq).toBe(17n)
    expect(stored.secretCiphertext).not.toContain(created.secret ?? '')

    const repeated = await setWebhook(deps, ctx, {
      url: 'https://1.1.1.1/events', events: ['record.created'], active: true, rotateSecret: false,
    })
    expect(repeated.secret).toBeUndefined()
    const rotated = await setWebhook(deps, ctx, {
      url: 'https://1.1.1.1/events', events: ['record.created'], active: true, rotateSecret: true,
    })
    expect(rotated.secret).toMatch(/^[a-f0-9]{64}$/u)
    expect(rotated.secret).not.toBe(created.secret)

    await expect(listWebhooks(deps, ctx)).resolves.toMatchObject({
      webhooks: [{ id: created.webhook.id, active: true, last_error: null }],
    })
    await expect(deleteWebhook(deps, ctx, created.webhook.id)).resolves.toEqual({ deleted: true })
    await expect(listWebhooks(deps, ctx)).resolves.toEqual({ webhooks: [] })
  })

  it('rejects private and non-HTTPS targets before writing', async () => {
    const tenant = await fixture()
    const ctx = context(tenant)
    await expect(setWebhook(deps, ctx, {
      url: 'https://127.0.0.1/events', events: ['record.updated'], active: true, rotateSecret: false,
    })).rejects.toThrow('non-public')
    await expect(setWebhook(deps, ctx, {
      url: 'http://1.1.1.1/events', events: ['record.updated'], active: true, rotateSecret: false,
    })).rejects.toThrow('HTTPS')
    expect(await db.webhook.count({ where: tenant })).toBe(0)
  })
})
