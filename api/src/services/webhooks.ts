import { randomBytes } from 'node:crypto'

import { tenantWhere, type AuditEntryInput, type Prisma } from '@deepcrm/db'
import {
  ErrorCode,
  ServiceError,
  WEBHOOK_SECRET_PURPOSE,
  WebhookEvent,
  assertSafeUrl,
  webhookSecretAdditionalData,
  type ActorContext,
  type WebhookEventValue,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { checkPolicy } from './policy.js'

export type WebhookSetInput = {
  url: string
  events: readonly WebhookEventValue[]
  active: boolean
  rotateSecret: boolean
}

export type WebhookView = {
  id: string
  url: string
  events: WebhookEventValue[]
  active: boolean
  last_error: string | null
}

function metadata(ctx: ActorContext, extra: Record<string, Prisma.InputJsonValue>): Prisma.InputJsonValue {
  return {
    app: ctx.app,
    actChain: ctx.actChain,
    provenance: ctx.provenance ?? null,
    ...extra,
  }
}

function auditInput(
  ctx: ActorContext,
  action: string,
  outcome: 'success' | 'denied',
  resourceId: string | null,
  extra: Record<string, Prisma.InputJsonValue>,
): AuditEntryInput {
  return {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action,
    resourceType: 'webhook',
    resourceId,
    outcome,
    reason: outcome === 'denied' ? 'policy' : null,
    metadata: metadata(ctx, extra),
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  }
}

async function authorize(deps: AppDeps, ctx: ActorContext, action: string): Promise<void> {
  const decision = await checkPolicy(deps.db, ctx, {
    resourceType: 'webhook',
    action: 'admin',
    scopes: [{ scope: 'team', id: ctx.tenant.teamId }],
  })
  if (ctx.onBehalfOf.role === 'owner' && decision.allowed && !decision.requiresApproval) return
  await deps.db.$transaction((tx) => deps.writeAudit(
    tx,
    auditInput(ctx, action, 'denied', null, {}),
  ))
  throw new ServiceError(
    decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Webhook administration is not permitted',
  )
}

function view(row: {
  id: string
  url: string
  events: string[]
  active: boolean
  lastError: string | null
}): WebhookView {
  return {
    id: row.id,
    url: row.url,
    events: WebhookEvent.array().parse(row.events),
    active: row.active,
    last_error: row.lastError,
  }
}

function newSecret(): string {
  return randomBytes(32).toString('hex')
}

function sealSecret(deps: AppDeps, secret: string, input: {
  id: string
  url: string
  organizationId: string
  teamId: string
}): string {
  return deps.secretBox.seal(
    new TextEncoder().encode(secret),
    WEBHOOK_SECRET_PURPOSE,
    webhookSecretAdditionalData({
      organizationId: input.organizationId,
      teamId: input.teamId,
      webhookId: input.id,
      url: input.url,
    }),
  )
}

export async function setWebhook(
  deps: AppDeps,
  ctx: ActorContext,
  input: WebhookSetInput,
): Promise<{ webhook: WebhookView; secret?: string }> {
  await authorize(deps, ctx, 'crm.webhook.set')
  const url = (await assertSafeUrl(input.url)).toString()
  const parsedEvents = WebhookEvent.array().min(1).parse(input.events)
  return deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(4, hashtext(${url}))`
    const existing = await tx.webhook.findFirst({
      where: { ...tenantWhere(ctx.tenant), url },
    })
    const secret = existing === null || input.rotateSecret ? newSecret() : undefined
    const id = existing?.id ?? deps.ids()
    const secretCiphertext = secret === undefined
      ? existing?.secretCiphertext
      : sealSecret(deps, secret, { id, url, ...ctx.tenant })
    if (secretCiphertext === undefined) {
      throw new ServiceError(ErrorCode.INTERNAL, 'Webhook secret could not be created')
    }
    const currentSeq = existing === null
      ? await tx.team.findFirst({
          where: { id: ctx.tenant.teamId, organizationId: ctx.tenant.organizationId },
          select: { feedSeq: true },
        })
      : null
    if (existing === null && currentSeq === null) {
      throw new ServiceError(ErrorCode.NOT_FOUND, 'Tenant team not found')
    }
    const row = existing === null
      ? await tx.webhook.create({
          data: {
            id,
            ...ctx.tenant,
            subscribingUoaUserId: ctx.onBehalfOf.uoaUserId,
            url,
            events: parsedEvents,
            secretCiphertext,
            active: input.active,
            lastDeliveredSeq: currentSeq?.feedSeq ?? 0n,
          },
        })
      : await tx.webhook.update({
          where: { id, ...tenantWhere(ctx.tenant) },
          data: {
            subscribingUoaUserId: ctx.onBehalfOf.uoaUserId,
            events: parsedEvents,
            secretCiphertext,
            active: input.active,
            lastError: input.active ? null : existing.lastError,
          },
        })
    await deps.writeAudit(tx, auditInput(ctx, 'crm.webhook.set', 'success', id, {
      eventCount: parsedEvents.length,
      active: input.active,
      secretRotated: secret !== undefined,
    }))
    return { webhook: view(row), ...(secret === undefined ? {} : { secret }) }
  })
}

export async function listWebhooks(deps: AppDeps, ctx: ActorContext): Promise<{ webhooks: WebhookView[] }> {
  await authorize(deps, ctx, 'crm.webhook.list')
  const rows = await deps.db.webhook.findMany({
    where: tenantWhere(ctx.tenant),
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return { webhooks: rows.map(view) }
}

export async function deleteWebhook(
  deps: AppDeps,
  ctx: ActorContext,
  id: string,
): Promise<{ deleted: true }> {
  await authorize(deps, ctx, 'crm.webhook.delete')
  return deps.db.$transaction(async (tx) => {
    const deleted = await tx.webhook.deleteMany({ where: { ...tenantWhere(ctx.tenant), id } })
    if (deleted.count !== 1) throw new ServiceError(ErrorCode.NOT_FOUND, 'Webhook not found')
    await deps.writeAudit(tx, auditInput(ctx, 'crm.webhook.delete', 'success', id, {}))
    return { deleted: true }
  })
}
