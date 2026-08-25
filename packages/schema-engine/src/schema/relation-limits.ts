import { tenantWhere, type TenantRef } from '@deepcrm/db'
import { ErrorCode, RelationEdgeLimit, ServiceError } from '@deepcrm/schemas'

import type { RelationInput } from './mutation-types.js'
import type { SchemaTx } from './tx.js'

type RelationLimitInput = Pick<RelationInput, 'maxActiveEdgesFrom' | 'maxActiveEdgesTo' | 'edgeLimitConfig'>
type CurrentRelation = {
  id: string
  slug: string
  maxActiveEdgesFrom: number | null
  maxActiveEdgesTo: number | null
  edgeLimitConfig: unknown
}

function schemaConflict(detail: string): ServiceError {
  return new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Schema conflicts with existing metadata', { detail })
}

function parsed(input: RelationLimitInput) {
  const limits = RelationEdgeLimit.parse({
    max_active_edges_from: input.maxActiveEdgesFrom ?? null,
    max_active_edges_to: input.maxActiveEdgesTo ?? null,
    label_limits: input.edgeLimitConfig ?? {},
  })
  for (const [label, limit] of Object.entries(limits.label_limits)) {
    if (limits.max_active_edges_from !== null && limit.max_active_edges_from !== undefined) {
      if (limit.max_active_edges_from > limits.max_active_edges_from) throw schemaConflict(`label_limit_loosened:${label}`)
    }
    if (limits.max_active_edges_to !== null && limit.max_active_edges_to !== undefined) {
      if (limit.max_active_edges_to > limits.max_active_edges_to) throw schemaConflict(`label_limit_loosened:${label}`)
    }
  }
  return limits
}

async function maxActive(tx: SchemaTx, tenant: TenantRef, relationTypeId: string, field: 'fromRecordId' | 'toRecordId', label?: string) {
  const rows = await tx.recordLink.groupBy({
    by: [field],
    where: { ...tenantWhere(tenant), relationTypeId, activeUntil: null, ...(label === undefined ? {} : { label }) },
    _count: { _all: true },
  })
  return Math.max(0, ...rows.map((row) => row._count._all))
}

async function ensureBound(
  tx: SchemaTx,
  tenant: TenantRef,
  relation: CurrentRelation,
  field: 'fromRecordId' | 'toRecordId',
  bound: number | null,
  label?: string,
): Promise<void> {
  if (bound === null) return
  const max = await maxActive(tx, tenant, relation.id, field, label)
  if (max <= bound) return
  throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Relation limit is below active data', {
    detail: 'relation_limit_requires_resolution_plan',
    relation_type: relation.slug,
    direction: field === 'fromRecordId' ? 'from' : 'to',
    label: label ?? null,
    bound,
  })
}

export async function relationLimitData(
  tx: SchemaTx,
  tenant: TenantRef,
  input: RelationLimitInput,
  current?: CurrentRelation,
) {
  const limits = parsed(input)
  if (current !== undefined) {
    await ensureBound(tx, tenant, current, 'fromRecordId', limits.max_active_edges_from)
    await ensureBound(tx, tenant, current, 'toRecordId', limits.max_active_edges_to)
    for (const [label, limit] of Object.entries(limits.label_limits)) {
      await ensureBound(tx, tenant, current, 'fromRecordId', limit.max_active_edges_from ?? null, label)
      await ensureBound(tx, tenant, current, 'toRecordId', limit.max_active_edges_to ?? null, label)
    }
  }
  return {
    maxActiveEdgesFrom: limits.max_active_edges_from,
    maxActiveEdgesTo: limits.max_active_edges_to,
    edgeLimitConfig: limits.label_limits,
  }
}
