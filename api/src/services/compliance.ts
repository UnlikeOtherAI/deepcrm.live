import {
  Prisma,
  type AuditTx,
  type SuppressionChannel,
  type SuppressionKind,
  type SuppressionReason,
} from '@deepcrm/db'
import { suppressionHash } from '@deepcrm/schema-engine'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import type { ApprovalConsumption } from './approvals.js'
import { checkPolicy } from './policy.js'

export type WriteGuardInput = {
  rejected_origins?: readonly string[]
  require_origin?: boolean
  team_visibility_only_apps?: readonly string[]
}

export type WriteGuardOutput = {
  rejected_origins: string[]
  require_origin: boolean
  team_visibility_only_apps: string[]
}
export type SuppressionAddInput = {
  kind: SuppressionKind
  value: string
  channel: SuppressionChannel
  reason: SuppressionReason
  sub_reason?: string
  expires_at?: string
  note?: string
}
export type SuppressionCheckInput = {
  entries: readonly { kind: SuppressionKind; value: string; channel: SuppressionChannel }[]
}
export type SuppressionListInput = {
  kind?: SuppressionKind
  channel?: SuppressionChannel
  reason?: SuppressionReason
  sub_reason?: string
  cursor?: string
  limit: number
}
export type SuppressionRemoveInput = {
  kind: SuppressionKind
  value: string
  channel: SuppressionChannel
  reason: string
}

type SuppressionCursor = { createdAt: string; id: string }
type SuppressionCheckResult = {
  kind: SuppressionKind
  suppressed: boolean
  reason?: SuppressionReason
  sub_reason?: string
}

function uniqueSorted(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined
  return [...new Set(values)].sort()
}

function auditMetadata(ctx: ActorContext, guard: WriteGuardOutput): Prisma.InputJsonObject {
  return {
    app: ctx.app,
    actChain: ctx.actChain,
    provenance: ctx.provenance,
    rejectedOriginsCount: guard.rejected_origins.length,
    requireOrigin: guard.require_origin,
    teamVisibilityOnlyAppsCount: guard.team_visibility_only_apps.length,
  }
}

function metadata(ctx: ActorContext, extra: Record<string, Prisma.InputJsonValue>): Prisma.InputJsonObject {
  return { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance, ...extra }
}

async function audit(
  deps: AppDeps,
  tx: AuditTx,
  ctx: ActorContext,
  action: string,
  outcome: 'success' | 'denied',
  extra: Record<string, Prisma.InputJsonValue>,
): Promise<void> {
  await deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action,
    resourceType: 'suppression',
    resourceId: null,
    outcome,
    reason: outcome === 'denied' ? 'policy' : null,
    metadata: metadata(ctx, extra),
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  })
}

async function authorizeSuppression(
  deps: AppDeps,
  ctx: ActorContext,
  action: 'view' | 'create' | 'admin',
  tool: string,
  approval?: ApprovalConsumption,
): Promise<void> {
  const decision = await checkPolicy(deps.db, ctx, {
    resourceType: 'suppression',
    action,
    scopes: [{ scope: 'team', id: ctx.tenant.teamId }],
  })
  if (decision.allowed && (!decision.requiresApproval || approval !== undefined)) return
  if (action !== 'view') {
    await deps.db.$transaction((tx) => audit(deps, tx, ctx, tool, 'denied', {}))
  }
  throw new ServiceError(
    decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Suppression operation is not permitted',
  )
}

async function deniedAudit(deps: AppDeps, ctx: ActorContext): Promise<void> {
  await deps.db.$transaction((tx) => deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action: 'crm_write_guard_set',
    resourceType: 'team',
    resourceId: ctx.tenant.teamId,
    outcome: 'denied',
    reason: null,
    metadata: { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance },
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  }))
}

function present(row: {
  rejectedOrigins: string[]
  requireOrigin: boolean
  teamVisibilityOnlyApps: string[]
}): WriteGuardOutput {
  return {
    rejected_origins: row.rejectedOrigins,
    require_origin: row.requireOrigin,
    team_visibility_only_apps: row.teamVisibilityOnlyApps,
  }
}

export async function setWriteGuard(
  deps: AppDeps,
  ctx: ActorContext,
  input: WriteGuardInput,
): Promise<WriteGuardOutput> {
  if (ctx.onBehalfOf.role !== 'owner') {
    await deniedAudit(deps, ctx)
    throw new ServiceError(ErrorCode.POLICY_DENIED, 'Write guard requires an owner')
  }
  const rejectedOrigins = uniqueSorted(input.rejected_origins)
  const teamVisibilityOnlyApps = uniqueSorted(input.team_visibility_only_apps)
  const data = {
    ...(rejectedOrigins === undefined ? {} : { rejectedOrigins }),
    ...(input.require_origin === undefined ? {} : { requireOrigin: input.require_origin }),
    ...(teamVisibilityOnlyApps === undefined ? {} : { teamVisibilityOnlyApps }),
  }
  if (Object.keys(data).length === 0) {
    const current = await deps.db.team.findUniqueOrThrow({
      where: { id: ctx.tenant.teamId },
      select: { rejectedOrigins: true, requireOrigin: true, teamVisibilityOnlyApps: true },
    })
    return present(current)
  }
  return deps.db.$transaction(async (tx) => {
    const updated = await tx.team.update({
      where: { id: ctx.tenant.teamId },
      data: { ...data, policyVersion: { increment: 1 } },
      select: { rejectedOrigins: true, requireOrigin: true, teamVisibilityOnlyApps: true },
    })
    const output = present(updated)
    await deps.writeAudit(tx, {
      organizationId: ctx.tenant.organizationId,
      teamId: ctx.tenant.teamId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      onBehalfOf: ctx.onBehalfOf.uoaUserId,
      action: 'crm_write_guard_set',
      resourceType: 'team',
      resourceId: ctx.tenant.teamId,
      outcome: 'success',
      reason: null,
      metadata: auditMetadata(ctx, output),
      requestId: ctx.requestId,
      ipAddress: null,
      userAgent: null,
    })
    return output
  })
}

function expiresAt(value: string | undefined, reason: SuppressionReason): Date | null {
  if (value === undefined) return null
  if (reason === 'objection' || reason === 'erasure') {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Permanent suppression cannot expire', {
      issues: [{ path: '/expires_at', message: 'expires_at is not allowed for this reason' }],
    })
  }
  return new Date(value)
}

export async function addSuppression(
  deps: AppDeps,
  ctx: ActorContext,
  input: SuppressionAddInput,
): Promise<{ added: true }> {
  const keyHash = suppressionHash(input.kind, input.value)
  const expiry = expiresAt(input.expires_at, input.reason)
  await authorizeSuppression(deps, ctx, 'create', 'crm_suppression_add')
  return deps.db.$transaction(async (tx) => {
    await tx.suppressionEntry.upsert({
      where: {
        teamId_kind_keyHash_channel: {
          teamId: ctx.tenant.teamId,
          kind: input.kind,
          keyHash,
          channel: input.channel,
        },
      },
      create: {
        organizationId: ctx.tenant.organizationId,
        teamId: ctx.tenant.teamId,
        kind: input.kind,
        channel: input.channel,
        keyHash,
        reason: input.reason,
        subReason: input.sub_reason,
        expiresAt: expiry,
        note: null,
        createdByType: ctx.actor.type,
        createdById: ctx.actor.id,
        onBehalfOf: ctx.onBehalfOf.uoaUserId,
      },
      update: {
        reason: input.reason,
        subReason: input.sub_reason,
        expiresAt: expiry,
        note: null,
        createdByType: ctx.actor.type,
        createdById: ctx.actor.id,
        onBehalfOf: ctx.onBehalfOf.uoaUserId,
      },
    })
    await audit(deps, tx, ctx, 'crm_suppression_add', 'success', {
      kind: input.kind,
      channel: input.channel,
      reason: input.reason,
      expires: expiry !== null,
    })
    return { added: true }
  })
}

export async function checkSuppression(
  deps: AppDeps,
  ctx: ActorContext,
  input: SuppressionCheckInput,
): Promise<{ results: SuppressionCheckResult[] }> {
  await authorizeSuppression(deps, ctx, 'view', 'crm_suppression_check')
  const results = await Promise.all(input.entries.map(async (entry) => {
    const keyHash = suppressionHash(entry.kind, entry.value)
    const rows = await deps.db.suppressionEntry.findMany({
      where: {
        organizationId: ctx.tenant.organizationId,
        teamId: ctx.tenant.teamId,
        kind: entry.kind,
        keyHash,
        channel: { in: ['all', entry.channel] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: ctx.now } }],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    })
    const selected = rows.find((row) => row.channel === entry.channel) ?? rows[0]
    if (selected === undefined) return { kind: entry.kind, suppressed: false }
    return {
      kind: entry.kind,
      suppressed: true,
      reason: selected.reason,
      ...(selected.subReason === null ? {} : { sub_reason: selected.subReason }),
    }
  }))
  return { results }
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }), 'utf8')
    .toString('base64url')
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeCursor(cursor: string | undefined): SuppressionCursor | null {
  if (cursor === undefined) return null
  const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  if (!objectRecord(decoded)) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Cursor is invalid')
  }
  if (typeof decoded['createdAt'] !== 'string' || typeof decoded['id'] !== 'string') {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Cursor is invalid')
  }
  return { createdAt: decoded['createdAt'], id: decoded['id'] }
}

export async function listSuppressions(
  deps: AppDeps,
  ctx: ActorContext,
  input: SuppressionListInput,
): Promise<{
  entries: Array<{
    kind: SuppressionKind
    channel: SuppressionChannel
    key_hash: string
    reason: SuppressionReason
    sub_reason: string | null
    expires_at: string | null
    created_at: string
  }>
  next_cursor: string | null
}> {
  await authorizeSuppression(deps, ctx, 'view', 'crm_suppression_list')
  const cursor = decodeCursor(input.cursor)
  const rows = await deps.db.suppressionEntry.findMany({
    where: {
      organizationId: ctx.tenant.organizationId,
      teamId: ctx.tenant.teamId,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.channel === undefined ? {} : { channel: input.channel }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.sub_reason === undefined ? {} : { subReason: input.sub_reason }),
      ...(cursor === null ? {} : {
        OR: [
          { createdAt: { gt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { gt: cursor.id } },
        ],
      }),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: input.limit + 1,
  })
  const page = rows.slice(0, input.limit)
  const last = page.at(-1)
  return {
    entries: page.map((row) => ({
      kind: row.kind,
      channel: row.channel,
      key_hash: row.keyHash,
      reason: row.reason,
      sub_reason: row.subReason,
      expires_at: row.expiresAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
    })),
    next_cursor: rows.length > input.limit && last !== undefined ? encodeCursor(last) : null,
  }
}

export async function removeSuppression(
  deps: AppDeps,
  ctx: ActorContext,
  input: SuppressionRemoveInput,
  approval?: ApprovalConsumption,
): Promise<{ removed: boolean }> {
  const keyHash = suppressionHash(input.kind, input.value)
  await authorizeSuppression(deps, ctx, 'admin', 'crm_suppression_remove', approval)
  return deps.db.$transaction(async (tx) => {
    await approval?.consume(tx)
    const deleted = await tx.suppressionEntry.deleteMany({
      where: {
        organizationId: ctx.tenant.organizationId,
        teamId: ctx.tenant.teamId,
        kind: input.kind,
        keyHash,
        channel: input.channel,
      },
    })
    await audit(deps, tx, ctx, 'crm_suppression_remove', 'success', {
      kind: input.kind,
      channel: input.channel,
      removed: deleted.count > 0,
    })
    return { removed: deleted.count > 0 }
  })
}
