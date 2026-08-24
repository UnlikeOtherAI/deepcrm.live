import {
  loadSchema,
  queryRecords as engineQueryRecords,
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
  type PolicyRequest,
} from './policy.js'
import type { QueryCursorBinding } from './query-cursor.js'
import { recordBoundary } from './record-boundary.js'
import {
  attributeRequest,
  filterAttributes,
  preauthorize,
  queryScopes,
  selectedAttribute,
  selectedObjectType,
} from './record-query-authorization.js'
import { buildRedactionMatrix, redactForActor, type RecordOut } from './redact.js'

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
export type RecordQueryIntegration = {
  tool: string
  cursorArguments: (query: NormalizedQuery) => Record<string, unknown>
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

function recordCursorArguments(query: NormalizedQuery): Record<string, unknown> {
  return {
    object_type: query.objectType,
    filter: query.filter ?? null,
    sort: query.sort,
    attributes: query.attributes ?? null,
    include_total: query.includeTotal,
    limit: query.limit,
  }
}

function binding(
  ctx: ActorContext, query: NormalizedQuery, integration: RecordQueryIntegration,
): QueryCursorBinding {
  return {
    tool: integration.tool,
    tenant: ctx.tenant,
    arguments: integration.cursorArguments(query),
  }
}

async function queryRecordsOperation(
  deps: AppDeps,
  ctx: ActorContext,
  input: RecordQueryInput,
  integration: RecordQueryIntegration,
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
    await preauthorize(
      deps, ctx, objectType, evaluator, [recordRequest, ...sensitiveRequests], integration.tool,
    )
    const cursorBinding = binding(ctx, query, integration)
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

export function queryRecords(
  deps: AppDeps, ctx: ActorContext, input: RecordQueryInput,
): Promise<RecordQueryResult> {
  return queryRecordsOperation(deps, ctx, input, {
    tool: 'crm_records_query', cursorArguments: recordCursorArguments,
  })
}

export async function countRecords(
  deps: AppDeps,
  ctx: ActorContext,
  input: Pick<RecordQueryInput, 'objectType' | 'filter'>,
): Promise<{ count: number }> {
  const result = await queryRecordsOperation(deps, ctx, {
    objectType: input.objectType,
    ...(input.filter === undefined ? {} : { filter: input.filter }),
    attributes: [],
    includeTotal: true,
    limit: 1,
  }, {
    tool: 'crm_records_count',
    cursorArguments: recordCursorArguments,
  })
  if (result.total === undefined) {
    throw new ServiceError(ErrorCode.INTERNAL, 'Record count was not returned')
  }
  return { count: result.total }
}

export function queryRecordsForTool(
  deps: AppDeps, ctx: ActorContext, input: RecordQueryInput, integration: RecordQueryIntegration,
): Promise<RecordQueryResult> {
  return queryRecordsOperation(deps, ctx, input, integration)
}
