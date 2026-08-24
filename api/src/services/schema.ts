import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'
import {
  applyTemplate,
  archiveAttribute,
  archiveObjectType,
  archiveRelationType,
  defineAttribute,
  defineObjectType,
  defineObjectTypeWithAttributes,
  defineRelationType,
  loadSchema,
  listTemplates,
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
import { Prisma, tenantWhere } from '@deepcrm/db'
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
  await requireSchemaView(deps, ctx)
  const schema = await loadSchema(deps.db, ctx.tenant)
  if (objectType === undefined) return schema
  const selected = schema.objectTypesBySlug.get(objectType)
  if (selected === undefined) {
    throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Unknown object type')
  }
  return selected
}

export async function requireSchemaView(deps: AppDeps, ctx: ActorContext): Promise<void> {
  const decision = await checkPolicy(deps.db, ctx, {
    resourceType: 'schema',
    action: 'view',
    scopes: [{ scope: 'team', id: ctx.tenant.teamId }],
  })
  if (!decision.allowed || decision.requiresApproval) throw new ServiceError(
    decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Schema access is not permitted',
  )
}

export async function requireSchemaDefine(deps: AppDeps, ctx: ActorContext): Promise<void> {
  const decision = await checkPolicy(deps.db, ctx, {
    resourceType: 'schema',
    action: 'define',
    scopes: [{ scope: 'team', id: ctx.tenant.teamId }],
  })
  if (!decision.allowed || decision.requiresApproval) throw new ServiceError(
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

export async function defineSchemaObjectWithAttributes(
  deps: AppDeps,
  ctx: ActorContext,
  input: Parameters<typeof defineObjectTypeWithAttributes>[3],
) {
  return runSchemaDefine(deps, ctx, (tx, author) => (
    defineObjectTypeWithAttributes(tx, ctx.tenant, author, input)
  ))
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

export const archiveSchemaObject = (
  deps: AppDeps,
  ctx: ActorContext,
  slug: string,
  reason?: string,
) => runSchemaDefine(
  deps,
  ctx,
  (tx, author) => archiveObjectType(tx, ctx.tenant, author, slug, reason),
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
  reason?: string,
) => runSchemaDefine(
  deps,
  ctx,
  (tx, author) => archiveAttribute(tx, ctx.tenant, author, objectSlug, slug, reason),
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

export const archiveSchemaRelation = (
  deps: AppDeps,
  ctx: ActorContext,
  slug: string,
  reason?: string,
) => runSchemaDefine(
  deps,
  ctx,
  (tx, author) => archiveRelationType(tx, ctx.tenant, author, slug, reason),
)

export async function previewSchemaObjectArchive(
  deps: AppDeps,
  ctx: ActorContext,
  slug: string,
): Promise<{ records: number }> {
  await requireSchemaDefine(deps, ctx)
  const objectType = await deps.db.objectType.findFirst({
    where: { ...tenantWhere(ctx.tenant), slug, archivedAt: null },
    select: { id: true },
  })
  if (objectType === null) throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Unknown object type')
  const records = await deps.db.record.count({
    where: { ...tenantWhere(ctx.tenant), objectTypeId: objectType.id },
  })
  return { records }
}

export async function previewSchemaAttributeArchive(
  deps: AppDeps,
  ctx: ActorContext,
  objectSlug: string,
  slug: string,
): Promise<{ recordsWithValues: number }> {
  await requireSchemaDefine(deps, ctx)
  const objectType = await deps.db.objectType.findFirst({
    where: { ...tenantWhere(ctx.tenant), slug: objectSlug, archivedAt: null },
    select: { id: true },
  })
  if (objectType === null) throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Unknown object type')
  const attribute = await deps.db.attribute.findFirst({
    where: { ...tenantWhere(ctx.tenant), objectTypeId: objectType.id, slug, archivedAt: null },
    select: { id: true },
  })
  if (attribute === null) throw new ServiceError(ErrorCode.UNKNOWN_ATTRIBUTE, 'Unknown attribute')
  const recordsWithValues = await deps.db.record.count({
    where: {
      ...tenantWhere(ctx.tenant),
      objectTypeId: objectType.id,
      data: { path: [slug], not: Prisma.JsonNull },
    },
  })
  return { recordsWithValues }
}

export async function previewSchemaRelationArchive(
  deps: AppDeps,
  ctx: ActorContext,
  slug: string,
): Promise<{ links: number }> {
  await requireSchemaDefine(deps, ctx)
  const relationType = await deps.db.relationType.findFirst({
    where: { ...tenantWhere(ctx.tenant), slug, archivedAt: null },
    select: { id: true },
  })
  if (relationType === null) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Unknown relation type')
  const links = await deps.db.recordLink.count({
    where: { ...tenantWhere(ctx.tenant), relationTypeId: relationType.id, activeUntil: null },
  })
  return { links }
}

export const applySchemaTemplate = (deps: AppDeps, ctx: ActorContext, slug: string) => runSchemaDefine(
  deps,
  ctx,
  (tx, author) => applyTemplate(tx, ctx.tenant, author, slug),
)

export async function listSchemaTemplates(deps: AppDeps, ctx: ActorContext) {
  await requireSchemaView(deps, ctx)
  return listTemplates()
}

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
