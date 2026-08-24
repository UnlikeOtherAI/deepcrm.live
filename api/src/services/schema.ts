import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'
import {
  archiveAttribute,
  archiveObjectType,
  archiveRelationType,
  defineAttribute,
  defineObjectType,
  defineRelationType,
  loadSchema,
  cancelMatchingRules,
  retryMatchingRules,
  setMatchingRules,
  updateAttribute,
  updateObjectType,
  updateRelationType,
  type LoadedObjectType,
  type LoadedSchema,
  type MatchingBackfillIdentity,
  type SchemaTx,
} from '@deepcrm/schema-engine'
import type { AppDeps } from '../deps.js'
import { checkPolicy } from './policy.js'

export function getSchema(deps: AppDeps, ctx: ActorContext): Promise<LoadedSchema>
export function getSchema(
  deps: AppDeps,
  ctx: ActorContext,
  objectType: string,
): Promise<LoadedObjectType>
export async function getSchema(
  deps: AppDeps,
  ctx: ActorContext,
  objectType?: string,
): Promise<LoadedSchema | LoadedObjectType> {
  const schema = await loadSchema(deps.db, ctx.tenant)
  if (objectType === undefined) return schema
  const selected = schema.objectTypesBySlug.get(objectType)
  if (selected === undefined) {
    throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Unknown object type')
  }
  return selected
}

export async function requireSchemaDefine(deps: AppDeps, ctx: ActorContext): Promise<void> {
  const decision = await checkPolicy(deps.db, ctx, {
    resourceType: 'schema',
    action: 'define',
    scopes: [{ scope: 'team', id: ctx.tenant.teamId }],
  })
  if (!decision.allowed) throw new ServiceError(
    decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Schema definition is not permitted',
  )
}

export async function defineSchemaObject(
  deps: AppDeps,
  ctx: ActorContext,
  input: { slug: string; singularName: string; pluralName: string; description: string; icon?: string },
) {
  return runSchemaDefine(deps, ctx, (tx, actor) => defineObjectType(tx, ctx.tenant, actor, input))
}

function actor(ctx: ActorContext) {
  return {
    type: ctx.actor.type,
    id: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    requestId: ctx.requestId,
  }
}

function matchingIdentity(ctx: ActorContext): MatchingBackfillIdentity {
  if (ctx.provenance === null) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Matching rule arguments are invalid', {
      issues: [{ path: 'provenance', message: 'runId, toolCallId and requestId are required' }],
    })
  }
  return {
    onBehalfOf: ctx.onBehalfOf,
    auditMetadata: { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance },
  }
}

export async function runSchemaDefine<T>(
  deps: AppDeps,
  ctx: ActorContext,
  operation: (tx: SchemaTx, auditActor: ReturnType<typeof actor>) => Promise<T>,
): Promise<T> {
  await requireSchemaDefine(deps, ctx)
  return inSchemaTransaction(deps, (tx) => operation(tx, actor(ctx)))
}

export const defineSchemaAttribute = (
  deps: AppDeps,
  ctx: ActorContext,
  input: Parameters<typeof defineAttribute>[3],
) => runSchemaDefine(deps, ctx, (tx, author) => defineAttribute(tx, ctx.tenant, author, input))

export const defineSchemaRelation = (
  deps: AppDeps,
  ctx: ActorContext,
  input: Parameters<typeof defineRelationType>[3],
) => runSchemaDefine(deps, ctx, (tx, author) => defineRelationType(tx, ctx.tenant, author, input))

export const updateSchemaObject = (
  deps: AppDeps,
  ctx: ActorContext,
  slug: string,
  input: Parameters<typeof updateObjectType>[4],
) => runSchemaDefine(
  deps,
  ctx,
  (tx, author) => updateObjectType(tx, ctx.tenant, author, slug, input),
)

export const archiveSchemaObject = (deps: AppDeps, ctx: ActorContext, slug: string) => runSchemaDefine(
  deps,
  ctx,
  (tx, author) => archiveObjectType(tx, ctx.tenant, author, slug),
)

export const updateSchemaAttribute = (
  deps: AppDeps,
  ctx: ActorContext,
  objectSlug: string,
  slug: string,
  input: Parameters<typeof updateAttribute>[5],
) => runSchemaDefine(
  deps,
  ctx,
  (tx, author) => updateAttribute(tx, ctx.tenant, author, objectSlug, slug, input),
)

export const archiveSchemaAttribute = (
  deps: AppDeps,
  ctx: ActorContext,
  objectSlug: string,
  slug: string,
) => runSchemaDefine(
  deps,
  ctx,
  (tx, author) => archiveAttribute(tx, ctx.tenant, author, objectSlug, slug),
)

export const updateSchemaRelation = (
  deps: AppDeps,
  ctx: ActorContext,
  slug: string,
  input: Parameters<typeof updateRelationType>[4],
) => runSchemaDefine(
  deps,
  ctx,
  (tx, author) => updateRelationType(tx, ctx.tenant, author, slug, input),
)

export const archiveSchemaRelation = (deps: AppDeps, ctx: ActorContext, slug: string) => runSchemaDefine(
  deps,
  ctx,
  (tx, author) => archiveRelationType(tx, ctx.tenant, author, slug),
)

export const replaceSchemaMatchingRules = (
  deps: AppDeps,
  ctx: ActorContext,
  objectSlug: string,
  input: Parameters<typeof setMatchingRules>[4],
) => runSchemaDefine(
  deps,
  ctx,
  (tx, author) => setMatchingRules(tx, ctx.tenant, author, objectSlug, input, matchingIdentity(ctx)),
)

export const retrySchemaMatchingRules = (
  deps: AppDeps,
  ctx: ActorContext,
  generationId: string,
) => runSchemaDefine(
  deps,
  ctx,
  (tx, author) => retryMatchingRules(tx, ctx.tenant, author, generationId, matchingIdentity(ctx)),
)

export const cancelSchemaMatchingRules = (
  deps: AppDeps,
  ctx: ActorContext,
  generationId: string,
) => runSchemaDefine(
  deps,
  ctx,
  (tx, author) => cancelMatchingRules(tx, ctx.tenant, author, generationId),
)

export function inSchemaTransaction<T>(
  deps: AppDeps,
  operation: (tx: SchemaTx) => Promise<T>,
): Promise<T> {
  return deps.db.$transaction((tx) => operation(tx))
}
