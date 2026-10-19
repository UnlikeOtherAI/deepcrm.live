import { tenantWhere, type Prisma } from '@deepcrm/db'
import { loadSchema, type LoadedAttribute, type LoadedObjectType, type LoadedSchema } from '@deepcrm/schema-engine'
import {
  ErrorCode,
  ServiceError,
  SourceRef,
  requireOnBehalfOf,
  type ActorContext,
  type CrmProposalsListInput,
  type CrmProposalsListOutput,
  type ProposalItem,
} from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { loadPolicyEvaluator, type PolicyEvaluator, type PolicyRequest, type PolicyScopeRef } from './policy.js'
import { MatchCandidates, PendingSubmission } from './proposal-store.js'
import { objectIdScopes } from './record-write-authorization.js'
import { visibleWhere } from './record-visibility.js'

type ProposalRow = Prisma.RecordProposalGetPayload<Record<string, never>>
type LiveRecord = { id: string; objectTypeId: string; displayName: string; version: number; data: Prisma.JsonValue }
type Cursor = { createdAt: string; id: string }

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): Cursor | null {
  if (cursor === undefined) return null
  const invalid = () => new ServiceError(ErrorCode.VALIDATION_FAILED, 'Cursor is invalid', { detail: 'cursor_invalid' })
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw invalid()
  }
  if (typeof decoded !== 'object' || decoded === null || !('createdAt' in decoded) || !('id' in decoded)) throw invalid()
  const { createdAt, id } = decoded
  if (typeof createdAt !== 'string' || typeof id !== 'string' || Number.isNaN(Date.parse(createdAt))) throw invalid()
  return { createdAt, id }
}

function liveVisible(ctx: ActorContext): Prisma.RecordWhereInput {
  return { ...visibleWhere(ctx), deletedAt: null, mergedIntoId: null, erasedAt: null }
}

function recordScopes(ctx: ActorContext, record: { id: string; objectTypeId: string }): PolicyScopeRef[] {
  return [...objectIdScopes(ctx, record.objectTypeId), { scope: 'record', id: record.id }]
}

function viewRequest(scopes: PolicyScopeRef[]): PolicyRequest {
  return { resourceType: 'record', action: 'view', scopes }
}

function attributeView(scopes: PolicyScopeRef[], attribute: LoadedAttribute): PolicyRequest {
  return { resourceType: 'attribute', action: 'view', scopes, sensitivity: attribute.sensitivity }
}

function allowed(evaluator: PolicyEvaluator, request: PolicyRequest): boolean {
  const decision = evaluator.evaluate(request)
  return decision.allowed && !decision.requiresApproval
}

function stored(record: LiveRecord, slug: string): unknown {
  const data = record.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  return data[slug] ?? null
}

function summary(schema: LoadedSchema, record: LiveRecord) {
  const objectType = schema.objectTypesById.get(record.objectTypeId)
  if (objectType === undefined) return null
  return { id: record.id, object_type: objectType.slug, display_name: record.displayName }
}

function common(row: ProposalRow, objectType: LoadedObjectType) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status === 'approved' || row.status === 'rejected' ? row.status : 'pending' as const,
    created_at: row.createdAt.toISOString(),
    source: SourceRef.parse({ kind: row.sourceKind, id: row.sourceId, name: row.sourceName }),
    object_type: objectType.slug,
    resolved_record_id: row.resolvedRecordId,
  }
}

type Context = {
  ctx: ActorContext
  schema: LoadedSchema
  evaluator: PolicyEvaluator
  records: ReadonlyMap<string, LiveRecord>
}

function amendment(context: Context, row: ProposalRow, objectType: LoadedObjectType): ProposalItem | null {
  const record = row.recordId === null ? undefined : context.records.get(row.recordId)
  const attribute = objectType.attributes.find((candidate) => candidate.slug === row.attributeSlug)
  if (record === undefined || attribute === undefined) return null
  const scopes = recordScopes(context.ctx, record)
  if (!allowed(context.evaluator, viewRequest(scopes))) return null
  const recordSummary = summary(context.schema, record)
  if (recordSummary === null) return null
  const visible = allowed(context.evaluator, attributeView(scopes, attribute))
  return {
    ...common(row, objectType),
    record: { ...recordSummary, version: record.version },
    attribute: { slug: attribute.slug, name: attribute.name, type: attribute.type, is_multi: attribute.isMulti },
    ...(visible ? { proposed_value: row.proposed, current_value: stored(record, attribute.slug) } : {}),
    redacted_attributes: visible ? [] : [attribute.slug],
  }
}

function match(context: Context, row: ProposalRow, objectType: LoadedObjectType): ProposalItem | null {
  const scopes = objectIdScopes(context.ctx, objectType.id)
  if (!allowed(context.evaluator, viewRequest(scopes))) return null
  const submission = PendingSubmission.parse(row.proposed)
  const submitted: Record<string, unknown> = {}
  const redacted: string[] = []
  for (const [slug, value] of Object.entries(submission.values).sort(([left], [right]) => left.localeCompare(right))) {
    const attribute = objectType.attributes.find((candidate) => candidate.slug === slug)
    if (attribute === undefined) continue
    if (allowed(context.evaluator, attributeView(scopes, attribute))) submitted[slug] = value
    else redacted.push(slug)
  }
  const candidates = MatchCandidates.parse(row.candidates).flatMap((candidate) => {
    const record = context.records.get(candidate.record_id)
    if (record === undefined || !allowed(context.evaluator, viewRequest(recordScopes(context.ctx, record)))) return []
    const recordSummary = summary(context.schema, record)
    return recordSummary === null ? [] : [{ record: recordSummary, matched_on: candidate.matched_on }]
  })
  return {
    ...common(row, objectType),
    record: null,
    attribute: null,
    candidates,
    submitted,
    activity: { subject: submission.activity.subject, occurred_at: submission.activity.occurred_at },
    redacted_attributes: redacted,
  }
}

function recordIds(rows: readonly ProposalRow[]): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.recordId !== null) ids.add(row.recordId)
    if (row.kind === 'match') for (const candidate of MatchCandidates.parse(row.candidates)) ids.add(candidate.record_id)
  }
  return [...ids]
}

// The evaluator loads rules by resource and action; scopes and sensitivity are decided per row.
function policyRequests(ctx: ActorContext): PolicyRequest[] {
  const team: PolicyScopeRef[] = [{ scope: 'team', id: ctx.tenant.teamId }]
  return [viewRequest(team), { resourceType: 'attribute', action: 'view', scopes: team }]
}

/**
 * Lists record proposals a submission left (schema-engine §4d″), oldest
 * first: an amendment to a record the caller can see, with the proposed and
 * the current value (absent when the attribute is redacted for them), or an
 * unresolved match with the visible candidates and the submitted values.
 */
export async function listProposals(
  deps: AppDeps, ctx: ActorContext, input: CrmProposalsListInput,
): Promise<CrmProposalsListOutput> {
  requireOnBehalfOf(ctx)
  const cursor = decodeCursor(input.cursor)
  const schema = await loadSchema(deps.db, ctx.tenant)
  const rows = await deps.db.recordProposal.findMany({
    where: {
      ...tenantWhere(ctx.tenant),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.record_id === undefined ? {} : { recordId: input.record_id }),
      ...(input.source_id === undefined ? {} : { sourceId: input.source_id }),
      OR: [{ kind: 'match' }, { record: { is: liveVisible(ctx) } }],
      ...(cursor === null ? {} : {
        AND: [{ OR: [
          { createdAt: { gt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { gt: cursor.id } },
        ] }],
      }),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: input.limit + 1,
  })
  const page = rows.slice(0, input.limit)
  const records = await deps.db.record.findMany({
    where: { ...liveVisible(ctx), id: { in: recordIds(page) } },
    select: { id: true, objectTypeId: true, displayName: true, version: true, data: true },
  })
  const context: Context = {
    ctx, schema,
    evaluator: await loadPolicyEvaluator(deps.db, ctx, policyRequests(ctx)),
    records: new Map(records.map((record) => [record.id, record])),
  }
  const proposals = page.flatMap((row) => {
    const objectType = schema.objectTypesById.get(row.objectTypeId)
    if (objectType === undefined) return []
    const item = row.kind === 'amendment' ? amendment(context, row, objectType) : match(context, row, objectType)
    return item === null ? [] : [item]
  })
  const last = page.at(-1)
  return { proposals, next_cursor: rows.length > input.limit && last !== undefined ? encodeCursor(last) : null }
}
