import {
  loadSchema,
  queryRecords as engineQueryRecords,
  type LoadedObjectType,
  type LoadedSchema,
  type QueryInput,
} from '@deepcrm/schema-engine'
import {
  ErrorCode,
  Filter as FilterSchema,
  ServiceError,
  Slug,
  Sort as SortSchema,
  type ActorContext,
  type Filter,
  type Sort,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import {
  loadPolicyEvaluator,
  type PolicyDecision,
  type PolicyEvaluator,
  type PolicyRequest,
  type PolicyScopeRef,
} from './policy.js'
import type { QueryCursorBinding } from './query-cursor.js'
import { recordBoundary } from './record-boundary.js'
import { buildRedactionMatrix, redactForActor, type RecordOut } from './redact.js'

type LoadedAttribute = LoadedObjectType['attributes'][number]

export type RecordQueryInput = {
  objectType: string
  filter?: Filter
  sort?: Sort
  attributes?: readonly string[]
  includeTotal?: boolean
  cursor?: string
  limit?: number
}

export type RecordQueryResult = {
  records: RecordOut[]
  next_cursor: string | null
  total?: number
}

type NormalizedQuery = {
  objectType: string
  filter?: Filter
  sort: Sort
  attributes?: readonly string[]
  includeTotal: boolean
  limit: number
}

function pointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) return ''
  return `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`
}

function invalidQuery(path: string, message: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Record query is invalid', {
    issues: [{ path, message }],
  })
}

function parseQuery(input: RecordQueryInput): NormalizedQuery {
  if (input.includeTotal !== undefined && typeof input.includeTotal !== 'boolean') {
    invalidQuery('/include_total', 'Include total must be boolean')
  }
  const objectType = Slug.safeParse(input.objectType)
  if (!objectType.success) invalidQuery('/object_type', 'Invalid object type slug')
  let parsedFilter: Filter | undefined
  if (input.filter !== undefined) {
    const filter = FilterSchema.safeParse(input.filter)
    if (!filter.success) {
      const issue = filter.error.issues[0]
      invalidQuery(pointer(issue?.path ?? []), issue?.message ?? 'Invalid filter')
    }
    parsedFilter = filter.data
  }
  let parsedSort: Sort = [{ system: 'created_at', direction: 'desc' }]
  if (input.sort !== undefined) {
    const sort = SortSchema.safeParse(input.sort)
    if (!sort.success) {
      const issue = sort.error.issues[0]
      invalidQuery(pointer(issue?.path ?? []), issue?.message ?? 'Invalid sort')
    }
    parsedSort = sort.data
  }
  let parsedAttributes: readonly string[] | undefined
  if (input.attributes !== undefined) {
    const attributes = Slug.array().max(100).safeParse(input.attributes)
    if (!attributes.success) {
      const issue = attributes.error.issues[0]
      invalidQuery(pointer(issue?.path ?? []), issue?.message ?? 'Invalid attributes')
    }
    parsedAttributes = [...new Set(attributes.data)].sort()
  }
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    invalidQuery('/limit', 'Limit must be an integer from 1 to 200')
  }
  return {
    objectType: objectType.data,
    ...(parsedFilter === undefined ? {} : { filter: parsedFilter }),
    sort: parsedSort,
    ...(parsedAttributes === undefined ? {} : { attributes: parsedAttributes }),
    includeTotal: input.includeTotal ?? false,
    limit,
  }
}

function selectedObjectType(schema: LoadedSchema, slug: string): LoadedObjectType {
  const objectType = schema.objectTypesBySlug.get(slug)
  if (objectType === undefined || objectType.archivedAt !== null) {
    throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Object type does not exist')
  }
  return objectType
}

function selectedAttribute(
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

function filterAttributes(filter: Filter | undefined, slugs = new Set<string>()): Set<string> {
  if (filter === undefined) return slugs
  if ('and' in filter) for (const child of filter.and) filterAttributes(child, slugs)
  else if ('or' in filter) for (const child of filter.or) filterAttributes(child, slugs)
  else if ('not' in filter) filterAttributes(filter.not, slugs)
  else if ('attribute' in filter) slugs.add(filter.attribute)
  return slugs
}

function queryScopes(ctx: ActorContext, objectType: LoadedObjectType): PolicyScopeRef[] {
  return [
    { scope: 'team', id: ctx.tenant.teamId },
    { scope: 'object_type', id: objectType.id },
  ]
}

function attributeRequest(
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

function binding(ctx: ActorContext, query: NormalizedQuery): QueryCursorBinding {
  return {
    tool: 'crm_records_query',
    tenant: ctx.tenant,
    arguments: {
      object_type: query.objectType,
      filter: query.filter ?? null,
      sort: query.sort,
      attributes: query.attributes ?? null,
      include_total: query.includeTotal,
      limit: query.limit,
    },
  }
}

async function writeDeniedAudit(
  deps: AppDeps,
  ctx: ActorContext,
  objectType: LoadedObjectType,
): Promise<void> {
  await deps.db.$transaction((tx) => deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action: 'crm_records_query',
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
): Promise<void> {
  if (decision.allowed && !decision.requiresApproval) return
  await writeDeniedAudit(deps, ctx, objectType)
  throw new ServiceError(
    decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Record query is not permitted',
    { resource: request.resourceType, action: request.action },
  )
}

async function preauthorize(
  deps: AppDeps,
  ctx: ActorContext,
  objectType: LoadedObjectType,
  evaluator: PolicyEvaluator,
  requests: readonly PolicyRequest[],
): Promise<void> {
  for (const request of requests) {
    await rejectDecision(deps, ctx, objectType, request, evaluator.evaluate(request))
  }
}

export async function queryRecords(
  deps: AppDeps,
  ctx: ActorContext,
  input: RecordQueryInput,
): Promise<RecordQueryResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const query = parseQuery(input)
    const schema = await loadSchema(deps.db, ctx.tenant)
    const objectType = selectedObjectType(schema, query.objectType)
    const scopes = queryScopes(ctx, objectType)
    const sensitiveSlugs = filterAttributes(query.filter)
    for (const sort of query.sort) if (sort.attribute !== undefined) sensitiveSlugs.add(sort.attribute)
    const sensitiveAttributes = [...sensitiveSlugs].sort().map((slug) => (
      selectedAttribute(schema, objectType, slug)
    ))
    const projectedAttributes = query.attributes === undefined
      ? [...objectType.attributes]
      : query.attributes.map((slug) => selectedAttribute(schema, objectType, slug))
    const recordRequest: PolicyRequest = {
      resourceType: 'record', action: 'view', scopes,
    }
    const sensitiveRequests = sensitiveAttributes.map((attribute) => (
      attributeRequest(scopes, attribute)
    ))
    const evaluator = await loadPolicyEvaluator(deps.db, ctx, [
      recordRequest,
      ...sensitiveRequests,
      ...projectedAttributes.map((attribute) => attributeRequest(scopes, attribute)),
    ])
    await preauthorize(deps, ctx, objectType, evaluator, [recordRequest, ...sensitiveRequests])
    const cursorBinding = binding(ctx, query)
    const after = input.cursor === undefined
      ? undefined
      : deps.queryCursor.open(input.cursor, cursorBinding)
    const engineInput: QueryInput = {
      ...(query.filter === undefined ? {} : { filter: query.filter }),
      sort: query.sort,
      ...(after === undefined ? {} : { after }),
      limit: query.limit,
      includeTotal: query.includeTotal,
    }
    const page = await engineQueryRecords(
      deps.db, ctx.tenant, ctx, schema, objectType, engineInput,
    )
    const matrix = buildRedactionMatrix(
      evaluator, ctx, schema, page.records, query.attributes,
    )
    const records = page.records.map((record) => (
      redactForActor(ctx, schema, record, matrix, query.attributes)
    ))
    return {
      records,
      next_cursor: page.next === null ? null : deps.queryCursor.seal(page.next, cursorBinding),
      ...(query.includeTotal ? { total: page.total ?? 0 } : {}),
    }
  })
}
