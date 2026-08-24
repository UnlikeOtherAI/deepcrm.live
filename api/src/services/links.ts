import {
  tenantWhere,
  type Db,
  type Prisma,
} from '@deepcrm/db'
import { enqueue, type QueueEnqueueTx } from '@deepcrm/queue'
import {
  linkRecords as engineLinkRecords,
  loadSchema,
  unlinkRecords as engineUnlinkRecords,
  writeChanges,
  type LinkInput,
  type LinkOperationResult,
  type LoadedSchema,
  type RecordTx,
  type ResolvedLinkOperation,
} from '@deepcrm/schema-engine'
import { AttributeSpec, ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import {
  linkArgumentHash,
  reserveLinkReplay,
  storeLinkReplay,
  type LinkDescriptor,
} from './link-idempotency.js'
import { presentLink, type PublicLink } from './link-presenter.js'
import { checkPolicy, type PolicyEvaluator, type PolicyRequest, type PolicyScopeRef } from './policy.js'
import { recordBoundary } from './record-boundary.js'
import { findVisibleRecord, requireVisibleRecord, type VisibleRecord } from './record-visibility.js'

type LinkServiceTx = RecordTx & QueueEnqueueTx & Pick<Db, 'webhook'>
type CommonInput = { idempotencyKey?: string; reason?: string }
export type LinkRecordsServiceInput = LinkInput & CommonInput
type UnlinkById = {
  linkId: string; relationType?: never; fromRecordId?: never; toRecordId?: never
}
type UnlinkByTriple = {
  linkId?: never; relationType: string; fromRecordId: string; toRecordId: string
}
export type UnlinkRecordsServiceInput = (UnlinkById | UnlinkByTriple) & CommonInput

export type LinkServiceResult = {
  link: PublicLink
  ended_links: string[]
  changed: boolean
}

type ResolvedTarget = {
  relationType: string
  fromRecordId: string
  toRecordId: string
  linkId: string | null
}

async function serviceResult(
  tx: LinkServiceTx,
  ctx: ActorContext,
  result: LinkOperationResult,
): Promise<LinkServiceResult> {
  return {
    link: await presentLink(tx, ctx, result.link.id),
    ended_links: [...result.endedLinks],
    changed: result.changes.length > 0,
  }
}

function auditMetadata(ctx: ActorContext): Prisma.InputJsonObject {
  return { app: ctx.app, actChain: ctx.actChain, provenance: ctx.provenance }
}

async function writeDeniedAudit(
  deps: AppDeps,
  ctx: ActorContext,
  descriptor: LinkDescriptor,
): Promise<void> {
  await deps.db.$transaction((tx) => deps.writeAudit(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    onBehalfOf: ctx.onBehalfOf.uoaUserId,
    action: descriptor.tool,
    resourceType: 'link',
    resourceId: descriptor.resourceId,
    outcome: 'denied',
    reason: descriptor.reason ?? null,
    metadata: auditMetadata(ctx),
    requestId: ctx.requestId,
    ipAddress: null,
    userAgent: null,
  }))
}

async function authorize(
  deps: AppDeps,
  ctx: ActorContext,
  descriptor: LinkDescriptor,
  requests: readonly PolicyRequest[],
): Promise<void> {
  const checked = await Promise.all(requests.map(async (request) => ({
    request,
    decision: await checkPolicy(deps.db, ctx, request),
  })))
  const hardDenied = checked.find(({ decision }) => !decision.allowed && !decision.requiresApproval)
  const rejected = hardDenied ?? checked.find(({ decision }) => (
    !decision.allowed || decision.requiresApproval
  ))
  if (rejected === undefined) return
  await writeDeniedAudit(deps, ctx, descriptor)
  throw new ServiceError(
    rejected.decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Link operation is not permitted',
    { resource: rejected.request.resourceType, action: rejected.request.action },
  )
}

function scopes(ctx: ActorContext, records: readonly VisibleRecord[]): PolicyScopeRef[] {
  const values: PolicyScopeRef[] = [{ scope: 'team', id: ctx.tenant.teamId }]
  for (const record of records) {
    values.push({ scope: 'object_type', id: record.objectTypeId })
    values.push({ scope: 'record', id: record.id })
  }
  const unique = new Map(values.map((value) => [`${value.scope}:${value.id}`, value]))
  return [...unique.values()]
}

function sensitiveRequests(
  relation: LoadedSchema['relationTypes'][number],
  data: Record<string, unknown> | undefined,
  policyScopes: PolicyScopeRef[],
): PolicyRequest[] {
  if (data === undefined) return []
  const specs = AttributeSpec.array().parse(relation.edgeAttributes)
  const sensitivities = new Set(specs.filter((spec) => (
    Object.hasOwn(data, spec.slug)
    && (spec.sensitivity === 'confidential' || spec.sensitivity === 'restricted')
  )).map((spec) => spec.sensitivity))
  return [...sensitivities].sort().map((sensitivity) => ({
    resourceType: 'attribute', action: 'edit', scopes: policyScopes, sensitivity,
  }))
}

function relationBySlug(
  schema: LoadedSchema,
  slug: string,
): LoadedSchema['relationTypes'][number] {
  const relation = schema.relationTypesBySlug.get(slug)
  if (relation === undefined || relation.archivedAt !== null) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Relation type is not active')
  }
  return relation
}

export function linkPolicyRequests(
  ctx: ActorContext,
  relation: LoadedSchema['relationTypes'][number],
  records: readonly VisibleRecord[],
  data: Record<string, unknown> | undefined,
): PolicyRequest[] {
  const policyScopes = scopes(ctx, records)
  return [
    ...records.map((record) => ({
      resourceType: 'record' as const,
      action: 'link' as const,
      scopes: scopes(ctx, [record]),
    })),
    { resourceType: 'link', action: 'link', scopes: policyScopes },
    ...sensitiveRequests(relation, data, policyScopes),
  ]
}

export function assertLinkPolicies(
  evaluator: PolicyEvaluator,
  requests: readonly PolicyRequest[],
): void {
  const decisions = requests.map((request) => ({ request, decision: evaluator.evaluate(request) }))
  const denied = decisions.find(({ decision }) => !decision.allowed && !decision.requiresApproval)
    ?? decisions.find(({ decision }) => !decision.allowed || decision.requiresApproval)
  if (denied === undefined) return
  throw new ServiceError(
    denied.decision.requiresApproval ? ErrorCode.APPROVAL_REQUIRED : ErrorCode.POLICY_DENIED,
    'Link operation is not permitted', { resource: denied.request.resourceType, action: denied.request.action },
  )
}

async function authorizeResolved(
  deps: AppDeps,
  ctx: ActorContext,
  schema: LoadedSchema,
  descriptor: LinkDescriptor,
  resolved: ResolvedLinkOperation,
  data: Record<string, unknown> | undefined,
): Promise<void> {
  const records = await Promise.all(resolved.endpointRecordIds.map((id) => (
    requireVisibleRecord(deps.db, ctx, id)
  )))
  const relation = schema.relationTypesById.get(resolved.relationTypeId)
  if (relation === undefined) {
    throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Relation type is not active')
  }
  await authorize(deps, ctx, descriptor, linkPolicyRequests(ctx, relation, records, data))
}

async function enqueueChanges(
  tx: LinkServiceTx,
  ctx: ActorContext,
  touchedRecordIds: readonly string[],
  lastSeq: number,
): Promise<void> {
  for (const recordId of touchedRecordIds) {
    await enqueue(tx, {
      organizationId: ctx.tenant.organizationId,
      teamId: ctx.tenant.teamId,
      type: 'record.reindex',
      payload: { organizationId: ctx.tenant.organizationId, teamId: ctx.tenant.teamId, recordId },
      idempotencyKey: `reindex:${recordId}:${lastSeq}`,
      priority: 100,
    })
  }
  const activeWebhooks = await tx.webhook.count({
    where: { ...tenantWhere(ctx.tenant), active: true },
  })
  if (activeWebhooks === 0) return
  const bucket = Math.floor(ctx.now.getTime() / 30_000)
  await enqueue(tx, {
    organizationId: ctx.tenant.organizationId,
    teamId: ctx.tenant.teamId,
    type: 'change.deliver',
    payload: { organizationId: ctx.tenant.organizationId, teamId: ctx.tenant.teamId },
    idempotencyKey: `deliver:${ctx.tenant.teamId}:${bucket}`,
    visibleAt: new Date(ctx.now.getTime() + 30_000),
    priority: 100,
  })
}

async function runWrite(
  deps: AppDeps,
  ctx: ActorContext,
  descriptor: LinkDescriptor,
  operation: (tx: LinkServiceTx) => Promise<LinkOperationResult>,
): Promise<LinkServiceResult> {
  const hash = linkArgumentHash(descriptor.args)
  return deps.db.$transaction(async (tx) => {
    const serviceTx: LinkServiceTx = tx
    const reservation = await reserveLinkReplay(serviceTx, ctx, descriptor, hash)
    if (reservation.kind === 'replay') return reservation.result
    const engineResult = await operation(serviceTx)
    const result = await serviceResult(serviceTx, ctx, engineResult)
    const changes = engineResult.changes.map((change) => ({
      ...change,
      reason: descriptor.reason ?? change.reason,
    }))
    const sequences = await writeChanges(serviceTx, ctx, changes)
    const lastSeq = sequences.at(-1)
    if (lastSeq !== undefined) {
      await enqueueChanges(serviceTx, ctx, engineResult.touchedRecordIds, lastSeq)
    }
    await storeLinkReplay(serviceTx, ctx, reservation, result)
    if (lastSeq === undefined) return result
    await deps.writeAudit(serviceTx, {
      organizationId: ctx.tenant.organizationId,
      teamId: ctx.tenant.teamId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      onBehalfOf: ctx.onBehalfOf.uoaUserId,
      action: descriptor.tool,
      resourceType: 'link',
      resourceId: result.link.id,
      outcome: 'success',
      reason: descriptor.reason ?? null,
      metadata: auditMetadata(ctx),
      requestId: ctx.requestId,
      ipAddress: null,
      userAgent: null,
    })
    return result
  })
}

async function resolveUnlinkTarget(
  deps: AppDeps,
  ctx: ActorContext,
  input: UnlinkRecordsServiceInput,
): Promise<ResolvedTarget> {
  if (input.linkId === undefined) {
    return {
      relationType: input.relationType,
      fromRecordId: input.fromRecordId,
      toRecordId: input.toRecordId,
      linkId: null,
    }
  }
  const link = await deps.db.recordLink.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: input.linkId },
    select: {
      id: true,
      fromRecordId: true,
      toRecordId: true,
      relationType: { select: { slug: true } },
    },
  })
  if (link === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Link not found')
  return {
    relationType: link.relationType.slug,
    fromRecordId: link.fromRecordId,
    toRecordId: link.toRecordId,
    linkId: link.id,
  }
}

async function redactInvisibleCardinality(
  deps: AppDeps,
  ctx: ActorContext,
  error: unknown,
): Promise<never> {
  if (!(error instanceof ServiceError) || error.code !== ErrorCode.CARDINALITY_VIOLATION) {
    throw error
  }
  const linkId = error.details['link_id']
  if (typeof linkId !== 'string') throw error
  const link = await deps.db.recordLink.findFirst({
    where: { ...tenantWhere(ctx.tenant), id: linkId },
    select: { fromRecordId: true, toRecordId: true },
  })
  if (link === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  const visible = await Promise.all([
    findVisibleRecord(deps.db, ctx, link.fromRecordId),
    findVisibleRecord(deps.db, ctx, link.toRecordId),
  ])
  if (visible.some((record) => record === null)) {
    throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  }
  throw error
}

export function linkRecords(
  deps: AppDeps,
  ctx: ActorContext,
  input: LinkRecordsServiceInput,
): Promise<LinkServiceResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    try {
      const [schema, from, to] = await Promise.all([
        loadSchema(deps.db, ctx.tenant),
        requireVisibleRecord(deps.db, ctx, input.fromRecordId),
        requireVisibleRecord(deps.db, ctx, input.toRecordId),
      ])
      const { idempotencyKey, reason, ...engineInput } = input
      const descriptor: LinkDescriptor = {
        tool: 'crm_link',
        args: {
          relationType: input.relationType,
          fromRecordId: input.fromRecordId,
          toRecordId: input.toRecordId,
          ...(input.data === undefined ? {} : { data: input.data }),
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(reason === undefined ? {} : { reason }),
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        },
        idempotencyKey,
        reason,
        resourceId: null,
      }
      const relation = relationBySlug(schema, input.relationType)
      const initialRecords = [from, to]
      await authorize(deps, ctx, descriptor, linkPolicyRequests(
        ctx, relation, initialRecords, input.data,
      ))
      return runWrite(deps, ctx, descriptor, (tx) => engineLinkRecords(
        tx,
        ctx,
        schema,
        engineInput,
        (resolved) => authorizeResolved(
          deps, ctx, schema, descriptor, resolved, input.data,
        ),
      ))
    } catch (error) {
      return redactInvisibleCardinality(deps, ctx, error)
    }
  })
}

export function unlinkRecords(
  deps: AppDeps,
  ctx: ActorContext,
  input: UnlinkRecordsServiceInput,
): Promise<LinkServiceResult> {
  return recordBoundary(deps.db, deps.ids, ctx, async () => {
    try {
      const target = await resolveUnlinkTarget(deps, ctx, input)
      const [schema, from, to] = await Promise.all([
        loadSchema(deps.db, ctx.tenant),
        requireVisibleRecord(deps.db, ctx, target.fromRecordId),
        requireVisibleRecord(deps.db, ctx, target.toRecordId),
      ])
      const descriptor: LinkDescriptor = {
        tool: 'crm_unlink',
        args: {
          ...(input.linkId === undefined
            ? {
                relationType: input.relationType,
                fromRecordId: input.fromRecordId,
                toRecordId: input.toRecordId,
              }
            : { linkId: input.linkId }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        },
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
        resourceId: target.linkId,
      }
      const relation = relationBySlug(schema, target.relationType)
      const initialRecords = [from, to]
      await authorize(
        deps,
        ctx,
        descriptor,
        linkPolicyRequests(ctx, relation, initialRecords, undefined),
      )
      return runWrite(deps, ctx, descriptor, (tx) => engineUnlinkRecords(
        tx,
        ctx,
        schema,
        target.relationType,
        target.fromRecordId,
        target.toRecordId,
        (resolved) => authorizeResolved(
          deps, ctx, schema, descriptor, resolved, undefined,
        ),
      ))
    } catch (error) {
      return redactInvisibleCardinality(deps, ctx, error)
    }
  })
}
