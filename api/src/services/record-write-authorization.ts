import type { PolicyAction, Prisma } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'
import type { CreateRecordInput, LoadedSchema, UpdateRecordInput } from '@deepcrm/schema-engine'

import type { AppDeps } from '../deps.js'
import { checkPolicy } from './policy.js'
import type { PolicyRequest, PolicyScopeRef } from './policy.js'
import type { VisibleRecord } from './record-visibility.js'

type CommonWriteInput = { idempotencyKey?: string; reason?: string }
type RecordAuditDescriptor = {
  tool: string
  reason: string | undefined
  resourceId: string | null
}

export function recordAuditMetadata(ctx: ActorContext): Prisma.InputJsonObject {
  return { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance }
}

export async function writeRecordDeniedAudit(
  deps: AppDeps, ctx: ActorContext, descriptor: RecordAuditDescriptor,
): Promise<void> {
  await deps.db.$transaction((tx) => deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action: descriptor.tool,
    resourceType: 'record',
    resourceId: descriptor.resourceId,
    outcome: 'denied',
    reason: descriptor.reason ?? null,
    metadata: recordAuditMetadata(ctx),
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  }))
}

export async function authorizeRecordWrite(
  deps: AppDeps, ctx: ActorContext, descriptor: RecordAuditDescriptor,
  requests: readonly PolicyRequest[],
): Promise<void> {
  const checked = await Promise.all(requests.map(async (request) => ({
    request,
    decision: await checkPolicy(deps.db, ctx, request),
  })))
  const hardDenied = checked.find(({ decision }) => !decision.allowed && !decision.requiresApproval)
  const rejected = hardDenied ?? checked.find(({ decision }) => (
    !decision.allowed || decision.requiresApproval
  ))
  if (rejected === undefined) return
  await writeRecordDeniedAudit(deps, ctx, descriptor)
  throw new ServiceError(
    rejected.decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Record operation is not permitted',
    { resource: rejected.request.resourceType, action: rejected.request.action },
  )
}

function teamScopes(ctx: ActorContext): PolicyScopeRef[] {
  return [{ scope: 'team', id: ctx.tenant.teamId }]
}

export function objectScopes(
  ctx: ActorContext,
  schema: LoadedSchema,
  slug: string,
): PolicyScopeRef[] {
  const selected = schema.objectTypesBySlug.get(slug)
  const scopes = teamScopes(ctx)
  if (selected !== undefined) scopes.push({ scope: 'object_type', id: selected.id })
  return scopes
}

export function objectIdScopes(ctx: ActorContext, objectTypeId: string): PolicyScopeRef[] {
  return [...teamScopes(ctx), { scope: 'object_type', id: objectTypeId }]
}

export function recordScopes(ctx: ActorContext, record: VisibleRecord): PolicyScopeRef[] {
  return [
    ...teamScopes(ctx),
    { scope: 'object_type', id: record.objectTypeId },
    { scope: 'record', id: record.id },
  ]
}

export function recordPolicy(action: PolicyAction, scopes: PolicyScopeRef[]): PolicyRequest {
  return { resourceType: 'record', action, scopes }
}

export function attributePolicies(
  schema: LoadedSchema,
  objectTypeId: string | undefined,
  data: Record<string, unknown>,
  scopes: PolicyScopeRef[],
): PolicyRequest[] {
  if (objectTypeId === undefined) return []
  const attributes = schema.attributesByObjectTypeId.get(objectTypeId)
  if (attributes === undefined) return []
  return Object.keys(data).sort().flatMap((slug) => {
    const sensitivity = attributes.get(slug)?.sensitivity
    return sensitivity === 'confidential' || sensitivity === 'restricted'
      ? [{ resourceType: 'attribute' as const, action: 'edit' as const, scopes, sensitivity }]
      : []
  })
}

export function commonArgs(input: CommonWriteInput): Record<string, unknown> {
  return {
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  }
}

export function metadataArgs(
  input: CreateRecordInput | UpdateRecordInput,
): Record<string, unknown> {
  return {
    ...(input.links === undefined ? {} : { links: input.links }),
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    ...(input.visibleTo === undefined ? {} : { visibleTo: input.visibleTo }),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
  }
}
