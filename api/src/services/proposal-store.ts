import { createHash } from 'node:crypto'

import { canonicalJson, tenantWhere, type AuditTx, type Db, type Prisma } from '@deepcrm/db'
import { canonicalJsonValue, type JsonValue } from '@deepcrm/schema-engine'
import { ErrorCode, ServiceError, type ActorContext, type SourceRef } from '@deepcrm/schemas'

import { z } from 'zod'

import type { PairChange } from './intake-submission.js'

/**
 * The pending windows (schema-engine §4d″). Every proposal waits in a queue —
 * an amendment's is its record and attribute, a match's its email and phone —
 * and a submission is never refused because of other proposals: an identical
 * one collapses into the open proposal, and past a window the oldest pending
 * proposals are superseded, the newest kept. Five per queue: approving an
 * amendment writes one value, so a reviewer chooses among a few alternatives,
 * and a flood on one field or one identity holds at most five pending rows
 * without growing the team's count. A thousand per team: an inbox a team can
 * still work through, reached only by submissions spread over at least two
 * hundred queues.
 */
export const PENDING_PER_QUEUE = 5
export const PENDING_PER_TEAM = 1_000

type ProposalTx = Pick<Db, 'recordProposal'> & Pick<AuditTx, '$executeRaw'>

/** Who proposed, through which source, about which type — the same for every row of one submission. */
export type ProposalOrigin = {
  source: SourceRef
  requester: { type: 'human' | 'agent' | 'system'; id: string }
  requestId: string
  objectTypeId: string
}

/** What a submission did to the proposals: how many it placed (new or collapsed) and how many it superseded. */
export type ProposalEffect = { placed: number; superseded: number }

export type MatchedOn = 'email' | 'phone' | 'archived_email' | 'archived_phone'
export type MatchCandidate = { record_id: string; matched_on: MatchedOn[] }

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
  record_id: z.string().uuid(), matched_on: z.array(z.enum(['email', 'phone', 'archived_email', 'archived_phone'])),
}).strict())

/** One proposal as the store places it. */
type Proposal = {
  kind: 'amendment' | 'match'
  queueKey: string
  proposedHash: string
  recordId: string | null
  attributeSlug: string | null
  proposed: Prisma.InputJsonValue
  candidates: Prisma.InputJsonValue
}

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

/** An amendment's queue: one field of one record. */
function amendmentQueue(recordId: string, attributeSlug: string): string {
  return `amendment:${recordId}:${attributeSlug}`
}

/** A match's queue: the normalised email and phone it was found by (migration 20261019160000 computes the same). */
export function matchQueue(email: string | undefined, phone: string | undefined): string {
  return `match:${createHash('sha256').update(`${email ?? ''}\n${phone ?? ''}`, 'utf8').digest('hex')}`
}

/**
 * Collapses a submission into an open proposal: one more submission, the
 * latest source, requester and stored value, and the newest place in
 * submission order, pending again. A decision may settle the row meanwhile
 * (deciding takes no team lock), so the status is checked again here and a
 * decided row is never reopened. Answers whether it collapsed.
 */
async function collapse(
  tx: ProposalTx, ctx: ActorContext, origin: ProposalOrigin, proposal: Proposal, id: string,
): Promise<boolean> {
  const updated = await tx.$executeRaw`
    UPDATE record_proposals
    SET status = 'pending'::"ProposalStatus", resolved_at = NULL, submissions = submissions + 1,
        submitted_seq = nextval(pg_get_serial_sequence('record_proposals', 'submitted_seq')),
        last_submitted_at = CURRENT_TIMESTAMP, proposed = ${JSON.stringify(proposal.proposed)}::jsonb,
        candidates = ${JSON.stringify(proposal.candidates)}::jsonb,
        source_kind = ${origin.source.kind}, source_id = ${origin.source.id}, source_name = ${origin.source.name},
        requester_type = ${origin.requester.type}::"ActorType", requester_id = ${origin.requester.id},
        request_id = ${origin.requestId}
    WHERE organization_id = ${ctx.tenant.organizationId}::uuid AND team_id = ${ctx.tenant.teamId}::uuid
      AND id = ${id}::uuid AND status IN ('pending'::"ProposalStatus", 'superseded'::"ProposalStatus")
  `
  return updated === 1
}

/**
 * Places one proposal. An open proposal of the same queue and value —
 * pending, or superseded and not yet removed by retention — absorbs it;
 * otherwise a new pending row is written. Callers hold the team's
 * link-topology lock (intake and match resolution take it), so there is one
 * open row per identity and the windows below hold exactly.
 */
async function place(tx: ProposalTx, ctx: ActorContext, origin: ProposalOrigin, proposal: Proposal): Promise<void> {
  const open = await tx.recordProposal.findFirst({
    where: {
      ...tenantWhere(ctx.tenant), queueKey: proposal.queueKey, proposedHash: proposal.proposedHash,
      status: { in: ['pending', 'superseded'] },
    },
    orderBy: { submittedSeq: 'desc' },
    select: { id: true },
  })
  if (open !== null && await collapse(tx, ctx, origin, proposal, open.id)) return
  await tx.recordProposal.create({
    data: {
      ...tenantWhere(ctx.tenant), objectTypeId: origin.objectTypeId, kind: proposal.kind, recordId: proposal.recordId,
      attributeSlug: proposal.attributeSlug, queueKey: proposal.queueKey, proposed: proposal.proposed,
      proposedHash: proposal.proposedHash, candidates: proposal.candidates,
      sourceKind: origin.source.kind, sourceId: origin.source.id, sourceName: origin.source.name,
      requesterType: origin.requester.type, requesterId: origin.requester.id, requestId: origin.requestId,
    },
    select: { id: true },
  })
}

/**
 * Supersedes the pending proposals past the windows, oldest first: beyond
 * the newest five of each queue just written to, then beyond the newest
 * thousand of the team. The rows stay, with their state, until retention.
 * The outer `status` check is re-read on a row a concurrent decision just
 * settled, so a decided proposal is never superseded. Answers how many were.
 */
async function supersedeOverflow(tx: ProposalTx, ctx: ActorContext, queueKeys: readonly string[]): Promise<number> {
  const { organizationId, teamId } = ctx.tenant
  const queues = await tx.$executeRaw`
    UPDATE record_proposals SET status = 'superseded'::"ProposalStatus", resolved_at = ${ctx.now}
    WHERE organization_id = ${organizationId}::uuid AND team_id = ${teamId}::uuid
      AND status = 'pending'::"ProposalStatus" AND id IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY queue_key ORDER BY submitted_seq DESC) AS place
        FROM record_proposals
        WHERE organization_id = ${organizationId}::uuid AND team_id = ${teamId}::uuid
          AND status = 'pending'::"ProposalStatus" AND queue_key = ANY(${[...queueKeys]}::text[])
      ) AS ranked
      WHERE place > ${PENDING_PER_QUEUE}
    )
  `
  const team = await tx.$executeRaw`
    UPDATE record_proposals SET status = 'superseded'::"ProposalStatus", resolved_at = ${ctx.now}
    WHERE organization_id = ${organizationId}::uuid AND team_id = ${teamId}::uuid
      AND status = 'pending'::"ProposalStatus" AND id IN (
      SELECT id FROM record_proposals
      WHERE organization_id = ${organizationId}::uuid AND team_id = ${teamId}::uuid
        AND status = 'pending'::"ProposalStatus"
      ORDER BY submitted_seq DESC
      OFFSET ${PENDING_PER_TEAM}
    )
  `
  return queues + team
}

/**
 * Places one pending amendment per real change — collapsing into an open
 * amendment of the same record, attribute and value — then supersedes what
 * overflows the windows. Never refuses.
 */
export async function proposeAmendments(
  tx: ProposalTx, ctx: ActorContext, origin: ProposalOrigin, recordId: string, amendments: readonly PairChange[],
): Promise<ProposalEffect> {
  const placed = new Map<string, string>()
  for (const amendment of amendments) {
    const slug = amendment.attribute.slug
    const proposed = json(amendment.value)
    const proposedHash = hash({ attribute: slug, value: proposed })
    const queueKey = amendmentQueue(recordId, slug)
    if (placed.get(queueKey) === proposedHash) continue
    await place(tx, ctx, origin, {
      kind: 'amendment', queueKey, proposedHash, recordId, attributeSlug: slug, proposed, candidates: [],
    })
    placed.set(queueKey, proposedHash)
  }
  if (placed.size === 0) return { placed: 0, superseded: 0 }
  return { placed: placed.size, superseded: await supersedeOverflow(tx, ctx, [...placed.keys()]) }
}

/**
 * Places a pending match — the validated submission and the people its email
 * and phone point at — collapsing into an open match of the same email,
 * phone, values, activity text and note, whatever its source or activity
 * time; then supersedes what overflows the windows. Never refuses.
 */
export async function proposeMatch(
  tx: ProposalTx, ctx: ActorContext, origin: ProposalOrigin, submission: PendingSubmission,
  candidates: readonly MatchCandidate[],
): Promise<ProposalEffect> {
  const { kind, subject, body } = submission.activity
  const queueKey = matchQueue(submission.email, submission.phone)
  await place(tx, ctx, origin, {
    kind: 'match', queueKey, recordId: null, attributeSlug: null,
    proposedHash: hash(json({ ...submission, activity: { kind, subject, ...(body === undefined ? {} : { body }) } })),
    proposed: json(submission), candidates: json(candidates),
  })
  return { placed: 1, superseded: await supersedeOverflow(tx, ctx, [queueKey]) }
}
