import type {
  LoadedAttribute,
  LoadedObjectType,
  LoadedSchema,
} from '@deepcrm/schema-engine'
import {
  ErrorCode,
  ServiceError,
  type ActorContext,
  type Filter,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import type {
  PolicyDecision,
  PolicyEvaluator,
  PolicyRequest,
  PolicyScopeRef,
} from './policy.js'

export function selectedObjectType(schema: LoadedSchema, slug: string): LoadedObjectType {
  const objectType = schema.objectTypesBySlug.get(slug)
  if (objectType === undefined || objectType.archivedAt !== null) {
    throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type does not exist')
  }
  return objectType
}

export function selectedAttribute(
  schema: LoadedSchema,
  objectType: LoadedObjectType,
  slug: string,
): LoadedAttribute {
  const attribute = schema.attributesByObjectTypeId.get(objectType.id)?.get(slug)
  if (attribute !== undefined) return attribute
  if (schema.archivedAttributeSlugsByObjectTypeId.get(objectType.id)?.has(slug) === true) {
    throw new ServiceError(ErrorCode.ATTRIBUTE_ARCHIVED, 'Attribute is archived', { attribute: slug })
  }
  throw new ServiceError(ErrorCode.UNKNOWN_ATTRIBUTE, 'Attribute does not exist', { attribute: slug })
}

export function filterAttributes(filter: Filter | undefined, slugs = new Set<string>()): Set<string> {
  if (filter === undefined) return slugs
  if ('and' in filter) for (const child of filter.and) filterAttributes(child, slugs)
  else if ('or' in filter) for (const child of filter.or) filterAttributes(child, slugs)
  else if ('not' in filter) filterAttributes(filter.not, slugs)
  else if ('attribute' in filter) slugs.add(filter.attribute)
  return slugs
}

export function queryScopes(ctx: ActorContext, objectType: LoadedObjectType): PolicyScopeRef[] {
  return [
    { scope: 'team', id: ctx.tenant.teamId },
    { scope: 'object_type', id: objectType.id },
  ]
}

export function attributeRequest(
  scopes: PolicyScopeRef[],
  attribute: LoadedAttribute,
): PolicyRequest {
  return {
    resourceType: 'attribute',
    action: 'view',
    scopes,
    sensitivity: attribute.sensitivity,
  }
}

async function writeDeniedAudit(
  deps: AppDeps,
  ctx: ActorContext,
  objectType: LoadedObjectType,
  tool: string,
): Promise<void> {
  await deps.db.$transaction((tx) => deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action: tool,
    resourceType: 'object_type',
    resourceId: objectType.id,
    outcome: 'denied',
    reason: null,
    metadata: { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance },
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  }))
}

async function rejectDecision(
  deps: AppDeps,
  ctx: ActorContext,
  objectType: LoadedObjectType,
  request: PolicyRequest,
  decision: PolicyDecision,
  tool: string,
): Promise<void> {
  if (decision.allowed && !decision.requiresApproval) return
  await writeDeniedAudit(deps, ctx, objectType, tool)
  throw new ServiceError(
    decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Record query is not permitted',
    { resource: request.resourceType, action: request.action },
  )
}

export async function preauthorize(
  deps: AppDeps,
  ctx: ActorContext,
  objectType: LoadedObjectType,
  evaluator: PolicyEvaluator,
  requests: readonly PolicyRequest[],
  tool: string,
): Promise<void> {
  for (const request of requests) {
    await rejectDecision(deps, ctx, objectType, request, evaluator.evaluate(request), tool)
  }
}
