import { randomUUID } from 'node:crypto'

import { tenantWhere, type Db, type Prisma } from '@deepcrm/db'
import {
  AttributeSpec,
  WEBHOOK_SECRET_PURPOSE,
  webhookSecretAdditionalData,
  type SecretBox,
  type SafeFetch,
  type WebhookEventValue,
} from '@deepcrm/schemas'
import { z } from 'zod'

import type { DeliveryTarget } from '../deliver/target.js'
import { createWebhookTarget } from '../deliver/targets/webhook.js'
import { JobRetryError, type JobHandler } from '../index.js'

export const CHANGE_DELIVER_JOB = 'change.deliver'
const BATCH_SIZE = 500
const MAX_BATCHES = 10
const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000] as const

export const ChangeDeliverPayload = z.object({
  organizationId: z.string().uuid(),
  teamId: z.string().uuid(),
}).strict()

type Tenant = z.infer<typeof ChangeDeliverPayload>
type ChangeRow = Awaited<ReturnType<typeof changeBatch>>[number]

function isObject(value: unknown): value is Record<string, Prisma.JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function endpoints(value: Prisma.JsonValue | null): readonly string[] {
  if (!isObject(value)) return []
  const from = value['from_record_id']
  const to = value['to_record_id']
  return [
    ...(typeof from === 'string' ? [from] : []),
    ...(typeof to === 'string' ? [to] : []),
  ]
}

function eventName(row: ChangeRow): WebhookEventValue {
  switch (row.kind) {
    case 'create': return 'record.created'
    case 'set':
    case 'unset':
    case 'restore':
    case 'unmerge': return 'record.updated'
    case 'delete': return 'record.deleted'
    case 'merge': return row.record?.mergedIntoId === null ? 'record.merged' : 'record.deleted'
    case 'link': return 'link.created'
    case 'unlink': return 'link.ended'
    case 'schema_change': return 'schema.changed'
  }
}

type ChangeReadTx = Pick<Db, 'recordChange'>
type EventReadTx = Pick<Db, 'attribute' | 'relationType' | 'record'>

async function changeBatch(db: ChangeReadTx, tenant: Tenant, after: bigint) {
  return db.recordChange.findMany({
    where: { ...tenantWhere(tenant), seq: { gt: after } },
    orderBy: { seq: 'asc' },
    take: BATCH_SIZE,
    include: {
      record: {
        select: {
          id: true,
          objectTypeId: true,
          displayName: true,
          visibility: true,
          createdOnBehalfOf: true,
          mergedIntoId: true,
          visibilityGrants: { select: { uoaUserId: true } },
          objectType: { select: { slug: true } },
        },
      },
    },
  })
}

function recordVisible(row: {
  visibility: 'team' | 'users' | 'private'
  createdOnBehalfOf: string | null
  visibilityGrants: readonly { uoaUserId: string }[]
}, subscriber: string): boolean {
  return row.visibility === 'team'
    || row.createdOnBehalfOf === subscriber
    || (row.visibility === 'users' && row.visibilityGrants.some((grant) => grant.uoaUserId === subscriber))
}

function valueFor(
  row: ChangeRow,
  value: Prisma.JsonValue | null,
  sensitivity: ReadonlyMap<string, string>,
): Prisma.JsonValue | undefined {
  if (value === null) return undefined
  if (row.attributeSlug === null || row.record === null) return value
  const level = sensitivity.get(`${row.record.objectTypeId}:${row.attributeSlug}`)
  return level === 'confidential' || level === 'restricted' ? undefined : value
}

function edgeValue(
  value: Prisma.JsonValue | undefined,
  permitted: ReadonlySet<string>,
): Prisma.JsonValue | undefined {
  if (!isObject(value)) return value
  const data = value['data']
  if (!isObject(data)) return value
  return {
    ...value,
    data: Object.fromEntries(Object.entries(data).filter(([slug]) => permitted.has(slug))),
  }
}

function present(
  row: ChangeRow,
  sensitivity: ReadonlyMap<string, string>,
  relationSlugs: ReadonlyMap<string, string>,
  edgeAllowed: ReadonlyMap<string, ReadonlySet<string>>,
): Prisma.InputJsonValue {
  const oldValue = valueFor(row, row.oldValue, sensitivity)
  const newValue = valueFor(row, row.newValue, sensitivity)
  const permitted = row.relationTypeId === null ? undefined : edgeAllowed.get(row.relationTypeId)
  const safeOld = permitted === undefined ? oldValue : edgeValue(oldValue, permitted)
  const safeNew = permitted === undefined ? newValue : edgeValue(newValue, permitted)
  return {
    event: eventName(row),
    id: row.id,
    seq: row.seq.toString(),
    resulting_version: row.resultingVersion,
    record: row.record === null ? null : {
      id: row.record.id,
      object_type: row.record.objectType.slug,
      display_name: row.record.displayName,
    },
    group_id: row.groupId,
    kind: row.kind === 'schema_change' ? 'schema' : row.kind,
    attribute: row.attributeSlug,
    relation_type: row.relationTypeId === null ? null : relationSlugs.get(row.relationTypeId) ?? null,
    link_id: row.linkId,
    ...(safeOld === undefined ? {} : { old_value: safeOld }),
    ...(safeNew === undefined ? {} : { new_value: safeNew }),
    actor: { type: row.actorType, id: row.actorId },
    on_behalf_of: row.onBehalfOf,
    provenance: { run_id: row.runId, tool_call_id: row.toolCallId, request_id: row.requestId },
    reason: row.reason,
    occurred_at: row.occurredAt.toISOString(),
  }
}

async function visibleEvents(
  db: EventReadTx,
  tenant: Tenant,
  subscriber: string,
  rows: readonly ChangeRow[],
): Promise<Prisma.InputJsonValue[]> {
  const [attributes, relations, related] = await Promise.all([
    db.attribute.findMany({
      where: tenantWhere(tenant),
      select: { objectTypeId: true, slug: true, sensitivity: true },
    }),
    db.relationType.findMany({
      where: tenantWhere(tenant),
      select: { id: true, slug: true, edgeAttributes: true },
    }),
    db.record.findMany({
      where: {
        ...tenantWhere(tenant),
        id: { in: [...new Set(rows.flatMap((row) => endpoints(row.newValue ?? row.oldValue)))] },
      },
      select: {
        id: true, visibility: true, createdOnBehalfOf: true,
        visibilityGrants: { select: { uoaUserId: true } },
      },
    }),
  ])
  const sensitivity = new Map(attributes.flatMap((attribute) => (
    attribute.objectTypeId === null ? [] : [[`${attribute.objectTypeId}:${attribute.slug}`, attribute.sensitivity]]
  )))
  const relationSlugs = new Map(relations.map((relation) => [relation.id, relation.slug]))
  const edgeAllowed = new Map(relations.map((relation) => [
    relation.id,
    new Set(AttributeSpec.array().parse(relation.edgeAttributes).flatMap((attribute) => (
      attribute.sensitivity === 'confidential' || attribute.sensitivity === 'restricted'
        ? [] : [attribute.slug]
    ))),
  ]))
  const relatedVisible = new Map(related.map((record) => [record.id, recordVisible(record, subscriber)]))
  return rows.flatMap((row) => {
    if (row.record !== null && !recordVisible(row.record, subscriber)) return []
    if (endpoints(row.newValue ?? row.oldValue).some((id) => relatedVisible.get(id) !== true)) return []
    return [present(row, sensitivity, relationSlugs, edgeAllowed)]
  })
}

function openSecret(secretBox: SecretBox, webhook: {
  id: string; organizationId: string; teamId: string; url: string; secretCiphertext: string
}): string {
  const bytes = secretBox.open(
    webhook.secretCiphertext,
    WEBHOOK_SECRET_PURPOSE,
    webhookSecretAdditionalData({
      organizationId: webhook.organizationId,
      teamId: webhook.teamId,
      webhookId: webhook.id,
      url: webhook.url,
    }),
  )
  return new TextDecoder().decode(bytes)
}

function retryDelay(attempts: number): number | null {
  return RETRY_DELAYS_MS[attempts - 1] ?? null
}

async function deliverWebhook(
  input: Parameters<JobHandler>[0],
  tenant: Tenant,
  webhookId: string,
  secretBox: SecretBox,
  target: DeliveryTarget,
): Promise<void> {
  await input.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(4, hashtext(${webhookId}))`
    const webhook = await tx.webhook.findFirst({
      where: { id: webhookId, ...tenantWhere(tenant), active: true },
    })
    if (webhook === null) return
    const team = await tx.team.findFirst({
      where: { id: tenant.teamId, organizationId: tenant.organizationId },
      select: { feedSeq: true, externalTeamId: true, organization: { select: { externalOrgId: true } } },
    })
    if (team === null) throw new Error('Webhook tenant is missing')
    for (let batchNumber = 0; batchNumber < MAX_BATCHES; batchNumber += 1) {
      const rows = await changeBatch(tx, tenant, webhook.lastDeliveredSeq)
      if (rows.length === 0) return
      const until = rows.at(-1)?.seq
      if (until === undefined) return
      const events = (await visibleEvents(tx, tenant, webhook.subscribingUoaUserId, rows))
        .filter((event) => {
          if (!isObject(event)) return false
          const name = event['event']
          return typeof name === 'string' && webhook.events.includes(name)
        })
      const backlog = team.feedSeq > until ? team.feedSeq - until : 0n
      if (events.length > 0) {
        const body = JSON.stringify({
          schema: 'deepcrm.webhook.v1',
          team: team.externalTeamId,
          organization: team.organization.externalOrgId,
          since_seq: webhook.lastDeliveredSeq.toString(),
          until_seq: until.toString(),
          backlog_remaining: Number(backlog),
          events,
        })
        const delivered = await target.deliver({
          body,
          webhookId: webhook.id,
          timestamp: Math.floor(input.clock().getTime() / 1_000).toString(),
          deliveryId: randomUUID(),
        }, { url: webhook.url, secret: openSecret(secretBox, webhook) })
        if (!delivered.ok) {
          const delay = retryDelay(input.job.attempts)
          if (delay !== null) throw new JobRetryError(delivered.error, new Date(input.clock().getTime() + delay))
          await tx.webhook.update({
            where: { id: webhook.id, ...tenantWhere(tenant) },
            data: { active: false, lastError: delivered.error },
          })
          return
        }
      }
      await tx.webhook.update({
        where: { id: webhook.id, ...tenantWhere(tenant) },
        data: { lastDeliveredSeq: until, lastError: null },
      })
      webhook.lastDeliveredSeq = until
      if (rows.length < BATCH_SIZE) return
    }
  })
}

export function createChangeDeliverHandler(secretBox: SecretBox, safeFetch: SafeFetch): JobHandler {
  const target = createWebhookTarget(safeFetch)
  return async (input) => {
    const tenant = ChangeDeliverPayload.parse(input.job.payload)
    if (input.job.organizationId !== tenant.organizationId || input.job.teamId !== tenant.teamId) {
      throw new Error('change.deliver tenant payload does not match job scope')
    }
    const webhooks = await input.db.webhook.findMany({
      where: { ...tenantWhere(tenant), active: true },
      select: { id: true },
      orderBy: { id: 'asc' },
    })
    for (const webhook of webhooks) {
      await deliverWebhook(input, tenant, webhook.id, secretBox, target)
    }
  }
}
