import { createHash } from 'node:crypto'

import { canonicalJson, tenantWhere, type Db, type Prisma } from '@deepcrm/db'
import { canonicalJsonValue, type JsonValue } from '@deepcrm/schema-engine'
import { ErrorCode, ServiceError, type ActorContext, type SourceRef } from '@deepcrm/schemas'

import { z } from 'zod'

import type { PairChange } from './intake-submission.js'

/**
 * Proposals a submission leaves for a person (schema-engine §4d″). Both caps
 * bound what public input can queue: a submission that would pass one is
 * refused with `LIMIT_EXCEEDED` whole, never partly stored.
 */
export const MAX_PENDING_PER_RECORD = 25
export const MAX_PENDING_PER_TEAM = 1_000

type ProposalTx = Pick<Db, 'recordProposal'>

/** Who proposed, through which source, about which type — the same for every row of one submission. */
export type ProposalOrigin = {
  source: SourceRef
  requester: { type: 'human' | 'agent' | 'system'; id: string }
  requestId: string
  objectTypeId: string
}

export type MatchCandidate = { record_id: string; matched_on: Array<'email' | 'phone'> }

/**
 * What a pending match holds: the normalised email and phone, the validated
 * mapped data, every value by attribute slug (what a reader is shown), and
 * the activity and note a resolution logs.
 */
export const PendingSubmission = z.object({
  email: z.string().optional(),
  phone: z.string().optional(),
  data: z.record(z.unknown()),
  values: z.record(z.unknown()),
  activity: z.object({
    kind: z.enum(['message', 'custom']), occurred_at: z.string(), subject: z.string(), body: z.string().optional(),
  }).strict(),
  note: z.object({ title: z.string().optional(), body: z.string() }).strict().nullable(),
}).strict()
export type PendingSubmission = z.infer<typeof PendingSubmission>

export const MatchCandidates = z.array(z.object({
  record_id: z.string().uuid(), matched_on: z.array(z.enum(['email', 'phone'])),
}).strict())

function hash(value: Prisma.InputJsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function inputJson(value: JsonValue): Prisma.InputJsonValue | null {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(inputJson)
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, inputJson(item)]))
}

function json(value: unknown): Prisma.InputJsonValue {
  const converted = inputJson(canonicalJsonValue(value))
  if (converted === null) throw new ServiceError(ErrorCode.INTERNAL, 'Proposal value is empty')
  return converted
}

function columns(ctx: ActorContext, origin: ProposalOrigin) {
  return {
    ...tenantWhere(ctx.tenant),
    objectTypeId: origin.objectTypeId,
    sourceKind: origin.source.kind,
    sourceId: origin.source.id,
    sourceName: origin.source.name,
    requesterType: origin.requester.type,
    requesterId: origin.requester.id,
    requestId: origin.requestId,
  }
}

function limitExceeded(limit: number, scope: 'team' | 'record'): ServiceError {
  return new ServiceError(ErrorCode.LIMIT_EXCEEDED, 'Too many pending proposals', { limit, scope })
}

async function assertRoom(tx: ProposalTx, ctx: ActorContext, recordId: string | null, adding: number): Promise<void> {
  if (adding === 0) return
  const pending = { ...tenantWhere(ctx.tenant), status: 'pending' as const }
  const team = await tx.recordProposal.count({ where: pending })
  if (team + adding > MAX_PENDING_PER_TEAM) throw limitExceeded(MAX_PENDING_PER_TEAM, 'team')
  if (recordId === null) return
  const record = await tx.recordProposal.count({ where: { ...pending, recordId } })
  if (record + adding > MAX_PENDING_PER_RECORD) throw limitExceeded(MAX_PENDING_PER_RECORD, 'record')
}

/**
 * Stores one pending amendment per real change, skipping a change the record
 * already has pending with the same value. Runs under the record's lock, so
 * the skip and the caps hold. Answers how many were stored.
 */
export async function proposeAmendments(
  tx: ProposalTx, ctx: ActorContext, origin: ProposalOrigin, recordId: string, amendments: readonly PairChange[],
): Promise<number> {
  const rows: Prisma.RecordProposalCreateManyInput[] = []
  for (const amendment of amendments) {
    const proposed = json(amendment.value)
    const proposedHash = hash({ attribute: amendment.attribute.slug, value: proposed })
    const existing = await tx.recordProposal.findFirst({
      where: { ...tenantWhere(ctx.tenant), recordId, attributeSlug: amendment.attribute.slug, proposedHash, status: 'pending' },
      select: { id: true },
    })
    if (existing !== null || rows.some((row) => row.proposedHash === proposedHash)) continue
    rows.push({
      ...columns(ctx, origin), kind: 'amendment', recordId, attributeSlug: amendment.attribute.slug,
      proposed, proposedHash,
    })
  }
  await assertRoom(tx, ctx, recordId, rows.length)
  if (rows.length > 0) await tx.recordProposal.createMany({ data: rows })
  return rows.length
}

/**
 * Stores a pending match — the validated submission and the people its email
 * and phone point at — unless the same submission from the same source is
 * already pending. Answers the proposal id.
 */
export async function proposeMatch(
  tx: ProposalTx, ctx: ActorContext, origin: ProposalOrigin, submission: PendingSubmission,
  candidates: readonly MatchCandidate[],
): Promise<string> {
  const proposed = json(submission)
  const proposedHash = hash({ source: [origin.source.kind, origin.source.id], submission: proposed })
  const existing = await tx.recordProposal.findFirst({
    where: { ...tenantWhere(ctx.tenant), kind: 'match', proposedHash, status: 'pending' },
    select: { id: true },
  })
  if (existing !== null) return existing.id
  await assertRoom(tx, ctx, null, 1)
  const created = await tx.recordProposal.create({
    data: {
      ...columns(ctx, origin), kind: 'match', recordId: null, attributeSlug: null,
      proposed, proposedHash, candidates: json(candidates),
    },
    select: { id: true },
  })
  return created.id
}
