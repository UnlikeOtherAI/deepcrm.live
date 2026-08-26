import {
  AttributeSpec,
  ErrorCode,
  Filter as FilterSchema,
  ServiceError,
  type ActorContext,
  type AttributeSpec as AttributeSpecValue,
} from '@deepcrm/schemas'
import { getAttributeType, loadSchema, validateRecordData, type LoadedList,
  type LoadedObjectType, type LoadedSchema } from '@deepcrm/schema-engine'
import { Prisma, tenantWhere, type Db, type PolicyAction } from '@deepcrm/db'

import type { AppDeps } from '../deps.js'
import { getManyRecords } from './record-collection.js'
import { selectedObjectType } from './record-query-authorization.js'
import type { RecordOut } from './redact.js'
import { checkPolicy, loadPolicyEvaluator, type PolicyRequest, type PolicyScopeRef } from './policy.js'
import { recordBoundary } from './record-boundary.js'
import { requireVisibleRecord } from './record-visibility.js'
import { enqueueDynamicListRefresh } from './record-mutation-effects.js'
import { dynamicStatus, presentList, recordAccess, type DynamicListStatus,
  type ListDetail } from './list-presenters.js'

export type CreateListInput = {
  slug: string; name: string; description?: string; objectType?: string
  kind?: 'static' | 'dynamic'; filter?: Record<string, unknown>; attributes?: readonly AttributeSpecValue[]
}
export type UpdateListInput = { list: string; name?: string; description?: string; filter?: Record<string, unknown> }
export type AddListEntriesInput = {
  list: string; entries: readonly { recordId: string; data?: Record<string, unknown> }[]
}
export type ListEntriesInput = { list: string; cursor?: string; limit?: number }
export type ListEntriesResult = {
  entries: Array<{ entry: { id: string; data: Record<string, unknown>; position: number }; record: RecordOut }>
  next_cursor: string | null
  list: { kind: 'static' | 'dynamic'; refresh_state: 'ready' | 'refreshing' | 'failed'; evaluation_version: number }
}
type VisibleEntryRow = { id: string; recordId: string; data: unknown; position: number }
type MutableJsonObject = { [key: string]: Prisma.InputJsonValue | null }
type ListTx = Pick<Db, '$queryRaw' | '$executeRaw' | 'auditLog' | 'policyRule' | 'team' | 'list' | 'attribute' | 'listEntry' | 'queueJob'>

function failure(code: typeof ErrorCode.NOT_FOUND | typeof ErrorCode.SCHEMA_CONFLICT, message: string): never {
  throw new ServiceError(code, message)
}

function isUnique(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function metadata(ctx: ActorContext): Prisma.InputJsonObject {
  return { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance }
}

async function audit(
  deps: AppDeps,
  tx: ListTx,
  ctx: ActorContext,
  action: string,
  resourceType: 'list' | 'view',
  resourceId: string | null,
  outcome: 'success' | 'denied',
): Promise<void> {
  await deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId, teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type, actorId: ctx.actor.id, onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action, resourceType, resourceId, outcome, reason: null, metadata: metadata(ctx),
    requestId: ctx.requestId, ipAddress: null, userAgent: null,
  })
}

async function authorize(
  deps: AppDeps,
  ctx: ActorContext,
  request: PolicyRequest,
  tool: string,
  resourceType: 'list' | 'view',
  resourceId: string | null,
): Promise<void> {
  const decision = await checkPolicy(deps.db, ctx, request)
  if (decision.allowed && !decision.requiresApproval) return
  await deps.db.$transaction((tx) => audit(deps, tx, ctx, tool, resourceType, resourceId, 'denied'))
  throw new ServiceError(
    decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    `${resourceType === 'list' ? 'List' : 'View'} operation is not permitted`,
    { resource: request.resourceType, action: request.action },
  )
}

function policyError(request: PolicyRequest, requiresApproval: boolean): ServiceError {
  return new ServiceError(
    requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'List operation is not permitted', { resource: request.resourceType, action: request.action },
  )
}

async function mutate<T>(
  deps: AppDeps, ctx: ActorContext, tool: string, resourceId: string | null,
  requests: readonly PolicyRequest[], operation: (tx: ListTx) => Promise<T>,
): Promise<T> {
  let rejection: ServiceError | undefined
  try {
    return await deps.db.$transaction(async (tx) => {
      const evaluator = await loadPolicyEvaluator(tx, ctx, requests)
      const decisions = requests.map((request) => ({ request, decision: evaluator.evaluate(request) }))
      const denied = decisions.find(({ decision }) => !decision.allowed && !decision.requiresApproval)
        ?? decisions.find(({ decision }) => !decision.allowed || decision.requiresApproval)
      if (denied !== undefined) {
        rejection = policyError(denied.request, denied.decision.requiresApproval)
        throw rejection
      }
      return operation(tx)
    })
  } catch (error) {
    if (rejection !== undefined) {
      await deps.db.$transaction((tx) => audit(deps, tx, ctx, tool, 'list', resourceId, 'denied'))
    }
    throw error
  }
}

function scopes(ctx: ActorContext, scope?: PolicyScopeRef): PolicyScopeRef[] {
  return [{ scope: 'team', id: ctx.tenant.teamId }, ...(scope === undefined ? [] : [scope])]
}

function listRequest(ctx: ActorContext, list: LoadedList | undefined, action: PolicyAction): PolicyRequest {
  return {
    resourceType: 'list', action,
    scopes: scopes(ctx, list === undefined ? undefined : { scope: 'list', id: list.id }),
  }
}

async function bumpVersion(tx: ListTx, ctx: ActorContext): Promise<void> {
  const updated = await tx.team.updateMany({
    where: { id: ctx.tenant.teamId, organizationId: ctx.tenant.organizationId },
    data: { schemaVersion: { increment: 1 } },
  })
  if (updated.count !== 1) failure(ErrorCode.SCHEMA_CONFLICT, 'Tenant schema does not exist')
}

function configInput(spec: AttributeSpecValue): Prisma.InputJsonObject {
  const definition = getAttributeType(spec.type)
  const raw = Object.fromEntries(Object.entries(spec.config ?? {}).filter(([key]) => key !== 'type'))
  const config = definition.configSchema.safeParse(raw)
  if (!config.success) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'List attribute config is invalid', {
      issues: [{ path: `/attributes/${spec.slug}/config`, message: 'Invalid attribute config' }],
    })
  }
  if (spec.is_multi && !definition.supportsMulti) failure(ErrorCode.SCHEMA_CONFLICT, 'List attribute cannot be multi-valued')
  if (spec.is_unique || spec.is_indexed) failure(ErrorCode.SCHEMA_CONFLICT, 'List entry attributes cannot be unique or indexed')
  if (spec.type === 'record_reference' || spec.type === 'timestamp_system') {
    failure(ErrorCode.SCHEMA_CONFLICT, 'List entry attribute type is not supported')
  }
  if (spec.default_value !== undefined) {
    const values = spec.is_multi && Array.isArray(spec.default_value) ? spec.default_value : [spec.default_value]
    if (values.some((value) => !definition.valueSchema(config.data).safeParse(value).success)) {
      throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'List attribute default is invalid')
    }
  }
  return jsonInput(config.data)
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
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'List attribute JSON is invalid')
}

function jsonInput(value: unknown): MutableJsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'List attribute config is invalid')
  }
  const result: MutableJsonObject = {}
  for (const [key, child] of Object.entries(value)) result[key] = nestedJson(child)
  return result
}

function defaultJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  const result = nestedJson(value)
  return result === null ? Prisma.JsonNull : result
}

async function activeList(deps: AppDeps, ctx: ActorContext, slug: string): Promise<[LoadedSchema, LoadedList]> {
  const schema = await loadSchema(deps.db, ctx.tenant, { useCache: false })
  const list = schema.listsBySlug.get(slug)
  if (list === undefined) failure(ErrorCode.NOT_FOUND, 'List not found')
  return [schema, list]
}

export async function getList(deps: AppDeps, ctx: ActorContext, slug: string): Promise<ListDetail> {
  const [schema, list] = await activeList(deps, ctx, slug)
  await authorize(deps, ctx, listRequest(ctx, list, 'view'), 'crm_list_get', 'list', list.id)
  return presentList(deps, ctx, schema, list)
}

export async function listLists(deps: AppDeps, ctx: ActorContext) {
  const schema = await loadSchema(deps.db, ctx.tenant, { useCache: false })
  const requests = schema.lists.map((list) => listRequest(ctx, list, 'view'))
  const evaluator = await loadPolicyEvaluator(deps.db, ctx, requests)
  return schema.lists.filter((list) => permitted(evaluator.evaluate(listRequest(ctx, list, 'view')))).map((list) => {
    const objectType = list.objectTypeId === null ? null : schema.objectTypesById.get(list.objectTypeId)
    if (list.objectTypeId !== null && objectType === undefined) failure(ErrorCode.SCHEMA_CONFLICT, 'List object type is not active')
    return {
      slug: list.slug,
      name: list.name,
      kind: list.kind,
      object_type: objectType?.slug ?? null,
      refresh_state: list.refreshState,
      evaluation_version: list.evaluationVersion,
    }
  })
}

export async function createList(
  deps: AppDeps, ctx: ActorContext, input: CreateListInput,
): Promise<ListDetail> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const schema = await loadSchema(deps.db, ctx.tenant)
    const kind = input.kind ?? 'static'
    const objectType = input.objectType === undefined
      ? undefined : selectedObjectType(schema, input.objectType)
    if (kind === 'dynamic' && (objectType === undefined || input.filter === undefined)) {
      throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Dynamic lists require object_type and filter')
    }
    if (kind === 'static' && input.filter !== undefined) {
      throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Static lists cannot have a filter')
    }
    const filter = input.filter === undefined ? undefined : FilterSchema.parse(input.filter)
    const parsed = AttributeSpec.array().max(20).safeParse(input.attributes ?? [])
    if (!parsed.success) throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'List attributes are invalid')
    if (kind === 'dynamic' && parsed.data.length > 0) failure(ErrorCode.SCHEMA_CONFLICT, 'Dynamic lists cannot have entry attributes')
    const configs = parsed.data.map(configInput)
    let id: string
    try {
      id = await mutate(deps, ctx, 'crm_list_create', null, [listRequest(ctx, undefined, 'create')], async (tx) => {
        const list = await tx.list.create({ data: {
          ...tenantWhere(ctx.tenant), kind, slug: input.slug, name: input.name,
          description: input.description ?? '', objectTypeId: objectType?.id ?? null,
          definition: filter === undefined ? undefined : { filter },
          evaluationVersion: kind === 'dynamic' ? 1 : 0,
          refreshState: kind === 'dynamic' ? 'refreshing' : 'ready',
          createdByType: ctx.actor.type, createdById: ctx.actor.id,
        } })
        for (const [position, spec] of parsed.data.entries()) {
          const config = configs[position]
          if (config === undefined) failure(ErrorCode.SCHEMA_CONFLICT, 'List attribute config is missing')
          await tx.attribute.create({ data: {
            ...tenantWhere(ctx.tenant), listId: list.id, slug: spec.slug, name: spec.name,
            description: spec.description, type: spec.type, config, isMulti: spec.is_multi,
            isRequired: spec.is_required, isUnique: false, isIndexed: false, isSystem: false,
            sensitivity: spec.sensitivity, defaultValue: spec.default_value === undefined
              ? undefined : defaultJson(spec.default_value),
            position,
          } })
        }
        await bumpVersion(tx, ctx)
        if (kind === 'dynamic') {
          await enqueueDynamicListRefresh(tx, ctx, list.id, 1, `list-create:${ctx.tenant.teamId}:${list.id}:${ctx.requestId}`)
        }
        await audit(deps, tx, ctx, 'crm_list_create', 'list', list.id, 'success')
        return list.id
      })
    } catch (error) {
      if (isUnique(error)) failure(ErrorCode.SCHEMA_CONFLICT, 'List slug or attribute slug already exists')
      throw error
    }
    const latest = await loadSchema(deps.db, ctx.tenant, { useCache: false })
    const created = latest.listsById.get(id)
    if (created === undefined) failure(ErrorCode.SCHEMA_CONFLICT, 'Created list is missing from schema')
    return presentList(deps, ctx, latest, created)
  })
}

export async function updateList(deps: AppDeps, ctx: ActorContext, input: UpdateListInput): Promise<ListDetail> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const [, list] = await activeList(deps, ctx, input.list)
    const filter = input.filter === undefined ? undefined : FilterSchema.parse(input.filter)
    if (filter !== undefined && list.kind !== 'dynamic') failure(ErrorCode.SCHEMA_CONFLICT, 'Static lists cannot have a filter')
    await mutate(deps, ctx, 'crm_list_update', list.id, [listRequest(ctx, list, 'edit')], async (tx) => {
      const nextVersion = filter === undefined ? list.evaluationVersion : list.evaluationVersion + 1
      await tx.list.updateMany({
        where: { ...tenantWhere(ctx.tenant), id: list.id },
        data: {
          name: input.name,
          description: input.description,
          evaluationVersion: nextVersion,
          definition: filter === undefined ? undefined : { filter },
          refreshState: filter === undefined ? list.refreshState : 'refreshing',
          refreshErrorCode: filter === undefined ? list.refreshErrorCode : null,
        },
      })
      await bumpVersion(tx, ctx)
      if (filter !== undefined) {
        await enqueueDynamicListRefresh(tx, ctx, list.id, nextVersion, `list-update:${ctx.tenant.teamId}:${list.id}:${ctx.requestId}`)
      }
      await audit(deps, tx, ctx, 'crm_list_update', 'list', list.id, 'success')
    })
    const latest = await loadSchema(deps.db, ctx.tenant, { useCache: false })
    const updated = latest.listsById.get(list.id)
    if (updated === undefined) failure(ErrorCode.SCHEMA_CONFLICT, 'Updated list is missing from schema')
    return presentList(deps, ctx, latest, updated)
  })
}

export async function listStatus(
  deps: AppDeps, ctx: ActorContext, slug: string,
): Promise<{ status: DynamicListStatus }> {
  const [schema, list] = await activeList(deps, ctx, slug)
  await authorize(deps, ctx, listRequest(ctx, list, 'view'), 'crm_list_status', 'list', list.id)
  const status = dynamicStatus(schema, list)
  if (status === null) failure(ErrorCode.SCHEMA_CONFLICT, 'List is not dynamic')
  return { status }
}

function validationTarget(schema: LoadedSchema, list: LoadedList): [LoadedSchema, LoadedObjectType] {
  const target: LoadedObjectType = { id: list.id, organizationId: list.organizationId, teamId: list.teamId,
    slug: list.slug, singularName: list.name, pluralName: list.name, description: list.description, icon: null,
    kind: 'custom', templateSlug: null, primaryAttributeId: null, archivedAt: null, createdByType: list.createdByType,
    createdById: list.createdById, createdAt: list.createdAt, updatedAt: list.updatedAt, attributes: list.attributes,
    attributeGroups: [] }
  const attributes = new Map(schema.attributesByObjectTypeId)
  attributes.set(list.id, schema.attributesByListId.get(list.id) ?? new Map())
  const archived = new Map(schema.archivedAttributeSlugsByObjectTypeId)
  archived.set(list.id, new Set())
  return [{ ...schema, attributesByObjectTypeId: attributes, archivedAttributeSlugsByObjectTypeId: archived }, target]
}

function validatedEntryData(
  schema: LoadedSchema, list: LoadedList, data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const [validationSchema, target] = validationTarget(schema, list)
  const result = validateRecordData(validationSchema, target, {}, data ?? {}, 'create')
  if (result.linkOps.length > 0) failure(ErrorCode.SCHEMA_CONFLICT, 'List entry links are not supported')
  return jsonInput(result.data)
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function entryWriteRequests(
  ctx: ActorContext, list: LoadedList, records: readonly { id: string; objectTypeId: string }[],
  data: readonly Record<string, unknown>[],
): PolicyRequest[] {
  const attributeSlugs = new Set(data.flatMap((entry) => Object.keys(entry)))
  return [
    listRequest(ctx, list, 'edit'),
    ...records.map((record) => ({
      resourceType: 'record' as const, action: 'view' as const,
      scopes: [
        ...scopes(ctx, { scope: 'object_type', id: record.objectTypeId }),
        { scope: 'record' as const, id: record.id },
      ],
    })),
    ...list.attributes.filter((attribute) => attributeSlugs.has(attribute.slug)).map((attribute) => ({
      resourceType: 'attribute' as const, action: 'edit' as const,
      scopes: scopes(ctx, { scope: 'list', id: list.id }), sensitivity: attribute.sensitivity,
    })),
  ]
}

export async function addListEntries(
  deps: AppDeps, ctx: ActorContext, input: AddListEntriesInput,
): Promise<{ added: number }> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const [schema, list] = await activeList(deps, ctx, input.list)
    if (list.kind === 'dynamic') failure(ErrorCode.SCHEMA_CONFLICT, 'Dynamic lists do not accept manual entries')
    const ids = input.entries.map((entry) => entry.recordId)
    if (new Set(ids).size !== ids.length) {
      throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'List entries contain duplicate record ids')
    }
    const records = await Promise.all(ids.map((id) => requireVisibleRecord(deps.db, ctx, id)))
    if (list.objectTypeId !== null && records.some((record) => record.objectTypeId !== list.objectTypeId)) {
      throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Record object type does not match list')
    }
    const data = input.entries.map((entry) => validatedEntryData(schema, list, entry.data))
    const added = await mutate(deps, ctx, 'crm_list_add', list.id,
      entryWriteRequests(ctx, list, records, data), async (tx) => {
      await tx.$queryRaw`SELECT id FROM lists WHERE id = ${list.id}::uuid
        AND organization_id = ${ctx.tenant.organizationId}::uuid
        AND team_id = ${ctx.tenant.teamId}::uuid FOR UPDATE`
      const maximum = await tx.$queryRaw<Array<{ position: number | null }>>`
        SELECT max(le.position)::int AS position FROM list_entries le JOIN lists l ON l.id = le.list_id
        WHERE l.id = ${list.id}::uuid AND l.organization_id = ${ctx.tenant.organizationId}::uuid
          AND l.team_id = ${ctx.tenant.teamId}::uuid
      `
      const start = (maximum[0]?.position ?? -1) + 1
      const created = await tx.listEntry.createMany({ data: input.entries.map((entry, index) => ({
        listId: list.id, recordId: entry.recordId, data: data[index] ?? {}, position: start + index,
      })), skipDuplicates: true })
      if (created.count > 0) await audit(deps, tx, ctx, 'crm_list_add', 'list', list.id, 'success')
      return created.count
    })
    return { added }
  })
}

export async function removeListEntries(
  deps: AppDeps, ctx: ActorContext, listSlug: string, recordIds: readonly string[],
): Promise<{ removed: number }> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const [, list] = await activeList(deps, ctx, listSlug)
    if (list.kind === 'dynamic') failure(ErrorCode.SCHEMA_CONFLICT, 'Dynamic lists do not accept manual entries')
    const records = await Promise.all(recordIds.map((id) => requireVisibleRecord(deps.db, ctx, id)))
    const removed = await mutate(deps, ctx, 'crm_list_remove', list.id,
      entryWriteRequests(ctx, list, records, []), async (tx) => {
      const count = await tx.$executeRaw`
        DELETE FROM list_entries le USING lists l
        WHERE le.list_id = l.id AND l.id = ${list.id}::uuid
          AND l.organization_id = ${ctx.tenant.organizationId}::uuid
          AND l.team_id = ${ctx.tenant.teamId}::uuid AND le.record_id = ANY(${[...recordIds]}::uuid[])
      `
      if (count > 0) await audit(deps, tx, ctx, 'crm_list_remove', 'list', list.id, 'success')
      return count
    })
    return { removed }
  })
}

function entryCursorBinding(ctx: ActorContext, list: LoadedList, limit: number) {
  return {
    tool: 'crm_list_entries', tenant: ctx.tenant,
    arguments: { list: list.slug, limit, sort: [{ system: 'position', direction: 'asc' }] },
  }
}

function entryAfter(deps: AppDeps, ctx: ActorContext, list: LoadedList, cursor: string | undefined, limit: number) {
  if (cursor === undefined) return undefined
  const state = deps.queryCursor.open(cursor, entryCursorBinding(ctx, list, limit))
  const value = state.values[0]?.value
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'List cursor does not match')
  }
  return { position: Number(value), id: state.id }
}

function permitted(decision: { allowed: boolean; requiresApproval: boolean }): boolean {
  return decision.allowed && !decision.requiresApproval
}

export async function listEntries(
  deps: AppDeps, ctx: ActorContext, input: ListEntriesInput,
): Promise<ListEntriesResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const [schema, list] = await activeList(deps, ctx, input.list)
    await authorize(deps, ctx, listRequest(ctx, list, 'view'), 'crm_list_entries', 'list', list.id)
    if (list.kind === 'dynamic' && list.refreshState !== 'ready') {
      failure(ErrorCode.SCHEMA_CONFLICT, 'Dynamic list membership is not ready')
    }
    const limit = input.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'List entry limit must be 1 to 200')
    }
    const after = entryAfter(deps, ctx, list, input.cursor, limit)
    const cursor = after === undefined ? Prisma.empty : Prisma.sql`
      AND (le.position > ${after.position} OR (le.position = ${after.position} AND le.id > ${after.id}::uuid))
    `
    const rows = await deps.db.$queryRaw<VisibleEntryRow[]>(Prisma.sql`
      SELECT le.id, le.record_id AS "recordId", le.data, le.position
      FROM list_entries le JOIN lists l ON l.id = le.list_id JOIN records r ON r.id = le.record_id
      WHERE l.id = ${list.id}::uuid AND l.organization_id = ${ctx.tenant.organizationId}::uuid
        AND l.team_id = ${ctx.tenant.teamId}::uuid AND r.erased_at IS NULL
        AND (${recordAccess(schema, ctx, list)}) ${cursor}
      ORDER BY le.position ASC, le.id ASC LIMIT ${limit + 1}
    `)
    const page = rows.slice(0, limit)
    const requests: PolicyRequest[] = list.attributes.map((attribute) => ({
        resourceType: 'attribute' as const, action: 'view' as const,
        scopes: scopes(ctx, { scope: 'list', id: list.id }), sensitivity: attribute.sensitivity,
      }))
    const evaluator = await loadPolicyEvaluator(deps.db, ctx, requests)
    const batch = await getManyRecords(deps, ctx, page.map((row) => row.recordId))
    const records = new Map<string, RecordOut>(batch.records.map((record) => [record.id, record]))
    const entries = page.flatMap((row) => {
      const record = records.get(row.recordId)
      if (record === undefined) return []
      const raw = plainRecord(row.data)
        ? row.data : failure(ErrorCode.SCHEMA_CONFLICT, 'Stored list entry data is invalid')
      const valid = validatedEntryData(schema, list, raw)
      const data = Object.fromEntries(Object.entries(valid).filter(([slug]) => {
        const attribute = schema.attributesByListId.get(list.id)?.get(slug)
        if (attribute === undefined) return false
        return permitted(evaluator.evaluate({
          resourceType: 'attribute', action: 'view',
          scopes: scopes(ctx, { scope: 'list', id: list.id }), sensitivity: attribute.sensitivity,
        }))
      }))
      return [{ entry: { id: row.id, data, position: row.position }, record }]
    })
    const last = page.at(-1)
    const nextCursor = rows.length <= limit || last === undefined ? null : deps.queryCursor.seal({
      values: [{ isNull: false, value: String(last.position) }], id: last.id,
    }, entryCursorBinding(ctx, list, limit))
    return {
      entries,
      next_cursor: nextCursor,
      list: { kind: list.kind, refresh_state: list.refreshState, evaluation_version: list.evaluationVersion },
    }
  })
}

export { deleteView, getView, listViews, runView, saveView } from './views.js'
export type { ViewDetail, ViewSummary } from './views.js'
