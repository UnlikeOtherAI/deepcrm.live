import { tenantWhere, type Db } from '@deepcrm/db'
import {
  ErrorCode,
  ServiceError,
  type ActorContext,
} from '@deepcrm/schemas'
import {
  canSee,
  type InlineLinkAuthorizer,
  type InlineLinkInput,
  type LoadedSchema,
  type RecordTx,
  type ResolvedLinkOperation,
} from '@deepcrm/schema-engine'

import { assertLinkPolicies, linkPolicyRequests } from './links.js'
import { loadPolicyEvaluator, type PolicyEvaluator, type PolicyRequest } from './policy.js'
import type { VisibleRecord } from './record-visibility.js'

type InlineLinkTx = Pick<Db, 'record' | 'policyRule'>

export class InlineLinkPolicyError extends ServiceError {
  readonly inlineLinkPolicy = true
}

export function isInlineLinkPolicyError(error: unknown): error is InlineLinkPolicyError {
  return error instanceof InlineLinkPolicyError
}

function policyRequests(ctx: ActorContext): PolicyRequest[] {
  const scopes = [{ scope: 'team' as const, id: ctx.tenant.teamId }]
  return [
    { resourceType: 'record', action: 'link', scopes },
    { resourceType: 'link', action: 'link', scopes },
    { resourceType: 'attribute', action: 'edit', scopes, sensitivity: 'confidential' },
    { resourceType: 'attribute', action: 'edit', scopes, sensitivity: 'restricted' },
  ]
}

function activeRelation(schema: LoadedSchema, relationTypeId: string) {
  const relation = schema.relationTypesById.get(relationTypeId)
  if (relation === undefined || relation.archivedAt !== null) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Relation type is not active')
  }
  return relation
}

function relationBySlug(schema: LoadedSchema, slug: string) {
  const relation = schema.relationTypesBySlug.get(slug)
  if (relation === undefined || relation.archivedAt !== null) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Relation type is not active')
  }
  return relation
}

async function visibleRecords(
  tx: InlineLinkTx,
  ctx: ActorContext,
  ids: readonly string[],
): Promise<readonly VisibleRecord[]> {
  const unique = [...new Set(ids)]
  const rows = await tx.record.findMany({
    where: {
      ...tenantWhere(ctx.tenant), id: { in: unique }, deletedAt: null,
      mergedIntoId: null, erasedAt: null,
    },
    select: {
      id: true, objectTypeId: true, visibility: true, createdOnBehalfOf: true,
      visibilityGrants: { select: { uoaUserId: true } },
    },
  })
  if (rows.length !== unique.length || rows.some((row) => !canSee(ctx, row))) {
    throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  }
  const byId = new Map(rows.map((row) => [row.id, {
    id: row.id, objectTypeId: row.objectTypeId,
  }]))
  return unique.map((id) => {
    const record = byId.get(id)
    if (record === undefined) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
    return record
  })
}

export function asInlineLinkPolicyError(error: unknown): never {
  if (
    error instanceof ServiceError
    && (error.code === ErrorCode.POLICY_DENIED || error.code === ErrorCode.APPROVAL_REQUIRED)
  ) {
    throw new InlineLinkPolicyError(error.code, error.message, error.details)
  }
  throw error
}

function authorize(
  ctx: ActorContext,
  relation: LoadedSchema['relationTypes'][number],
  records: readonly VisibleRecord[],
  data: Record<string, unknown> | undefined,
  evaluator: PolicyEvaluator,
  wrapped: boolean,
): void {
  try {
    assertLinkPolicies(evaluator, linkPolicyRequests(ctx, relation, records, data))
  } catch (error) {
    if (wrapped) asInlineLinkPolicyError(error)
    throw error
  }
}

export async function preflightInlineLinks(
  tx: InlineLinkTx,
  ctx: ActorContext,
  schema: LoadedSchema,
  links: readonly InlineLinkInput[] | undefined,
  sourceRecordId?: string,
): Promise<void> {
  if (links === undefined || links.length === 0) return
  const evaluator = await loadPolicyEvaluator(tx, ctx, policyRequests(ctx))
  for (const link of links) {
    const relation = relationBySlug(schema, link.relationType)
    const records = await visibleRecords(
      tx,
      ctx,
      sourceRecordId === undefined ? [link.toRecordId] : [sourceRecordId, link.toRecordId],
    )
    await authorize(ctx, relation, records, link.data, evaluator, false)
  }
}

export async function reauthorizeAssertReplay(
  tx: InlineLinkTx,
  ctx: ActorContext,
  schema: LoadedSchema,
  recordId: string,
  created: boolean,
  links: readonly InlineLinkInput[] | undefined,
): Promise<void> {
  const [record] = await visibleRecords(tx, ctx, [recordId])
  if (record === undefined) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const scopes = [
    { scope: 'team' as const, id: ctx.tenant.teamId },
    { scope: 'object_type' as const, id: record.objectTypeId },
    { scope: 'record' as const, id: record.id },
  ]
  const action = created ? 'create' as const : 'edit' as const
  const evaluator = await loadPolicyEvaluator(tx, ctx, [{ resourceType: 'record', action, scopes }])
  const decision = evaluator.evaluate({ resourceType: 'record', action, scopes })
  if (!decision.allowed || decision.requiresApproval) {
    asInlineLinkPolicyError(new ServiceError(
      decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
      'Record operation is not permitted', { resource: 'record', action },
    ))
  }
  await preflightInlineLinks(tx, ctx, schema, links, recordId)
}

export async function createInlineLinkAuthorizer(
  tx: RecordTx & Pick<Db, 'policyRule'>,
  ctx: ActorContext,
  schema: LoadedSchema,
): Promise<InlineLinkAuthorizer> {
  let evaluator: Promise<PolicyEvaluator> | undefined
  return async (resolved: ResolvedLinkOperation, link: InlineLinkInput): Promise<void> => {
    const records = await visibleRecords(tx, ctx, resolved.endpointRecordIds)
    const relation = activeRelation(schema, resolved.relationTypeId)
    evaluator ??= loadPolicyEvaluator(tx, ctx, policyRequests(ctx))
    authorize(ctx, relation, records, link.data, await evaluator, true)
  }
}
