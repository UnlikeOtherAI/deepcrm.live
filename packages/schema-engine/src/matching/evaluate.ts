import { Prisma, type TenantRef } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import { rowAccess } from '../records/visibility.js'
import type { LoadedObjectType, LoadedSchema } from '../schema/load.js'
import type { RecordTx } from '../schema/tx.js'
import { finalMatchingRecords, matchingTupleHash, matchingTuples } from './keys.js'
import type { FindMatchesInput, MatchCandidateFact } from './types.js'

function object(schema: LoadedSchema, id: string): LoadedObjectType {
  const value = schema.objectTypesById.get(id)
  if (value === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Matching object type is unknown')
  return value
}

type Row = { id: string; score: number | null }

function score(candidate: MatchCandidateFact): number | null {
  return candidate.evidence.find((item) => item.kind === 'fuzzy')?.score ?? null
}

export async function findMatches(
  tx: RecordTx, tenant: TenantRef, ctx: ActorContext, schema: LoadedSchema, input: FindMatchesInput,
): Promise<readonly MatchCandidateFact[]> {
  const objectType = object(schema, input.objectTypeId)
  const source = (await finalMatchingRecords(tx, tenant, schema, [input.recordId]))[0]
  if (source === undefined || source.objectType.id !== objectType.id) {
    throw new ServiceError(ErrorCode.NOT_FOUND, 'Record not found')
  }
  const data = source.data
  const candidates: MatchCandidateFact[] = []
  for (const rule of schema.matchingRulesByObjectTypeId.get(objectType.id) ?? []) {
    if (rule.method === 'fuzzy') {
      const threshold = rule.threshold ?? 1
      const rows = await tx.$queryRaw<Row[]>`
        SELECT r.id, similarity(r.display_name, ${source.displayName})::double precision AS score
        FROM records r
        WHERE ${rowAccess(tenant, ctx, objectType)} AND r.id <> ${input.recordId}::uuid
          AND similarity(r.display_name, ${source.displayName}) >= ${threshold}
        ORDER BY similarity(r.display_name, ${source.displayName}) DESC, r.id ASC LIMIT 20
      `
      for (const row of rows) candidates.push({
        recordId: row.id, objectTypeId: objectType.id, ruleId: rule.id, rulePosition: rule.position,
        evidence: [{
          attribute: rule.attributeSlugs[0] ?? '', kind: 'fuzzy',
          value: data[rule.attributeSlugs[0] ?? ''] ?? null, score: row.score,
        }],
      })
      continue
    }
    const hashes = matchingTuples(schema, objectType, rule, data).map(matchingTupleHash)
    if (hashes.length === 0) continue
    const visible = await tx.$queryRaw<Row[]>`
      SELECT DISTINCT r.id, NULL::double precision AS score
      FROM record_match_lookup_keys k
      JOIN records r ON r.id = k.record_id
      WHERE k.organization_id = ${tenant.organizationId}::uuid
        AND k.team_id = ${tenant.teamId}::uuid
        AND k.matching_rule_id = ${rule.id}::uuid
        AND k.normalized_hash IN (${Prisma.join(hashes)})
        AND r.id <> ${input.recordId}::uuid
        AND ${rowAccess(tenant, ctx, objectType)}
      ORDER BY r.id ASC
      LIMIT 20
    `
    for (const row of visible) candidates.push({
      recordId: row.id, objectTypeId: objectType.id, ruleId: rule.id, rulePosition: rule.position,
      evidence: rule.attributeSlugs.map((attribute) => ({
        attribute, kind: rule.method, value: data[attribute] ?? null, score: null,
      })),
    })
  }
  return candidates.sort((left, right) => {
    const byRule = left.rulePosition - right.rulePosition
    if (byRule !== 0) return byRule
    const leftScore = score(left)
    const rightScore = score(right)
    if (leftScore !== null || rightScore !== null) {
      if (leftScore === null) return 1
      if (rightScore === null) return -1
      if (leftScore !== rightScore) return rightScore - leftScore
    }
    return left.recordId.localeCompare(right.recordId)
  })
}
