import { createHash, randomBytes } from 'node:crypto'

import {
  canonicalJson, Prisma, tenantWhere,
  type AuditTx, type PolicyResourceType,
} from '@deepcrm/db'
import {
  ApprovalContent, ErrorCode, ServiceError,
  type ActorContext, type InputRequests, type InputResponses, type RequestStatePayload,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'

export type ApprovalRequestInput = {
  tool: string
  resourceType: PolicyResourceType
  resourceId?: string | null
  args: Record<string, unknown>
  reason?: string
  message?: string
}
export type ApprovalChallenge = {
  inputRequests: typeof InputRequests._output
  requestStatePayload: RequestStatePayload
}
export type ApprovalRetryInput = {
  tool: string
  args: Record<string, unknown>
  inputResponses: typeof InputResponses._output
  requestStatePayload: RequestStatePayload
}
export type ApprovalConsumeTx = Pick<AuditTx, '$queryRaw'>
export type ApprovalConsumption = {
  args: Record<string, unknown>
  consume: (tx: ApprovalConsumeTx) => Promise<void>
}

const DAY_MS = 24 * 60 * 60 * 1_000
const DAY_SECONDS = 24 * 60 * 60
const MAX_TEAM_PENDING = 100
const MAX_REQUESTER_PENDING = 10

function jsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(jsonValue)
  if (typeof value === 'object') {
    const result: Record<string, Prisma.InputJsonValue | null> = {}
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) result[key] = jsonValue(child)
    }
    return result
  }
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Approval arguments must be JSON', {
    detail: 'approval_arguments_invalid',
  })
}

function jsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  const result: Record<string, Prisma.InputJsonValue | null> = {}
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) result[key] = jsonValue(child)
  }
  return result
}

export function approvalArgumentsHash(args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(jsonObject(args)), 'utf8').digest('hex')
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
function newToken(): string {
  return `apr_${randomBytes(32).toString('base64url')}`
}
function requiredRole(input: ApprovalRequestInput): 'admin' | 'owner' {
  return input.resourceType === 'webhook' ? 'owner' : 'admin'
}
function message(input: ApprovalRequestInput, role: 'admin' | 'owner'): string {
  return input.message ?? `Approve ${input.tool}? Requires ${role === 'admin' ? 'an admin' : 'an owner'}.`
}
function challengeSchema(messageText: string): typeof InputRequests._output {
  return {
    approval: {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: messageText,
        requestedSchema: {
          type: 'object',
          properties: { approved: { type: 'boolean' }, note: { type: 'string' } },
          required: ['approved'],
        },
      },
    },
  }
}
function invalidApproval(detail: string): never {
  throw new ServiceError(ErrorCode.APPROVAL_REQUIRED, 'Approval is required', {
    next: 'retry_with_approval', detail,
  })
}
function storedArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ServiceError(ErrorCode.INTERNAL, 'Stored approval arguments are invalid')
  }
  return Object.fromEntries(Object.entries(value))
}
function approvalAudit(
  ctx: ActorContext, action: string, resourceId: string,
  outcome: 'success' | 'denied', metadata: Prisma.InputJsonObject,
) {
  return {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action,
    resourceType: 'approval',
    resourceId,
    outcome,
    reason: null,
    metadata,
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  } as const
}

export async function requireApproval(
  deps: AppDeps, ctx: ActorContext, input: ApprovalRequestInput,
): Promise<ApprovalChallenge> {
  const argumentsHash = approvalArgumentsHash(input.args)
  const role = requiredRole(input)
  const token = newToken()
  const expiresAt = new Date(ctx.now.getTime() + DAY_MS)
  const snapshot = jsonObject(input.args)
  const row = await deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8, hashtext(${ctx.tenant.teamId}))`
    await tx.approvalRequest.updateMany({
      where: { ...tenantWhere(ctx.tenant), status: 'pending', expiresAt: { lte: ctx.now } },
      data: { status: 'expired', resolvedAt: ctx.now },
    })
    const duplicate = await tx.approvalRequest.findFirst({
      where: {
        ...tenantWhere(ctx.tenant), action: input.tool, argumentsHash,
        status: 'pending', expiresAt: { gt: ctx.now },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    })
    let selected: { id: string }
    if (duplicate !== null) {
      selected = await tx.approvalRequest.update({
        where: { id: duplicate.id },
        data: {
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          argumentsSnapshot: snapshot,
          requesterType: ctx.actor.type,
          requesterId: ctx.actor.id,
          onBehalfOf: ctx.onBehalfOf.uoaUserId,
          reason: input.reason ?? 'approval_required',
          requiredRole: role,
          continuationTokenHash: tokenHash(token),
          expiresAt,
        },
        select: { id: true },
      })
    } else {
      const pendingWhere = { ...tenantWhere(ctx.tenant), status: 'pending' as const }
      const [teamPending, requesterPending] = await Promise.all([
        tx.approvalRequest.count({ where: pendingWhere }),
        tx.approvalRequest.count({
          where: { ...pendingWhere, onBehalfOf: ctx.onBehalfOf.uoaUserId },
        }),
      ])
      if (teamPending >= MAX_TEAM_PENDING || requesterPending >= MAX_REQUESTER_PENDING) {
        throw new ServiceError(ErrorCode.LIMIT_EXCEEDED, 'Too many pending approvals', {
          limit: teamPending >= MAX_TEAM_PENDING ? MAX_TEAM_PENDING : MAX_REQUESTER_PENDING,
          scope: teamPending >= MAX_TEAM_PENDING ? 'team' : 'requester',
        })
      }
      selected = await tx.approvalRequest.create({
        data: {
          ...tenantWhere(ctx.tenant),
          action: input.tool,
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          argumentsHash,
          argumentsSnapshot: snapshot,
          requesterType: ctx.actor.type,
          requesterId: ctx.actor.id,
          onBehalfOf: ctx.onBehalfOf.uoaUserId,
          reason: input.reason ?? 'approval_required',
          requiredRole: role,
          continuationTokenHash: tokenHash(token),
          expiresAt,
        },
        select: { id: true },
      })
    }
    await deps.writeAudit(tx, approvalAudit(ctx, 'approval.requested', selected.id, 'success', {
      tool: input.tool, requiredRole: role, deduplicated: duplicate !== null,
    }))
    return selected
  })
  const messageText = message(input, role)
  return {
    inputRequests: challengeSchema(messageText),
    requestStatePayload: {
      app: ctx.app,
      uoaUserId: ctx.onBehalfOf.uoaUserId,
      tool: input.tool,
      argumentsHash,
      impact: messageText,
      approvalId: row.id,
      approvalToken: token,
      exp: Math.floor(expiresAt.getTime() / 1_000),
    },
  }
}

function verifyApprovalState(
  state: RequestStatePayload, ctx: ActorContext, tool: string, args: Record<string, unknown>,
): { approvalId: string; approvalToken: string } {
  const now = Math.floor(ctx.now.getTime() / 1_000)
  if (
    state.approvalId === undefined
    || state.approvalToken === undefined
    || state.exp <= now
    || state.exp > now + DAY_SECONDS
    || state.app !== ctx.app
    || state.tool !== tool
    || state.argumentsHash !== approvalArgumentsHash(args)
  ) invalidApproval('approval_state_invalid')
  return { approvalId: state.approvalId, approvalToken: state.approvalToken }
}

async function rejectApproval(
  deps: AppDeps, ctx: ActorContext, input: ApprovalRetryInput,
  approvalId: string, approvalToken: string, note: string | undefined,
): Promise<never> {
  await deps.db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE approval_requests
      SET status = 'rejected'::"ApprovalStatus",
          resolver_uoa_user_id = ${ctx.onBehalfOf.uoaUserId},
          resolved_at = ${ctx.now}, resolution_note = ${note ?? null}
      WHERE organization_id = ${ctx.tenant.organizationId}::uuid
        AND team_id = ${ctx.tenant.teamId}::uuid
        AND id = ${approvalId}::uuid
        AND action = ${input.tool}
        AND arguments_hash = ${input.requestStatePayload.argumentsHash}
        AND continuation_token_hash = ${tokenHash(approvalToken)}
        AND required_role = ${ctx.onBehalfOf.role ?? ''}
        AND on_behalf_of <> ${ctx.onBehalfOf.uoaUserId}
        AND status = 'pending'::"ApprovalStatus" AND expires_at > ${ctx.now}
      RETURNING id
    `
    if (rows.length !== 1) invalidApproval('approval_not_pending')
    await deps.writeAudit(tx, approvalAudit(ctx, 'approval.rejected', approvalId, 'denied', {
      tool: input.tool,
    }))
  })
  throw new ServiceError(ErrorCode.POLICY_DENIED, 'Approval was rejected', {
    next: 'fatal', detail: 'approval_rejected',
  })
}

export async function prepareApproval(
  deps: AppDeps, ctx: ActorContext, input: ApprovalRetryInput,
): Promise<ApprovalConsumption> {
  const { approvalId, approvalToken } = verifyApprovalState(
    input.requestStatePayload, ctx, input.tool, input.args,
  )
  const response = input.inputResponses.approval
  const content = response?.action === 'accept' ? ApprovalContent.safeParse(response.content) : undefined
  if (content === undefined || !content.success) invalidApproval('approval_response_invalid')
  if (!content.data.approved) {
    return rejectApproval(deps, ctx, input, approvalId, approvalToken, content.data.note)
  }
  if (ctx.onBehalfOf.role !== 'admin' && ctx.onBehalfOf.role !== 'owner') {
    invalidApproval('approver_must_be_admin_or_owner')
  }
  if (ctx.onBehalfOf.uoaUserId === input.requestStatePayload.uoaUserId) {
    invalidApproval('approver_must_differ')
  }
  const row = await deps.db.approvalRequest.findFirst({
    where: {
      ...tenantWhere(ctx.tenant),
      id: approvalId,
      action: input.tool,
      argumentsHash: input.requestStatePayload.argumentsHash,
      continuationTokenHash: tokenHash(approvalToken),
      requiredRole: ctx.onBehalfOf.role,
      onBehalfOf: input.requestStatePayload.uoaUserId,
      status: 'pending',
      expiresAt: { gt: ctx.now },
    },
    select: { id: true, argumentsSnapshot: true },
  })
  if (row === null) invalidApproval('approval_not_pending')
  return {
    args: storedArgs(row.argumentsSnapshot),
    consume: (tx) => consumeApproval(tx, ctx, {
      approvalId,
      approvalToken,
      argumentsHash: input.requestStatePayload.argumentsHash,
      tool: input.tool,
      note: content.data.note,
    }),
  }
}

export async function consumeApproval(
  tx: ApprovalConsumeTx, ctx: ActorContext,
  input: {
    approvalId: string
    approvalToken: string
    argumentsHash: string
    tool: string
    note?: string
  },
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE approval_requests
    SET status = 'consumed'::"ApprovalStatus",
        resolver_uoa_user_id = ${ctx.onBehalfOf.uoaUserId},
        resolved_at = ${ctx.now}, resolution_note = ${input.note ?? null}
    WHERE organization_id = ${ctx.tenant.organizationId}::uuid
      AND team_id = ${ctx.tenant.teamId}::uuid
      AND id = ${input.approvalId}::uuid
      AND action = ${input.tool}
      AND arguments_hash = ${input.argumentsHash}
      AND continuation_token_hash = ${tokenHash(input.approvalToken)}
      AND required_role = ${ctx.onBehalfOf.role ?? ''}
      AND on_behalf_of <> ${ctx.onBehalfOf.uoaUserId}
      AND status = 'pending'::"ApprovalStatus" AND expires_at > ${ctx.now}
    RETURNING id
  `
  if (rows.length !== 1) invalidApproval('approval_not_pending')
}
