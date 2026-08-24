import { canonicalJson, tenantWhere } from '@deepcrm/db'
import {
  getAttributeType,
  listLinks,
  loadSchema,
  type LoadedRelationType,
  type LoadedSchema,
} from '@deepcrm/schema-engine'
import {
  AttributeSpec,
  ErrorCode,
  IsoDateTime,
  ServiceError,
  Slug,
  Uuid,
  type ActorContext,
  type SecretBox,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import {
  loadPolicyEvaluator,
  type PolicyDecision,
  type PolicyEvaluator,
  type PolicyRequest,
  type PolicyScopeRef,
} from './policy.js'
import { recordBoundary } from './record-boundary.js'
import { findVisibleLiveRecords, resolveVisibleRecord } from './record-visibility.js'

export type LinkListInput = {
  recordId: string
  relationType?: string
  direction?: 'from' | 'to' | 'both'
  includeHistory?: boolean
  cursor?: string
  limit?: number
}

export type ListedLinkOut = {
  id: string
  relation_type: string
  from_record_id: string
  to_record_id: string
  label: string | null
  data: Record<string, unknown>
  active_from: string
  active_until: string | null
}

export type LinkListResult = {
  links: Array<{
    link: ListedLinkOut
    related: { id: string; object_type: string; display_name: string }
  }>
  next_cursor: string | null
}

type NormalizedInput = {
  recordId: string
  relationType?: string
  direction: 'from' | 'to' | 'both'
  includeHistory: boolean
  limit: number
}
type LinkEntry = Awaited<ReturnType<typeof listLinks>>[number]
type CursorState = { activeFrom: string; id: string }
type RelatedRow = {
  id: string
  objectTypeId: string
  displayName: string
}

const purpose = 'deepcrm.links-list-cursor.v1'
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function invalid(path: string, message: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Link list input is invalid', {
    issues: [{ path, message }],
  })
}

function normalize(input: LinkListInput): NormalizedInput {
  const recordId = Uuid.safeParse(input.recordId)
  if (!recordId.success) invalid('/record_id', 'Invalid record id')
  let relationType: string | undefined
  if (input.relationType !== undefined) {
    const parsed = Slug.safeParse(input.relationType)
    if (!parsed.success) invalid('/relation_type', 'Invalid relation type slug')
    relationType = parsed.data
  }
  const direction = input.direction ?? 'both'
  if (direction !== 'from' && direction !== 'to' && direction !== 'both') {
    invalid('/direction', 'Direction must be from, to, or both')
  }
  if (input.includeHistory !== undefined && typeof input.includeHistory !== 'boolean') {
    invalid('/include_history', 'Include history must be boolean')
  }
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    invalid('/limit', 'Limit must be an integer from 1 to 200')
  }
  return {
    recordId: recordId.data,
    ...(relationType === undefined ? {} : { relationType }),
    direction,
    includeHistory: input.includeHistory ?? false,
    limit,
  }
}

function cursorMismatch(): ServiceError {
  return new ServiceError(ErrorCode.VALIDATION_FAILED, 'Link list cursor does not match', {
    detail: 'cursor_mismatch',
  })
}

function cursorBinding(ctx: ActorContext, input: NormalizedInput): Uint8Array {
  return encoder.encode(canonicalJson({
    format: purpose,
    tool: 'crm_links_list',
    tenant: ctx.tenant,
    arguments: {
      record_id: input.recordId,
      relation_type: input.relationType ?? null,
      direction: input.direction,
      include_history: input.includeHistory,
      limit: input.limit,
    },
  }))
}

function parseCursor(value: unknown): CursorState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw cursorMismatch()
  const entries = Object.entries(value)
  if (entries.length !== 2 || !Object.hasOwn(value, 'activeFrom') || !Object.hasOwn(value, 'id')) {
    throw cursorMismatch()
  }
  const activeFrom = Reflect.get(value, 'activeFrom')
  const id = Reflect.get(value, 'id')
  if (
    typeof activeFrom !== 'string'
    || !IsoDateTime.safeParse(activeFrom).success
    || typeof id !== 'string'
    || !Uuid.safeParse(id).success
  ) throw cursorMismatch()
  return { activeFrom, id }
}

function openCursor(
  secretBox: SecretBox,
  value: string | undefined,
  ctx: ActorContext,
  input: NormalizedInput,
): CursorState | undefined {
  if (value === undefined) return undefined
  if (value.length === 0) throw cursorMismatch()
  try {
    const plaintext = secretBox.open(value, purpose, cursorBinding(ctx, input))
    const decoded: unknown = JSON.parse(decoder.decode(plaintext))
    return parseCursor(decoded)
  } catch {
    throw cursorMismatch()
  }
}

function sealCursor(
  secretBox: SecretBox,
  state: CursorState,
  ctx: ActorContext,
  input: NormalizedInput,
): string {
  const parsed = parseCursor(state)
  return secretBox.seal(
    encoder.encode(canonicalJson(parsed)), purpose, cursorBinding(ctx, input),
  )
}

function afterCursor(entry: LinkEntry, cursor: CursorState | undefined): boolean {
  if (cursor === undefined) return true
  const activeFrom = entry.link.activeFrom.toISOString()
  return activeFrom < cursor.activeFrom || (activeFrom === cursor.activeFrom && entry.link.id < cursor.id)
}

function scopes(ctx: ActorContext, records: readonly RelatedRow[]): PolicyScopeRef[] {
  const values: PolicyScopeRef[] = [{ scope: 'team', id: ctx.tenant.teamId }]
  for (const record of records) {
    values.push({ scope: 'object_type', id: record.objectTypeId })
    values.push({ scope: 'record', id: record.id })
  }
  return [...new Map(values.map((scope) => [`${scope.scope}:${scope.id}`, scope])).values()]
}

function recordRequest(ctx: ActorContext, record: RelatedRow): PolicyRequest {
  return { resourceType: 'record', action: 'view', scopes: scopes(ctx, [record]) }
}

function linkRequest(ctx: ActorContext, anchor: RelatedRow, related: RelatedRow): PolicyRequest {
  return { resourceType: 'link', action: 'view', scopes: scopes(ctx, [anchor, related]) }
}

function attributeRequest(
  ctx: ActorContext,
  anchor: RelatedRow,
  related: RelatedRow,
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted',
): PolicyRequest {
  return {
    resourceType: 'attribute', action: 'view', scopes: scopes(ctx, [anchor, related]), sensitivity,
  }
}

function permitted(decision: PolicyDecision): boolean {
  return decision.allowed && !decision.requiresApproval
}

function relationForEntry(schema: LoadedSchema, entry: LinkEntry): LoadedRelationType | undefined {
  const relation = schema.relationTypesById.get(entry.link.relationTypeId)
  if (relation === undefined || relation.slug !== entry.link.relationType) return undefined
  return relation
}

function validatedEdgeData(relation: LoadedRelationType, entry: LinkEntry): Record<string, unknown> {
  const parsedSpecs = AttributeSpec.array().safeParse(relation.edgeAttributes)
  const stored = entry.link.data
  if (
    !parsedSpecs.success
    || typeof stored !== 'object'
    || stored === null
    || Array.isArray(stored)
  ) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Stored link data is invalid')
  }
  const specs = new Map(parsedSpecs.data.map((spec) => [spec.slug, spec]))
  if (Object.keys(stored).some((slug) => !specs.has(slug))) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Stored link data is invalid')
  }
  for (const [slug, value] of Object.entries(stored)) {
    const spec = specs.get(slug)
    if (spec === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Stored link data is invalid')
    const definition = getAttributeType(spec.type)
    const config = definition.configSchema.safeParse(Object.fromEntries(
      Object.entries(spec.config ?? {}).filter(([key]) => key !== 'type'),
    ))
    if (!config.success) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Stored link data is invalid')
    const valueSchema = spec.is_multi
      ? definition.valueSchema(config.data).array()
      : definition.valueSchema(config.data)
    if (!valueSchema.safeParse(value).success) {
      throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Stored link data is invalid')
    }
  }
  return stored
}

function redactedEdgeData(
  ctx: ActorContext,
  relation: LoadedRelationType,
  entry: LinkEntry,
  anchor: RelatedRow,
  related: RelatedRow,
  evaluator: PolicyEvaluator,
): Record<string, unknown> {
  const stored = validatedEdgeData(relation, entry)
  const specs = AttributeSpec.array().parse(relation.edgeAttributes)
  return Object.fromEntries(specs.flatMap((spec) => {
    const value = stored[spec.slug]
    if (value === undefined) return []
    const decision = evaluator.evaluate(attributeRequest(
      ctx, anchor, related, spec.sensitivity,
    ))
    return permitted(decision) ? [[spec.slug, value]] : []
  }))
}

async function deniedAnchor(
  deps: AppDeps,
  ctx: ActorContext,
  anchor: RelatedRow,
  decision: PolicyDecision,
): Promise<void> {
  if (permitted(decision)) return
  await deps.db.$transaction((tx) => deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action: 'crm_links_list',
    resourceType: 'record',
    resourceId: anchor.id,
    outcome: 'denied',
    reason: null,
    metadata: { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance },
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  }))
  throw new ServiceError(
    decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Link list is not permitted', { resource: 'record', action: 'view' },
  )
}

function linkOut(
  ctx: ActorContext,
  entry: LinkEntry,
  relation: LoadedRelationType,
  anchor: RelatedRow,
  related: RelatedRow,
  evaluator: PolicyEvaluator,
): ListedLinkOut {
  return {
    id: entry.link.id,
    relation_type: entry.link.relationType,
    from_record_id: entry.link.fromRecordId,
    to_record_id: entry.link.toRecordId,
    label: entry.link.label,
    data: redactedEdgeData(ctx, relation, entry, anchor, related, evaluator),
    active_from: entry.link.activeFrom.toISOString(),
    active_until: entry.link.activeUntil?.toISOString() ?? null,
  }
}

export async function listRecordLinks(
  deps: AppDeps,
  ctx: ActorContext,
  input: LinkListInput,
): Promise<LinkListResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const normalized = normalize(input)
    const anchorVisible = (await resolveVisibleRecord(deps.db, ctx, normalized.recordId)).record
    const anchorState = await deps.db.record.findFirst({
      where: { ...tenantWhere(ctx.tenant), id: anchorVisible.id },
      select: { id: true, objectTypeId: true, displayName: true, erasedAt: true },
    })
    if (anchorState === null || anchorState.erasedAt !== null) {
      throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
    }
    const anchor: RelatedRow = anchorState
    const cursor = openCursor(deps.secretBox, input.cursor, ctx, normalized)
    const schema = await loadSchema(deps.db, ctx.tenant)
    const entries = (await listLinks(deps.db, ctx, schema, {
      recordId: anchorVisible.id,
      ...(normalized.relationType === undefined ? {} : { relationType: normalized.relationType }),
      direction: normalized.direction,
      includeHistory: normalized.includeHistory,
    })).filter((entry) => afterCursor(entry, cursor))
    const visibleRelated = await findVisibleLiveRecords(
      deps.db, ctx, entries.map((entry) => entry.relatedRecordId),
    )
    const visibleIds = new Set(visibleRelated.map((record) => record.id))
    const relatedRows = visibleIds.size === 0 ? [] : await deps.db.record.findMany({
      where: {
        ...tenantWhere(ctx.tenant), id: { in: [...visibleIds] }, deletedAt: null,
        mergedIntoId: null, erasedAt: null,
      },
      select: { id: true, objectTypeId: true, displayName: true },
    })
    const relatedById = new Map(relatedRows.map((record) => [record.id, record]))
    const requests: PolicyRequest[] = [
      recordRequest(ctx, anchor),
      ...relatedRows.map((related) => recordRequest(ctx, related)),
      ...relatedRows.map((related) => linkRequest(ctx, anchor, related)),
      { resourceType: 'attribute', action: 'view', scopes: [{ scope: 'team', id: ctx.tenant.teamId }] },
    ]
    const evaluator = await loadPolicyEvaluator(deps.db, ctx, requests)
    await deniedAnchor(deps, ctx, anchor, evaluator.evaluate(recordRequest(ctx, anchor)))
    const visible = entries.flatMap((entry) => {
      const related = relatedById.get(entry.relatedRecordId)
      const relation = relationForEntry(schema, entry)
      if (related === undefined || relation === undefined) return []
      if (!permitted(evaluator.evaluate(recordRequest(ctx, related)))) return []
      if (!permitted(evaluator.evaluate(linkRequest(ctx, anchor, related)))) return []
      const objectType = schema.objectTypesById.get(related.objectTypeId)
      if (objectType === undefined) return []
      return [{
        link: linkOut(ctx, entry, relation, anchor, related, evaluator),
        related: { id: related.id, object_type: objectType.slug, display_name: related.displayName },
      }]
    })
    const links = visible.slice(0, normalized.limit)
    const last = links.at(-1)
    const nextCursor = visible.length <= normalized.limit || last === undefined
      ? null
      : sealCursor(deps.secretBox, {
        activeFrom: last.link.active_from,
        id: last.link.id,
      }, ctx, normalized)
    return { links, next_cursor: nextCursor }
  })
}
