import { Prisma } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { RecordTx } from '../schema/tx.js'
import { canonicalJson, type JsonValue } from './json.js'

export type ChangeIntent = {
  recordId: string
  kind: 'create' | 'set' | 'unset' | 'link' | 'unlink' | 'delete' | 'restore' | 'merge' | 'unmerge' | 'erase'
  attributeSlug: string | null
  relationTypeId: string | null
  linkId: string | null
  groupId: string | null
  oldValue: JsonValue | null
  newValue: JsonValue | null
  snapshot: JsonValue | null
  resultingVersion: number
  reason: string | null
}

type DiffInput = Record<string, JsonValue>

function json(value: JsonValue | null): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : value
}

export function diffChanges(
  before: DiffInput, after: DiffInput, recordId: string, resultingVersion: number,
): ChangeIntent[] {
  const slugs = new Set([...Object.keys(before), ...Object.keys(after)])
  const changes: ChangeIntent[] = []
  for (const slug of [...slugs].sort()) {
    const oldValue = before[slug]
    const newValue = after[slug]
    if (oldValue === undefined && newValue === undefined) continue
    if (oldValue !== undefined && newValue !== undefined && canonicalJson(oldValue) === canonicalJson(newValue)) {
      continue
    }
    if (newValue === undefined) {
      changes.push({ recordId, kind: 'unset', attributeSlug: slug, relationTypeId: null, linkId: null, groupId: null, oldValue: oldValue ?? null, newValue: null, snapshot: null, resultingVersion, reason: null })
    } else {
      changes.push({ recordId, kind: 'set', attributeSlug: slug, relationTypeId: null, linkId: null, groupId: null, oldValue: oldValue ?? null, newValue, snapshot: null, resultingVersion, reason: null })
    }
  }
  return changes
}

export function createChanges(after: DiffInput, recordId: string): ChangeIntent[] {
  const changes: ChangeIntent[] = [{
    recordId, kind: 'create', attributeSlug: null, relationTypeId: null, linkId: null, groupId: null, oldValue: null, newValue: null, snapshot: null, resultingVersion: 1, reason: null,
  }]
  for (const slug of Object.keys(after).sort()) {
    const value = after[slug]
    if (value === undefined) continue
    changes.push({ recordId, kind: 'set', attributeSlug: slug, relationTypeId: null, linkId: null, groupId: null, oldValue: null, newValue: value, snapshot: null, resultingVersion: 1, reason: null })
  }
  return changes
}

export async function writeChanges(
  tx: RecordTx,
  ctx: ActorContext,
  changes: readonly ChangeIntent[],
): Promise<number[]> {
  if (changes.length === 0) return []
  const advanced = await tx.team.updateMany({
    where: { id: ctx.tenant.teamId, organizationId: ctx.tenant.organizationId },
    data: { feedSeq: { increment: changes.length } },
  })
  if (advanced.count !== 1) throw new ServiceError(ErrorCode.NOT_FOUND, 'Tenant team not found')
  const team = await tx.team.findFirst({
    where: { id: ctx.tenant.teamId, organizationId: ctx.tenant.organizationId },
    select: { feedSeq: true },
  })
  if (team === null) throw new ServiceError(ErrorCode.NOT_FOUND, 'Tenant team not found')
  const first = Number(team.feedSeq) - changes.length + 1
  const sequences = changes.map((_, index) => first + index)
  for (const [index, change] of changes.entries()) {
    const seq = sequences[index]
    if (seq === undefined) throw new ServiceError(ErrorCode.INTERNAL, 'Missing change sequence')
    await tx.recordChange.create({
      data: {
        organizationId: ctx.tenant.organizationId,
        teamId: ctx.tenant.teamId,
        recordId: change.recordId,
        kind: change.kind,
        attributeSlug: change.attributeSlug,
        relationTypeId: change.relationTypeId,
        linkId: change.linkId,
        groupId: change.groupId,
        oldValue: json(change.oldValue),
        newValue: json(change.newValue),
        snapshot: json(change.snapshot),
        actorType: ctx.actor.type,
        actorId: ctx.actor.id,
        onBehalfOf: ctx.onBehalfOf.uoaUserId,
        runId: ctx.provenance?.runId ?? null,
        toolCallId: ctx.provenance?.toolCallId ?? null,
        requestId: ctx.requestId,
        reason: change.reason,
        resultingVersion: change.resultingVersion,
        seq: BigInt(seq),
      },
    })
  }
  return sequences
}
