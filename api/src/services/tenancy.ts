import { writeAudit, type TenantRef } from '@deepcrm/db'
import { enqueue } from '@deepcrm/queue'
import { applyTemplateBatch, type TemplateAdded } from '@deepcrm/schema-engine'
import { ErrorCode, ServiceError, type Principal } from '@deepcrm/schemas'
import type { AppDeps } from '../deps.js'
import { seedDefaultPolicies } from './policy.js'

const CACHE_TTL_MS = 60_000
const CACHE_LIMIT = 1_000
const PROVISIONING_ACTOR_ID = 'provisioning'
const TENANT_REPARENT_JOB = 'tenant.reparent'

type CachedTenantIds = {
  organizationId: string
  teamId: string
  expiresAt: number
}

export type TenantResolution = {
  organizationId: string
  teamId: string
  schemaVersion: number
  policyVersion: number
}

const tenantCache = new Map<string, CachedTenantIds>()

function cacheKey(principal: Principal): string {
  return `${principal.uoaOrgId}:${principal.uoaTeamId}`
}

function totalAdded(added: TemplateAdded): number {
  return added.objectTypes + added.attributes + added.relationTypes + added.pipelines + added.matchingRules
}

function enforceOrgAllowlist(deps: AppDeps, principal: Principal): void {
  if (deps.orgAllowlist === null || deps.orgAllowlist.has(principal.uoaOrgId)) return
  throw new ServiceError(
    ErrorCode.POLICY_DENIED,
    'Organisation is not allowed to provision a tenant',
  )
}

function cacheTenant(key: string, ids: Omit<CachedTenantIds, 'expiresAt'>): void {
  tenantCache.delete(key)
  tenantCache.set(key, { ...ids, expiresAt: Date.now() + CACHE_TTL_MS })
  if (tenantCache.size > CACHE_LIMIT) {
    const oldestKey = tenantCache.keys().next().value
    if (oldestKey !== undefined) tenantCache.delete(oldestKey)
  }
}

async function readCurrentVersions(
  deps: AppDeps,
  cached: CachedTenantIds,
): Promise<TenantResolution | null> {
  const team = await deps.db.team.findFirst({
    where: { id: cached.teamId, organizationId: cached.organizationId },
    select: { id: true, organizationId: true, schemaVersion: true, policyVersion: true },
  })
  if (team === null) return null
  return {
    organizationId: team.organizationId,
    teamId: team.id,
    schemaVersion: team.schemaVersion,
    policyVersion: team.policyVersion,
  }
}

export async function resolveTenant(
  deps: AppDeps,
  principal: Principal,
  requestId: string,
): Promise<TenantResolution> {
  enforceOrgAllowlist(deps, principal)
  const key = cacheKey(principal)
  const cached = tenantCache.get(key)
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    tenantCache.delete(key)
    tenantCache.set(key, cached)
    const current = await readCurrentVersions(deps, cached)
    if (current !== null) return current
  }
  tenantCache.delete(key)

  const resolved = await deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(3, hashtext(${principal.uoaTeamId}))`

    const organization = await tx.organization.upsert({
      where: { externalOrgId: principal.uoaOrgId },
      create: {
        externalOrgId: principal.uoaOrgId,
        name: `Organisation ${principal.uoaOrgId.slice(0, 8)}`,
      },
      update: {},
      select: { id: true },
    })
    const existingTeam = await tx.team.findUnique({
      where: { externalTeamId: principal.uoaTeamId },
      select: { id: true, organizationId: true, schemaVersion: true, policyVersion: true },
    })
    if (existingTeam !== null) {
      if (existingTeam.organizationId !== organization.id) {
        await enqueue(tx, {
          organizationId: existingTeam.organizationId,
          teamId: existingTeam.id,
          type: TENANT_REPARENT_JOB,
          priority: 100,
          maxAttempts: 10,
          idempotencyKey: `tenant-reparent:${principal.uoaTeamId}:${organization.id}`,
          payload: {
            teamId: existingTeam.id,
            sourceOrganizationId: existingTeam.organizationId,
            targetOrganizationId: organization.id,
            externalOrgId: principal.uoaOrgId,
            externalTeamId: principal.uoaTeamId,
            requestId,
            uoaUserId: principal.uoaUserId,
          },
        })
        return { status: 'reparenting' as const }
      }
      return { status: 'resolved' as const, team: existingTeam }
    }
    const created = await tx.team.create({
      data: {
        organizationId: organization.id,
        externalTeamId: principal.uoaTeamId,
        name: `Team ${principal.uoaTeamId.slice(0, 8)}`,
      },
      select: { id: true, organizationId: true, schemaVersion: true, policyVersion: true },
    })
    const tenant: TenantRef = {
      organizationId: created.organizationId,
      teamId: created.id,
    }
    const actor: {
      type: 'system'
      id: string
      onBehalfOf: string
      requestId: string
    } = {
      type: 'system',
      id: PROVISIONING_ACTOR_ID,
      onBehalfOf: principal.uoaUserId,
      requestId,
    }
    const policy = await seedDefaultPolicies(tx, tenant)
    const template = await applyTemplateBatch(tx, tenant, actor, 'system')
    const versioned = await tx.team.update({
      where: { id: created.id, organizationId: created.organizationId },
      data: {
        policyVersion: { increment: policy.seeded ? 1 : 0 },
        schemaVersion: { increment: totalAdded(template.added) === 0 ? 0 : 1 },
      },
      select: { id: true, organizationId: true, schemaVersion: true, policyVersion: true },
    })
    await writeAudit(tx, {
      organizationId: tenant.organizationId,
      teamId: tenant.teamId,
      actorType: 'system',
      actorId: PROVISIONING_ACTOR_ID,
      onBehalfOf: principal.uoaUserId,
      action: 'tenant.provisioned',
      resourceType: 'team',
      resourceId: tenant.teamId,
      outcome: 'success',
      reason: null,
      metadata: null,
      requestId,
      ipAddress: null,
      userAgent: null,
    })
    return { status: 'resolved' as const, team: versioned }
  })

  if (resolved.status === 'reparenting') {
    throw new ServiceError(
      ErrorCode.TENANT_REPARENTING,
      'The UOA team is being reconciled to its current organisation',
    )
  }
  const team = resolved.team
  cacheTenant(key, { organizationId: team.organizationId, teamId: team.id })
  return {
    organizationId: team.organizationId,
    teamId: team.id,
    schemaVersion: team.schemaVersion,
    policyVersion: team.policyVersion,
  }
}
