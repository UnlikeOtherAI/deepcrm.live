import { Prisma, type TenantRef } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { LoadedAttribute, LoadedObjectType } from '../schema/load.js'

type RuleAlias = 'p' | 'higher' | 'tied'
type BindingAlias = 'b' | 'hb' | 'tb'

export type VisibilityRecord = {
  visibility: 'team' | 'users' | 'private'
  createdOnBehalfOf: string | null
  visibilityGrants: readonly { uoaUserId: string }[]
}

export function canSee(ctx: ActorContext, record: VisibilityRecord): boolean {
  return record.visibility === 'team'
    || record.createdOnBehalfOf === ctx.onBehalfOf.uoaUserId
    || (
      record.visibility === 'users'
      && record.visibilityGrants.some((grant) => grant.uoaUserId === ctx.onBehalfOf.uoaUserId)
    )
}

function policyPredicate(
  tenant: TenantRef,
  ctx: ActorContext,
  objectType: LoadedObjectType,
  resourceType: 'record' | 'attribute',
  sensitivity: LoadedAttribute['sensitivity'] | undefined,
): Prisma.Sql {
  const userId = ctx.onBehalfOf.uoaUserId
  const role = ctx.onBehalfOf.role
  const agentId = `agent:${ctx.app}:${ctx.actor.id}`
  const scopes = (alias: RuleAlias): Prisma.Sql => {
    const rule = Prisma.raw(alias)
    return Prisma.sql`(${rule}.scope = 'record' AND ${rule}.scope_id = r.id::text)
      OR (${rule}.scope = 'object_type' AND ${rule}.scope_id = CAST(${objectType.id} AS text))
      OR (${rule}.scope = 'team' AND ${rule}.scope_id = CAST(${tenant.teamId} AS text))`
  }
  const conditions = (alias: RuleAlias): Prisma.Sql => {
    const rule = Prisma.raw(alias)
    const unconditional = Prisma.sql`(${rule}.conditions IS NULL OR ${rule}.conditions = 'null'::jsonb)`
    return sensitivity === undefined
      ? unconditional
      : Prisma.sql`(${unconditional} OR ${rule}.conditions = ${JSON.stringify({ sensitivity })}::jsonb)`
  }
  const binding = (alias: BindingAlias, agent: boolean): Prisma.Sql => {
    const table = Prisma.raw(alias)
    if (agent) return Prisma.sql`${table}.actor_type = 'agent' AND ${table}.actor_id = ${agentId}`
    return role === null
      ? Prisma.sql`${table}.actor_type = 'human' AND ${table}.actor_id = ${userId}`
      : Prisma.sql`(${table}.actor_type = 'human' AND ${table}.actor_id = ${userId})
        OR (${table}.actor_type = 'role' AND ${table}.actor_id = ${role})`
  }
  const channel = (
    current: Prisma.Sql,
    higher: Prisma.Sql,
    agent: boolean,
    fallback: boolean,
  ): Prisma.Sql => Prisma.sql`(
    NOT EXISTS (SELECT 1 FROM policy_rules p JOIN policy_bindings b ON b.policy_rule_id = p.id
      WHERE p.organization_id = r.organization_id AND p.team_id = r.team_id
        AND p.resource_type = ${resourceType}::"PolicyResourceType" AND p.action = 'view' AND (${scopes('p')})
        AND ${conditions('p')} AND (${current}) AND p.effect = 'deny' AND p.requires_approval = false)
    AND NOT EXISTS (SELECT 1 FROM policy_rules p JOIN policy_bindings b ON b.policy_rule_id = p.id
      WHERE p.organization_id = r.organization_id AND p.team_id = r.team_id
        AND p.resource_type = ${resourceType}::"PolicyResourceType" AND p.action = 'view' AND (${scopes('p')})
        AND ${conditions('p')} AND (${current}) AND p.effect = 'deny' AND p.requires_approval = true)
    AND (${fallback ? Prisma.sql`NOT EXISTS (SELECT 1 FROM policy_rules p JOIN policy_bindings b ON b.policy_rule_id = p.id
      WHERE p.organization_id = r.organization_id AND p.team_id = r.team_id
        AND p.resource_type = ${resourceType}::"PolicyResourceType" AND p.action = 'view' AND (${scopes('p')})
        AND ${conditions('p')} AND (${current}))` : Prisma.sql`false`} OR EXISTS (
      SELECT 1 FROM policy_rules p JOIN policy_bindings b ON b.policy_rule_id = p.id
      WHERE p.organization_id = r.organization_id AND p.team_id = r.team_id
        AND p.resource_type = ${resourceType}::"PolicyResourceType" AND p.action = 'view' AND (${scopes('p')})
        AND ${conditions('p')} AND (${current}) AND p.effect = 'allow' AND p.requires_approval = false
        AND p.priority = (SELECT MAX(higher.priority) FROM policy_rules higher
          JOIN policy_bindings hb ON hb.policy_rule_id = higher.id
          WHERE higher.organization_id = p.organization_id AND higher.team_id = p.team_id
            AND higher.resource_type = p.resource_type AND higher.action = p.action
            AND (${scopes('higher')}) AND ${conditions('higher')} AND (${higher})
            AND higher.effect = 'allow')
        AND NOT EXISTS (SELECT 1 FROM policy_rules tied JOIN policy_bindings tb ON tb.policy_rule_id = tied.id
          WHERE tied.organization_id = p.organization_id AND tied.team_id = p.team_id
            AND tied.resource_type = p.resource_type AND tied.action = p.action
            AND tied.priority = p.priority AND (${scopes('tied')}) AND ${conditions('tied')}
            AND (${binding('tb', agent)}) AND tied.effect = 'allow' AND tied.requires_approval = true)
    ))
  )`
  const human = channel(
    binding('b', false),
    binding('hb', false),
    false,
    ctx.actor.type !== 'agent',
  )
  return ctx.actor.type === 'agent'
    ? Prisma.sql`${human} AND ${channel(binding('b', true), binding('hb', true), true, false)}`
    : human
}

function assertTenant(tenant: TenantRef, ctx: ActorContext): void {
  if (tenant.organizationId !== ctx.tenant.organizationId || tenant.teamId !== ctx.tenant.teamId) {
    throw new ServiceError(ErrorCode.TENANT_MISMATCH, 'Tenant does not match actor context')
  }
}

export function rowAccess(tenant: TenantRef, ctx: ActorContext, objectType: LoadedObjectType): Prisma.Sql {
  assertTenant(tenant, ctx)
  const userId = ctx.onBehalfOf.uoaUserId
  return Prisma.sql`r.organization_id = ${tenant.organizationId}::uuid
    AND r.team_id = ${tenant.teamId}::uuid AND r.object_type_id = ${objectType.id}::uuid
    AND r.deleted_at IS NULL AND r.merged_into_id IS NULL
    AND (r.visibility = 'team' OR r.created_on_behalf_of = ${userId}
      OR (r.visibility = 'users' AND EXISTS (SELECT 1 FROM record_visibility_grants g
        WHERE g.record_id = r.id AND g.uoa_user_id = ${userId})))
    AND ${policyPredicate(tenant, ctx, objectType, 'record', undefined)}`
}

/** Correlated attribute-view gate for filter/sort membership; output redaction remains API-owned. */
export function attributeReadAccess(
  tenant: TenantRef,
  ctx: ActorContext,
  objectType: LoadedObjectType,
  attributes: readonly LoadedAttribute[],
): Prisma.Sql {
  assertTenant(tenant, ctx)
  if (attributes.length === 0) return Prisma.empty
  return Prisma.sql` AND ${Prisma.join(
    attributes.map((attribute) => policyPredicate(tenant, ctx, objectType, 'attribute', attribute.sensitivity)),
    ' AND ',
  )}`
}
