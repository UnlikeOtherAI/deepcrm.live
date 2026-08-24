import {
  Prisma,
  policyDefaults,
  type Db,
  type PolicyAction,
  type PolicyEffect,
  type PolicyResourceType,
  type PolicyScope,
  type TenantRef,
} from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

export type PolicyScopeRef = { scope: PolicyScope; id: string }
export type PolicyDecision = { allowed: boolean; requiresApproval: boolean }
export type PolicyRequest = {
  resourceType: PolicyResourceType
  action: PolicyAction
  scopes: PolicyScopeRef[]
  sensitivity?: 'public' | 'internal' | 'confidential' | 'restricted'
}
export type PolicyEvaluator = {
  evaluate: (request: PolicyRequest) => PolicyDecision
}

type Sensitivity = NonNullable<PolicyRequest['sensitivity']>
type PolicyConditions = { sensitivity: Sensitivity } | null
type SeedBinding = { actorType: string; actorId: string }
type SeedRule = {
  resourceType: PolicyResourceType
  action: PolicyAction
  effect: PolicyEffect
  priority: number
  requiresApproval: boolean
  conditions: PolicyConditions
  bindings: SeedBinding[]
}
type NormalizedRule = Omit<SeedRule, 'bindings'> & {
  bindings: string[]
  createdById: string
}
type SeedTx = Pick<Db, '$executeRaw' | 'policyRule'>

const defaultDenied = new Set<PolicyAction>([
  'define',
  'merge',
  'export',
  'delete',
  'restore',
  'erase',
  'admin',
])

function invalidDefault(detail: string): ServiceError {
  return new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Invalid policy default', { detail })
}

function seedDrift(): ServiceError {
  return new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Policy seed drift')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseResourceType(value: unknown): PolicyResourceType {
  switch (value) {
    case 'schema':
    case 'object_type':
    case 'attribute':
    case 'record':
    case 'link':
    case 'list':
    case 'view':
    case 'merge':
    case 'export':
    case 'webhook':
    case 'approval':
    case 'suppression':
      return value
    default:
      throw invalidDefault('resource_type')
  }
}

function parseAction(value: unknown): PolicyAction {
  switch (value) {
    case 'view':
    case 'create':
    case 'edit':
    case 'delete':
    case 'restore':
    case 'erase':
    case 'link':
    case 'merge':
    case 'export':
    case 'define':
    case 'admin':
      return value
    default:
      throw invalidDefault('action')
  }
}

function parseEffect(value: unknown): PolicyEffect {
  if (value === 'allow' || value === 'deny') return value
  throw invalidDefault('effect')
}

function parseSensitivity(value: unknown): Sensitivity {
  switch (value) {
    case 'public':
    case 'internal':
    case 'confidential':
    case 'restricted':
      return value
    default:
      throw invalidDefault('conditions.sensitivity')
  }
}

function parseConditions(value: unknown): PolicyConditions {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) throw invalidDefault('conditions')
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'sensitivity')) {
    throw invalidDefault('conditions')
  }
  return { sensitivity: parseSensitivity(value['sensitivity']) }
}

function conditionsMatch(value: unknown, sensitivity: PolicyRequest['sensitivity']): boolean {
  if (value === null) return true
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return entries.length === 1 && entries[0]?.[0] === 'sensitivity' && entries[0][1] === sensitivity
}

function decide(
  rules: Array<{ effect: PolicyEffect; priority: number; requiresApproval: boolean }>,
): PolicyDecision {
  if (rules.some((rule) => rule.effect === 'deny' && !rule.requiresApproval)) {
    return { allowed: false, requiresApproval: false }
  }
  if (rules.some((rule) => rule.effect === 'deny' && rule.requiresApproval)) {
    return { allowed: false, requiresApproval: true }
  }
  const allows = rules.filter((rule) => rule.effect === 'allow')
  if (allows.length === 0) return { allowed: false, requiresApproval: false }
  const priority = Math.max(...allows.map((rule) => rule.priority))
  return {
    allowed: true,
    requiresApproval: allows.some((rule) => rule.priority === priority && rule.requiresApproval),
  }
}

function isHardDenied(decision: PolicyDecision): boolean {
  return !decision.allowed && !decision.requiresApproval
}

type PolicyRuleWithBindings = Prisma.PolicyRuleGetPayload<{
  include: { bindings: true }
}>

function evaluatePolicy(
  ctx: ActorContext,
  rules: readonly PolicyRuleWithBindings[],
  request: PolicyRequest,
): PolicyDecision {
  const scoped = rules.filter((rule) => (
    rule.resourceType === request.resourceType
    && rule.action === request.action
    && request.scopes.some((scope) => scope.scope === rule.scope && scope.id === rule.scopeId)
    && conditionsMatch(rule.conditions, request.sensitivity)
  ))
  const humanIds = new Set([
    `human:${ctx.onBehalfOf.uoaUserId}`,
    ...(ctx.onBehalfOf.role === null ? [] : [`role:${ctx.onBehalfOf.role}`]),
  ])
  const humanRules = scoped.filter((rule) => rule.bindings.some(
    (binding) => humanIds.has(`${binding.actorType}:${binding.actorId}`),
  ))
  const human = decide(humanRules)
  if (ctx.actor.type !== 'agent') {
    if (humanRules.length > 0) return human
    return { allowed: !defaultDenied.has(request.action), requiresApproval: false }
  }
  const agent = decide(scoped.filter((rule) => rule.bindings.some((binding) => (
    binding.actorType === 'agent'
    && binding.actorId === `agent:${ctx.app}:${ctx.actor.id}`
  ))))
  if (isHardDenied(human) || isHardDenied(agent)) {
    return { allowed: false, requiresApproval: false }
  }
  if (!human.allowed || !agent.allowed) return { allowed: false, requiresApproval: true }
  return { allowed: true, requiresApproval: human.requiresApproval || agent.requiresApproval }
}

function requestKey(request: PolicyRequest): string {
  return `${request.resourceType}:${request.action}`
}

type PolicyReadDb = Pick<Db, 'policyRule'>

export async function loadPolicyEvaluator(
  db: PolicyReadDb,
  ctx: ActorContext,
  requests: readonly PolicyRequest[],
): Promise<PolicyEvaluator> {
  const distinct = new Map(requests.map((request) => [requestKey(request), request]))
  const rules = distinct.size === 0
    ? []
    : await db.policyRule.findMany({
      where: {
        organizationId: ctx.tenant.organizationId,
        teamId: ctx.tenant.teamId,
        OR: [...distinct.values()].map((request) => ({
          resourceType: request.resourceType,
          action: request.action,
        })),
      },
      include: { bindings: true },
    })
  return {
    evaluate: (request) => evaluatePolicy(ctx, rules, request),
  }
}

export async function checkPolicy(
  db: Db,
  ctx: ActorContext,
  request: PolicyRequest,
): Promise<PolicyDecision> {
  const evaluator = await loadPolicyEvaluator(db, ctx, [request])
  return evaluator.evaluate(request)
}

function parseBinding(value: unknown): SeedBinding {
  if (
    !Array.isArray(value)
    || value.length !== 2
    || typeof value[0] !== 'string'
    || typeof value[1] !== 'string'
  ) {
    throw invalidDefault('binding')
  }
  return { actorType: value[0], actorId: value[1] }
}

function parseRule(value: unknown): SeedRule {
  if (!isRecord(value)) throw invalidDefault('rule')
  if (!Array.isArray(value['bindings'])) throw invalidDefault('bindings')
  const priority = value['priority']
  if (typeof priority !== 'number' || !Number.isInteger(priority)) {
    throw invalidDefault('priority')
  }
  const requiresApproval = value['requires_approval'] ?? false
  if (typeof requiresApproval !== 'boolean') throw invalidDefault('requires_approval')
  return {
    resourceType: parseResourceType(value['resource_type']),
    action: parseAction(value['action']),
    effect: parseEffect(value['effect']),
    priority,
    requiresApproval,
    conditions: parseConditions(value['conditions']),
    bindings: value['bindings'].map(parseBinding),
  }
}

function normalizeExpected(rule: SeedRule): NormalizedRule {
  return {
    resourceType: rule.resourceType,
    action: rule.action,
    effect: rule.effect,
    priority: rule.priority,
    requiresApproval: rule.requiresApproval,
    conditions: rule.conditions,
    bindings: rule.bindings.map((binding) => `${binding.actorType}:${binding.actorId}`).sort(),
    createdById: 'system',
  }
}

function encodeRule(rule: NormalizedRule): string {
  const encoded = JSON.stringify(rule)
  if (encoded === undefined) throw invalidDefault('serialization')
  return encoded
}

export async function seedDefaultPolicies(
  tx: SeedTx,
  tenant: TenantRef,
): Promise<{ seeded: boolean }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(4, hashtext(${tenant.teamId}))`
  const expected = policyDefaults.rules.map(parseRule)
  const existing = await tx.policyRule.findMany({
    where: {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      scope: 'team',
      scopeId: tenant.teamId,
    },
    include: { bindings: true },
  })
  if (existing.length > 0) {
    const expectedRules = expected.map(normalizeExpected).map(encodeRule).sort()
    const actualRules = existing.map((rule) => encodeRule({
      resourceType: rule.resourceType,
      action: rule.action,
      effect: rule.effect,
      priority: rule.priority,
      requiresApproval: rule.requiresApproval,
      conditions: parseConditions(rule.conditions),
      bindings: rule.bindings.map(
        (binding) => `${binding.actorType}:${binding.actorId}`,
      ).sort(),
      createdById: rule.createdById,
    })).sort()
    if (
      actualRules.length !== expectedRules.length
      || actualRules.some((rule, index) => rule !== expectedRules[index])
    ) {
      throw seedDrift()
    }
    return { seeded: false }
  }
  for (const rule of expected) {
    await tx.policyRule.create({
      data: {
        organizationId: tenant.organizationId,
        teamId: tenant.teamId,
        scope: 'team',
        scopeId: tenant.teamId,
        resourceType: rule.resourceType,
        action: rule.action,
        effect: rule.effect,
        priority: rule.priority,
        requiresApproval: rule.requiresApproval,
        conditions: rule.conditions === null ? Prisma.DbNull : rule.conditions,
        createdById: 'system',
        bindings: { create: rule.bindings },
      },
    })
  }
  return { seeded: true }
}
