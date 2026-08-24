import { createHmac } from 'node:crypto'

import { createDb, dropTenant, Prisma, seedTenant, writeAudit } from '@deepcrm/db'
import { complete, enqueue, progress } from '@deepcrm/queue'
import {
  WEBHOOK_SECRET_PURPOSE,
  createSafeFetch,
  parseSecretBox,
  webhookSecretAdditionalData,
  type SafeFetch,
} from '@deepcrm/schemas'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { JobRetryError, type JobHandlerInput } from '../../src/index.js'
import {
  CHANGE_DELIVER_JOB,
  createChangeDeliverHandler,
} from '../../src/jobs/change-deliver.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for delivery tests')
const db = createDb(databaseUrl)
const organizationIds: string[] = []
const now = new Date('2026-08-24T12:00:00.000Z')
const secretBox = parseSecretBox(Buffer.from(JSON.stringify({
  active: 'delivery-v1',
  keys: { 'delivery-v1': Buffer.alloc(32, 52).toString('base64') },
}), 'utf8').toString('base64'))

type Tenant = Awaited<ReturnType<typeof seedTenant>>

async function fixture() {
  const tenant = await seedTenant(db)
  organizationIds.push(tenant.organizationId)
  const objectType = await db.objectType.create({ data: {
    organizationId: tenant.organizationId,
    teamId: tenant.teamId,
    slug: 'person', singularName: 'Person', pluralName: 'People', description: 'Webhook person',
    kind: 'custom', createdByType: 'system', createdById: 'delivery-test',
  } })
  await db.attribute.createMany({ data: [
    {
      organizationId: tenant.organizationId, teamId: tenant.teamId,
      objectTypeId: objectType.id, slug: 'name', name: 'Name', description: 'Name',
      type: 'text', config: { maxLength: 100 }, sensitivity: 'public', position: 0,
    },
    {
      organizationId: tenant.organizationId, teamId: tenant.teamId,
      objectTypeId: objectType.id, slug: 'secret', name: 'Secret', description: 'Secret',
      type: 'text', config: { maxLength: 100 }, sensitivity: 'restricted', position: 1,
    },
  ] })
  const record = await db.record.create({ data: {
    organizationId: tenant.organizationId, teamId: tenant.teamId,
    objectTypeId: objectType.id, data: { name: 'Ada', secret: 'never-push' },
    displayName: 'Ada', visibility: 'team', createdOnBehalfOf: 'subscriber',
    createdByType: 'human', createdById: 'subscriber',
  } })
  await db.principalLastSeen.create({
    data: { teamId: tenant.teamId, uoaUserId: 'subscriber', lastSeenAt: now },
  })
  return { tenant, objectType, record }
}

async function storeWebhook(tenant: Tenant, secret: string) {
  const id = crypto.randomUUID()
  const url = 'https://hooks.example.test/events'
  const secretCiphertext = secretBox.seal(
    new TextEncoder().encode(secret),
    WEBHOOK_SECRET_PURPOSE,
    webhookSecretAdditionalData({
      organizationId: tenant.organizationId, teamId: tenant.teamId, webhookId: id, url,
    }),
  )
  return db.webhook.create({ data: {
    id, organizationId: tenant.organizationId, teamId: tenant.teamId,
    subscribingUoaUserId: 'subscriber', url,
    events: ['record.updated'], secretCiphertext, active: true, lastDeliveredSeq: 0n,
  } })
}

async function storeChange(target: Awaited<ReturnType<typeof fixture>>, attribute = 'name') {
  await db.recordChange.create({ data: {
    organizationId: target.tenant.organizationId, teamId: target.tenant.teamId,
    recordId: target.record.id, kind: 'set', attributeSlug: attribute,
    oldValue: Prisma.JsonNull, newValue: attribute === 'secret' ? 'never-push' : 'Ada',
    snapshot: Prisma.JsonNull, actorType: 'human', actorId: 'subscriber',
    onBehalfOf: 'subscriber', requestId: crypto.randomUUID(), resultingVersion: 2, seq: 1n,
  } })
  await db.team.update({ where: { id: target.tenant.teamId }, data: { feedSeq: 1n } })
}

async function handlerInput(tenant: Tenant, attempts: number): Promise<JobHandlerInput> {
  const workerId = crypto.randomUUID()
  const stored = await enqueue(db, {
    organizationId: tenant.organizationId, teamId: tenant.teamId,
    type: CHANGE_DELIVER_JOB,
    payload: { organizationId: tenant.organizationId, teamId: tenant.teamId },
    maxAttempts: 6,
  })
  await db.queueJob.update({
    where: { id: stored.id },
    data: { status: 'running', lockedBy: workerId, lockedAt: now, attempts },
  })
  const job = await db.queueJob.findUniqueOrThrow({ where: { id: stored.id } })
  return {
    db, job, workerId, clock: () => now, writeAudit,
    progress: (value) => progress(db, job.id, workerId, value),
    terminalize: (tx, result) => complete(tx, job.id, workerId, result),
  }
}

afterAll(async () => {
  for (const organizationId of organizationIds) await dropTenant(db, organizationId)
  await db.$disconnect()
})

describe('change delivery worker', () => {
  it('signs a post-registration batch, advances its cursor, and omits restricted values', async () => {
    const target = await fixture()
    const secret = 'a'.repeat(64)
    const webhook = await storeWebhook(target.tenant, secret)
    await storeChange(target)
    const requests: Array<{ body: string; headers: Record<string, string> }> = []
    const safeFetch: SafeFetch = async (_url, init) => {
      if (init.body === undefined || init.headers === undefined) throw new Error('missing request body')
      requests.push({ body: init.body, headers: init.headers })
      return { ok: true, status: 204 }
    }
    await createChangeDeliverHandler(secretBox, safeFetch, 30)(await handlerInput(target.tenant, 1))

    const request = requests[0]
    expect(request).toBeDefined()
    if (request === undefined) throw new Error('delivery request missing')
    const timestamp = request.headers['x-deepcrm-timestamp']
    if (timestamp === undefined) throw new Error('delivery timestamp missing')
    const signature = createHmac('sha256', secret).update(`${timestamp}.${request.body}`).digest('hex')
    expect(request.headers['x-deepcrm-signature']).toBe(`sha256=${signature}`)
    expect(request.headers['x-deepcrm-webhook']).toBe(webhook.id)
    expect(JSON.parse(request.body)).toMatchObject({
      schema: 'deepcrm.webhook.v1', since_seq: '0', until_seq: '1', backlog_remaining: 0,
      events: [{ event: 'record.updated', seq: '1', new_value: 'Ada' }],
    })
    expect(request.body).not.toContain('never-push')
    expect((await db.webhook.findFirstOrThrow({
      where: { id: webhook.id, organizationId: target.tenant.organizationId, teamId: target.tenant.teamId },
    })).lastDeliveredSeq).toBe(1n)
  })

  it('keeps the first failed attempt queued for the exact one-minute retry', async () => {
    const target = await fixture()
    await storeWebhook(target.tenant, 'b'.repeat(64))
    await storeChange(target)
    const handler = createChangeDeliverHandler(secretBox, async () => ({ ok: false, status: 500 }), 30)
    const input = await handlerInput(target.tenant, 1)
    const failure = await handler(input).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(JobRetryError)
    if (!(failure instanceof JobRetryError)) throw new Error('expected retry error')
    expect(failure.retryAt.toISOString()).toBe('2026-08-24T12:01:00.000Z')
    expect(input.job.attempts).toBe(1)
  })

  it('re-resolves and rejects a private address at delivery time before connecting', async () => {
    const target = await fixture()
    await storeWebhook(target.tenant, 'c'.repeat(64))
    await storeChange(target)
    const requester = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    const safeFetch = createSafeFetch(
      async () => [{ address: '127.0.0.1', family: 4 }],
      requester,
    )
    await expect(createChangeDeliverHandler(secretBox, safeFetch, 30)(await handlerInput(target.tenant, 1)))
      .rejects.toBeInstanceOf(JobRetryError)
    expect(requester).not.toHaveBeenCalled()
  })

  it('pauses stale subscribers without advancing the delivery cursor', async () => {
    const target = await fixture()
    const webhook = await storeWebhook(target.tenant, 'd'.repeat(64))
    await storeChange(target)
    await db.principalLastSeen.update({
      where: { teamId_uoaUserId: { teamId: target.tenant.teamId, uoaUserId: 'subscriber' } },
      data: { lastSeenAt: new Date('2026-07-01T00:00:00.000Z') },
    })
    const requester = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    await createChangeDeliverHandler(secretBox, requester, 30)(await handlerInput(target.tenant, 1))
    expect(requester).not.toHaveBeenCalled()
    expect((await db.webhook.findFirstOrThrow({
      where: { id: webhook.id, organizationId: target.tenant.organizationId, teamId: target.tenant.teamId },
    })).lastDeliveredSeq).toBe(0n)
  })
})
