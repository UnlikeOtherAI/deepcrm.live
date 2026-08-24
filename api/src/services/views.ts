import { canonicalJson, Prisma, tenantWhere, type Db } from '@deepcrm/db'
import {
  compileQuery,
  loadSchema,
  type LoadedSchema,
  type LoadedView,
} from '@deepcrm/schema-engine'
import { ErrorCode, Filter, ServiceError, Sort, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { loadPolicyEvaluator, type PolicyRequest, type PolicyScopeRef } from './policy.js'
import { queryRecordsForTool, type RecordQueryResult } from './record-query.js'
import { selectedAttribute, selectedObjectType } from './record-query-authorization.js'
import { recordBoundary } from './record-boundary.js'

export type SaveViewInput = {
  slug: string; name: string; description?: string; objectType: string
  filter: Filter; sort?: typeof Sort._output; attributes?: readonly string[]
}
export type ViewSummary = { slug: string; name: string; object_type: string }
export type ViewDetail = ViewSummary & {
  id: string; description: string; filter: Filter; sort: typeof Sort._output; attributes: string[]
}
type MutableJsonObject = { [key: string]: Prisma.InputJsonValue | null }
type ViewTx = Pick<Db,
  '$queryRaw' | '$executeRaw' | 'auditLog' | 'policyRule' | 'team' | 'view'
>

function failure(code: typeof ErrorCode.NOT_FOUND | typeof ErrorCode.SCHEMA_CONFLICT, message: string): never {
  throw new ServiceError(code, message)
}

function viewRequest(
  ctx: ActorContext, view: LoadedView | undefined, action: 'view' | 'create' | 'edit' | 'delete',
  targetObjectTypeId?: string,
): PolicyRequest {
  const ids = new Set([view?.objectTypeId, targetObjectTypeId].filter((id): id is string => id !== undefined))
  const objectScope: PolicyScopeRef[] = [...ids].map((id) => ({ scope: 'object_type', id }))
  return {
    resourceType: 'view', action,
    scopes: [{ scope: 'team', id: ctx.tenant.teamId }, ...objectScope],
  }
}

function permitted(decision: { allowed: boolean; requiresApproval: boolean }): boolean {
  return decision.allowed && !decision.requiresApproval
}

function policyError(request: PolicyRequest, requiresApproval: boolean): ServiceError {
  return new ServiceError(
    requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'View operation is not permitted', { resource: request.resourceType, action: request.action },
  )
}

async function audit(
  deps: AppDeps, tx: ViewTx, ctx: ActorContext, tool: string,
  resourceId: string | null, outcome: 'success' | 'denied',
): Promise<void> {
  await deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId, teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type, actorId: ctx.actor.id, onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action: tool, resourceType: 'view', resourceId, outcome, reason: null,
    metadata: { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance },
    requestId: ctx.requestId, ipAddress: null, userAgent: null,
  })
}

async function denied(deps: AppDeps, ctx: ActorContext, tool: string, resourceId: string | null): Promise<void> {
  await deps.db.$transaction((tx) => audit(deps, tx, ctx, tool, resourceId, 'denied'))
}

async function authorizeRead(
  deps: AppDeps, ctx: ActorContext, request: PolicyRequest, tool: string,
  resourceId: string, hide: boolean,
): Promise<void> {
  const evaluator = await loadPolicyEvaluator(deps.db, ctx, [request])
  const decision = evaluator.evaluate(request)
  if (permitted(decision)) return
  if (hide) failure(ErrorCode.NOT_FOUND, 'View not found')
  await denied(deps, ctx, tool, resourceId)
  throw policyError(request, decision.requiresApproval)
}

async function mutate<T>(
  deps: AppDeps, ctx: ActorContext, tool: string, resourceId: string | null,
  request: PolicyRequest, operation: (tx: ViewTx) => Promise<T>,
): Promise<T> {
  let rejection: ServiceError | undefined
  try {
    return await deps.db.$transaction(async (tx) => {
      const evaluator = await loadPolicyEvaluator(tx, ctx, [request])
      const decision = evaluator.evaluate(request)
      if (!permitted(decision)) {
        rejection = policyError(request, decision.requiresApproval)
        throw rejection
      }
      return operation(tx)
    })
  } catch (error) {
    if (rejection !== undefined) await denied(deps, ctx, tool, resourceId)
    throw error
  }
}

async function bumpVersion(tx: ViewTx, ctx: ActorContext): Promise<void> {
  const result = await tx.team.updateMany({
    where: { id: ctx.tenant.teamId, organizationId: ctx.tenant.organizationId },
    data: { schemaVersion: { increment: 1 } },
  })
  if (result.count !== 1) failure(ErrorCode.SCHEMA_CONFLICT, 'Tenant schema does not exist')
}

function publicView(schema: LoadedSchema, view: LoadedView): ViewDetail {
  const objectType = schema.objectTypesById.get(view.objectTypeId)
  const filter = Filter.safeParse(view.filter)
  const sort = Sort.safeParse(view.sort)
  if (objectType === undefined || !filter.success || !sort.success) {
    failure(ErrorCode.SCHEMA_CONFLICT, 'Stored view definition is invalid')
  }
  return {
    id: view.id, slug: view.slug, name: view.name, description: view.description,
    object_type: objectType.slug, filter: filter.data, sort: sort.data, attributes: [...view.attributes],
  }
}

async function activeView(deps: AppDeps, ctx: ActorContext, slug: string): Promise<[LoadedSchema, LoadedView]> {
  const schema = await loadSchema(deps.db, ctx.tenant)
  const view = schema.viewsBySlug.get(slug)
  if (view === undefined) failure(ErrorCode.NOT_FOUND, 'View not found')
  return [schema, view]
}

export async function getView(deps: AppDeps, ctx: ActorContext, slug: string): Promise<ViewDetail> {
  const [schema, view] = await activeView(deps, ctx, slug)
  await authorizeRead(deps, ctx, viewRequest(ctx, view, 'view'), 'crm_view_get', view.id, true)
  return publicView(schema, view)
}

export async function listViews(deps: AppDeps, ctx: ActorContext): Promise<ViewSummary[]> {
  const schema = await loadSchema(deps.db, ctx.tenant)
  const requests = schema.views.map((view) => viewRequest(ctx, view, 'view'))
  const evaluator = await loadPolicyEvaluator(deps.db, ctx, requests)
  return schema.views.filter((view) => permitted(evaluator.evaluate(viewRequest(ctx, view, 'view')))).map((view) => {
    const detail = publicView(schema, view)
    return { slug: detail.slug, name: detail.name, object_type: detail.object_type }
  })
}

function nestedJson(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(nestedJson)
  if (typeof value === 'object') {
    const result: MutableJsonObject = {}
    for (const [key, child] of Object.entries(value)) result[key] = nestedJson(child)
    return result
  }
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'View query is not JSON')
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  const result = nestedJson(value)
  if (result === null) throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'View query is not JSON')
  return result
}

function isUnique(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

export async function saveView(
  deps: AppDeps, ctx: ActorContext, input: SaveViewInput,
): Promise<ViewDetail> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const schema = await loadSchema(deps.db, ctx.tenant)
    const objectType = selectedObjectType(schema, input.objectType)
    const filter = Filter.safeParse(input.filter)
    const sort = Sort.safeParse(input.sort ?? [{ system: 'created_at', direction: 'desc' }])
    if (!filter.success || !sort.success) throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'View query is invalid')
    const attributes = [...new Set(input.attributes ?? [])]
    for (const slug of attributes) selectedAttribute(schema, objectType, slug)
    compileQuery(ctx.tenant, ctx, schema, objectType, { filter: filter.data, sort: sort.data, limit: 1 })
    const existing = schema.viewsBySlug.get(input.slug)
    const next = {
      name: input.name, description: input.description ?? '', objectTypeId: objectType.id,
      filter: jsonInput(filter.data), sort: jsonInput(sort.data), attributes,
    }
    if (existing !== undefined && existing.name === next.name && existing.description === next.description
      && existing.objectTypeId === next.objectTypeId && canonicalJson(existing.filter) === canonicalJson(next.filter)
      && canonicalJson(existing.sort) === canonicalJson(next.sort)
      && canonicalJson(existing.attributes) === canonicalJson(next.attributes)) {
      await mutate(deps, ctx, 'crm_view_save', existing.id,
        viewRequest(ctx, existing, 'edit', objectType.id), async () => undefined)
      return publicView(schema, existing)
    }
    let id: string
    try {
      id = await mutate(
        deps, ctx, 'crm_view_save', existing?.id ?? null,
        viewRequest(ctx, existing, existing === undefined ? 'create' : 'edit', objectType.id), async (tx) => {
          const view = existing === undefined ? await tx.view.create({ data: {
            ...tenantWhere(ctx.tenant), slug: input.slug, ...next,
            createdByType: ctx.actor.type, createdById: ctx.actor.id,
          } }) : await tx.view.updateMany({
            where: { id: existing.id, ...tenantWhere(ctx.tenant) }, data: next,
          }).then(async (updated) => {
            if (updated.count !== 1) failure(ErrorCode.NOT_FOUND, 'View not found')
            return tx.view.findFirstOrThrow({ where: { id: existing.id, ...tenantWhere(ctx.tenant) } })
          })
          await bumpVersion(tx, ctx)
          await audit(deps, tx, ctx, 'crm_view_save', view.id, 'success')
          return view.id
        },
      )
    } catch (error) {
      if (isUnique(error)) failure(ErrorCode.SCHEMA_CONFLICT, 'View slug already exists')
      throw error
    }
    const latest = await loadSchema(deps.db, ctx.tenant)
    const saved = latest.viewsById.get(id)
    if (saved === undefined) failure(ErrorCode.SCHEMA_CONFLICT, 'Saved view is missing from schema')
    return publicView(latest, saved)
  })
}

export async function runView(
  deps: AppDeps, ctx: ActorContext, slug: string, cursor?: string, limit?: number,
): Promise<RecordQueryResult> {
  const [schema, view] = await activeView(deps, ctx, slug)
  await authorizeRead(deps, ctx, viewRequest(ctx, view, 'view'), 'crm_view_run', view.id, false)
  const detail = publicView(schema, view)
  return queryRecordsForTool(deps, ctx, {
    objectType: detail.object_type, filter: detail.filter, sort: detail.sort,
    ...(detail.attributes.length === 0 ? {} : { attributes: detail.attributes }), cursor, limit,
  }, {
    tool: 'crm_view_run',
    cursorArguments: (query) => ({
      view: slug, updated_at: view.updatedAt.toISOString(), limit: query.limit, sort: query.sort,
    }),
  })
}

export async function deleteView(deps: AppDeps, ctx: ActorContext, slug: string): Promise<{ deleted: true }> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const [, view] = await activeView(deps, ctx, slug)
    await mutate(deps, ctx, 'crm_view_delete', view.id, viewRequest(ctx, view, 'edit'), async (tx) => {
      const removed = await tx.view.deleteMany({ where: { id: view.id, ...tenantWhere(ctx.tenant) } })
      if (removed.count !== 1) failure(ErrorCode.NOT_FOUND, 'View not found')
      await bumpVersion(tx, ctx)
      await audit(deps, tx, ctx, 'crm_view_delete', view.id, 'success')
    })
    return { deleted: true }
  })
}
