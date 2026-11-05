import { Prisma, type Db, type TenantRef } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { ChangeIntent } from './records/changes.js'
import type { JsonValue } from './records/json.js'

export type ChangeLogTx = Pick<Db, '$queryRaw' | 'recordChange'>
export type ChangeAuthor = {
  tenant: TenantRef
  actor: ActorContext['actor']
  onBehalfOf: string | null
  requestId: string
  provenance?: ActorContext['provenance']
}
export type SchemaChangeIntent = Omit<ChangeIntent, 'recordId' | 'kind'> & {
  recordId: null
  kind: 'schema_change'
}

function json(value: JsonValue | null): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : value
}

/** The team row serializes allocations until the caller's mutation transaction commits. */
export async function writeChangeRows(
  tx: ChangeLogTx,
  author: ChangeAuthor,
  changes: readonly (ChangeIntent | SchemaChangeIntent)[],
): Promise<number[]> {
  if (changes.length === 0) return []
  const [team] = await tx.$queryRaw<{ feedSeq: bigint }[]>`
    UPDATE teams SET feed_seq = feed_seq + ${changes.length}::bigint
    WHERE id = ${author.tenant.teamId}::uuid AND organization_id = ${author.tenant.organizationId}::uuid
    RETURNING feed_seq AS "feedSeq"
  `
  if (team === undefined) throw new ServiceError(ErrorCode.NOT_FOUND, 'Tenant team not found')
  const first = Number(team.feedSeq) - changes.length + 1
  const sequences = changes.map((_, index) => first + index)
  for (const [index, change] of changes.entries()) {
    const seq = sequences[index]
    if (seq === undefined) throw new ServiceError(ErrorCode.INTERNAL, 'Missing change sequence')
    await tx.recordChange.create({
      data: {
        organizationId: author.tenant.organizationId,
        teamId: author.tenant.teamId,
        recordId: change.recordId,
        kind: change.kind,
        attributeSlug: change.attributeSlug,
        relationTypeId: change.relationTypeId,
        linkId: change.linkId,
        groupId: change.groupId,
        oldValue: json(change.oldValue),
        newValue: json(change.newValue),
        snapshot: json(change.snapshot),
        actorType: author.actor.type,
        actorId: author.actor.id,
        onBehalfOf: author.onBehalfOf,
        runId: author.provenance?.runId ?? null,
        toolCallId: author.provenance?.toolCallId ?? null,
        requestId: author.requestId,
        reason: change.reason,
        resultingVersion: change.resultingVersion,
        seq: BigInt(seq),
      },
    })
  }
  return sequences
}
