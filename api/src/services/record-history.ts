import { tenantWhere, type Prisma } from '@deepcrm/db'
import {
  recordAt as engineRecordAt,
  recordHistory as engineRecordHistory,
  type HistoricalChange,
  type RecordAtResult,
} from '@deepcrm/schema-engine'
import {
  AttributeSpec,
  ErrorCode,
  IsoDateTime,
  ServiceError,
  Slug,
  Uuid,
  type ActorContext,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import type { HistoryCursorBinding } from './history-cursor.js'
import {
  loadPolicyEvaluator,
  type PolicyDecision,
  type PolicyEvaluator,
  type PolicyRequest,
  type PolicyScopeRef,
} from './policy.js'
import { recordBoundary } from './record-boundary.js'
import {
  findVisibleLiveRecords,
  requireVisibleRecord,
  type VisibleRecord,
} from './record-visibility.js'

type CurrentAttribute = {
  slug: string
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'
}

type CurrentLinkAttribute = CurrentAttribute & { relationType: string }

export type HistoryAccess = {
  visibleAttributeSlugs: ReadonlySet<string>
  visibleLinkDataSlugsByRelationType: ReadonlyMap<string, ReadonlySet<string>>
  visibleLinkedRecordIds: ReadonlySet<string>
}

export type RecordAtServiceInput = {
  recordId: string
  at: string | Date
}

export type RecordAtServiceResult = {
  record_at: RecordAtResult
}

export type RecordHistoryServiceInput = {
  recordId: string
  attributes?: readonly string[]
  cursor?: string
  limit?: number
}

export type RecordHistoryServiceResult = {
  changes: readonly HistoricalChange[]
  next_cursor: string | null
}

type NormalizedHistoryInput = {
  recordId: string
  attributes?: readonly string[]
  cursor?: string
  limit: number
}

function invalid(path: string, message: string): never {
  throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Record history arguments are invalid', {
    issues: [{ path, message }],
  })
}

function recordId(value: string): string {
  const parsed = Uuid.safeParse(value)
  if (!parsed.success) invalid('/id', 'Invalid record id')
  return parsed.data
}

function historyInput(input: RecordHistoryServiceInput): NormalizedHistoryInput {
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    invalid('/limit', 'Limit must be an integer from 1 to 200')
  }
  let attributes: readonly string[] | undefined
  if (input.attributes !== undefined) {
    const parsed = Slug.array().safeParse(input.attributes)
    if (!parsed.success) invalid('/attributes', 'Attributes must contain valid slugs')
    attributes = [...new Set(parsed.data)].sort()
  }
  return {
    recordId: recordId(input.recordId),
    ...(attributes === undefined ? {} : { attributes }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    limit,
  }
}

function historyTime(value: string | Date): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) invalid('/at', 'Invalid history timestamp')
    return value
  }
  const parsed = IsoDateTime.safeParse(value)
  if (!parsed.success) invalid('/at', 'History timestamp must be ISO 8601 with an offset')
  return new Date(parsed.data)
}

function scopes(ctx: ActorContext, record: VisibleRecord): PolicyScopeRef[] {
  return [
    { scope: 'team', id: ctx.tenant.teamId },
    { scope: 'object_type', id: record.objectTypeId },
    { scope: 'record', id: record.id },
  ]
}

function attributeRequest(
  policyScopes: PolicyScopeRef[],
  attribute: CurrentAttribute,
): PolicyRequest {
  return {
    resourceType: 'attribute',
    action: 'view',
    scopes: policyScopes,
    sensitivity: attribute.sensitivity,
  }
}

function recordRequest(policyScopes: PolicyScopeRef[]): PolicyRequest {
  return { resourceType: 'record', action: 'view', scopes: policyScopes }
}

function auditMetadata(ctx: ActorContext): Prisma.InputJsonObject {
  return { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance }
}

async function writeDeniedAudit(
  deps: AppDeps,
  ctx: ActorContext,
  tool: 'crm_record_at' | 'crm_record_history' | 'crm_record_timeline',
  record: VisibleRecord,
): Promise<void> {
  await deps.db.$transaction((tx) => deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action: tool,
    resourceType: 'record',
    resourceId: record.id,
    outcome: 'denied',
    reason: null,
    metadata: auditMetadata(ctx),
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  }))
}

function rejection(decisions: readonly { request: PolicyRequest; decision: PolicyDecision }[]) {
  return decisions.find(({ decision }) => !decision.allowed && !decision.requiresApproval)
    ?? decisions.find(({ decision }) => !decision.allowed || decision.requiresApproval)
}

async function authorizeRecord(
  deps: AppDeps,
  ctx: ActorContext,
  tool: 'crm_record_at' | 'crm_record_history' | 'crm_record_timeline',
  record: VisibleRecord,
  request: PolicyRequest,
  evaluator: PolicyEvaluator,
): Promise<void> {
  const rejected = rejection([{ request, decision: evaluator.evaluate(request) }])
  if (rejected === undefined) return
  await writeDeniedAudit(deps, ctx, tool, record)
  throw new ServiceError(
    rejected.decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Record history is not permitted',
    { resource: rejected.request.resourceType, action: rejected.request.action },
  )
}

async function currentAttributes(
  deps: AppDeps,
  ctx: ActorContext,
  record: VisibleRecord,
): Promise<readonly CurrentAttribute[]> {
  return deps.db.attribute.findMany({
    where: { ...tenantWhere(ctx.tenant), objectTypeId: record.objectTypeId },
    select: { slug: true, sensitivity: true },
    orderBy: { slug: 'asc' },
  })
}

async function currentLinkAttributes(
  deps: AppDeps,
  ctx: ActorContext,
): Promise<readonly CurrentLinkAttribute[]> {
  const relations = await deps.db.relationType.findMany({
    where: tenantWhere(ctx.tenant),
    select: { slug: true, edgeAttributes: true },
    orderBy: { slug: 'asc' },
  })
  return relations.flatMap((relation) => AttributeSpec.array().parse(relation.edgeAttributes)
    .map((attribute) => ({
      relationType: relation.slug,
      slug: attribute.slug,
      sensitivity: attribute.sensitivity,
    })))
}

async function currentLinkedRecords(
  deps: AppDeps,
  ctx: ActorContext,
  recordIdValue: string,
): Promise<readonly VisibleRecord[]> {
  const links = await deps.db.recordLink.findMany({
    where: {
      ...tenantWhere(ctx.tenant),
      OR: [{ fromRecordId: recordIdValue }, { toRecordId: recordIdValue }],
    },
    select: { fromRecordId: true, toRecordId: true },
  })
  const relatedIds = links.map((link) => (
    link.fromRecordId === recordIdValue ? link.toRecordId : link.fromRecordId
  ))
  return findVisibleLiveRecords(deps.db, ctx, relatedIds)
}

function requestedAttributes(
  available: readonly CurrentAttribute[],
  requested: readonly string[] | undefined,
): readonly CurrentAttribute[] {
  if (requested === undefined) return available
  const bySlug = new Map(available.map((attribute) => [attribute.slug, attribute]))
  return requested.map((slug) => {
    const attribute = bySlug.get(slug)
    if (attribute === undefined) {
      throw new ServiceError(ErrorCode.UNKNOWN_ATTRIBUTE, 'Attribute does not exist', {
        attribute: slug,
      })
    }
    return attribute
  })
}

function visibleAttributes(
  evaluator: PolicyEvaluator,
  policyScopes: PolicyScopeRef[],
  attributes: readonly CurrentAttribute[],
): ReadonlySet<string> {
  return new Set(attributes.flatMap((attribute) => {
    const decision = evaluator.evaluate(attributeRequest(policyScopes, attribute))
    return decision.allowed && !decision.requiresApproval ? [attribute.slug] : []
  }))
}

function visibleLinkAttributes(
  evaluator: PolicyEvaluator,
  policyScopes: PolicyScopeRef[],
  attributes: readonly CurrentLinkAttribute[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const visible = new Map<string, Set<string>>()
  for (const attribute of attributes) {
    if (!visible.has(attribute.relationType)) visible.set(attribute.relationType, new Set())
    const decision = evaluator.evaluate(attributeRequest(policyScopes, attribute))
    if (decision.allowed && !decision.requiresApproval) {
      visible.get(attribute.relationType)?.add(attribute.slug)
    }
  }
  return visible
}

export async function buildHistoryAccess(
  deps: AppDeps,
  ctx: ActorContext,
  tool: 'crm_record_at' | 'crm_record_history' | 'crm_record_timeline',
  id: string,
  requested?: readonly string[],
): Promise<HistoryAccess> {
  const record = await requireVisibleRecord(deps.db, ctx, id)
  const [attributes, linkAttributes, linkedRecords] = await Promise.all([
    currentAttributes(deps, ctx, record),
    currentLinkAttributes(deps, ctx),
    currentLinkedRecords(deps, ctx, record.id),
  ])
  const selected = requestedAttributes(attributes, requested)
  const policyScopes = scopes(ctx, record)
  const viewRecord = recordRequest(policyScopes)
  const requests = [
    viewRecord,
    ...selected.map((attribute) => attributeRequest(policyScopes, attribute)),
    ...linkAttributes.map((attribute) => attributeRequest(policyScopes, attribute)),
    ...linkedRecords.map((linked) => recordRequest(scopes(ctx, linked))),
  ]
  const evaluator = await loadPolicyEvaluator(deps.db, ctx, requests)
  await authorizeRecord(deps, ctx, tool, record, viewRecord, evaluator)
  if (requested !== undefined) {
    const denied = rejection(selected.map((attribute) => {
      const request = attributeRequest(policyScopes, attribute)
      return { request, decision: evaluator.evaluate(request) }
    }))
    if (denied !== undefined) {
      await writeDeniedAudit(deps, ctx, tool, record)
      throw new ServiceError(
        denied.decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
        'Record history attribute is not permitted',
        { resource: denied.request.resourceType, action: denied.request.action },
      )
    }
  }
  return {
    visibleAttributeSlugs: visibleAttributes(evaluator, policyScopes, attributes),
    visibleLinkDataSlugsByRelationType: visibleLinkAttributes(
      evaluator, policyScopes, linkAttributes,
    ),
    visibleLinkedRecordIds: new Set(linkedRecords.flatMap((linked) => {
      const decision = evaluator.evaluate(recordRequest(scopes(ctx, linked)))
      return decision.allowed && !decision.requiresApproval ? [linked.id] : []
    })),
  }
}

function binding(ctx: ActorContext, input: NormalizedHistoryInput): HistoryCursorBinding {
  return {
    tool: 'crm_record_history',
    tenant: ctx.tenant,
    arguments: {
      id: input.recordId,
      attributes: input.attributes ?? null,
      limit: input.limit,
    },
  }
}

export async function recordAt(
  deps: AppDeps,
  ctx: ActorContext,
  input: RecordAtServiceInput,
): Promise<RecordAtServiceResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const id = recordId(input.recordId)
    const at = historyTime(input.at)
    const visibility = await buildHistoryAccess(deps, ctx, 'crm_record_at', id)
    const result = await engineRecordAt(deps.db, ctx.tenant, id, at, visibility)
    return { record_at: result }
  })
}

export async function recordHistory(
  deps: AppDeps,
  ctx: ActorContext,
  input: RecordHistoryServiceInput,
): Promise<RecordHistoryServiceResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    const normalized = historyInput(input)
    const cursorBinding = binding(ctx, normalized)
    const after = normalized.cursor === undefined
      ? undefined
      : deps.historyCursor.open(normalized.cursor, cursorBinding)
    const visibility = await buildHistoryAccess(
      deps, ctx, 'crm_record_history', normalized.recordId, normalized.attributes,
    )
    const page = await engineRecordHistory(deps.db, ctx.tenant, {
      recordId: normalized.recordId,
      ...(normalized.attributes === undefined ? {} : { attributes: normalized.attributes }),
      ...(after === undefined ? {} : { after }),
      limit: normalized.limit,
      ...visibility,
    })
    return {
      changes: page.changes,
      next_cursor: page.next === null ? null : deps.historyCursor.seal(page.next, cursorBinding),
    }
  })
}
