import { policyDefaults } from '@deepcrm/db'
import type { ActorContext } from '@deepcrm/schemas'
import type { Db, TenantRef } from '@deepcrm/db'

type PolicyResource = 'schema' | 'object_type' | 'attribute' | 'record' | 'link' | 'list' | 'view' | 'merge' | 'export' | 'webhook' | 'approval'
type PolicyAction = 'view' | 'create' | 'edit' | 'delete' | 'restore' | 'link' | 'merge' | 'export' | 'define' | 'admin'
export type PolicyDecision = { allowed: boolean; requiresApproval: boolean }

const denyByDefault = new Set<PolicyAction>(['define', 'merge', 'export', 'delete', 'restore', 'admin'])
const resources = ['schema', 'object_type', 'attribute', 'record', 'link', 'list', 'view', 'merge', 'export', 'webhook', 'approval'] as const
const actions = ['view', 'create', 'edit', 'delete', 'restore', 'link', 'merge', 'export', 'define', 'admin'] as const
const effects = ['allow', 'deny'] as const
function member<T extends string>(values: readonly T[], value: string): value is T {
  return values.includes(value as T)
}

function bindingIds(ctx: ActorContext): Array<{ actorType: string; actorId: string }> {
  const values = [{ actorType: 'human', actorId: ctx.onBehalfOf.uoaUserId }]
  if (ctx.onBehalfOf.role !== null) values.push({ actorType: 'role', actorId: ctx.onBehalfOf.role })
  if (ctx.actor.type === 'agent') values.push({ actorType: 'agent', actorId: `agent:${ctx.app}:${ctx.actor.id}` })
  return values
}

export async function checkPolicy(
  db: Db, ctx: ActorContext, resourceType: PolicyResource, action: PolicyAction, scopeIds: string[],
): Promise<PolicyDecision> {
  const rules = await db.policyRule.findMany({
    where: {
      organizationId: ctx.tenant.organizationId,
      teamId: ctx.tenant.teamId,
      resourceType,
      action,
      scopeId: { in: scopeIds },
    },
    include: { bindings: true },
  })
  const ids = bindingIds(ctx)
  const matching = rules.filter((rule) => rule.bindings.some((binding) => ids.some(
    (id) => id.actorType === binding.actorType && id.actorId === binding.actorId,
  )))
  const denied = matching.find((rule) => rule.effect === 'deny')
  if (denied !== undefined) return { allowed: false, requiresApproval: denied.requiresApproval }
  const allows = matching.filter((rule) => rule.effect === 'allow').sort((left, right) => right.priority - left.priority)
  if (allows.length > 0) return { allowed: true, requiresApproval: false }
  return { allowed: !denyByDefault.has(action), requiresApproval: false }
}

type SeedTx = Pick<Db, 'policyRule'>

export async function seedDefaultPolicies(tx: SeedTx, tenant: TenantRef): Promise<void> {
  for (const rule of policyDefaults.rules) {
    if (!member(resources, rule.resource_type) || !member(actions, rule.action)
      || !member(effects, rule.effect)) continue
    const bindings = rule.bindings.flatMap((binding) => {
      const actorType = binding[0]
      const actorId = binding[1]
      return typeof actorType === 'string' && typeof actorId === 'string' ? [{ actorType, actorId }] : []
    })
    const existing = await tx.policyRule.findFirst({ where: { organizationId: tenant.organizationId, teamId: tenant.teamId, scope: 'team', scopeId: tenant.teamId, resourceType: rule.resource_type, action: rule.action, effect: rule.effect, priority: rule.priority } })
    if (existing !== null) continue
    await tx.policyRule.create({ data: { organizationId: tenant.organizationId, teamId: tenant.teamId, scope: 'team', scopeId: tenant.teamId, resourceType: rule.resource_type, action: rule.action, effect: rule.effect, priority: rule.priority, requiresApproval: rule.requires_approval ?? false, createdById: 'system', bindings: { create: bindings } } })
  }
}
