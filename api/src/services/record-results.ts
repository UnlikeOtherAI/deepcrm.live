import { tenantWhere, type Db } from '@deepcrm/db'
import { type Candidate, type ActorContext } from '@deepcrm/schemas'
import { canSee, type LoadedSchema, type MatchCandidateFact, type RecordTx } from '@deepcrm/schema-engine'

import { loadPolicyEvaluator, type PolicyEvaluator, type PolicyRequest, type PolicyScopeRef } from './policy.js'

export function loadDuplicateEvaluator(db: Db, ctx: ActorContext): Promise<PolicyEvaluator> {
  const team = [{ scope: 'team', id: ctx.tenant.teamId }] as const
  return loadPolicyEvaluator(db, ctx, [
    { resourceType: 'record', action: 'view', scopes: [...team] },
    { resourceType: 'attribute', action: 'view', scopes: [...team] },
  ])
}

function scopes(ctx: ActorContext, objectTypeId: string, recordId: string): PolicyScopeRef[] {
  return [
    { scope: 'team', id: ctx.tenant.teamId },
    { scope: 'object_type', id: objectTypeId },
    { scope: 'record', id: recordId },
  ]
}

function evidence(
  evaluator: PolicyEvaluator,
  ctx: ActorContext,
  schema: LoadedSchema,
  objectTypeId: string,
  recordId: string,
  facts: MatchCandidateFact['evidence'],
): Candidate['evidence'] {
  const access = (attribute: string): PolicyRequest => ({
    resourceType: 'attribute', action: 'view', scopes: scopes(ctx, objectTypeId, recordId),
    sensitivity: schema.attributesByObjectTypeId.get(objectTypeId)?.get(attribute)?.sensitivity,
  })
  return facts.map((fact) => {
    const decision = evaluator.evaluate(access(fact.attribute))
    const base = { kind: fact.kind, attribute: fact.attribute, matched: true as const }
    if (!decision.allowed || decision.requiresApproval) return base
    return {
      ...base,
      ...(fact.value === null ? {} : { value: fact.value }),
      ...(fact.score === null ? {} : { score: fact.score }),
    }
  })
}

export async function presentDuplicates(
  tx: RecordTx,
  ctx: ActorContext,
  evaluator: PolicyEvaluator,
  schema: LoadedSchema,
  facts: readonly MatchCandidateFact[],
): Promise<readonly Candidate[]> {
  if (facts.length === 0) return []
  const ids = [...new Set(facts.map((fact) => fact.recordId))]
  const rows = await tx.record.findMany({
    where: { ...tenantWhere(ctx.tenant), id: { in: ids }, deletedAt: null, mergedIntoId: null },
    select: {
      id: true, objectTypeId: true, displayName: true, visibility: true, createdOnBehalfOf: true,
      objectType: { select: { slug: true } }, visibilityGrants: { select: { uoaUserId: true } },
    },
  })
  const byId = new Map(rows.filter((row) => canSee(ctx, row)).map((row) => [row.id, row]))
  return facts.flatMap((fact) => {
    const row = byId.get(fact.recordId)
    if (row === undefined) return []
    const decision = evaluator.evaluate({ resourceType: 'record', action: 'view', scopes: scopes(ctx, row.objectTypeId, row.id) })
    if (!decision.allowed || decision.requiresApproval) return []
    return [{
      record: { id: row.id, object_type: row.objectType.slug, display_name: row.displayName },
      rule_position: fact.rulePosition,
      evidence: evidence(evaluator, ctx, schema, row.objectTypeId, row.id, fact.evidence),
    }]
  })
}

export type PresentedDuplicates = readonly Candidate[]
