import { createHash } from 'node:crypto'

import { canonicalJson, tenantWhere } from '@deepcrm/db'
import type { RecordTx } from '@deepcrm/schema-engine'
import { ErrorCode, LinkOut, ServiceError, Uuid, type ActorContext } from '@deepcrm/schemas'

import type { LinkServiceResult } from './links.js'

type LinkReplayTx = Pick<RecordTx, '$queryRaw' | 'idempotencyReplay'>

export type LinkDescriptor = {
  tool: 'crm_link' | 'crm_unlink'
  args: Record<string, unknown>
  idempotencyKey: string | undefined
  reason: string | undefined
  resourceId: string | null
}

export type LinkReservation =
  | { kind: 'none' }
  | { kind: 'replay'; result: LinkServiceResult }
  | { kind: 'reserved'; id: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function replayResult(value: unknown): LinkServiceResult {
  if (!isObject(value) || !isObject(value['link'])) {
    throw new ServiceError(ErrorCode.INTERNAL, 'Stored replay result is invalid')
  }
  const link = LinkOut.safeParse(value['link'])
  const ended = Uuid.array().safeParse(value['ended_links'])
  if (!link.success || !ended.success || typeof value['changed'] !== 'boolean') {
    throw new ServiceError(ErrorCode.INTERNAL, 'Stored replay result is invalid')
  }
  return {
    link: link.data,
    ended_links: ended.data,
    changed: value['changed'],
  }
}

export function linkArgumentHash(args: Record<string, unknown>): string {
  try {
    return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex')
  } catch {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Link arguments are invalid', {
      issues: [{ path: '', message: 'Arguments must be valid JSON' }],
    })
  }
}

function lockKey(ctx: ActorContext, tool: string, key: string): string {
  return [ctx.tenant.teamId, ctx.onBehalfOf.uoaUserId, tool, key].join(':')
}

export async function reserveLinkReplay(
  tx: LinkReplayTx,
  ctx: ActorContext,
  descriptor: LinkDescriptor,
  hash: string,
): Promise<LinkReservation> {
  const key = descriptor.idempotencyKey
  if (key === undefined) return { kind: 'none' }
  const locks = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock(6::integer, hashtext(${lockKey(ctx, descriptor.tool, key)})) AS locked
  `
  if (locks[0]?.locked !== true) {
    throw new ServiceError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'Idempotent operation is in progress')
  }
  const existing = await tx.idempotencyReplay.findFirst({
    where: {
      ...tenantWhere(ctx.tenant),
      principalUserId: ctx.onBehalfOf.uoaUserId,
      tool: descriptor.tool,
      key,
    },
  })
  if (existing !== null) {
    if (existing.argumentsHash !== hash) {
      throw new ServiceError(ErrorCode.IDEMPOTENCY_MISMATCH, 'Idempotency key arguments do not match')
    }
    if (existing.result === null) {
      throw new ServiceError(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'Idempotent operation is in progress')
    }
    return { kind: 'replay', result: replayResult(existing.result) }
  }
  const created = await tx.idempotencyReplay.create({
    data: {
      ...tenantWhere(ctx.tenant),
      principalUserId: ctx.onBehalfOf.uoaUserId,
      tool: descriptor.tool,
      key,
      argumentsHash: hash,
    },
    select: { id: true },
  })
  return { kind: 'reserved', id: created.id }
}

export async function storeLinkReplay(
  tx: LinkReplayTx,
  ctx: ActorContext,
  reservation: LinkReservation,
  result: LinkServiceResult,
): Promise<void> {
  if (reservation.kind !== 'reserved') return
  const updated = await tx.idempotencyReplay.updateMany({
    where: { ...tenantWhere(ctx.tenant), id: reservation.id },
    data: { result },
  })
  if (updated.count !== 1) {
    throw new ServiceError(ErrorCode.INTERNAL, 'Idempotency result was not stored')
  }
}
